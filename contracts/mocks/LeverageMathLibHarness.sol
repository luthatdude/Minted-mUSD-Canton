// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../libraries/LeverageMathLib.sol";

/**
 * @title LeverageMathLibHarness
 * @notice Test harness that exposes LeverageMathLib internal functions as public
 */
contract LeverageMathLibHarness {
    function calculateFlashLoanAmount(
        uint256 depositAmount,
        uint256 targetLtvBps
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateFlashLoanAmount(depositAmount, targetLtvBps);
    }

    function ltvToLeverage(uint256 ltvBps) external pure returns (uint256) {
        return LeverageMathLib.ltvToLeverage(ltvBps);
    }

    function calculateLtv(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateLtv(collateral, debt);
    }

    function calculateHealthFactor(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateHealthFactor(collateral, debt);
    }

    function calculateNetValue(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateNetValue(collateral, debt);
    }

    function calculateSharePrice(
        uint256 totalValue,
        uint256 totalShares
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateSharePrice(totalValue, totalShares);
    }

    function needsRebalance(
        uint256 currentLtv,
        uint256 targetLtv,
        uint256 thresholdBps
    ) external pure returns (bool needsRebalance_, bool isOverLeveraged) {
        return LeverageMathLib.needsRebalance(currentLtv, targetLtv, thresholdBps);
    }

    function calculateDeleverageAmount(
        uint256 collateral,
        uint256 debt,
        uint256 targetLtvBps
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateDeleverageAmount(collateral, debt, targetLtvBps);
    }

    function calculateReleverageAmount(
        uint256 collateral,
        uint256 debt,
        uint256 targetLtvBps
    ) external pure returns (uint256) {
        return LeverageMathLib.calculateReleverageAmount(collateral, debt, targetLtvBps);
    }

    function validateSharePrice(
        uint256 currentPrice,
        uint256 minPrice
    ) external pure returns (bool) {
        return LeverageMathLib.validateSharePrice(currentPrice, minPrice);
    }
}
