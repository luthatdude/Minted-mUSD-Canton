// SPDX-License-Identifier: MIT
// BLE Protocol - Borrow Module
// Tracks debt positions with per-second interest accrual

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

/// @title BorrowModule
/// @notice Manages debt positions for overcollateralized mUSD borrowing.
///         Users deposit collateral in CollateralVault, then borrow mUSD here.
///         Interest accrues per-second on outstanding debt.
contract BorrowModule is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant BORROW_ADMIN_ROLE = keccak256("BORROW_ADMIN_ROLE");
    bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    ICollateralVault public immutable vault;
    IPriceOracle public immutable oracle;
    IMUSDMint public immutable musd;

    // Annual interest rate in basis points (e.g., 200 = 2% APR)
    uint256 public interestRateBps;

    // Seconds per year for interest calculation
    uint256 private constant SECONDS_PER_YEAR = 365 days;

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

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BORROW_ADMIN_ROLE, msg.sender);
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

        // Burn the repaid mUSD
        musd.burn(msg.sender, repayAmount);

        emit Repaid(msg.sender, repayAmount, totalDebt(msg.sender));
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

    /// @notice Accrue interest on a user's debt
    /// @dev Uses SIMPLE INTEREST model (not compound).
    ///      Formula: interest = principal × rate × time
    ///      This is intentional for gas efficiency and predictability.
    ///      For multi-year positions, compound interest could be added.
    ///      H-02: DOCUMENTED DESIGN DECISION - simple interest is intentional.
    function _accrueInterest(address user) internal {
        DebtPosition storage pos = positions[user];
        if (pos.principal == 0 && pos.accruedInterest == 0) {
            pos.lastAccrualTime = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        if (elapsed == 0) return;

        // interest = principal * rate * elapsed / (10000 * SECONDS_PER_YEAR)
        uint256 interest = (pos.principal * interestRateBps * elapsed) / (10000 * SECONDS_PER_YEAR);

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
    function reduceDebt(address user, uint256 amount) external onlyRole(LIQUIDATION_ROLE) {
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

        emit DebtAdjusted(user, totalDebt(user), "LIQUIDATION");
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get total debt (principal + accrued interest) for a user
    function totalDebt(address user) public view returns (uint256) {
        DebtPosition storage pos = positions[user];
        uint256 elapsed = block.timestamp - pos.lastAccrualTime;
        uint256 pendingInterest = (pos.principal * interestRateBps * elapsed) / (10000 * SECONDS_PER_YEAR);
        return pos.principal + pos.accruedInterest + pendingInterest;
    }

    /// @notice Get health factor for a user (public view)
    /// @return Health factor in basis points (10000 = 1.0)
    function healthFactor(address user) external view returns (uint256) {
        uint256 debt = totalDebt(user);
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

    function setMinDebt(uint256 _minDebt) external onlyRole(BORROW_ADMIN_ROLE) {
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
