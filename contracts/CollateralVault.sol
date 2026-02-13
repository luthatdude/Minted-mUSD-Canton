// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Collateral Vault
// Accepts ERC-20 collateral deposits (WETH, WBTC, etc.) for overcollateralized borrowing

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev Interface for checking health factor before withdrawal
interface IBorrowModule {
    function healthFactor(address user) external view returns (uint256);
    function healthFactorUnsafe(address user) external view returns (uint256);
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

    /// @dev BorrowModule reference for health factor checks
    address public borrowModule;
    
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
    // Separate event for disable/enable to avoid misleading 0-value emissions
    event CollateralDisabled(address indexed token);
    event CollateralEnabled(address indexed token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Seized(address indexed user, address indexed token, uint256 amount, address indexed liquidator);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Set the BorrowModule address for health factor checks
    function setBorrowModule(address _borrowModule) external onlyRole(VAULT_ADMIN_ROLE) {
        require(_borrowModule != address(0), "INVALID_MODULE");
        emit BorrowModuleUpdated(borrowModule, _borrowModule);
        borrowModule = _borrowModule;
    }

    // ============================================================
    //                  COLLATERAL CONFIG
    // ============================================================

    /// @notice Add a new supported collateral token
    function addCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        // Use collateralFactorBps == 0 to detect never-added tokens.
        // A disabled token retains its collateralFactorBps > 0, so checking
        // !enabled would allow a duplicate push into supportedTokens[].
        // Use enableCollateral() to re-enable a disabled token instead.
        require(collateralConfigs[token].collateralFactorBps == 0, "ALREADY_ADDED");
        // Cap supported tokens array to prevent unbounded growth
        require(supportedTokens.length < 50, "TOO_MANY_TOKENS");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH"); // Max 95%
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");    // Max 20%

        collateralConfigs[token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps
        });

        supportedTokens.push(token);
        emit CollateralAdded(token, collateralFactorBps, liquidationThresholdBps);
    }

    /// @notice Update collateral parameters
    function updateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "NOT_SUPPORTED");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");

        collateralConfigs[token].collateralFactorBps = collateralFactorBps;
        collateralConfigs[token].liquidationThresholdBps = liquidationThresholdBps;
        collateralConfigs[token].liquidationPenaltyBps = liquidationPenaltyBps;

        emit CollateralUpdated(token, collateralFactorBps, liquidationThresholdBps);
    }

    /// @notice Disable a collateral token (no new deposits; existing positions can withdraw)
    /// @dev Disabled tokens MUST remain in supportedTokens[] so that
    ///      BorrowModule._weightedCollateralValue() continues to count them for health factor.
    ///      The 50-token cap already prevents gas DoS.
    function disableCollateral(address token) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "NOT_SUPPORTED");
        collateralConfigs[token].enabled = false;

        // Token stays in supportedTokens[] — only the enabled flag changes.
        // BorrowModule checks liqThreshold (persists) rather than enabled flag.

        emit CollateralDisabled(token);
    }

    /// @notice Re-enable a previously disabled collateral token
    /// @dev Token already remains in supportedTokens[] after disable,
    ///      so no push needed. Just flips the enabled flag.
    function enableCollateral(address token) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].collateralFactorBps > 0, "NOT_PREVIOUSLY_ADDED");
        require(!collateralConfigs[token].enabled, "ALREADY_ENABLED");
        collateralConfigs[token].enabled = true;
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

        deposits[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Deposit collateral on behalf of another user (for LeverageVault integration)
    /// @param user The user to credit the deposit to
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function depositFor(address user, address token, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "INVALID_AMOUNT");
        require(user != address(0), "INVALID_USER");

        deposits[user][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(user, token, amount);
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
    /// @dev Checks health factor via BorrowModule to prevent undercollateralized withdrawals
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

        // When skipHealthCheck is true, restrict recipient to the
        // LeverageVault (msg.sender) or the user themselves. This prevents a
        // compromised LEVERAGE_VAULT_ROLE from draining collateral to arbitrary addresses.
        if (skipHealthCheck) {
            require(
                recipient == msg.sender || recipient == user,
                "SKIP_HC_RECIPIENT_RESTRICTED"
            );
        }

        // Decrement deposit BEFORE health check so healthFactor()
        // sees the post-withdrawal state. Solidity's atomic revert ensures the
        // decrement is rolled back if the health check fails.
        deposits[user][token] -= amount;

        // Check health factor unless explicitly skipped during atomic position closure
        if (!skipHealthCheck && borrowModule != address(0)) {
            // Only check if user has debt
            uint256 userDebt = IBorrowModule(borrowModule).totalDebt(user);
            if (userDebt > 0) {
                // Use try/catch so oracle failure does NOT silently
                // allow withdrawal. If both safe and unsafe health checks revert,
                // we block the withdrawal rather than fail-open.
                bool healthOk = false;
                try IBorrowModule(borrowModule).healthFactor(user) returns (uint256 hf) {
                    healthOk = hf >= 11000;
                } catch {
                    // Safe oracle reverted (circuit breaker). Try unsafe path for resilience.
                    try IBorrowModule(borrowModule).healthFactorUnsafe(user) returns (uint256 hfUnsafe) {
                        healthOk = hfUnsafe >= 11000;
                    } catch {
                        // Both oracles failed — BLOCK withdrawal (fail-closed).
                        // Previously this would have reverted naturally, but with try/catch
                        // we must explicitly revert to prevent fail-open.
                        revert("ORACLE_UNAVAILABLE");
                    }
                }
                require(healthOk, "WITHDRAWAL_WOULD_UNDERCOLLATERALIZE");
            }
        }

        IERC20(token).safeTransfer(recipient, amount);

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
    /// @dev Requires DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
