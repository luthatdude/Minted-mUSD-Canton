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

    // ── Timelock (48h propose → execute via MintedTimelockController) ──
    uint256 public constant ADMIN_DELAY = 48 hours;

    address public pendingBorrowModule;
    uint256 public pendingBorrowModuleTime;

    struct PendingCollateral {
        address token;
        uint256 collateralFactorBps;
        uint256 liquidationThresholdBps;
        uint256 liquidationPenaltyBps;
        uint256 requestTime;
    }
    PendingCollateral public pendingAddCollateral;
    PendingCollateral public pendingUpdateCollateral;

    // ── Events ──────────────────────────────────────────────────────────
    event CollateralAdded(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralUpdated(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralDisabled(address indexed token);
    event CollateralEnabled(address indexed token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Seized(address indexed user, address indexed token, uint256 amount, address indexed liquidator);
    event BorrowModuleUpdated(address indexed oldModule, address indexed newModule);
    event BorrowModuleChangeRequested(address indexed module, uint256 readyAt);
    event BorrowModuleChangeCancelled(address indexed module);
    event CollateralAddRequested(address indexed token, uint256 factorBps, uint256 liqThreshold, uint256 readyAt);
    event CollateralAddCancelled(address indexed token);
    event CollateralUpdateRequested(address indexed token, uint256 factorBps, uint256 liqThreshold, uint256 readyAt);
    event CollateralUpdateCancelled(address indexed token);

    // ── Storage gap for future upgrades ─────────────────────────────────
    uint256[40] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
    }

    /// @dev Only DEFAULT_ADMIN_ROLE can authorize upgrades (through TimelockController)
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ══════════════════════════════════════════════════════════════════════
    // TIMELOCKED ADMIN — setBorrowModule
    // ══════════════════════════════════════════════════════════════════════

    function requestBorrowModule(address _borrowModule) external onlyRole(VAULT_ADMIN_ROLE) {
        require(_borrowModule != address(0), "INVALID_MODULE");
        require(pendingBorrowModule == address(0), "CHANGE_ALREADY_PENDING");
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
        require(pendingBorrowModule != address(0), "NOTHING_PENDING");
        require(block.timestamp >= pendingBorrowModuleTime + ADMIN_DELAY, "TIMELOCK_NOT_ELAPSED");
        address old = borrowModule;
        borrowModule = pendingBorrowModule;
        pendingBorrowModule = address(0);
        pendingBorrowModuleTime = 0;
        emit BorrowModuleUpdated(old, borrowModule);
    }

    // ══════════════════════════════════════════════════════════════════════
    // TIMELOCKED ADMIN — addCollateral
    // ══════════════════════════════════════════════════════════════════════

    function requestAddCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(!collateralConfigs[token].enabled, "ALREADY_ENABLED");
        require(collateralFactorBps <= 9000, "FACTOR_TOO_HIGH");
        require(liquidationThresholdBps > collateralFactorBps, "THRESHOLD_MUST_EXCEED_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");
        require(pendingAddCollateral.token == address(0), "ADD_ALREADY_PENDING");

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
        require(p.token != address(0), "NOTHING_PENDING");
        require(block.timestamp >= p.requestTime + ADMIN_DELAY, "TIMELOCK_NOT_ELAPSED");

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

    // ══════════════════════════════════════════════════════════════════════
    // TIMELOCKED ADMIN — updateCollateral
    // ══════════════════════════════════════════════════════════════════════

    function requestUpdateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_ACTIVE");
        require(collateralFactorBps <= 9000, "FACTOR_TOO_HIGH");
        require(liquidationThresholdBps > collateralFactorBps, "THRESHOLD_MUST_EXCEED_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");
        require(pendingUpdateCollateral.token == address(0), "UPDATE_ALREADY_PENDING");

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
        require(p.token != address(0), "NOTHING_PENDING");
        require(block.timestamp >= p.requestTime + ADMIN_DELAY, "TIMELOCK_NOT_ELAPSED");

        collateralConfigs[p.token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: p.collateralFactorBps,
            liquidationThresholdBps: p.liquidationThresholdBps,
            liquidationPenaltyBps: p.liquidationPenaltyBps
        });
        delete pendingUpdateCollateral;
        emit CollateralUpdated(p.token, p.collateralFactorBps, p.liquidationThresholdBps);
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

    function _checkHealthFactor(address user) internal view {
        if (borrowModule != address(0)) {
            uint256 debt = IBorrowModule(borrowModule).totalDebt(user);
            if (debt > 0) {
                uint256 hf = IBorrowModule(borrowModule).healthFactor(user);
                require(hf >= 10000, "HEALTH_FACTOR_TOO_LOW");
            }
        }
    }
}
