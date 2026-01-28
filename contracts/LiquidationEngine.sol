// SPDX-License-Identifier: MIT
// BLE Protocol - Liquidation Engine
// Liquidates undercollateralized positions in the borrowing system

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

// FIX H-01: Token decimals interface for proper seizure calculation
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IBorrowModule {
    function totalDebt(address user) external view returns (uint256);
    function healthFactor(address user) external view returns (uint256);
    function reduceDebt(address user, uint256 amount) external;
}

interface IPriceOracleLiq {
    function getPrice(address token) external view returns (uint256);
    function getValueUsd(address token, uint256 amount) external view returns (uint256);
}

interface IMUSDBurn {
    function burn(address from, uint256 amount) external;
}

/// @title LiquidationEngine
/// @notice Liquidates undercollateralized borrowing positions.
///         Liquidators repay a portion of the debt in mUSD and receive
///         the borrower's collateral at a discount (liquidation penalty).
contract LiquidationEngine is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ENGINE_ADMIN_ROLE = keccak256("ENGINE_ADMIN_ROLE");

    ICollateralVaultLiq public immutable vault;
    IBorrowModule public immutable borrowModule;
    IPriceOracleLiq public immutable oracle;
    IMUSDBurn public immutable musd;

    // Maximum percentage of debt that can be liquidated in a single call (basis points)
    // e.g., 5000 = 50% (similar to Aave's close factor)
    uint256 public closeFactorBps;

    // Minimum health factor below which full liquidation is allowed
    uint256 public fullLiquidationThreshold; // bps, e.g., 5000 = 0.5

    event Liquidation(
        address indexed liquidator,
        address indexed borrower,
        address indexed collateralToken,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event CloseFactorUpdated(uint256 oldFactor, uint256 newFactor);

    constructor(
        address _vault,
        address _borrowModule,
        address _oracle,
        address _musd,
        uint256 _closeFactorBps
    ) {
        require(_vault != address(0), "INVALID_VAULT");
        require(_borrowModule != address(0), "INVALID_BORROW_MODULE");
        require(_oracle != address(0), "INVALID_ORACLE");
        require(_musd != address(0), "INVALID_MUSD");
        require(_closeFactorBps > 0 && _closeFactorBps <= 10000, "INVALID_CLOSE_FACTOR");

        vault = ICollateralVaultLiq(_vault);
        borrowModule = IBorrowModule(_borrowModule);
        oracle = IPriceOracleLiq(_oracle);
        musd = IMUSDBurn(_musd);
        closeFactorBps = _closeFactorBps;
        fullLiquidationThreshold = 5000; // 0.5 health factor = allow full liquidation

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ENGINE_ADMIN_ROLE, msg.sender);
    }

    /// @notice Liquidate an undercollateralized position
    /// @param borrower The address of the undercollateralized borrower
    /// @param collateralToken The collateral token to seize
    /// @param debtToRepay Amount of mUSD debt to repay on behalf of borrower
    function liquidate(
        address borrower,
        address collateralToken,
        uint256 debtToRepay
    ) external nonReentrant {
        require(borrower != msg.sender, "CANNOT_SELF_LIQUIDATE");
        require(debtToRepay > 0, "INVALID_AMOUNT");

        // Check position is liquidatable
        uint256 hf = borrowModule.healthFactor(borrower);
        require(hf < 10000, "POSITION_HEALTHY"); // Health factor < 1.0

        // Determine max repayable amount
        uint256 totalDebt = borrowModule.totalDebt(borrower);
        uint256 maxRepay;

        if (hf < fullLiquidationThreshold) {
            // Position is severely undercollateralized — allow full liquidation
            maxRepay = totalDebt;
        } else {
            // Normal liquidation — cap at close factor
            maxRepay = (totalDebt * closeFactorBps) / 10000;
        }

        uint256 actualRepay = debtToRepay > maxRepay ? maxRepay : debtToRepay;

        // Calculate collateral to seize
        // FIX H-01: Use oracle.getValueUsd for proper decimal normalization
        (bool enabled, , , uint256 penaltyBps) = vault.getConfig(collateralToken);
        require(enabled, "COLLATERAL_NOT_SUPPORTED");

        uint256 collateralPrice = oracle.getPrice(collateralToken);
        require(collateralPrice > 0, "INVALID_PRICE");

        // debtRepaid is in 18 decimals (mUSD), price is in 18 decimals (USD per token)
        // seize value in USD = actualRepay * (10000 + penaltyBps) / 10000
        uint256 seizeValueUsd = (actualRepay * (10000 + penaltyBps)) / 10000;

        // FIX H-01: Convert USD value to collateral token amount accounting for token decimals
        // collateralPrice is USD per 1 full token (18 decimals)
        // For a token with D decimals: seizeAmount = seizeValueUsd * 10^D / collateralPrice
        uint8 tokenDecimals = 18; // Default; PriceOracle.getValueUsd handles normalization
        try IERC20Decimals(collateralToken).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {}
        uint256 seizeAmount = (seizeValueUsd * (10 ** tokenDecimals)) / collateralPrice;

        // Cap at available collateral
        uint256 available = vault.deposits(borrower, collateralToken);
        if (seizeAmount > available) {
            seizeAmount = available;
            // Recalculate actual debt repaid based on available collateral
            uint256 seizeValue = oracle.getValueUsd(collateralToken, seizeAmount);
            actualRepay = (seizeValue * 10000) / (10000 + penaltyBps);
        }

        require(seizeAmount > 0, "NOTHING_TO_SEIZE");

        // Execute liquidation:
        // 1. Liquidator pays mUSD (burns it)
        musd.burn(msg.sender, actualRepay);

        // 2. Reduce borrower's debt
        borrowModule.reduceDebt(borrower, actualRepay);

        // 3. Seize collateral to liquidator
        vault.seize(borrower, collateralToken, seizeAmount, msg.sender);

        emit Liquidation(msg.sender, borrower, collateralToken, actualRepay, seizeAmount);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Check if a position is liquidatable
    function isLiquidatable(address borrower) external view returns (bool) {
        uint256 debt = borrowModule.totalDebt(borrower);
        if (debt == 0) return false;
        return borrowModule.healthFactor(borrower) < 10000;
    }

    /// @notice Estimate collateral received for a given debt repayment
    function estimateSeize(
        address borrower,
        address collateralToken,
        uint256 debtToRepay
    ) external view returns (uint256 collateralAmount) {
        (bool enabled, , , uint256 penaltyBps) = vault.getConfig(collateralToken);
        if (!enabled) return 0;

        uint256 collateralPrice = oracle.getPrice(collateralToken);
        if (collateralPrice == 0) return 0;

        uint256 seizeValueUsd = (debtToRepay * (10000 + penaltyBps)) / 10000;
        // FIX H-01: Account for token decimals in estimate
        uint8 tokenDecimals = 18;
        try IERC20Decimals(collateralToken).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {}
        collateralAmount = (seizeValueUsd * (10 ** tokenDecimals)) / collateralPrice;

        uint256 available = vault.deposits(borrower, collateralToken);
        if (collateralAmount > available) {
            collateralAmount = available;
        }
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    function setCloseFactor(uint256 _bps) external onlyRole(ENGINE_ADMIN_ROLE) {
        require(_bps > 0 && _bps <= 10000, "INVALID_CLOSE_FACTOR");
        uint256 old = closeFactorBps;
        closeFactorBps = _bps;
        emit CloseFactorUpdated(old, _bps);
    }

    function setFullLiquidationThreshold(uint256 _bps) external onlyRole(ENGINE_ADMIN_ROLE) {
        require(_bps > 0 && _bps < 10000, "INVALID_THRESHOLD");
        fullLiquidationThreshold = _bps;
    }
}
