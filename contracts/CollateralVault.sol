// SPDX-License-Identifier: MIT
// BLE Protocol - Collateral Vault
// Accepts ERC-20 collateral deposits (WETH, WBTC, etc.) for overcollateralized borrowing

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev FIX S-H04: Interface for checking health factor before withdrawal
interface IBorrowModule {
    function healthFactor(address user) external view returns (uint256);
    function totalDebt(address user) external view returns (uint256);
}

/// @title CollateralVault
/// @notice Holds collateral deposits for the borrowing system.
///         BorrowModule and LiquidationEngine interact with this vault.
contract CollateralVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant BORROW_MODULE_ROLE = keccak256("BORROW_MODULE_ROLE");
    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev FIX S-H04: BorrowModule reference for health factor checks
    address public borrowModule;
    
    /// @dev FIX S-H04: Event for borrowModule updates
    event BorrowModuleUpdated(address indexed oldModule, address indexed newModule);

    struct CollateralConfig {
        bool enabled;
        uint256 collateralFactorBps;  // e.g., 7500 = 75% LTV
        uint256 liquidationThresholdBps; // e.g., 8000 = 80% — liquidation triggers here
        uint256 liquidationPenaltyBps;   // e.g., 500 = 5% penalty
    }

    // Supported collateral tokens and their configs
    mapping(address => CollateralConfig) public collateralConfigs;
    address[] public supportedTokens;

    // user => token => deposited amount
    mapping(address => mapping(address => uint256)) public deposits;

    event CollateralAdded(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralUpdated(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    // FIX M-05: Separate event for disable/enable to avoid misleading 0-value emissions
    event CollateralDisabled(address indexed token);
    event CollateralEnabled(address indexed token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Seized(address indexed user, address indexed token, uint256 amount, address indexed liquidator);

    // ═══════════════════════════════════════════════════════════════════════
    // FIX H-01: ADMIN TIMELOCK (48h propose → execute)
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant ADMIN_DELAY = 48 hours;

    // Pending setBorrowModule
    address public pendingBorrowModule;
    uint256 public pendingBorrowModuleTime;

    // Pending addCollateral
    struct PendingCollateral {
        address token;
        uint256 collateralFactorBps;
        uint256 liquidationThresholdBps;
        uint256 liquidationPenaltyBps;
        uint256 requestTime;
    }
    PendingCollateral public pendingAddCollateral;

    // Pending updateCollateral
    PendingCollateral public pendingUpdateCollateral;

    event BorrowModuleChangeRequested(address indexed module, uint256 readyAt);
    event BorrowModuleChangeCancelled(address indexed module);
    event CollateralAddRequested(address indexed token, uint256 factorBps, uint256 liqThreshold, uint256 readyAt);
    event CollateralAddCancelled(address indexed token);
    event CollateralUpdateRequested(address indexed token, uint256 factorBps, uint256 liqThreshold, uint256 readyAt);
    event CollateralUpdateCancelled(address indexed token);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
    }

    /// @dev FIX H-01: Timelocked setBorrowModule (48h delay)
    function requestBorrowModule(address _borrowModule) external onlyRole(VAULT_ADMIN_ROLE) {
        require(_borrowModule != address(0), "INVALID_MODULE");
        pendingBorrowModule = _borrowModule;
        pendingBorrowModuleTime = block.timestamp;
        emit BorrowModuleChangeRequested(_borrowModule, block.timestamp + ADMIN_DELAY);
    }
    function cancelBorrowModule() external onlyRole(VAULT_ADMIN_ROLE) {
        address cancelled = pendingBorrowModule;
        pendingBorrowModule = address(0);
        pendingBorrowModuleTime = 0;
        emit BorrowModuleChangeCancelled(cancelled);
    }
    function executeBorrowModule() external onlyRole(VAULT_ADMIN_ROLE) {
        require(pendingBorrowModule != address(0), "NO_PENDING");
        require(block.timestamp >= pendingBorrowModuleTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        emit BorrowModuleUpdated(borrowModule, pendingBorrowModule);
        borrowModule = pendingBorrowModule;
        pendingBorrowModule = address(0);
        pendingBorrowModuleTime = 0;
    }

    // ============================================================
    //                  COLLATERAL CONFIG
    // ============================================================

    /// @notice FIX H-01: Propose adding a new collateral token (48h delay)
    function requestAddCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(collateralConfigs[token].collateralFactorBps == 0, "ALREADY_ADDED");
        require(supportedTokens.length < 50, "TOO_MANY_TOKENS");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        // FIX CORE-M-07: Enforce minimum 1% penalty to ensure liquidation profitability
        require(liquidationPenaltyBps >= 100 && liquidationPenaltyBps <= 2000, "INVALID_PENALTY");

        pendingAddCollateral = PendingCollateral({
            token: token,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps,
            requestTime: block.timestamp
        });
        emit CollateralAddRequested(token, collateralFactorBps, liquidationThresholdBps, block.timestamp + ADMIN_DELAY);
    }

    function cancelAddCollateral() external onlyRole(VAULT_ADMIN_ROLE) {
        address cancelled = pendingAddCollateral.token;
        delete pendingAddCollateral;
        emit CollateralAddCancelled(cancelled);
    }

    function executeAddCollateral() external onlyRole(VAULT_ADMIN_ROLE) {
        PendingCollateral memory p = pendingAddCollateral;
        require(p.token != address(0), "NO_PENDING");
        require(block.timestamp >= p.requestTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        // Re-validate in case state changed during timelock
        require(collateralConfigs[p.token].collateralFactorBps == 0, "ALREADY_ADDED");
        require(supportedTokens.length < 50, "TOO_MANY_TOKENS");

        collateralConfigs[p.token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: p.collateralFactorBps,
            liquidationThresholdBps: p.liquidationThresholdBps,
            liquidationPenaltyBps: p.liquidationPenaltyBps
        });
        supportedTokens.push(p.token);
        delete pendingAddCollateral;
        emit CollateralAdded(p.token, p.collateralFactorBps, p.liquidationThresholdBps);
    }

    /// @notice FIX H-01: Propose updating collateral parameters (48h delay)
    function requestUpdateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "NOT_SUPPORTED");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        // FIX CORE-M-07: Enforce minimum 1% penalty to ensure liquidation profitability
        require(liquidationPenaltyBps >= 100 && liquidationPenaltyBps <= 2000, "INVALID_PENALTY");

        pendingUpdateCollateral = PendingCollateral({
            token: token,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps,
            requestTime: block.timestamp
        });
        emit CollateralUpdateRequested(token, collateralFactorBps, liquidationThresholdBps, block.timestamp + ADMIN_DELAY);
    }

    function cancelUpdateCollateral() external onlyRole(VAULT_ADMIN_ROLE) {
        address cancelled = pendingUpdateCollateral.token;
        delete pendingUpdateCollateral;
        emit CollateralUpdateCancelled(cancelled);
    }

    function executeUpdateCollateral() external onlyRole(VAULT_ADMIN_ROLE) {
        PendingCollateral memory p = pendingUpdateCollateral;
        require(p.token != address(0), "NO_PENDING");
        require(block.timestamp >= p.requestTime + ADMIN_DELAY, "TIMELOCK_ACTIVE");
        require(collateralConfigs[p.token].enabled, "NOT_SUPPORTED");

        collateralConfigs[p.token].collateralFactorBps = p.collateralFactorBps;
        collateralConfigs[p.token].liquidationThresholdBps = p.liquidationThresholdBps;
        collateralConfigs[p.token].liquidationPenaltyBps = p.liquidationPenaltyBps;
        delete pendingUpdateCollateral;
        emit CollateralUpdated(p.token, p.collateralFactorBps, p.liquidationThresholdBps);
    }

    /// FIX M-09: Allow disabling collateral (no new deposits, existing positions can withdraw)
    /// FIX H-01 (Final Audit): Disabled tokens MUST remain in supportedTokens[] so that
    /// BorrowModule._weightedCollateralValue() continues to count them for health factor.
    /// Removing them (previous S-M04) made the S-C01 fix dead code, instantly liquidating
    /// users who held disabled collateral. The 50-token cap already prevents gas DoS.
    function disableCollateral(address token) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "NOT_SUPPORTED");
        collateralConfigs[token].enabled = false;

        // Token stays in supportedTokens[] — only the enabled flag changes.
        // BorrowModule checks liqThreshold (persists) rather than enabled flag.

        // FIX M-05: Emit specific disable event instead of misleading CollateralUpdated(0, 0)
        emit CollateralDisabled(token);
    }

    /// FIX S-C03: Re-enable a previously disabled collateral token
    /// FIX H-01 (Final Audit): Token already remains in supportedTokens[] after disable,
    /// so no push needed on re-enable. Just flip the enabled flag.
    function enableCollateral(address token) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].collateralFactorBps > 0, "NOT_PREVIOUSLY_ADDED");
        require(!collateralConfigs[token].enabled, "ALREADY_ENABLED");
        collateralConfigs[token].enabled = true;
        // FIX M-05: Use specific enable event
        emit CollateralEnabled(token);
    }

    // ============================================================
    //                  USER OPERATIONS
    // ============================================================

    /// @notice Deposit collateral
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "INVALID_AMOUNT");

        // FIX CORE-M-03: Measure actual received tokens for fee-on-transfer safety
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        deposits[msg.sender][token] += received;

        emit Deposited(msg.sender, token, received);
    }

    /// @notice Deposit collateral on behalf of another user (for LeverageVault integration)
    /// @param user The user to credit the deposit to
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function depositFor(address user, address token, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "INVALID_AMOUNT");
        require(user != address(0), "INVALID_USER");

        // FIX CORE-M-03: Measure actual received tokens for fee-on-transfer safety
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;

        deposits[user][token] += received;

        emit Deposited(user, token, received);
    }

    /// @notice Withdraw collateral (BorrowModule checks health factor before allowing)
    /// @param token The collateral token
    /// @param amount Amount to withdraw
    /// @param user The user withdrawing (must be called by BorrowModule after health check)
    function withdraw(
        address token,
        uint256 amount,
        address user
    ) external onlyRole(BORROW_MODULE_ROLE) nonReentrant {
        require(deposits[user][token] >= amount, "INSUFFICIENT_DEPOSIT");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(user, amount);

        emit Withdrawn(user, token, amount);
    }

    /// @notice Seize collateral during liquidation
    /// @param user The borrower being liquidated
    /// @param token The collateral token to seize
    /// @param amount Amount to seize
    /// @param liquidator The liquidator receiving the collateral
    function seize(
        address user,
        address token,
        uint256 amount,
        address liquidator
    ) external onlyRole(LIQUIDATION_ROLE) nonReentrant {
        require(deposits[user][token] >= amount, "INSUFFICIENT_COLLATERAL");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(liquidator, amount);

        emit Seized(user, token, amount, liquidator);
    }

    /// @notice Withdraw collateral on behalf of a user (for LeverageVault close position)
    /// @dev Only callable by contracts with LEVERAGE_VAULT_ROLE
    /// @dev FIX S-H04: Now checks health factor via BorrowModule to prevent undercollateralized withdrawals
    /// @param user The user whose collateral to withdraw
    /// @param token The collateral token
    /// @param amount Amount to withdraw
    /// @param recipient Where to send the collateral
    /// @param skipHealthCheck Set to true only during position closure (when debt is also being repaid)
    function withdrawFor(
        address user,
        address token,
        uint256 amount,
        address recipient,
        bool skipHealthCheck
    ) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant {
        require(deposits[user][token] >= amount, "INSUFFICIENT_DEPOSIT");
        require(recipient != address(0), "INVALID_RECIPIENT");
        
        // FIX S-H04 + CV-M01: Moved to post-withdrawal check for accuracy
        // Pre-check was unreliable because it estimated HF before the actual state change
        // Post-check (below, after transfer) verifies against actual on-chain state

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(recipient, amount);

        // FIX CV-M01: Post-withdrawal health factor check to ensure position remains healthy
        if (!skipHealthCheck && borrowModule != address(0)) {
            uint256 userDebt = IBorrowModule(borrowModule).totalDebt(user);
            if (userDebt > 0) {
                uint256 postHf = IBorrowModule(borrowModule).healthFactor(user);
                require(postHf >= 10000, "POST_WITHDRAWAL_UNDERCOLLATERALIZED");
            }
        }

        emit Withdrawn(user, token, amount);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get a user's deposit for a specific token
    function getDeposit(address user, address token) external view returns (uint256) {
        return deposits[user][token];
    }

    /// @notice Get the list of supported collateral tokens
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    /// @notice Get collateral config for a token
    function getConfig(address token) external view returns (
        bool enabled,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) {
        CollateralConfig storage c = collateralConfigs[token];
        return (c.enabled, c.collateralFactorBps, c.liquidationThresholdBps, c.liquidationPenaltyBps);
    }

    // ============================================================
    //                  EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause deposits
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause deposits
    /// FIX H-02: Require DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
