// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Collateral Vault
// Accepts ERC-20 collateral deposits (WETH, WBTC, etc.) for overcollateralized borrowing

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./GlobalPausable.sol";
import "./Errors.sol";

/// @dev Interface for checking health factor before withdrawal
interface IBorrowModule {
    function healthFactor(address user) external view returns (uint256);
    function healthFactorUnsafe(address user) external view returns (uint256);
    function totalDebt(address user) external view returns (uint256);
}

/// @title CollateralVault
/// @notice Holds collateral deposits for the borrowing system.
///         BorrowModule and LiquidationEngine interact with this vault.
contract CollateralVault is AccessControl, ReentrancyGuard, Pausable, GlobalPausable {
    using SafeERC20 for IERC20;

    bytes32 public constant BORROW_MODULE_ROLE = keccak256("BORROW_MODULE_ROLE");
    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice SOL-H-15: TIMELOCK_ROLE for critical config changes (48h governance delay)
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    /// @dev BorrowModule reference for health factor checks
    address public borrowModule;
    
    event BorrowModuleUpdated(address indexed oldModule, address indexed newModule);

    /// @dev GAS-H-02: Packed from 4 slots → 1 slot (bool + 3×uint16 = 7 bytes).
    ///      All BPS values are capped at ≤9500, fitting uint16 (max 65535).
    ///      Saves ~60,000 gas per write and 3 SLOADs per token in health check loops.
    struct CollateralConfig {
        bool enabled;
        uint16 collateralFactorBps;     // e.g., 7500 = 75% LTV (max 9500)
        uint16 liquidationThresholdBps; // e.g., 8000 = 80% (max 9500)
        uint16 liquidationPenaltyBps;   // e.g., 500 = 5% penalty (max 2000)
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

    /// @param _globalPauseRegistry Address of the GlobalPauseRegistry (address(0) to skip global pause)
    constructor(address _globalPauseRegistry) GlobalPausable(_globalPauseRegistry) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, msg.sender);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    /// @notice Set the BorrowModule address for health factor checks
    /// @dev SOL-H-15: Changed from VAULT_ADMIN_ROLE to TIMELOCK_ROLE — critical dependency
    function setBorrowModule(address _borrowModule) external onlyRole(TIMELOCK_ROLE) {
        if (_borrowModule == address(0)) revert InvalidModule();
        emit BorrowModuleUpdated(borrowModule, _borrowModule);
        borrowModule = _borrowModule;
    }

    // ============================================================
    //                  COLLATERAL CONFIG
    // ============================================================

    /// @notice Add a new supported collateral token
    /// @dev SOL-H-15: Changed from VAULT_ADMIN_ROLE to TIMELOCK_ROLE — collateral params are critical
    function addCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(TIMELOCK_ROLE) {
        if (token == address(0)) revert InvalidToken();
        // Use collateralFactorBps == 0 to detect never-added tokens.
        // A disabled token retains its collateralFactorBps > 0, so checking
        // !enabled would allow a duplicate push into supportedTokens[].
        // Use enableCollateral() to re-enable a disabled token instead.
        if (collateralConfigs[token].collateralFactorBps != 0) revert AlreadyAdded();
        // Cap supported tokens array to prevent unbounded growth
        if (supportedTokens.length >= 50) revert TooManyTokens();
        if (collateralFactorBps == 0 || collateralFactorBps >= liquidationThresholdBps) revert InvalidFactor();
        if (liquidationThresholdBps > 9500) revert ThresholdTooHigh(); // Max 95%
        if (liquidationPenaltyBps > 2000) revert PenaltyTooHigh();    // Max 20%

        collateralConfigs[token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: uint16(collateralFactorBps),
            liquidationThresholdBps: uint16(liquidationThresholdBps),
            liquidationPenaltyBps: uint16(liquidationPenaltyBps)
        });

        supportedTokens.push(token);
        emit CollateralAdded(token, collateralFactorBps, liquidationThresholdBps);
    }

    /// @notice Update collateral parameters
    /// @dev SOL-H-15: Changed from VAULT_ADMIN_ROLE to TIMELOCK_ROLE — LTV changes affect liquidations
    function updateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(TIMELOCK_ROLE) {
        if (!collateralConfigs[token].enabled) revert NotSupported();
        if (collateralFactorBps == 0 || collateralFactorBps >= liquidationThresholdBps) revert InvalidFactor();
        if (liquidationThresholdBps > 9500) revert ThresholdTooHigh();
        if (liquidationPenaltyBps > 2000) revert PenaltyTooHigh();

        collateralConfigs[token].collateralFactorBps = uint16(collateralFactorBps);
        collateralConfigs[token].liquidationThresholdBps = uint16(liquidationThresholdBps);
        collateralConfigs[token].liquidationPenaltyBps = uint16(liquidationPenaltyBps);

        emit CollateralUpdated(token, collateralFactorBps, liquidationThresholdBps);
    }

    /// @notice Disable a collateral token (no new deposits; existing positions can withdraw)
    /// @dev Disabled tokens MUST remain in supportedTokens[] so that
    ///      BorrowModule._weightedCollateralValue() continues to count them for health factor.
    ///      The 50-token cap already prevents gas DoS.
    /// @dev SOL-H-15: Changed from VAULT_ADMIN_ROLE to TIMELOCK_ROLE
    function disableCollateral(address token) external onlyRole(TIMELOCK_ROLE) {
        if (!collateralConfigs[token].enabled) revert NotSupported();
        collateralConfigs[token].enabled = false;

        // Token stays in supportedTokens[] — only the enabled flag changes.
        // BorrowModule checks liqThreshold (persists) rather than enabled flag.

        emit CollateralDisabled(token);
    }

    /// @notice Re-enable a previously disabled collateral token
    /// @dev Token already remains in supportedTokens[] after disable,
    ///      so no push needed. Just flips the enabled flag.
    /// @dev SOL-H-15: Changed from VAULT_ADMIN_ROLE to TIMELOCK_ROLE
    function enableCollateral(address token) external onlyRole(TIMELOCK_ROLE) {
        if (collateralConfigs[token].collateralFactorBps == 0) revert NotPreviouslyAdded();
        if (collateralConfigs[token].enabled) revert AlreadyEnabled();
        collateralConfigs[token].enabled = true;
        emit CollateralEnabled(token);
    }

    // ============================================================
    //                  USER OPERATIONS
    // ============================================================

    /// @notice Deposit collateral
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused whenNotGloballyPaused {
        if (!collateralConfigs[token].enabled) revert TokenNotSupported();
        if (amount == 0) revert InvalidAmount();

        deposits[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Deposit collateral on behalf of another user (for LeverageVault integration)
    /// @param user The user to credit the deposit to
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function depositFor(address user, address token, uint256 amount) external onlyRole(LEVERAGE_VAULT_ROLE) nonReentrant whenNotPaused whenNotGloballyPaused {
        if (!collateralConfigs[token].enabled) revert TokenNotSupported();
        if (amount == 0) revert InvalidAmount();
        if (user == address(0)) revert InvalidUser();

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
        if (deposits[user][token] < amount) revert InsufficientDeposit();

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
        if (deposits[user][token] < amount) revert InsufficientCollateral();

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
        if (deposits[user][token] < amount) revert InsufficientDeposit();
        if (recipient == address(0)) revert InvalidRecipient();

        // When skipHealthCheck is true, restrict recipient to the
        // LeverageVault (msg.sender) or the user themselves. This prevents a
        // compromised LEVERAGE_VAULT_ROLE from draining collateral to arbitrary addresses.
        if (skipHealthCheck) {
            if (recipient != msg.sender && recipient != user) revert SkipHcRecipientRestricted();
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
                        revert OracleUnavailable();
                    }
                }
                if (!healthOk) revert WithdrawalWouldUndercollateralize();
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
    /// @dev SOL-H-17: Requires TIMELOCK_ROLE (48h governance delay) to prevent
    ///      compromised lower-privilege roles from unpausing during active exploits
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }
}
