// SPDX-License-Identifier: MIT
// BLE Protocol - Borrow Module V2
// Tracks debt positions with utilization-based dynamic interest rates
// Routes interest payments to SMUSD stakers

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPriceOracle {
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
    // FIX C-01: Unsafe variant bypasses circuit breaker for liquidation health checks
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

    /// @notice FIX SOL-M01: Pre-accrual total borrows snapshot for per-user interest calculation
    /// Prevents denominator inflation that causes systematic undercharging
    uint256 internal totalBorrowsBeforeAccrual;
    
    /// @notice Accumulated protocol reserves (from reserve factor)
    uint256 public protocolReserves;
    
    /// @notice Last time global interest was accrued
    uint256 public lastGlobalAccrualTime;
    
    /// @notice Total interest paid to suppliers (for analytics)
    uint256 public totalInterestPaidToSuppliers;

    /// @notice Interest that accrued as debt but couldn't be minted (supply cap hit)
    /// @dev Tracked separately so totalBorrows stays in sync with actual mUSD supply.
    ///      Cleared when a subsequent mint succeeds or admin calls drainUnroutedInterest().
    uint256 public unroutedInterest;

    // ═══════════════════════════════════════════════════════════════════════
    // FIX C-02: BAD DEBT TRACKING & SOCIALIZATION
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Accumulated bad debt from underwater liquidations (unbacked mUSD)
    /// @dev When a liquidation exhausts all collateral but debt remains, the
    ///      residual debt is written off the user's position and accumulated here.
    ///      This represents mUSD in circulation that is no longer collateral-backed.
    uint256 public badDebt;

    /// @notice Total bad debt ever recorded (for analytics, never decremented)
    uint256 public cumulativeBadDebt;

    /// @notice Total bad debt covered by protocol reserves or external injection
    uint256 public badDebtCovered;

    /// @notice Emitted when bad debt is recorded from an underwater liquidation
    event BadDebtRecorded(address indexed user, uint256 amount, uint256 totalBadDebt);

    /// @notice Emitted when bad debt is covered (burned from reserves or injection)
    event BadDebtCovered(uint256 amount, uint256 remainingBadDebt, string source);

    /// @notice Emitted when bad debt is socialized across the protocol
    event BadDebtSocialized(uint256 amount, uint256 totalBorrowsBefore, uint256 totalBorrowsAfter);

    // ═══════════════════════════════════════════════════════════════════════
    // FIX H-01: ADMIN TIMELOCK (48h propose → execute)
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant ADMIN_DELAY = 48 hours;

    // Pending contract-reference changes
    address public pendingInterestRateModel;
    uint256 public pendingInterestRateModelTime;
    address public pendingSMUSD;
    uint256 public pendingSMUSDTime;
    address public pendingTreasury;
    uint256 public pendingTreasuryTime;

    // Pending parameter changes
    uint256 public pendingInterestRate;
    uint256 public pendingInterestRateTime;
    bool    public pendingInterestRateSet; // distinguish 0-value from unset
    uint256 public pendingMinDebt;
    uint256 public pendingMinDebtTime;

    event InterestRateModelChangeRequested(address indexed model, uint256 readyAt);
    event InterestRateModelChangeCancelled(address indexed model);
    event SMUSDChangeRequested(address indexed smusd, uint256 readyAt);
    event SMUSDChangeCancelled(address indexed smusd);
    event TreasuryChangeRequested(address indexed treasury, uint256 readyAt);
    event TreasuryChangeCancelled(address indexed treasury);
    event InterestRateChangeRequested(uint256 rateBps, uint256 readyAt);
    event InterestRateChangeCancelled(uint256 rateBps);
    event MinDebtChangeRequested(uint256 minDebt, uint256 readyAt);
    event MinDebtChangeCancelled(uint256 minDebt);
    
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
    /// @dev FIX P0-H1: Emitted when interest routing to SMUSD fails (e.g. supply cap hit)
    event InterestRoutingFailed(uint256 supplierAmount, bytes reason);
    /// @dev FIX P1-H3: Emitted when reserve minting fails
    event ReservesMintFailed(address indexed to, uint256 amount);

    constructor(
        address _vault,
        address _oracle,
        address _musd,
        uint256 _interestRateBps,
        uint256 _minDebt
    ) {
        require(_vault != address(0), "INVALID_VAULT");
        require(_oracle != address(0), "INVALID_ORACLE");
        require(_musd != address(0), "INVALID_MUSD");

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

    // ── FIX H-01: Timelocked contract-reference setters ──────────────────

    /// @notice Propose new interest rate model (48h delay)
    function requestInterestRateModel(address _model) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_model != address(0), "ZERO_ADDRESS");
        pendingInterestRateModel = _model;
        pendingInterestRateModelTime = block.timestamp;
        emit InterestRateModelChangeRequested(_model, block.timestamp + ADMIN_DELAY);
    }
    function cancelInterestRateModel() external onlyRole(BORROW_ADMIN_ROLE) {
        address cancelled = pendingInterestRateModel;
        pendingInterestRateModel = address(0);
        pendingInterestRateModelTime = 0;
        emit InterestRateModelChangeCancelled(cancelled);
    }
    function executeInterestRateModel() external onlyRole(BORROW_ADMIN_ROLE) {
        require(pendingInterestRateModel != address(0), "NO_PENDING");
        require(block.timestamp >= pendingInterestRateModelTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        address old = address(interestRateModel);
        interestRateModel = IInterestRateModel(pendingInterestRateModel);
        pendingInterestRateModel = address(0);
        pendingInterestRateModelTime = 0;
        emit InterestRateModelUpdated(old, address(interestRateModel));
    }

    /// @notice Propose new SMUSD vault (48h delay)
    function requestSMUSD(address _smusd) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_smusd != address(0), "ZERO_ADDRESS");
        pendingSMUSD = _smusd;
        pendingSMUSDTime = block.timestamp;
        emit SMUSDChangeRequested(_smusd, block.timestamp + ADMIN_DELAY);
    }
    function cancelSMUSD() external onlyRole(BORROW_ADMIN_ROLE) {
        address cancelled = pendingSMUSD;
        pendingSMUSD = address(0);
        pendingSMUSDTime = 0;
        emit SMUSDChangeCancelled(cancelled);
    }
    function executeSMUSD() external onlyRole(BORROW_ADMIN_ROLE) {
        require(pendingSMUSD != address(0), "NO_PENDING");
        require(block.timestamp >= pendingSMUSDTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        address old = address(smusd);
        smusd = ISMUSD(pendingSMUSD);
        pendingSMUSD = address(0);
        pendingSMUSDTime = 0;
        emit SMUSDUpdated(old, address(smusd));
    }

    /// @notice Propose new Treasury (48h delay)
    function requestTreasury(address _treasury) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
        pendingTreasury = _treasury;
        pendingTreasuryTime = block.timestamp;
        emit TreasuryChangeRequested(_treasury, block.timestamp + ADMIN_DELAY);
    }
    function cancelTreasury() external onlyRole(BORROW_ADMIN_ROLE) {
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryTime = 0;
        emit TreasuryChangeCancelled(cancelled);
    }
    function executeTreasury() external onlyRole(BORROW_ADMIN_ROLE) {
        require(pendingTreasury != address(0), "NO_PENDING");
        require(block.timestamp >= pendingTreasuryTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        address old = address(treasury);
        treasury = ITreasury(pendingTreasury);
        pendingTreasury = address(0);
        pendingTreasuryTime = 0;
        emit TreasuryUpdated(old, address(treasury));
    }

    /// @notice FIX SOL-H01: Drain unrouted interest to correct totalBorrows divergence.
    /// When supply cap exhaustion prevents minting mUSD for supplier interest,
    /// `unroutedInterest` accumulates while `totalBorrows` keeps growing.
    /// This function reconciles by subtracting the unrouted amount from totalBorrows.
    event UnroutedInterestDrained(uint256 amount, uint256 totalBorrowsBefore, uint256 totalBorrowsAfter);

    function drainUnroutedInterest() external onlyRole(BORROW_ADMIN_ROLE) {
        uint256 amount = unroutedInterest;
        require(amount > 0, "NOTHING_TO_DRAIN");
        uint256 totalBorrowsBefore = totalBorrows;
        unroutedInterest = 0;
        if (totalBorrows >= amount) {
            totalBorrows -= amount;
        } else {
            totalBorrows = 0; // Safety: prevent underflow from rounding drift
        }
        emit UnroutedInterestDrained(amount, totalBorrowsBefore, totalBorrows);
    }

    // ============================================================
    //                  BORROW / REPAY
    // ============================================================

    /// @notice Borrow mUSD against deposited collateral
    /// @param amount Amount of mUSD to borrow (18 decimals)
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "INVALID_AMOUNT");

        // Accrue interest first
        _accrueInterest(msg.sender);

        DebtPosition storage pos = positions[msg.sender];
        uint256 newDebt = pos.principal + pos.accruedInterest + amount;
        require(newDebt >= minDebt, "BELOW_MIN_DEBT");

        pos.principal += amount;
        totalBorrows += amount; // Track global borrows

        // FIX H-20: Use borrow capacity (collateral factor) not liquidation threshold
        // _healthFactor uses liquidation threshold, which allows borrowing at the liquidation edge
        uint256 capacity = _borrowCapacity(msg.sender);
        uint256 newTotalDebt = totalDebt(msg.sender);
        require(capacity >= newTotalDebt, "EXCEEDS_BORROW_CAPACITY");

        // Mint mUSD to borrower
        musd.mint(msg.sender, amount);

        emit Borrowed(msg.sender, amount, totalDebt(msg.sender));
    }

    /// @notice Borrow mUSD on behalf of a user (for LeverageVault integration)
    /// @param user The user to borrow for
    /// @param amount Amount of mUSD to borrow (18 decimals)
    function borrowFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
        require(amount > 0, "INVALID_AMOUNT");
        require(user != address(0), "INVALID_USER");

        // Accrue interest first
        _accrueInterest(user);

        DebtPosition storage pos = positions[user];
        uint256 newDebt = pos.principal + pos.accruedInterest + amount;
        require(newDebt >= minDebt, "BELOW_MIN_DEBT");

        pos.principal += amount;
        totalBorrows += amount; // Track global borrows

        uint256 capacity = _borrowCapacity(user);
        uint256 newTotalDebt = totalDebt(user);
        require(capacity >= newTotalDebt, "EXCEEDS_BORROW_CAPACITY");

        // Mint mUSD to the LeverageVault (msg.sender) for swapping
        musd.mint(msg.sender, amount);

        emit Borrowed(user, amount, totalDebt(user));
    }

    /// @notice Repay mUSD debt
    /// @param amount Amount of mUSD to repay (18 decimals)
    /// FIX CR-05: Removed whenNotPaused — users must always be able to repay debt,
    /// even during a pause, to avoid unfair liquidation from accruing interest.
    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");

        _accrueInterest(msg.sender);

        DebtPosition storage pos = positions[msg.sender];
        uint256 total = pos.principal + pos.accruedInterest;
        require(total > 0, "NO_DEBT");

        // Cap repayment at total debt
        uint256 repayAmount = amount > total ? total : amount;

        // FIX S-M03: Prevent dust positions after partial repayment
        uint256 remaining = total - repayAmount;
        if (remaining > 0) {
            require(remaining >= minDebt, "REMAINING_BELOW_MIN_DEBT");
        }

        // Pay interest first, then principal
        if (repayAmount <= pos.accruedInterest) {
            pos.accruedInterest -= repayAmount;
        } else {
            // FIX S-C02: Renamed to 'principalPayment' to avoid shadowing outer 'remaining'
            uint256 principalPayment = repayAmount - pos.accruedInterest;
            pos.accruedInterest = 0;
            pos.principal -= principalPayment;
        }

        // FIX C-05: Subtract full repayment (principal + interest) from totalBorrows.
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
    /// @dev FIX CRITICAL: Allows LeverageVault to repay user debt when closing positions
    /// @param user The user whose debt to repay
    /// @param amount Amount of mUSD to repay (18 decimals)
    /// FIX CR-05: Removed whenNotPaused — repayment must always be available.
    function repayFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        require(user != address(0), "INVALID_USER");

        _accrueInterest(user);

        DebtPosition storage pos = positions[user];
        uint256 total = pos.principal + pos.accruedInterest;
        require(total > 0, "NO_DEBT");

        // Cap repayment at total debt
        uint256 repayAmount = amount > total ? total : amount;

        // FIX S-M03: Prevent dust positions after partial repayment
        uint256 remaining = total - repayAmount;
        if (remaining > 0) {
            require(remaining >= minDebt, "REMAINING_BELOW_MIN_DEBT");
        }

        // Pay interest first, then principal
        if (repayAmount <= pos.accruedInterest) {
            pos.accruedInterest -= repayAmount;
        } else {
            uint256 principalPayment = repayAmount - pos.accruedInterest;
            pos.accruedInterest = 0;
            pos.principal -= principalPayment;
        }

        // FIX C-05: Subtract full repayment (principal + interest) from totalBorrows.
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
    /// FIX H-05: Checks health BEFORE withdrawal (CEI pattern)
    function withdrawCollateral(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "INVALID_AMOUNT");

        _accrueInterest(msg.sender);

        // FIX H-05: Check health factor BEFORE transfer to follow CEI pattern.
        // The vault.withdraw call below transfers tokens, so we must verify first.
        if (totalDebt(msg.sender) > 0) {
            // Verify the user has enough deposit
            uint256 currentDeposit = vault.deposits(msg.sender, token);
            require(currentDeposit >= amount, "INSUFFICIENT_DEPOSIT");

            // Compute post-withdrawal health by subtracting the withdrawn amount's value
            (bool enabled, , uint256 liqThreshold, ) = vault.getConfig(token);
            // FIX M-01 (Final Audit): Allow withdrawal of disabled-token collateral.
            // If admin disables a token, users with debt must still be able to withdraw
            // as long as the token was properly configured (liqThreshold > 0).
            // Blocking withdrawal traps collateral permanently for indebted users.
            require(enabled || liqThreshold > 0, "TOKEN_NOT_SUPPORTED");
            // FIX BM-M02: Use try/catch to handle circuit breaker gracefully
            // If circuit breaker trips during withdrawal, fall back to unsafe price
            // rather than DoS-ing the withdrawal entirely
            uint256 withdrawnValue;
            try oracle.getValueUsd(token, amount) returns (uint256 val) {
                withdrawnValue = val;
            } catch {
                // Circuit breaker tripped — use unsafe price for withdrawal safety check
                withdrawnValue = oracle.getValueUsdUnsafe(token, amount);
            }
            uint256 weightedReduction = (withdrawnValue * liqThreshold) / 10000;

            uint256 currentWeighted = _weightedCollateralValue(msg.sender);
            uint256 postWeighted = currentWeighted > weightedReduction
                ? currentWeighted - weightedReduction
                : 0;

            uint256 debt = totalDebt(msg.sender);
            uint256 postHf = debt > 0 ? (postWeighted * 10000) / debt : type(uint256).max;
            require(postHf >= 10000, "WITHDRAWAL_WOULD_LIQUIDATE");
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
    /// @dev FIX CRITICAL: Treasury.totalValue() returns USDC (6 decimals) but totalBorrows
    ///      is in mUSD (18 decimals). Must scale by 1e12 for correct utilization.
    function _getTotalSupply() internal view returns (uint256) {
        if (address(treasury) != address(0)) {
            try treasury.totalValue() returns (uint256 value) {
                // FIX: Convert USDC (6 decimals) to mUSD scale (18 decimals)
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
    function _getCurrentBorrowRateBps() internal view returns (uint256) {
        if (address(interestRateModel) != address(0)) {
            return interestRateModel.getBorrowRateAnnual(totalBorrows, _getTotalSupply());
        }
        return interestRateBps; // Fallback to fixed rate
    }

    /// @notice Accrue global interest and route to suppliers
    /// @dev Called before any borrow/repay to update global state
    function _accrueGlobalInterest() internal {
        uint256 elapsed = block.timestamp - lastGlobalAccrualTime;
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0 || totalBorrows == 0) {
            lastGlobalAccrualTime = block.timestamp;
            return;
        }

        uint256 totalSupply = _getTotalSupply();
        uint256 interest;

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
            interest = (totalBorrows * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        }

        // FIX S-M02: Cap interest per accrual to 10% of totalBorrows to prevent runaway minting
        uint256 maxInterestPerAccrual = totalBorrows / 10;
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
                reserveAmount = interest / 10;
                supplierAmount = interest - reserveAmount;
            }

            // Add reserves to protocol
            protocolReserves += reserveAmount;

            // Route supplier portion to SMUSD
            // FIX P0-H1: Wrap in try/catch so supply cap exhaustion doesn't brick
            // repay/liquidation paths. Interest is still tracked in totalBorrows.
            if (supplierAmount > 0 && address(smusd) != address(0)) {
                try musd.mint(address(this), supplierAmount) {
                    // Approve and send to SMUSD
                    IERC20(address(musd)).approve(address(smusd), supplierAmount);
                    try smusd.receiveInterest(supplierAmount) {
                        totalInterestPaidToSuppliers += supplierAmount;
                        emit InterestRoutedToSuppliers(supplierAmount, reserveAmount);
                    } catch (bytes memory reason) {
                        // SMUSD rejected — burn the minted tokens to keep supply clean
                        musd.burn(address(this), supplierAmount);
                        emit InterestRoutingFailed(supplierAmount, reason);
                    }
                } catch (bytes memory reason) {
                    // FIX: Supply cap hit — track as unrouted so totalBorrows stays
                    // in sync with actual mUSD supply.  The debt still exists but
                    // the corresponding mUSD was never minted.
                    unroutedInterest += supplierAmount;
                    emit InterestRoutingFailed(supplierAmount, reason);
                }
            }

            // FIX SOL-M01: Update total borrows to include accrued interest
            // NOTE: totalBorrows is updated AFTER _accrueInterest() reads it for per-user
            // proportional calculation. This is correct: _accrueGlobalInterest() runs first
            // (updating totalBorrows here), then _accrueInterest() uses the new totalBorrows
            // as the denominator. To prevent systematic undercharging, we cache the pre-update
            // value in totalBorrowsBeforeAccrual for the per-user calculation.
            totalBorrowsBeforeAccrual = totalBorrows;
            totalBorrows += interest;
            
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
    ///      H-02: DOCUMENTED DESIGN DECISION - simple interest is intentional.
    function _accrueInterest(address user) internal {
        // First accrue global interest (for routing to suppliers)
        _accrueGlobalInterest();

        DebtPosition storage pos = positions[user];
        if (pos.principal == 0 && pos.accruedInterest == 0) {
            pos.lastAccrualTime = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return;

        // FIX P1-H2: Calculate user interest as their proportional share of global interest
        // to prevent totalBorrows divergence. User's share = (user_principal / totalBorrows) * global_interest
        // This ensures Σ user_interest ≈ global_interest by construction.
        // FIX SOL-M01: Use totalBorrowsBeforeAccrual (cached pre-increment value) to prevent
        // systematic undercharging. Without this, the denominator is inflated by the global
        // interest already added in _accrueGlobalInterest(), causing sum(user_debts) < totalBorrows.
        uint256 interest;
        uint256 userTotal = pos.principal + pos.accruedInterest;
        uint256 denominator = totalBorrowsBeforeAccrual > 0 ? totalBorrowsBeforeAccrual : totalBorrows;
        if (denominator > 0 && userTotal > 0) {
            if (address(interestRateModel) != address(0)) {
                uint256 globalInterest = interestRateModel.calculateInterest(
                    denominator,
                    denominator,
                    _getTotalSupply(),
                    elapsed
                );
                // User's proportional share of global interest
                interest = (globalInterest * userTotal) / denominator;
            } else {
                // Fallback: use user's total debt (principal + accrued) as base
                interest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
            }
        }

        pos.accruedInterest += interest;
        pos.lastAccrualTime = block.timestamp;

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
    function _healthFactor(address user) internal view returns (uint256) {
        uint256 debt = totalDebt(user);
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValue(user);
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @notice Get the collateral value weighted by liquidation threshold
    /// @dev FIX S-C01: Includes disabled collateral in health calculations.
    ///      When admin disables a token, borrowers still have deposits. Excluding
    ///      disabled tokens would instantly drop their health factor, making them
    ///      liquidatable through no fault of their own. The collateral config
    ///      (liqThreshold) persists even after disableCollateral().
    function _weightedCollateralValue(address user) internal view returns (uint256) {
        address[] memory tokens = vault.getSupportedTokens();
        uint256 totalWeighted = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited == 0) continue;

            (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);
            // FIX S-C01: Do NOT skip disabled tokens — borrowers with existing deposits
            // must retain their collateral value for health factor calculations.
            // Only liqThreshold == 0 means truly unconfigured (never added).
            if (liqThreshold == 0) continue;

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);
            totalWeighted += (valueUsd * liqThreshold) / 10000;
        }

        return totalWeighted;
    }

    /// @notice FIX C-01: Collateral value using unsafe oracle (bypasses circuit breaker)
    /// @dev Mirrors _weightedCollateralValue but uses getValueUsdUnsafe so liquidation
    ///      health checks work during extreme price moves when circuit breaker trips.
    /// @dev FIX S-C01: Includes disabled collateral (same rationale as _weightedCollateralValue)
    function _weightedCollateralValueUnsafe(address user) internal view returns (uint256) {
        address[] memory tokens = vault.getSupportedTokens();
        uint256 totalWeighted = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited == 0) continue;

            (, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);
            // FIX S-C01: Do NOT skip disabled tokens (same fix as _weightedCollateralValue)
            if (liqThreshold == 0) continue;

            uint256 valueUsd = oracle.getValueUsdUnsafe(tokens[i], deposited);
            totalWeighted += (valueUsd * liqThreshold) / 10000;
        }

        return totalWeighted;
    }

    /// @notice Get the maximum borrowable amount for a user (based on collateral factor, not liq threshold)
    /// @dev M-01: Intentionally skips disabled tokens — users must NOT open new debt against
    ///      disabled collateral. This is asymmetric with health-check/liquidation (which still
    ///      credits disabled collateral via liqThreshold > 0) to avoid trapping users. The
    ///      asymmetry is by design: disabled tokens protect against new risk but don't orphan
    ///      existing positions.
    function _borrowCapacity(address user) internal view returns (uint256) {
        address[] memory tokens = vault.getSupportedTokens();
        uint256 totalCapacity = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited == 0) continue;

            (bool enabled, uint256 colFactor, , ) = vault.getConfig(tokens[i]);
            if (!enabled) continue; // Intentional: no new borrows against disabled collateral

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);
            totalCapacity += (valueUsd * colFactor) / 10000;
        }

        return totalCapacity;
    }

    // ============================================================
    //                  LIQUIDATION INTERFACE
    // ============================================================

    /// @notice Called by LiquidationEngine or LeverageVault to reduce a user's debt after seizure/emergency close
    /// FIX M-01: Added nonReentrant to match all other state-modifying debt functions
    /// FIX LV-H01: Allow LEVERAGE_VAULT_ROLE to call for emergency debt cleanup
    function reduceDebt(address user, uint256 amount) external nonReentrant {
        require(
            hasRole(LIQUIDATION_ROLE, msg.sender) || hasRole(LEVERAGE_VAULT_ROLE, msg.sender),
            "UNAUTHORIZED_REDUCE_DEBT"
        );
        _accrueInterest(user);

        DebtPosition storage pos = positions[user];
        uint256 total = pos.principal + pos.accruedInterest;
        uint256 reduction = amount > total ? total : amount;

        if (reduction <= pos.accruedInterest) {
            pos.accruedInterest -= reduction;
        } else {
            uint256 remaining = reduction - pos.accruedInterest;
            pos.accruedInterest = 0;
            pos.principal -= remaining;
        }

        // FIX H-04: Subtract full reduction (principal + interest) from totalBorrows.
        // Same class as C-05: _accrueGlobalInterest adds interest to totalBorrows,
        // so liquidation must subtract the full amount, not just principal.
        if (reduction > 0 && totalBorrows >= reduction) {
            totalBorrows -= reduction;
        } else if (reduction > 0) {
            totalBorrows = 0; // Safety: prevent underflow from rounding drift
        }

        emit DebtAdjusted(user, totalDebt(user), "LIQUIDATION");
    }

    /// @notice FIX C-02: Record bad debt from underwater liquidation.
    ///         Called by LiquidationEngine after a liquidation exhausts all collateral
    ///         on a borrower who still has residual debt. Writes off the user's position
    ///         and moves the shortfall into the badDebt accumulator.
    /// @param user The borrower whose remaining debt is uncollectible
    function recordBadDebt(address user) external nonReentrant {
        require(
            hasRole(LIQUIDATION_ROLE, msg.sender),
            "UNAUTHORIZED_RECORD_BAD_DEBT"
        );

        _accrueInterest(user);

        DebtPosition storage pos = positions[user];
        uint256 residual = pos.principal + pos.accruedInterest;
        if (residual == 0) return;

        // Verify borrower truly has no collateral left
        address[] memory tokens = vault.getSupportedTokens();
        uint256 remainingCollateralValue = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited > 0) {
                remainingCollateralValue += oracle.getValueUsdUnsafe(tokens[i], deposited);
            }
        }
        require(remainingCollateralValue == 0, "COLLATERAL_REMAINING");

        // Write off the user's position
        pos.principal = 0;
        pos.accruedInterest = 0;

        // Remove from totalBorrows (this debt no longer earns interest)
        if (totalBorrows >= residual) {
            totalBorrows -= residual;
        } else {
            totalBorrows = 0;
        }

        // Track bad debt
        badDebt += residual;
        cumulativeBadDebt += residual;

        emit BadDebtRecorded(user, residual, badDebt);
        emit DebtAdjusted(user, 0, "BAD_DEBT_WRITEOFF");
    }

    /// @notice FIX C-02: Cover bad debt by burning mUSD from protocol reserves.
    ///         Admin sends mUSD to this contract, which is burned to reduce
    ///         the unbacked supply. Reduces the badDebt accumulator accordingly.
    /// @param amount Amount of bad debt to cover (mUSD, 18 decimals)
    function coverBadDebt(uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount > 0, "ZERO_AMOUNT");
        require(badDebt > 0, "NO_BAD_DEBT");

        uint256 coverAmount = amount > badDebt ? badDebt : amount;

        // Burn mUSD from this contract to reduce unbacked supply
        // Admin must transfer mUSD to this contract before calling
        uint256 balance = IERC20(address(musd)).balanceOf(address(this));
        require(balance >= coverAmount, "INSUFFICIENT_MUSD_BALANCE");

        musd.burn(address(this), coverAmount);

        badDebt -= coverAmount;
        badDebtCovered += coverAmount;

        emit BadDebtCovered(coverAmount, badDebt, "PROTOCOL_RESERVES");
    }

    /// @notice FIX C-02: Socialize remaining bad debt by reducing totalBorrows.
    ///         This effectively distributes the loss across all borrowers by
    ///         slightly reducing the interest base. Should only be used as a
    ///         last resort when reserves are insufficient.
    /// @dev This does NOT change individual debt positions — it reduces the
    ///      global totalBorrows which lowers utilization and interest rates,
    ///      effectively spreading the cost across future interest payments.
    /// @param amount Amount of bad debt to socialize
    function socializeBadDebt(uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount > 0, "ZERO_AMOUNT");
        require(badDebt > 0, "NO_BAD_DEBT");

        uint256 socializeAmount = amount > badDebt ? badDebt : amount;
        uint256 totalBorrowsBefore = totalBorrows;

        badDebt -= socializeAmount;
        badDebtCovered += socializeAmount;

        // FIX CR-01: Decrement totalBorrows so utilization rate reflects the write-off.
        // Without this, totalBorrows stays permanently inflated after socialization.
        if (totalBorrows >= socializeAmount) {
            totalBorrows -= socializeAmount;
        } else {
            totalBorrows = 0;
        }

        emit BadDebtSocialized(socializeAmount, totalBorrowsBefore, totalBorrows);
        emit BadDebtCovered(socializeAmount, badDebt, "SOCIALIZED");
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get total debt (principal + accrued interest) for a user
    /// @dev FIX S-H02: Uses pos.principal + pos.accruedInterest (total debt) as interest base,
    ///      matching _accrueInterest() execution. Previously used only pos.principal, causing
    ///      the view to understate pending interest vs what _accrueInterest actually charges.
    function totalDebt(address user) public view returns (uint256) {
        DebtPosition storage pos = positions[user];
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        uint256 userTotal = pos.principal + pos.accruedInterest;
        
        uint256 pendingInterest;
        if (address(interestRateModel) != address(0)) {
            // FIX S-H02: Use userTotal as base (matches _accrueInterest proportional share)
            uint256 globalInterest = interestRateModel.calculateInterest(
                totalBorrows,
                totalBorrows,
                _getTotalSupply(),
                elapsed
            );
            // User's proportional share of global interest (same formula as _accrueInterest)
            pendingInterest = totalBorrows > 0 ? (globalInterest * userTotal) / totalBorrows : 0;
        } else {
            // FIX S-H02: Use userTotal (principal + accrued) as base, matching _accrueInterest
            pendingInterest = (userTotal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        }
        return userTotal + pendingInterest;
    }

    /// @notice Get health factor for a user (public view)
    /// @return Health factor in basis points (10000 = 1.0)
    function healthFactor(address user) external view returns (uint256) {
        uint256 debt = totalDebt(user);
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValue(user);
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @notice FIX C-01: Health factor using unsafe oracle (bypasses circuit breaker)
    /// @dev Used by LiquidationEngine so liquidations proceed during >20% price crashes.
    ///      Without this, healthFactor() reverts via getValueUsd() circuit breaker,
    ///      blocking all liquidations exactly when they are most needed.
    /// @return Health factor in basis points (10000 = 1.0)
    function healthFactorUnsafe(address user) external view returns (uint256) {
        uint256 debt = totalDebt(user);
        // slither-disable-next-line incorrect-equality
        if (debt == 0) return type(uint256).max;

        uint256 weightedCollateral = _weightedCollateralValueUnsafe(user);
        if (weightedCollateral == 0) return 0;

        return (weightedCollateral * 10000) / debt;
    }

    /// @notice Get maximum additional borrow amount for a user
    function maxBorrow(address user) external view returns (uint256) {
        uint256 capacity = _borrowCapacity(user);
        uint256 debt = totalDebt(user);
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
        uint256 supply = _getTotalSupply();
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
    /// FIX P1-H3: Reserves are accounting entries for the protocol's share of interest.
    /// Instead of minting unbacked mUSD (which dilutes the peg), we try to mint
    /// within the supply cap. If the cap is hit, the withdrawal fails gracefully.
    /// Admin should coordinate with supply cap management before withdrawing.
    function withdrawReserves(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount <= protocolReserves, "EXCEEDS_RESERVES");
        require(to != address(0), "ZERO_ADDRESS");
        
        protocolReserves -= amount;
        
        // FIX P1-H3: Try to mint — if supply cap is hit, revert gracefully
        // so admin knows to increase cap or reduce reserves first
        try musd.mint(to, amount) {
            emit ReservesWithdrawn(to, amount);
        } catch {
            // Restore reserves and emit failure
            protocolReserves += amount;
            emit ReservesMintFailed(to, amount);
            revert("SUPPLY_CAP_REACHED");
        }
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    // ── FIX H-01: Timelocked parameter setters ──────────────────────────

    /// @notice Propose new interest rate (48h delay)
    function requestInterestRate(uint256 _rateBps) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_rateBps <= 5000, "RATE_TOO_HIGH"); // Max 50% APR
        pendingInterestRate = _rateBps;
        pendingInterestRateTime = block.timestamp;
        pendingInterestRateSet = true;
        emit InterestRateChangeRequested(_rateBps, block.timestamp + ADMIN_DELAY);
    }
    function cancelInterestRate() external onlyRole(BORROW_ADMIN_ROLE) {
        uint256 cancelled = pendingInterestRate;
        pendingInterestRate = 0;
        pendingInterestRateTime = 0;
        pendingInterestRateSet = false;
        emit InterestRateChangeCancelled(cancelled);
    }
    function executeInterestRate() external onlyRole(BORROW_ADMIN_ROLE) {
        require(pendingInterestRateSet, "NO_PENDING");
        require(block.timestamp >= pendingInterestRateTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        uint256 old = interestRateBps;
        interestRateBps = pendingInterestRate;
        pendingInterestRate = 0;
        pendingInterestRateTime = 0;
        pendingInterestRateSet = false;
        emit InterestRateUpdated(old, interestRateBps);
    }

    /// @notice Propose new min debt threshold (48h delay)
    function requestMinDebt(uint256 _minDebt) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_minDebt > 0, "MIN_DEBT_ZERO");
        require(_minDebt <= 1e24, "MIN_DEBT_TOO_HIGH");
        pendingMinDebt = _minDebt;
        pendingMinDebtTime = block.timestamp;
        emit MinDebtChangeRequested(_minDebt, block.timestamp + ADMIN_DELAY);
    }
    function cancelMinDebt() external onlyRole(BORROW_ADMIN_ROLE) {
        uint256 cancelled = pendingMinDebt;
        pendingMinDebt = 0;
        pendingMinDebtTime = 0;
        emit MinDebtChangeCancelled(cancelled);
    }
    function executeMinDebt() external onlyRole(BORROW_ADMIN_ROLE) {
        require(pendingMinDebt > 0, "NO_PENDING");
        require(block.timestamp >= pendingMinDebtTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        emit MinDebtUpdated(minDebt, pendingMinDebt);
        minDebt = pendingMinDebt;
        pendingMinDebt = 0;
        pendingMinDebtTime = 0;
    }

    // ============================================================
    //                  EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause borrowing and repayments
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause borrowing and repayments
    /// FIX H-01: Require DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
