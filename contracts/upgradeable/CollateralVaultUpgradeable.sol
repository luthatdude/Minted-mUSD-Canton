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
    function addCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(TIMELOCK_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(!collateralConfigs[token].enabled, "ALREADY_ENABLED");
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

    function withdraw(address token, uint256 amount, address user) external nonReentrant whenNotPaused {
        require(msg.sender == user || hasRole(BORROW_MODULE_ROLE, msg.sender), "UNAUTHORIZED");
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

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ══════════════════════════════════════════════════════════════════════

    /// @notice FIX HIGH-15: Wrapped in try/catch to prevent oracle circuit breaker
    /// from permanently blocking withdrawals during extreme price moves
    function _checkHealthFactor(address user) internal view {
        if (borrowModule != address(0)) {
            uint256 debt = IBorrowModule(borrowModule).totalDebt(user);
            if (debt > 0) {
                // Use try/catch: if oracle circuit breaker trips, allow withdrawal
                // rather than trapping user funds indefinitely
                try IBorrowModule(borrowModule).healthFactor(user) returns (uint256 hf) {
                    require(hf >= 10000, "HEALTH_FACTOR_TOO_LOW");
                } catch {
                    // Oracle circuit breaker triggered — fall through to allow withdrawal
                    // Users can still be liquidated via LiquidationEngine's unsafe path
                }
            }
        }
    }
}
