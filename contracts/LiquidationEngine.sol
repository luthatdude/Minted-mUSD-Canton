// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Liquidation Engine
// Liquidates undercollateralized positions in the borrowing system

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Errors.sol";

interface ICollateralVaultLiq {
    function deposits(address user, address token) external view returns (uint256);
    function getSupportedTokens() external view returns (address[] memory);
    function getConfig(address token) external view returns (
        bool enabled, uint256 collateralFactorBps, uint256 liquidationThresholdBps, uint256 liquidationPenaltyBps
    );
    function seize(address user, address token, uint256 amount, address liquidator) external;
}

interface IPriceOracleLiqExt {
    function getPrice(address token) external view returns (uint256);
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
}

/// @dev Token decimals interface for proper seizure calculation
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IBorrowModule {
    function totalDebt(address user) external view returns (uint256);
    function healthFactor(address user) external view returns (uint256);
    /// @dev Unsafe variant bypasses circuit breaker for liquidation path
    function healthFactorUnsafe(address user) external view returns (uint256);
    function reduceDebt(address user, uint256 amount) external;
    function absorbBadDebt(uint256 amount) external;
}

interface IPriceOracleLiq {
    function getPrice(address token) external view returns (uint256);
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
    /// @dev Unsafe versions bypass circuit breaker for liquidation paths
    function getPriceUnsafe(address token) external view returns (uint256);
    function getValueUsdUnsafe(address token, uint256 amount) external view returns (uint256);
}

interface IMUSDBurn {
    function burn(address from, uint256 amount) external;
}

