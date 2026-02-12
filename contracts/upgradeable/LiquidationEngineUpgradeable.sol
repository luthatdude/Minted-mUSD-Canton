// SPDX-License-Identifier: MIT
// Minted mUSD Protocol - Upgradeable Liquidation Engine
// UUPS upgradeable version of LiquidationEngine for post-deployment patching

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/ICollateralVault.sol";
import "../interfaces/IPriceOracle.sol";
import "../interfaces/IBorrowModule.sol";
import "../interfaces/IMUSD.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title LiquidationEngineUpgradeable
/// @notice UUPS-upgradeable version of LiquidationEngine.
/// @dev Liquidates undercollateralized borrowing positions.
contract LiquidationEngineUpgradeable is
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant ENGINE_ADMIN_ROLE = keccak256("ENGINE_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    ICollateralVault public vault;
    IBorrowModule public borrowModule;
    IPriceOracle public oracle;
    IMUSD public musd;

    uint256 public closeFactorBps;
    uint256 public fullLiquidationThreshold;
    uint256 public constant MIN_LIQUIDATION_AMOUNT = 100e18;

    // ── Timelock (48h) ─────────────────────────────────────────────────
    uint256 public constant ADMIN_DELAY = 48 hours;

    uint256 public pendingCloseFactor;
    uint256 public pendingCloseFactorTime;
    uint256 public pendingFullLiqThreshold;
    uint256 public pendingFullLiqThresholdTime;

    // ── Events ──────────────────────────────────────────────────────────
    event Liquidation(
        address indexed liquidator,
        address indexed borrower,
        address indexed collateralToken,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event BadDebtDetected(address indexed borrower, uint256 residualDebt, uint256 debtRepaid, uint256 collateralSeized);
    event CloseFactorUpdated(uint256 oldFactor, uint256 newFactor);
    event FullLiquidationThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event CloseFactorChangeRequested(uint256 bps, uint256 readyAt);
    event CloseFactorChangeCancelled(uint256 bps);
    event FullLiqThresholdChangeRequested(uint256 bps, uint256 readyAt);
    event FullLiqThresholdChangeCancelled(uint256 bps);

    // ── Storage gap ─────────────────────────────────────────────────────
    uint256[40] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _vault,
        address _borrowModule,
        address _oracle,
        address _musd,
        uint256 _closeFactorBps
    ) public initializer {
        require(_vault != address(0), "INVALID_VAULT");
        require(_borrowModule != address(0), "INVALID_BORROW_MODULE");
        require(_oracle != address(0), "INVALID_ORACLE");
        require(_musd != address(0), "INVALID_MUSD");
        require(_closeFactorBps > 0 && _closeFactorBps <= 10000, "INVALID_CLOSE_FACTOR");

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        vault = ICollateralVault(_vault);
        borrowModule = IBorrowModule(_borrowModule);
        oracle = IPriceOracle(_oracle);
        musd = IMUSD(_musd);
        closeFactorBps = _closeFactorBps;
        fullLiquidationThreshold = 5000;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ADMIN_ROLE, msg.sender);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ── Timelocked admin: closeFactor ───────────────────────────────────

    function requestCloseFactor(uint256 _bps) external onlyRole(ENGINE_ADMIN_ROLE) {
        require(_bps > 0 && _bps <= 10000, "INVALID_CLOSE_FACTOR");
        require(pendingCloseFactor == 0, "CHANGE_ALREADY_PENDING");
        pendingCloseFactor = _bps;
        pendingCloseFactorTime = block.timestamp;
        emit CloseFactorChangeRequested(_bps, block.timestamp + ADMIN_DELAY);
    }

    function cancelCloseFactor() external onlyRole(ENGINE_ADMIN_ROLE) {
        uint256 cancelled = pendingCloseFactor;
        pendingCloseFactor = 0;
        pendingCloseFactorTime = 0;
        emit CloseFactorChangeCancelled(cancelled);
    }

    function executeCloseFactor() external onlyRole(ENGINE_ADMIN_ROLE) {
        require(pendingCloseFactor > 0, "NOTHING_PENDING");
        require(block.timestamp >= pendingCloseFactorTime + ADMIN_DELAY, "TIMELOCK_NOT_ELAPSED");
        uint256 old = closeFactorBps;
        closeFactorBps = pendingCloseFactor;
        pendingCloseFactor = 0;
        pendingCloseFactorTime = 0;
        emit CloseFactorUpdated(old, closeFactorBps);
    }

    // ── Timelocked admin: fullLiquidationThreshold ──────────────────────

    function requestFullLiquidationThreshold(uint256 _bps) external onlyRole(ENGINE_ADMIN_ROLE) {
        require(_bps > 0 && _bps <= 10000, "INVALID_THRESHOLD");
        require(pendingFullLiqThreshold == 0, "CHANGE_ALREADY_PENDING");
        pendingFullLiqThreshold = _bps;
        pendingFullLiqThresholdTime = block.timestamp;
        emit FullLiqThresholdChangeRequested(_bps, block.timestamp + ADMIN_DELAY);
    }

    function cancelFullLiquidationThreshold() external onlyRole(ENGINE_ADMIN_ROLE) {
        uint256 cancelled = pendingFullLiqThreshold;
        pendingFullLiqThreshold = 0;
        pendingFullLiqThresholdTime = 0;
        emit FullLiqThresholdChangeCancelled(cancelled);
    }

    function executeFullLiquidationThreshold() external onlyRole(ENGINE_ADMIN_ROLE) {
        require(pendingFullLiqThreshold > 0, "NOTHING_PENDING");
        require(block.timestamp >= pendingFullLiqThresholdTime + ADMIN_DELAY, "TIMELOCK_NOT_ELAPSED");
        uint256 old = fullLiquidationThreshold;
        fullLiquidationThreshold = pendingFullLiqThreshold;
        pendingFullLiqThreshold = 0;
        pendingFullLiqThresholdTime = 0;
        emit FullLiquidationThresholdUpdated(old, fullLiquidationThreshold);
    }

    // ── Pause / Unpause ─────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
