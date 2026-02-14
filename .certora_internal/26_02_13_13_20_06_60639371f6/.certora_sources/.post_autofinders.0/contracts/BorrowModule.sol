// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Borrow Module V2
// Tracks debt positions with utilization-based dynamic interest rates
// Routes interest payments to SMUSD stakers

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";

interface IPriceOracle {
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
    function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256);
}

interface ICollateralVault {
    function deposits(address user, address token) external view returns (uint256);
    function getSupportedTokens() external view returns (address[] memory);
    function getConfig(address token) external view returns (
        bool enabled, uint256 collateralFactorBps, uint256 liquidationThresholdBps, uint256 liquidationPenaltyBps
    );
    function withdraw(address token, uint256 amount, address user) external;
}

interface IMUSDMint {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

interface IInterestRateModel {
    function calculateInterest(
        uint256 principal,
        uint256 totalBorrows,
        uint256 totalSupply,
        uint256 secondsElapsed
    ) external view returns (uint256);
    function splitInterest(uint256 interestAmount) 
        external view returns (uint256 supplierAmount, uint256 reserveAmount);
    function getBorrowRateAnnual(uint256 totalBorrows, uint256 totalSupply) 
        external view returns (uint256);
    function getSupplyRateAnnual(uint256 totalBorrows, uint256 totalSupply) 
        external view returns (uint256);
    function utilizationRate(uint256 totalBorrows, uint256 totalSupply) 
        external pure returns (uint256);
}

interface ISMUSD {
    function receiveInterest(uint256 amount) external;
}

interface ITreasury {
    function totalValue() external view returns (uint256);
}

/// @title BorrowModule
/// @notice Manages debt positions for overcollateralized mUSD borrowing.
///         Uses utilization-based dynamic interest rates (Compound-style).
///         Interest accrues per-second and is routed to SMUSD stakers.
contract BorrowModule is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant BORROW_ADMIN_ROLE = keccak256("BORROW_ADMIN_ROLE");
    bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice TIMELOCK_ROLE for critical parameter changes
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    ICollateralVault public immutable vault;
    IPriceOracle public immutable oracle;
    IMUSDMint public immutable musd;

    // ═══════════════════════════════════════════════════════════════════════
    // INTEREST RATE MODEL INTEGRATION
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Dynamic interest rate model (utilization-based)
    IInterestRateModel public interestRateModel;
    
    /// @notice SMUSD vault to receive interest payments
    ISMUSD public smusd;
    
    /// @notice Treasury for total supply calculation
    ITreasury public treasury;
    
    /// @notice Global total borrows across all users
    uint256 public totalBorrows;
    
    /// @notice Accumulated protocol reserves (from reserve factor)
    uint256 public protocolReserves;
    
    /// @notice Last time global interest was accrued
    uint256 public lastGlobalAccrualTime;
    
    /// @notice Total interest paid to suppliers (for analytics)
    uint256 public totalInterestPaidToSuppliers;

    /// @notice Buffered interest that failed to route to SMUSD
    /// Retried on next accrual to prevent phantom debt accumulation
    uint256 public pendingInterest;
    
    /// @notice Fallback fixed rate if model not set (legacy compatibility)
    uint256 public interestRateBps;

    // Seconds per year for interest calculation
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant BPS = 10000;

    // Minimum debt to open a position (prevents dust positions)
    uint256 public minDebt;

    struct DebtPosition {
        uint256 principal;        // Original borrowed amount (18 decimals)
        uint256 accruedInterest;  // Accumulated interest at last update
        uint256 lastAccrualTime;  // Timestamp of last interest accrual
    }

    // user => debt position
    mapping(address => DebtPosition) public positions;