/// @title LiquidationEngine
/// @notice Liquidates undercollateralized borrowing positions.
///         Liquidators repay a portion of the debt in mUSD and receive
///         the borrower's collateral at a discount (liquidation penalty).
/// @dev SETUP DEPENDENCY — After deployment, the admin MUST:
///      1. Grant LIQUIDATOR_ROLE on MUSD.sol to this contract's address
///         so it can call musd.burn() during liquidations.
///      2. Grant LIQUIDATION_ROLE on CollateralVault to this contract's address
///         so it can call vault.seize() to transfer collateral.
contract LiquidationEngine is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant ENGINE_ADMIN_ROLE = keccak256("ENGINE_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice SOL-H-01: TIMELOCK_ROLE for critical parameter changes
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    ICollateralVaultLiq public immutable vault;
    IBorrowModule public immutable borrowModule;
    IPriceOracleLiq public immutable oracle;
    IMUSDBurn public immutable musd;

    // Maximum percentage of debt that can be liquidated in a single call (basis points)
    // e.g., 5000 = 50% (similar to Aave's close factor)
    uint256 public closeFactorBps;

    // Minimum health factor below which full liquidation is allowed
    uint256 public fullLiquidationThreshold; // bps, e.g., 5000 = 0.5
    
    // Minimum profitable liquidation to prevent dust attacks
    // Set to 100 mUSD (18 decimals) to ensure liquidations are economically meaningful
    uint256 public constant MIN_LIQUIDATION_AMOUNT = 100e18;

    /// @notice Total bad debt accumulated when seizure is capped at available collateral
    /// Bad debt = debt that cannot be recovered because the borrower has insufficient collateral
    uint256 public totalBadDebt;

    /// @notice Per-borrower bad debt for targeted write-off
    mapping(address => uint256) public borrowerBadDebt;

    event BadDebtRecorded(address indexed borrower, uint256 amount, uint256 totalBadDebtAfter);
    event BadDebtSocialized(address indexed borrower, uint256 amount, uint256 totalBadDebtAfter);
    event Liquidation(
        address indexed liquidator,
        address indexed borrower,
        address indexed collateralToken,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event CloseFactorUpdated(uint256 oldFactor, uint256 newFactor);
    event FullLiquidationThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    constructor(
        address _vault,
        address _borrowModule,
        address _oracle,
        address _musd,
        uint256 _closeFactorBps,
        address _timelockController
    ) {
        if (_vault == address(0)) revert InvalidVault();
        if (_borrowModule == address(0)) revert InvalidBorrowModule();
        if (_oracle == address(0)) revert InvalidOracle();
        if (_musd == address(0)) revert InvalidMusd();
        if (_closeFactorBps == 0 || _closeFactorBps > 10000) revert InvalidCloseFactor();
        if (_timelockController == address(0)) revert InvalidAddress();

        vault = ICollateralVaultLiq(_vault);
        borrowModule = IBorrowModule(_borrowModule);
        oracle = IPriceOracleLiq(_oracle);
        musd = IMUSDBurn(_musd);
        closeFactorBps = _closeFactorBps;
        fullLiquidationThreshold = 5000; // 0.5 health factor = allow full liquidation

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ADMIN_ROLE, msg.sender);
        _grantRole(TIMELOCK_ROLE, _timelockController);
        // Make TIMELOCK_ROLE its own admin — DEFAULT_ADMIN cannot grant/revoke it
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }

    /// @notice Liquidate an undercollateralized position
    /// @dev LIQUIDATOR PREREQUISITES:
    ///      1. Hold sufficient mUSD to cover `debtToRepay`
    ///      2. Approve this contract (LiquidationEngine) to spend mUSD via
    ///         `IERC20(musd).approve(address(liquidationEngine), amount)`
    /// @param borrower The address of the undercollateralized borrower
    /// @param collateralToken The collateral token to seize
    /// @param debtToRepay Amount of mUSD debt to repay on behalf of borrower
    function liquidate(
        address borrower,
        address collateralToken,
        uint256 debtToRepay
    ) external nonReentrant whenNotPaused {
        if (borrower == msg.sender) revert CannotSelfLiquidate();
        if (debtToRepay == 0) revert InvalidAmount();
        if (debtToRepay < MIN_LIQUIDATION_AMOUNT) revert DustLiquidation();

        uint256 hf = borrowModule.healthFactorUnsafe(borrower);
        if (hf >= 10000) revert PositionHealthy();

        uint256 actualRepay;
        uint256 seizeAmount;
        (actualRepay, seizeAmount) = _calculateLiquidation(borrower, collateralToken, debtToRepay, hf);

        if (seizeAmount == 0) revert NothingToSeize();

        // Explicit transferFrom + burn-from-self pattern.
        // Standard ERC-20 pull + self-burn (no hidden allowance semantics).
        IERC20(address(musd)).safeTransferFrom(msg.sender, address(this), actualRepay);
        musd.burn(address(this), actualRepay);
        vault.seize(borrower, collateralToken, seizeAmount, msg.sender);
        borrowModule.reduceDebt(borrower, actualRepay);

        emit Liquidation(msg.sender, borrower, collateralToken, actualRepay, seizeAmount);
    }

    /// @dev Internal calculation to avoid stack-too-deep in liquidate()
    function _calculateLiquidation(
        address borrower,
        address collateralToken,
        uint256 debtToRepay,
        uint256 hf
    ) internal returns (uint256 actualRepay, uint256 seizeAmount) {
        uint256 totalDebt = borrowModule.totalDebt(borrower);
        uint256 maxRepay = hf < fullLiquidationThreshold ? totalDebt : (totalDebt * closeFactorBps) / 10000;
        actualRepay = debtToRepay > maxRepay ? maxRepay : debtToRepay;

        (, , , uint256 penaltyBps) = vault.getConfig(collateralToken);
        uint256 collateralPrice = oracle.getPriceUnsafe(collateralToken);
        if (collateralPrice == 0) revert InvalidPrice();

        seizeAmount = (actualRepay * (10000 + penaltyBps) * (10 ** IERC20Decimals(collateralToken).decimals())) / (10000 * collateralPrice);

        // Cap at available collateral + track bad debt
        (actualRepay, seizeAmount) = _capSeizureAndTrackBadDebt(
            borrower, collateralToken, actualRepay, seizeAmount, penaltyBps
        );
    }

    /// @dev Cap seizure at available collateral and record any bad debt
    function _capSeizureAndTrackBadDebt(
        address borrower,
        address collateralToken,
        uint256 actualRepay,
        uint256 seizeAmount,
        uint256 penaltyBps
    ) internal returns (uint256, uint256) {
        uint256 available = vault.deposits(borrower, collateralToken);
        if (seizeAmount > available) {
            seizeAmount = available;
            uint256 seizeValue = oracle.getValueUsdUnsafe(collateralToken, seizeAmount);
            uint256 cappedRepay = (seizeValue * 10000) / (10000 + penaltyBps);

            if (actualRepay > cappedRepay) {
                uint256 badDebtAmount = actualRepay - cappedRepay;
                totalBadDebt += badDebtAmount;
                borrowerBadDebt[borrower] += badDebtAmount;
                emit BadDebtRecorded(borrower, badDebtAmount, totalBadDebt);
            }
            actualRepay = cappedRepay;
        }
        return (actualRepay, seizeAmount);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Check if a position is liquidatable
    /// @dev Uses healthFactorUnsafe() to match liquidate() behavior.
    ///      Standard healthFactor() reverts when circuit breaker trips,
    ///      which would cause isLiquidatable to revert while liquidate() succeeds.
    function isLiquidatable(address borrower) external view returns (bool) {
        uint256 debt = borrowModule.totalDebt(borrower);
        if (debt == 0) return false;
        return borrowModule.healthFactorUnsafe(borrower) < 10000;
    }

    /// @notice Estimate collateral received for a given debt repayment
    /// @notice Estimate collateral received for a given debt repayment
    function estimateSeize(
        address borrower,
        address collateralToken,
        uint256 debtToRepay
    ) external view returns (uint256 collateralAmount) {
        (, , , uint256 penaltyBps) = vault.getConfig(collateralToken);

        // Use unsafe version so estimates work even when circuit breaker trips
        uint256 collateralPrice = oracle.getPriceUnsafe(collateralToken);
        if (collateralPrice == 0) return 0;

        // Combined calculation avoids divide-before-multiply precision loss
        uint8 tokenDecimals = IERC20Decimals(collateralToken).decimals();
        collateralAmount = (debtToRepay * (10000 + penaltyBps) * (10 ** tokenDecimals)) / (10000 * collateralPrice);

        uint256 available = vault.deposits(borrower, collateralToken);
        if (collateralAmount > available) {
            collateralAmount = available;
        }
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    /// @dev SOL-H-01: Changed from ENGINE_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setCloseFactor(uint256 _bps) external onlyRole(TIMELOCK_ROLE) {
        if (_bps == 0 || _bps > 10000) revert InvalidCloseFactor();
        uint256 old = closeFactorBps;
        closeFactorBps = _bps;
        emit CloseFactorUpdated(old, _bps);
    }

    /// @dev SOL-H-01: Changed from ENGINE_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setFullLiquidationThreshold(uint256 _bps) external onlyRole(TIMELOCK_ROLE) {
        if (_bps == 0 || _bps >= 10000) revert InvalidThreshold();
        emit FullLiquidationThresholdUpdated(fullLiquidationThreshold, _bps);
        fullLiquidationThreshold = _bps;
    }

    /// @notice Write off bad debt for a specific borrower
    /// @dev Called after all collateral has been seized and position is fully underwater.
    ///      Reduces totalBadDebt accounting and realizes the loss in BorrowModule:
    ///      reserves absorb first, residual queues supplier-interest haircut.
    /// @dev SOL-M-21: Changed from ENGINE_ADMIN_ROLE to TIMELOCK_ROLE — bad debt write-off is a critical operation
    function socializeBadDebt(address borrower) external onlyRole(TIMELOCK_ROLE) {
        uint256 recorded = borrowerBadDebt[borrower];
        if (recorded == 0) revert NoBadDebt();

        // If borrower repaid part of debt after liquidation, only socialize remaining debt.
        uint256 currentDebt = borrowModule.totalDebt(borrower);
        uint256 socializedAmount = recorded > currentDebt ? currentDebt : recorded;

        borrowerBadDebt[borrower] = 0;
        totalBadDebt -= recorded;

        if (socializedAmount > 0) {
            // 1) Remove borrower liability from debt book.
            borrowModule.reduceDebt(borrower, socializedAmount);
            // 2) Realize loss economically (reserves first, then supplier queue).
            borrowModule.absorbBadDebt(socializedAmount);
        }

        emit BadDebtSocialized(borrower, socializedAmount, totalBadDebt);
    }

    // ============================================================
    //                  EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause liquidations
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause liquidations
    /// @dev SOL-H-03: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — consistent unpause governance
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }
}
