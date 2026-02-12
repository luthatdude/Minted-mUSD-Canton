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
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    ICollateralVault public vault;
    IBorrowModule public borrowModule;
    IPriceOracle public oracle;
    IMUSD public musd;

    uint256 public closeFactorBps;
    uint256 public fullLiquidationThreshold;
    uint256 public constant MIN_LIQUIDATION_AMOUNT = 100e18;

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
        uint256 _closeFactorBps,
        address _timelockController
    ) public initializer {
        require(_vault != address(0), "INVALID_VAULT");
        require(_borrowModule != address(0), "INVALID_BORROW_MODULE");
        require(_oracle != address(0), "INVALID_ORACLE");
        require(_musd != address(0), "INVALID_MUSD");
        require(_closeFactorBps > 0 && _closeFactorBps <= 10000, "INVALID_CLOSE_FACTOR");
        require(_timelockController != address(0), "INVALID_TIMELOCK");

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
        _grantRole(TIMELOCK_ROLE, _timelockController);
    }

    /// @dev Only the MintedTimelockController can authorize upgrades (48h delay enforced by OZ TimelockController)
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(TIMELOCK_ROLE) {}

    // ── Admin setters (executed via MintedTimelockController) ───────────

    /// @notice Set close factor — must be called through MintedTimelockController
    /// @dev Timelock delay (48h) is enforced by the OZ TimelockController, not here
    function setCloseFactor(uint256 _bps) external onlyRole(TIMELOCK_ROLE) {
        require(_bps > 0 && _bps <= 10000, "INVALID_CLOSE_FACTOR");
        uint256 old = closeFactorBps;
        closeFactorBps = _bps;
        emit CloseFactorUpdated(old, _bps);
    }

    /// @notice Set full liquidation threshold — must be called through MintedTimelockController
    function setFullLiquidationThreshold(uint256 _bps) external onlyRole(TIMELOCK_ROLE) {
        require(_bps > 0 && _bps <= 10000, "INVALID_THRESHOLD");
        uint256 old = fullLiquidationThreshold;
        fullLiquidationThreshold = _bps;
        emit FullLiquidationThresholdUpdated(old, _bps);
    }

    // ── Pause / Unpause ─────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
