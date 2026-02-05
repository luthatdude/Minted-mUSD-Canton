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
    
    /// @notice Accumulated protocol reserves (from reserve factor)
    uint256 public protocolReserves;
    
    /// @notice Last time global interest was accrued
    uint256 public lastGlobalAccrualTime;
    
    /// @notice Total interest paid to suppliers (for analytics)
    uint256 public totalInterestPaidToSuppliers;
    
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

    /// @notice Set the interest rate model (enables dynamic rates)
    /// FIX S-M01: Added zero-address check to prevent bricking interest accrual
    function setInterestRateModel(address _model) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_model != address(0), "ZERO_ADDRESS");
        address old = address(interestRateModel);
        interestRateModel = IInterestRateModel(_model);
        emit InterestRateModelUpdated(old, _model);
    }

    /// @notice Set the SMUSD vault for interest routing
    function setSMUSD(address _smusd) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_smusd != address(0), "ZERO_ADDRESS");
        address old = address(smusd);
        smusd = ISMUSD(_smusd);
        emit SMUSDUpdated(old, _smusd);
    }

    /// @notice Set the Treasury for supply calculation
    function setTreasury(address _treasury) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
        address old = address(treasury);
        treasury = ITreasury(_treasury);
        emit TreasuryUpdated(old, _treasury);
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
    function repay(uint256 amount) external nonReentrant whenNotPaused {
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
    function repayFor(address user, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
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
            require(enabled, "TOKEN_NOT_SUPPORTED");
            uint256 withdrawnValue = oracle.getValueUsd(token, amount);
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
            if (supplierAmount > 0 && address(smusd) != address(0)) {
                // Mint mUSD representing interest earned
                musd.mint(address(this), supplierAmount);
                // Approve and send to SMUSD
                IERC20(address(musd)).approve(address(smusd), supplierAmount);
                smusd.receiveInterest(supplierAmount);
                totalInterestPaidToSuppliers += supplierAmount;
                
                emit InterestRoutedToSuppliers(supplierAmount, reserveAmount);
            }

            // Update total borrows to include accrued interest
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

        uint256 interest;
        if (address(interestRateModel) != address(0)) {
            // Use dynamic rate from model
            interest = interestRateModel.calculateInterest(
                pos.principal,
                totalBorrows,
                _getTotalSupply(),
                elapsed
            );
        } else {
            // Fallback to fixed rate
            interest = (pos.principal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
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
    function _weightedCollateralValue(address user) internal view returns (uint256) {
        address[] memory tokens = vault.getSupportedTokens();
        uint256 totalWeighted = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited == 0) continue;

            (bool enabled, , uint256 liqThreshold, ) = vault.getConfig(tokens[i]);
            if (!enabled) continue;

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);
            totalWeighted += (valueUsd * liqThreshold) / 10000;
        }

        return totalWeighted;
    }

    /// @notice Get the maximum borrowable amount for a user (based on collateral factor, not liq threshold)
    function _borrowCapacity(address user) internal view returns (uint256) {
        address[] memory tokens = vault.getSupportedTokens();
        uint256 totalCapacity = 0;

        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 deposited = vault.deposits(user, tokens[i]);
            if (deposited == 0) continue;

            (bool enabled, uint256 colFactor, , ) = vault.getConfig(tokens[i]);
            if (!enabled) continue;

            uint256 valueUsd = oracle.getValueUsd(tokens[i], deposited);
            totalCapacity += (valueUsd * colFactor) / 10000;
        }

        return totalCapacity;
    }

    // ============================================================
    //                  LIQUIDATION INTERFACE
    // ============================================================

    /// @notice Called by LiquidationEngine to reduce a user's debt after seizure
    /// FIX M-01: Added nonReentrant to match all other state-modifying debt functions
    function reduceDebt(address user, uint256 amount) external nonReentrant onlyRole(LIQUIDATION_ROLE) {
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

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get total debt (principal + accrued interest) for a user
    function totalDebt(address user) public view returns (uint256) {
        DebtPosition storage pos = positions[user];
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        
        uint256 pendingInterest;
        if (address(interestRateModel) != address(0)) {
            pendingInterest = interestRateModel.calculateInterest(
                pos.principal,
                totalBorrows,
                _getTotalSupply(),
                elapsed
            );
        } else {
            pendingInterest = (pos.principal * interestRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        }
        return pos.principal + pos.accruedInterest + pendingInterest;
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
    /// FIX M-02: Reserves represent accrued interest — mint is correct here because
    /// the interest is not held as mUSD tokens but tracked as accounting entries.
    /// However, this must coordinate with MUSD supply cap to prevent unbounded minting.
    function withdrawReserves(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount <= protocolReserves, "EXCEEDS_RESERVES");
        require(to != address(0), "ZERO_ADDRESS");
        
        protocolReserves -= amount;
        musd.mint(to, amount);
        
        emit ReservesWithdrawn(to, amount);
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    /// @notice Update the global interest rate
    /// @dev FIX 5C-M05: Rate changes apply prospectively at each user's next accrual.
    /// Existing positions accrue at the OLD rate until their next interaction triggers _accrueInterest().
    /// This is by-design (same as Aave/Compound variable rates) and avoids O(n) global accrual.
    function setInterestRate(uint256 _rateBps) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_rateBps <= 5000, "RATE_TOO_HIGH"); // Max 50% APR
        uint256 old = interestRateBps;
        interestRateBps = _rateBps;
        emit InterestRateUpdated(old, _rateBps);
    }

    /// FIX S-M03: Enforce minDebt > 0 to prevent dust positions
    function setMinDebt(uint256 _minDebt) external onlyRole(BORROW_ADMIN_ROLE) {
        require(_minDebt > 0, "MIN_DEBT_ZERO");
        require(_minDebt <= 1e24, "MIN_DEBT_TOO_HIGH");
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
    /// FIX H-01: Require DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
