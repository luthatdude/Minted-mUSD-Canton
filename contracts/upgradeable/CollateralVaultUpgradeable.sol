// SPDX-License-Identifier: MIT
// Minted mUSD Protocol - Upgradeable Collateral Vault
// UUPS upgradeable version of CollateralVault for post-deployment patching

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IBorrowModule.sol";

/// @title CollateralVaultUpgradeable
/// @notice UUPS-upgradeable version of CollateralVault.
/// @dev Holds collateral deposits for the borrowing system.
///      BorrowModule and LiquidationEngine interact with this vault.
///      All admin operations are executed through MintedTimelockController.
contract CollateralVaultUpgradeable is
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant BORROW_MODULE_ROLE = keccak256("BORROW_MODULE_ROLE");
    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    address public borrowModule;

    struct CollateralConfig {
        bool enabled;
        uint256 collateralFactorBps;
        uint256 liquidationThresholdBps;
        uint256 liquidationPenaltyBps;
    }

    mapping(address => CollateralConfig) public collateralConfigs;
    address[] public supportedTokens;
    mapping(address => mapping(address => uint256)) public deposits;

    // ── Events ──────────────────────────────────────────────────────────
    event CollateralAdded(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralUpdated(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralDisabled(address indexed token);
    event CollateralEnabled(address indexed token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Seized(address indexed user, address indexed token, uint256 amount, address indexed liquidator);
    event BorrowModuleUpdated(address indexed oldModule, address indexed newModule);

    // ── Storage gap for future upgrades ─────────────────────────────────
    uint256[40] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _timelockController) public initializer {
        require(_timelockController != address(0), "INVALID_TIMELOCK");

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, _timelockController);
        // Make TIMELOCK_ROLE its own admin — DEFAULT_ADMIN cannot grant/revoke it
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    /// @dev Only the MintedTimelockController can authorize upgrades (48h delay enforced by OZ TimelockController)
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(TIMELOCK_ROLE) {}

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN SETTERS (executed via MintedTimelockController)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Set borrow module — must be called through MintedTimelockController
    /// @dev Timelock delay (48h) is enforced by the OZ TimelockController, not here
    function setBorrowModule(address _borrowModule) external onlyRole(TIMELOCK_ROLE) {
        require(_borrowModule != address(0), "INVALID_MODULE");
        address old = borrowModule;
        borrowModule = _borrowModule;
        emit BorrowModuleUpdated(old, _borrowModule);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN — addCollateral (via MintedTimelockController)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Add a new collateral token — must be called through MintedTimelockController
    /// @dev Enforces supportedTokens length cap (max 50) to prevent
    ///      gas DoS in BorrowModule's _weightedCollateralValue() which iterates all supported tokens.
    function addCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(TIMELOCK_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(!collateralConfigs[token].enabled, "ALREADY_ENABLED");
        require(supportedTokens.length < 50, "TOO_MANY_TOKENS");
        require(collateralFactorBps <= 9000, "FACTOR_TOO_HIGH");
        require(liquidationThresholdBps > collateralFactorBps, "THRESHOLD_MUST_EXCEED_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");

        collateralConfigs[token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps
        });
        supportedTokens.push(token);
        emit CollateralAdded(token, collateralFactorBps, liquidationThresholdBps);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN — updateCollateral (via MintedTimelockController)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Update an existing collateral config — must be called through MintedTimelockController
    function updateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(TIMELOCK_ROLE) {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_ACTIVE");
        require(collateralFactorBps <= 9000, "FACTOR_TOO_HIGH");
        require(liquidationThresholdBps > collateralFactorBps, "THRESHOLD_MUST_EXCEED_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");

        collateralConfigs[token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps
        });
        emit CollateralUpdated(token, collateralFactorBps, liquidationThresholdBps);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN — disableCollateral / enableCollateral
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Disable an existing collateral token — must be called through MintedTimelockController
    /// @dev Disabling prevents new deposits but allows withdrawals and liquidations to continue.
    ///      Existing positions are not affected; users can still withdraw their deposits.
    /// @param token The collateral token address to disable
    function disableCollateral(address token) external onlyRole(TIMELOCK_ROLE) {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_ACTIVE");
        collateralConfigs[token].enabled = false;
        emit CollateralDisabled(token);
    }

    /// @notice Re-enable a previously disabled collateral token — must be called through MintedTimelockController
    /// @param token The collateral token address to re-enable
    function enableCollateral(address token) external onlyRole(TIMELOCK_ROLE) {
        require(!collateralConfigs[token].enabled, "TOKEN_ALREADY_ENABLED");
        // Ensure the token was previously added (has non-zero config)
        require(
            collateralConfigs[token].liquidationThresholdBps > 0,
            "TOKEN_NEVER_ADDED"
        );
        collateralConfigs[token].enabled = true;
        emit CollateralEnabled(token);
    }

    // ══════════════════════════════════════════════════════════════════════
    // USER OPERATIONS
    // ══════════════════════════════════════════════════════════════════════

    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "ZERO_AMOUNT");

        deposits[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, token, amount);
    }

    function depositFor(address user, address token, uint256 amount) external nonReentrant whenNotPaused onlyRole(LEVERAGE_VAULT_ROLE) {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "ZERO_AMOUNT");

        deposits[user][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(user, token, amount);
    }

    /// @dev H-01 fix: Only BorrowModule can call withdraw — users go through BorrowModule.withdrawCollateral()
    ///      which accrues interest before releasing collateral, preventing stale-debt exploits.
    function withdraw(address token, uint256 amount, address user) external onlyRole(BORROW_MODULE_ROLE) nonReentrant whenNotPaused {
        require(deposits[user][token] >= amount, "INSUFFICIENT_BALANCE");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(user, amount);
        emit Withdrawn(user, token, amount);

        _checkHealthFactor(user);
    }

    function withdrawFor(
        address user,
        address token,
        uint256 amount,
        address recipient,
        bool skipHealthCheck
    ) external nonReentrant whenNotPaused onlyRole(LEVERAGE_VAULT_ROLE) {
        require(deposits[user][token] >= amount, "INSUFFICIENT_BALANCE");
        // SOL-H-02: Restrict recipient when health check is skipped to prevent
        // LEVERAGE_VAULT_ROLE from draining collateral to arbitrary addresses
        if (skipHealthCheck) {
            require(recipient == msg.sender || recipient == user, "SKIP_HC_RECIPIENT_RESTRICTED");
        }

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawn(user, token, amount);

        if (!skipHealthCheck) {
            _checkHealthFactor(user);
        }
    }

    function seize(
        address user,
        address token,
        uint256 amount,
        address liquidator
    ) external nonReentrant onlyRole(LIQUIDATION_ROLE) {
        require(deposits[user][token] >= amount, "INSUFFICIENT_COLLATERAL");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(liquidator, amount);
        emit Seized(user, token, amount, liquidator);
    }

    // ══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════

    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    function getConfig(address token) external view returns (
        bool enabled,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) {
        CollateralConfig memory c = collateralConfigs[token];
        return (c.enabled, c.collateralFactorBps, c.liquidationThresholdBps, c.liquidationPenaltyBps);
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAUSE / UNPAUSE
    // ══════════════════════════════════════════════════════════════════════

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @dev Requires TIMELOCK_ROLE (48h governance delay) to prevent compromised lower-privilege roles from unpausing
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ══════════════════════════════════════════════════════════════════════

    /// from permanently blocking withdrawals during extreme price moves
    /// @dev Fail-CLOSED when both oracle paths revert.
    ///      Reverts with HEALTH_CHECK_FAILED, blocking withdrawal until oracle recovers.
    function _checkHealthFactor(address user) internal view {
        if (borrowModule != address(0)) {
            uint256 debt = IBorrowModule(borrowModule).totalDebt(user);
            if (debt > 0) {
                try IBorrowModule(borrowModule).healthFactor(user) returns (uint256 hf) {
                    require(hf >= 10000, "HEALTH_FACTOR_TOO_LOW");
                } catch {
                    // Oracle circuit breaker triggered — try unsafe health factor
                    try IBorrowModule(borrowModule).healthFactorUnsafe(user) returns (uint256 hfUnsafe) {
                        require(hfUnsafe >= 10000, "HEALTH_FACTOR_TOO_LOW");
                    } catch {
                        // Both safe and unsafe oracles failed — REVERT.
                        revert("HEALTH_CHECK_FAILED");
                    }
                }
            }
        }
    }
}