    event Borrowed(address indexed user, uint256 amount, uint256 totalDebt);
    event Repaid(address indexed user, uint256 amount, uint256 remaining);
    event InterestAccrued(address indexed user, uint256 interest, uint256 totalDebt);
    event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);
    event InterestRateUpdated(uint256 oldRate, uint256 newRate);
    event DebtAdjusted(address indexed user, uint256 newDebt, string reason);
    event MinDebtUpdated(uint256 oldMinDebt, uint256 newMinDebt);
    
    // Interest routing events
    event InterestRoutedToSuppliers(uint256 supplierAmount, uint256 reserveAmount);
    event InterestRateModelUpdated(address indexed oldModel, address indexed newModel);
    event SMUSDUpdated(address indexed oldSMUSD, address indexed newSMUSD);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event GlobalInterestAccrued(uint256 interest, uint256 newTotalBorrows, uint256 utilizationBps);
    event ReservesWithdrawn(address indexed to, uint256 amount);
    event InterestRoutingFailed(uint256 supplierAmount, bytes reason);
    event ReservesMintFailed(address indexed to, uint256 amount);

    constructor(
        address _vault,
        address _oracle,
        address _musd,
        uint256 _interestRateBps,
        uint256 _minDebt
    ) {
        if (_vault == address(0)) revert InvalidVault();
        if (_oracle == address(0)) revert InvalidOracle();
        if (_musd == address(0)) revert InvalidMusd();

        vault = ICollateralVault(_vault);
        oracle = IPriceOracle(_oracle);
        musd = IMUSDMint(_musd);
        interestRateBps = _interestRateBps;
        minDebt = _minDebt;
        lastGlobalAccrualTime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BORROW_ADMIN_ROLE, msg.sender);
    }

    // ============================================================
    //                  INTEREST MODEL SETTERS
    // ============================================================

    /// @notice Set the interest rate model (enables dynamic rates)
    /// @dev SOL-H-01 FIX: Changed from BORROW_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setInterestRateModel(address _model) external onlyRole(TIMELOCK_ROLE) {
        if (_model == address(0)) revert ZeroAddress();
        address old = address(interestRateModel);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,old)}
        interestRateModel = IInterestRateModel(_model);
        emit InterestRateModelUpdated(old, _model);
    }

    /// @notice Set the SMUSD vault for interest routing
    /// @dev SOL-H-01 FIX: Changed from BORROW_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setSMUSD(address _smusd) external onlyRole(TIMELOCK_ROLE) {
        if (_smusd == address(0)) revert ZeroAddress();
        address old = address(smusd);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,old)}
        smusd = ISMUSD(_smusd);
        emit SMUSDUpdated(old, _smusd);
    }

    /// @notice Set the Treasury for supply calculation
    /// @dev SOL-H-01 FIX: Changed from BORROW_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setTreasury(address _treasury) external onlyRole(TIMELOCK_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        address old = address(treasury);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,old)}
        treasury = ITreasury(_treasury);
        emit TreasuryUpdated(old, _treasury);
    }

    // ============================================================
    //                  BORROW / REPAY
    // ============================================================

    /// @notice Borrow mUSD against deposited collateral
    /// @param amount Amount of mUSD to borrow (18 decimals)
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        // Accrue interest first
        _accrueInterest(msg.sender);

        DebtPosition storage pos = positions[msg.sender];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010004,0)}
        uint256 newDebt = pos.principal + pos.accruedInterest + amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,newDebt)}
        if (newDebt < minDebt) revert BelowMinDebt();

        pos.principal += amount;uint256 certora_local56 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000038,certora_local56)}
        totalBorrows += amount; // Track global borrows

        // _healthFactor uses liquidation threshold, which allows borrowing at the liquidation edge
        uint256 capacity = _borrowCapacity(msg.sender);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,capacity)}
        uint256 newTotalDebt = totalDebt(msg.sender);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,newTotalDebt)}
        if (capacity < newTotalDebt) revert ExceedsBorrowCapacity();

        // Mint mUSD to borrower
        musd.mint(msg.sender, amount);

        emit Borrowed(msg.sender, amount, totalDebt(msg.sender));
    }

    /// @notice Borrow mUSD on behalf of a user (for LeverageVault integration)
    /// @param user The user to borrow for
    /// @param amount Amount of mUSD to borrow (18 decimals)
    function borrowFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (user == address(0)) revert InvalidUser();

        // Accrue interest first
        _accrueInterest(user);

        DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010008,0)}
        uint256 newDebt = pos.principal + pos.accruedInterest + amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000009,newDebt)}
        if (newDebt < minDebt) revert BelowMinDebt();

        pos.principal += amount;uint256 certora_local57 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000039,certora_local57)}
        totalBorrows += amount; // Track global borrows

        uint256 capacity = _borrowCapacity(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000a,capacity)}
        uint256 newTotalDebt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000b,newTotalDebt)}
        if (capacity < newTotalDebt) revert ExceedsBorrowCapacity();

        // Mint mUSD to the LeverageVault (msg.sender) for swapping
        musd.mint(msg.sender, amount);

        emit Borrowed(user, amount, totalDebt(user));
    }

    /// @notice Repay mUSD debt
    /// @param amount Amount of mUSD to repay (18 decimals)
    function repay(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        _accrueInterest(msg.sender);

        DebtPosition storage pos = positions[msg.sender];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001000c,0)}
        uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000d,total)}
        if (total == 0) revert NoDebt();

        // Cap repayment at total debt
        uint256 repayAmount = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000e,repayAmount)}

        // Auto-close dust positions. If remaining debt would be
        // below minDebt, force full repayment to prevent uneconomical dust.
        uint256 remaining = total - repayAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000000f,remaining)}
        if (remaining > 0 && remaining < minDebt) {
            repayAmount = total;
            remaining = 0;
        } else if (remaining > 0) {
            if (remaining < minDebt) revert RemainingBelowMinDebt();
        }

        // Pay interest first, then principal
        if (repayAmount <= pos.accruedInterest) {
            pos.accruedInterest -= repayAmount;
        } else {
            uint256 principalPayment = repayAmount - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003c,principalPayment)}
            pos.accruedInterest = 0;uint256 certora_local73 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000049,certora_local73)}
            pos.principal -= principalPayment;uint256 certora_local74 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004a,certora_local74)}
        }

        // Previously only principal was subtracted, but _accrueGlobalInterest() adds
        // interest to totalBorrows, so repayment must subtract the full amount to
        // prevent totalBorrows from growing unboundedly.
        if (repayAmount > 0 && totalBorrows >= repayAmount) {
            totalBorrows -= repayAmount;
        } else if (repayAmount > 0) {
            totalBorrows = 0; // Safety: prevent underflow if rounding drift occurs
        }

        // Burn the repaid mUSD
        musd.burn(msg.sender, repayAmount);

        emit Repaid(msg.sender, repayAmount, totalDebt(msg.sender));
    }

    /// @notice Repay mUSD debt on behalf of a user (for LeverageVault integration)
    /// @param user The user whose debt to repay
    /// @param amount Amount of mUSD to repay (18 decimals)
    function repayFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (user == address(0)) revert InvalidUser();

        _accrueInterest(user);

        DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010010,0)}
        uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000011,total)}
        if (total == 0) revert NoDebt();

        // Cap repayment at total debt
        uint256 repayAmount = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000012,repayAmount)}

        // Auto-close dust positions in repayFor (same as repay)
        uint256 remaining = total - repayAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000013,remaining)}
        if (remaining > 0 && remaining < minDebt) {
            repayAmount = total;
            remaining = 0;
        } else if (remaining > 0) {
            if (remaining < minDebt) revert RemainingBelowMinDebt();
        }

        // Pay interest first, then principal
        if (repayAmount <= pos.accruedInterest) {
            pos.accruedInterest -= repayAmount;
        } else {
            uint256 principalPayment = repayAmount - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003d,principalPayment)}
            pos.accruedInterest = 0;uint256 certora_local75 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004b,certora_local75)}
            pos.principal -= principalPayment;uint256 certora_local76 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004c,certora_local76)}
        }

        if (repayAmount > 0 && totalBorrows >= repayAmount) {
            totalBorrows -= repayAmount;
        } else if (repayAmount > 0) {
            totalBorrows = 0;
        }

        // Burn the repaid mUSD from the caller (LeverageVault)
        musd.burn(msg.sender, repayAmount);

        emit Repaid(user, repayAmount, totalDebt(user));
    }

    /// @notice Withdraw collateral (only if position stays healthy)
    /// @param token The collateral token
    /// @param amount Amount to withdraw
    function withdrawCollateral(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        _accrueInterest(msg.sender);

        // The vault.withdraw call below transfers tokens, so we must verify first.
        if (totalDebt(msg.sender) > 0) {
            // Verify the user has enough deposit
            uint256 currentDeposit = vault.deposits(msg.sender, token);
            if (currentDeposit < amount) revert InsufficientDeposit();

            // Compute post-withdrawal health by subtracting the withdrawn amount's value
            (bool enabled, , uint256 liqThreshold, ) = vault.getConfig(token);
            // If admin disables a token, users with debt must still be able to withdraw
            // as long as the token was properly configured (liqThreshold > 0).
            // Blocking withdrawal traps collateral permanently for indebted users.
            if (!enabled && liqThreshold == 0) revert TokenNotSupported();
            uint256 withdrawnValue = oracle.getValueUsd(token, amount);
            uint256 weightedReduction = (withdrawnValue * liqThreshold) / 10000;

            uint256 currentWeighted = _weightedCollateralValue(msg.sender);
            uint256 postWeighted = currentWeighted > weightedReduction
                ? currentWeighted - weightedReduction
                : 0;

            uint256 debt = totalDebt(msg.sender);
            uint256 postHf = debt > 0 ? (postWeighted * 10000) / debt : type(uint256).max;
            if (postHf < 10000) revert WithdrawalWouldLiquidate();
        }

        // Now perform the transfer (Interaction)
        vault.withdraw(token, amount, msg.sender);

        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    // ============================================================
    //                  INTEREST ACCRUAL
    // ============================================================

    /// @notice Get total supply for utilization calculation
    /// @dev Uses Treasury.totalValue() if available, otherwise returns totalBorrows * 2 as fallback
    ///      is in mUSD (18 decimals). Must scale by 1e12 for correct utilization.
    function _getTotalSupply() internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000000, 1037618708480) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00000004, 0) }
        if (address(treasury) != address(0)) {
            try treasury.totalValue() returns (uint256 value) {
                return value * 1e12;
            } catch {
                // Fallback: assume 50% utilization
                return totalBorrows * 2;
            }
        }
        // No treasury set: assume 50% utilization
        return totalBorrows > 0 ? totalBorrows * 2 : 1e18;
    }

    /// @notice Get current borrow rate (dynamic or fixed fallback)
    function _getCurrentBorrowRateBps() internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010000, 1037618708481) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00010004, 0) }
        if (address(interestRateModel) != address(0)) {
            return interestRateModel.getBorrowRateAnnual(totalBorrows, _getTotalSupply());
        }
        return interestRateBps; // Fallback to fixed rate
    }

    /// @notice Accrue global interest and route to suppliers
    /// @dev Called before any borrow/repay to update global state
    function _accrueGlobalInterest() internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030000, 1037618708483) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00030004, 0) }
        uint256 elapsed = block.timestamp - lastGlobalAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000014,elapsed)}
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0 || totalBorrows == 0) {
            lastGlobalAccrualTime = block.timestamp;
            return;
        }

        uint256 totalSupply = _getTotalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000015,totalSupply)}
        uint256 interest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000016,interest)}

        if (address(interestRateModel) != address(0)) {
            // Use dynamic interest rate model
            interest = interestRateModel.calculateInterest(
                totalBorrows,
                totalBorrows,
                totalSupply,
                elapsed
            );
        } else {
            // Fallback to fixed rate
            interest = (totalBorrows * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004d,interest)}
        }

        uint256 maxInterestPerAccrual = totalBorrows / 10;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000017,maxInterestPerAccrual)}
        if (interest > maxInterestPerAccrual) {
            interest = maxInterestPerAccrual;
        }

        if (interest > 0) {
            // Split interest between suppliers and protocol reserves
            uint256 supplierAmount;
            uint256 reserveAmount;
            
            if (address(interestRateModel) != address(0)) {
                (supplierAmount, reserveAmount) = interestRateModel.splitInterest(interest);
            } else {
                // Default 10% to reserves if no model
                reserveAmount = interest / 10;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000055,reserveAmount)}
                supplierAmount = interest - reserveAmount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000056,supplierAmount)}
            }

            // Add reserves to protocol
            protocolReserves += reserveAmount;

            // Route supplier portion to SMUSD. Buffer unrouted interest
            // so totalBorrows only increases when routing succeeds, preventing phantom debt.
            bool routingSucceeded = false;
            if (supplierAmount > 0 && address(smusd) != address(0)) {
                uint256 toRoute = supplierAmount + pendingInterest;
                try musd.mint(address(this), toRoute) {
                    // Use forceApprove instead of raw approve
                    IERC20(address(musd)).forceApprove(address(smusd), toRoute);
                    try smusd.receiveInterest(toRoute) {
                        totalInterestPaidToSuppliers += toRoute;
                        pendingInterest = 0;
                        routingSucceeded = true;
                        emit InterestRoutedToSuppliers(toRoute, reserveAmount);
                    } catch (bytes memory reason) {
                        // SMUSD rejected — burn the minted tokens to keep supply clean
                        musd.burn(address(this), toRoute);
                        pendingInterest += supplierAmount;
                        emit InterestRoutingFailed(toRoute, reason);
                    }
                } catch (bytes memory reason) {
                    // Supply cap hit — buffer for retry
                    pendingInterest += supplierAmount;
                    emit InterestRoutingFailed(supplierAmount, reason);
                }
            } else {
                routingSucceeded = true;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000057,routingSucceeded)} // No routing needed
            }

            // Only increase totalBorrows when interest is successfully routed
            // This prevents phantom debt from inflating utilization rates
            if (routingSucceeded) {
                totalBorrows += interest;
            }
            
            uint256 utilization = address(interestRateModel) != address(0)
                ? interestRateModel.utilizationRate(totalBorrows, totalSupply)
                : (totalBorrows * BPS) / totalSupply;
            
            emit GlobalInterestAccrued(interest, totalBorrows, utilization);
        }

        lastGlobalAccrualTime = block.timestamp;
    }

    /// @notice Accrue interest on a user's debt
    /// @dev Uses dynamic rate from InterestRateModel if set, otherwise fixed rate.
    ///      Uses SIMPLE INTEREST model (not compound) for gas efficiency.
    ///      Simple interest is intentional (documented design decision).
    function _accrueInterest(address user) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040000, 1037618708484) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00040005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00046000, user) }
        // First accrue global interest (for routing to suppliers)
        _accrueGlobalInterest();

        DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010018,0)}
        if (pos.principal == 0 && pos.accruedInterest == 0) {
            pos.lastAccrualTime = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000019,elapsed)}
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return;

        // to prevent totalBorrows divergence. User's share = (user_principal / totalBorrows) * global_interest
        // This ensures Σ user_interest ≈ global_interest by construction.
        uint256 interest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001a,interest)}
        uint256 userTotal = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001b,userTotal)}
        if (totalBorrows > 0 && userTotal > 0) {
            if (address(interestRateModel) != address(0)) {
                uint256 globalInterest = interestRateModel.calculateInterest(
                    totalBorrows,
                    totalBorrows,
                    _getTotalSupply(),
                    elapsed
                );
                // User's proportional share of global interest
                interest = (globalInterest * userTotal) / totalBorrows;
            } else {
                // Fallback: use user's total debt (principal + accrued) as base
                interest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000058,interest)}
            }
        }

        pos.accruedInterest += interest;uint256 certora_local58 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003a,certora_local58)}
        pos.lastAccrualTime = block.timestamp;uint256 certora_local59 = pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003b,certora_local59)}

        if (interest > 0) {
            emit InterestAccrued(user, interest, pos.principal + pos.accruedInterest);
        }
    }

    // ============================================================
    //                  HEALTH FACTOR
    // ============================================================

    /// @notice Calculate health factor for a user
    /// @dev healthFactor = (collateralValue * liquidationThreshold) / debt
    ///      Returns in basis points (10000 = 1.0). Below 10000 = liquidatable.
    function _healthFactor(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020000, 1037618708482) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00020005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00026000, user) }
        uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001c,debt)}
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValue(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001d,weightedCollateral)}
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @notice Get the collateral value weighted by liquidation threshold
    ///      When admin disables a token, borrowers still have deposits. Excluding
    ///      disabled tokens would instantly drop their health factor, making them
    ///      liquidatable through no fault of their own. The collateral config
    ///      (liqThreshold) persists even after disableCollateral().
    function _weightedCollateralValue(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050000, 1037618708485) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00050005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00056000, user) }
        address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001e,0)}
        uint256 totalWeighted = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001f,totalWeighted)}

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000003e,deposited)}
            if (deposited == 0) continue;

            (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001003f,0)}
            // must retain their collateral value for health factor calculations.
            // Only liqThreshold == 0 means truly unconfigured (never added).
            if (liqThreshold == 0) continue;

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000040,valueUsd)}
            totalWeighted += (valueUsd * liqThreshold) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004e,totalWeighted)}
        }

        return totalWeighted;
    }

    /// @dev Mirrors _weightedCollateralValue but uses getValueUsdUnsafe so liquidation
    ///      health checks work during extreme price moves when circuit breaker trips.
    function _weightedCollateralValueUnsafe(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060000, 1037618708486) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00060005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00066000, user) }
        address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010020,0)}
        uint256 totalWeighted = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000021,totalWeighted)}

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000041,deposited)}
            if (deposited == 0) continue;

            (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010042,0)}
            if (liqThreshold == 0) continue;

            uint256 valueUsd = oracle.getValueUsdUnsafe(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000043,valueUsd)}
            totalWeighted += (valueUsd * liqThreshold) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000004f,totalWeighted)}
        }

        return totalWeighted;
    }

    /// @notice Get the maximum borrowable amount for a user (based on collateral factor, not liq threshold)
    /// @dev M-01: Intentionally skips disabled tokens — users must NOT open new debt against
    ///      disabled collateral. This is asymmetric with health-check/liquidation (which still
    ///      credits disabled collateral via liqThreshold > 0) to avoid trapping users. The
    ///      asymmetry is by design: disabled tokens protect against new risk but don't orphan
    ///      existing positions.
    function _borrowCapacity(address user) internal view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070000, 1037618708487) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00070005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00076000, user) }
        address[] memory tokens = vault.getSupportedTokens();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010022,0)}
        uint256 totalCapacity = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000023,totalCapacity)}

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000044,deposited)}
            if (deposited == 0) continue;

            (bool enabled, uint256 colFactor, , ) = vault.getConfig(tokens[i]);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010045,0)}
            if (!enabled) continue; // Intentional: no new borrows against disabled collateral

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000046,valueUsd)}
            totalCapacity += (valueUsd * colFactor) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000050,totalCapacity)}
        }

        return totalCapacity;
    }

    // ============================================================
    //                  LIQUIDATION INTERFACE
    // ============================================================

    /// @notice Called by LiquidationEngine to reduce a user's debt after seizure
    function reduceDebt(address user, uint256 amount) external nonReentrant onlyRole(LIQUIDATION_ROLE) {
        _accrueInterest(user);

        DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010024,0)}
        uint256 total = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000025,total)}
        uint256 reduction = amount > total ? total : amount;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000026,reduction)}

        if (reduction <= pos.accruedInterest) {
            pos.accruedInterest -= reduction;
        } else {
            uint256 remaining = reduction - pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000047,remaining)}
            pos.accruedInterest = 0;uint256 certora_local81 = pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000051,certora_local81)}
            pos.principal -= remaining;uint256 certora_local82 = pos.principal;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000052,certora_local82)}
        }

        // Same class as C-05: _accrueGlobalInterest adds interest to totalBorrows,
        // so liquidation must subtract the full amount, not just principal.
        if (reduction > 0 && totalBorrows >= reduction) {
            totalBorrows -= reduction;
        } else if (reduction > 0) {
            totalBorrows = 0; // Safety: prevent underflow from rounding drift
        }

        emit DebtAdjusted(user, totalDebt(user), "LIQUIDATION");
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get total debt (principal + accrued interest) for a user
    ///      matching _accrueInterest() execution. Previously used only pos.principal, causing
    ///      the view to understate pending interest vs what _accrueInterest actually charges.
    function totalDebt(address user) public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000a0000, 1037618708490) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000a0005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff000a6000, user) }
        DebtPosition storage pos = positions[user];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010027,0)}
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000028,elapsed)}
        uint256 userTotal = pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000029,userTotal)}
        
        uint256 pendingInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002a,pendingInterest)}
        if (address(interestRateModel) != address(0)) {
            uint256 globalInterest = interestRateModel.calculateInterest(
                totalBorrows,
                totalBorrows,
                _getTotalSupply(),
                elapsed
            );
            // User's proportional share of global interest (same formula as _accrueInterest)
            pendingInterest = totalBorrows > 0 ? (globalInterest * userTotal) / totalBorrows : 0;
        } else {
            pendingInterest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000053,pendingInterest)}
        }
        return userTotal + pendingInterest;
    }

    /// @notice Get health factor for a user (public view)
    /// @return Health factor in basis points (10000 = 1.0)
    function healthFactor(address user) external view returns (uint256) {
        uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002b,debt)}
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValue(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002c,weightedCollateral)}
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @dev Used by LiquidationEngine so liquidations proceed during >20% price crashes.
    ///      Without this, healthFactor() reverts via getValueUsd() circuit breaker,
    ///      blocking all liquidations exactly when they are most needed.
    /// @return Health factor in basis points (10000 = 1.0)
    function healthFactorUnsafe(address user) external view returns (uint256) {
        uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002d,debt)}
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValueUnsafe(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002e,weightedCollateral)}
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @notice Get maximum additional borrow amount for a user
    function maxBorrow(address user) external view returns (uint256) {
        uint256 capacity = _borrowCapacity(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000002f,capacity)}
        uint256 debt = totalDebt(user);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000030,debt)}
        return capacity > debt ? capacity - debt : 0;
    }

    /// @notice Get total borrow capacity for a user (public wrapper)
    function borrowCapacity(address user) external view returns (uint256) {
        return _borrowCapacity(user);
    }

    // ============================================================
    //                  INTEREST RATE VIEW FUNCTIONS
    // ============================================================

    /// @notice Get current utilization rate in BPS
    function getUtilizationRate() external view returns (uint256) {
        if (address(interestRateModel) != address(0)) {
            return interestRateModel.utilizationRate(totalBorrows, _getTotalSupply());
        }
        uint256 supply = _getTotalSupply();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000031,supply)}
        if (supply == 0) return 0;
        return (totalBorrows * BPS) / supply;
    }

    /// @notice Get current annual borrow rate in BPS
    function getCurrentBorrowRate() external view returns (uint256) {
        return _getCurrentBorrowRateBps();
    }

    /// @notice Get current annual supply rate in BPS
    function getCurrentSupplyRate() external view returns (uint256) {
        if (address(interestRateModel) != address(0)) {
            return interestRateModel.getSupplyRateAnnual(totalBorrows, _getTotalSupply());
        }
        // Fallback: 90% of borrow rate goes to suppliers
        return (interestRateBps * 9) / 10;
    }

    /// @notice Get total supply used for utilization calculation
    function getTotalSupply() external view returns (uint256) {
        return _getTotalSupply();
    }

    /// @notice Withdraw accumulated protocol reserves
    /// Instead of minting unbacked mUSD (which dilutes the peg), we try to mint
    /// within the supply cap. If the cap is hit, the withdrawal fails gracefully.
    /// Admin should coordinate with supply cap management before withdrawing.
    function withdrawReserves(address to, uint256 amount) external onlyRole(TIMELOCK_ROLE) {
        if (amount > protocolReserves) revert ExceedsReserves();
        if (to == address(0)) revert ZeroAddress();
        
        protocolReserves -= amount;
        
        // so admin knows to increase cap or reduce reserves first
        try musd.mint(to, amount) {
            emit ReservesWithdrawn(to, amount);
        } catch {
            // Restore reserves and emit failure
            protocolReserves += amount;
            emit ReservesMintFailed(to, amount);
            revert SupplyCapReached();
        }
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    /// @notice Update the global interest rate
    /// Existing positions accrue at the OLD rate until their next interaction triggers _accrueInterest().
    /// This is by-design (same as Aave/Compound variable rates) and avoids O(n) global accrual.
    function setInterestRate(uint256 _rateBps) external onlyRole(TIMELOCK_ROLE) {
        if (_rateBps > 5000) revert RateTooHigh(); // Max 50% APR
        uint256 old = interestRateBps;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000032,old)}
        interestRateBps = _rateBps;
        emit InterestRateUpdated(old, _rateBps);
    }

    function setMinDebt(uint256 _minDebt) external onlyRole(TIMELOCK_ROLE) {
        if (_minDebt == 0) revert MinDebtZero();
        if (_minDebt > 1e24) revert MinDebtTooHigh();
        emit MinDebtUpdated(minDebt, _minDebt);
        minDebt = _minDebt;
    }

    // ============================================================
    //                  EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause borrowing and repayments
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause borrowing and repayments
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @dev Allows LiquidationEngine and keepers to force interest accrual
    ///      before health factor checks, ensuring debt is up-to-date.
    ///      Without this, a borrower could avoid liquidation by never
    ///      triggering _accrueInterest() (no borrow/repay interactions).
    /// @param user The user whose interest to accrue
    function accrueInterest(address user) external nonReentrant {
        _accrueInterest(user);
    }

    // ============================================================
    //          DRAIN PENDING INTEREST
    // ============================================================

    event PendingInterestDrained(uint256 amount, uint256 adjustedTotalBorrows);

    /// @notice Drain buffered pendingInterest to prevent routing livelock.
    /// @dev    When SMUSD's MAX_YIELD_BPS cap causes repeated receiveInterest()
    ///         failures, pendingInterest grows monotonically. Each retry includes
    ///         the accumulated buffer, making it increasingly likely to exceed the cap.
    ///         This function zeros pendingInterest and adjusts totalBorrows to prevent
    ///         phantom debt from inflating utilization rates.
    ///         Only callable by TIMELOCK_ROLE (48h MintedTimelockController delay).
    function drainPendingInterest() external onlyRole(TIMELOCK_ROLE) nonReentrant {
        uint256 amount = pendingInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000033,amount)}
        if (amount == 0) revert NoPendingInterest();

        pendingInterest = 0;

        // Adjust totalBorrows since this interest was never successfully routed,
        // meaning totalBorrows was never incremented for it (see _accrueGlobalInterest).
        // The drain simply acknowledges the lost interest and resets the buffer.
        emit PendingInterestDrained(amount, totalBorrows);
    }

    // ============================================================
    //          RECONCILE totalBorrows WITH USER DEBT
    // ============================================================

    event TotalBorrowsReconciled(uint256 oldTotalBorrows, uint256 newTotalBorrows, int256 drift);
    event DriftThresholdExceeded(uint256 oldTotalBorrows, uint256 newTotalBorrows, int256 drift, uint256 thresholdBps);

    /// @notice Maximum allowed drift as basis points of totalBorrows.
    ///         Reverts if drift exceeds this to prevent silent large mismatches.
    uint256 public constant MAX_DRIFT_BPS = 500; // 5%

    /// @notice Reconcile totalBorrows with the actual sum of all user debts
    /// @dev    Accounting drift can accumulate from rounding in
    ///         interest accrual, repayment, and liquidation. This function
    ///         computes the true aggregate debt by iterating tracked borrowers
    ///         and snaps totalBorrows to that value.
    ///         Callable by BORROW_ADMIN_ROLE; should be run periodically (e.g. weekly).
    ///         The keeper bot (bot/src/reconciliation-keeper.ts) automates this.
    /// @param  borrowers Array of all addresses that have (or had) debt positions.
    ///         Off-chain indexer supplies this list from Borrowed / Repaid events.
    function reconcileTotalBorrows(address[] calldata borrowers) external onlyRole(BORROW_ADMIN_ROLE) nonReentrant {
        _accrueGlobalInterest();

        uint256 sumDebt = 0;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000034,sumDebt)}
        for (uint256 i = 0; i < borrowers.length; i++) {
            DebtPosition storage pos = positions[borrowers[i]];assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010048,0)}
            sumDebt += pos.principal + pos.accruedInterest;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000054,sumDebt)}
        }

        uint256 oldTotal = totalBorrows;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000035,oldTotal)}
        int256 drift = int256(oldTotal) - int256(sumDebt);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000036,drift)}

        // H-01: Guard against excessively large drift (> MAX_DRIFT_BPS of old total)
        uint256 absDrift = drift >= 0 ? uint256(drift) : uint256(-drift);assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000037,absDrift)}
        if (oldTotal > 0) {
            uint256 driftBps = (absDrift * 10_000) / oldTotal;
            if (driftBps > MAX_DRIFT_BPS) revert DriftExceedsSafetyThreshold();
            if (driftBps > 100) { // > 1% — emit warning event
                emit DriftThresholdExceeded(oldTotal, sumDebt, drift, driftBps);
            }
        }

        totalBorrows = sumDebt;

        emit TotalBorrowsReconciled(oldTotal, sumDebt, drift);
    }
}
