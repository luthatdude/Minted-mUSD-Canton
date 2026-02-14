// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title LeverageMathLib
 * @notice Pure math library for leverage loop strategy calculations
 * @dev Extracted from strategy contracts for code reuse and gas savings
 */
library LeverageMathLib {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    /// @notice Calculate flash loan amount needed for target leverage
    /// @param depositAmount User's deposit amount
    /// @param targetLtvBps Target LTV in basis points (e.g., 7500 = 75%)
    /// @return flashAmount Amount to flash loan
    function calculateFlashLoanAmount(
        uint256 depositAmount,
        uint256 targetLtvBps
    ) internal pure returns (uint256 flashAmount) {
        if (targetLtvBps >= BPS) return 0;
        flashAmount = (depositAmount * targetLtvBps) / (BPS - targetLtvBps);
    }

    /// @notice Calculate effective leverage from LTV
    /// @param ltvBps LTV in basis points
    /// @return leverageX100 Leverage multiplied by 100 (e.g., 400 = 4x)
    function ltvToLeverage(uint256 ltvBps) internal pure returns (uint256 leverageX100) {
        if (ltvBps >= BPS) return type(uint256).max;
        leverageX100 = (BPS * 100) / (BPS - ltvBps);
    }

    /// @notice Calculate current LTV from collateral and debt
    /// @param collateral Total collateral value
    /// @param debt Total debt value
    /// @return ltvBps Current LTV in basis points
    function calculateLtv(
        uint256 collateral,
        uint256 debt
    ) internal pure returns (uint256 ltvBps) {
        if (collateral == 0) return 0;
        ltvBps = (debt * BPS) / collateral;
    }

    /// @notice Calculate health factor from collateral and debt
    /// @param collateral Total collateral value
    /// @param debt Total debt value
    /// @return healthFactor Health factor in WAD (1e18 = 1.0)
    function calculateHealthFactor(
        uint256 collateral,
        uint256 debt
    ) internal pure returns (uint256 healthFactor) {
        if (debt == 0) return type(uint256).max;
        healthFactor = (collateral * WAD) / debt;
    }

    /// @notice Calculate net value (collateral - debt), floored at 0
    /// @param collateral Total collateral
    /// @param debt Total debt
    /// @return netValue Net position value
    function calculateNetValue(
        uint256 collateral,
        uint256 debt
    ) internal pure returns (uint256 netValue) {
        netValue = collateral > debt ? collateral - debt : 0;
    }

    /// @notice Calculate share price given total value and total shares
    /// @param totalValue Total value in asset terms
    /// @param totalShares Total shares (principal) outstanding
    /// @return priceWad Share price in WAD (1e18 = 1.0)
    function calculateSharePrice(
        uint256 totalValue,
        uint256 totalShares
    ) internal pure returns (uint256 priceWad) {
        if (totalShares == 0) return WAD; // Default 1:1
        priceWad = (totalValue * WAD) / totalShares;
    }

    /// @notice Check if LTV drift exceeds threshold for rebalance trigger
    /// @param currentLtv Current LTV in BPS
    /// @param targetLtv Target LTV in BPS
    /// @param thresholdBps Rebalance trigger threshold in BPS
    /// @return needsRebalance_ Whether rebalancing is needed
    /// @return isOverLeveraged True if over-leveraged, false if under
    function needsRebalance(
        uint256 currentLtv,
        uint256 targetLtv,
        uint256 thresholdBps
    ) internal pure returns (bool needsRebalance_, bool isOverLeveraged) {
        if (currentLtv > targetLtv + thresholdBps) {
            return (true, true);
        }
        if (currentLtv + thresholdBps < targetLtv) {
            return (true, false);
        }
        return (false, false);
    }

    /// @notice Calculate deleverage amount needed
    /// @param collateral Current collateral
    /// @param debt Current debt
    /// @param targetLtvBps Target LTV
    /// @return excessDebt Amount of debt to repay
    function calculateDeleverageAmount(
        uint256 collateral,
        uint256 debt,
        uint256 targetLtvBps
    ) internal pure returns (uint256 excessDebt) {
        uint256 targetDebt = (collateral * targetLtvBps) / BPS;
        excessDebt = debt > targetDebt ? debt - targetDebt : 0;
    }

    /// @notice Calculate releverage amount needed
    /// @param collateral Current collateral
    /// @param debt Current debt
    /// @param targetLtvBps Target LTV
    /// @return deficitDebt Additional debt to take on
    function calculateReleverageAmount(
        uint256 collateral,
        uint256 debt,
        uint256 targetLtvBps
    ) internal pure returns (uint256 deficitDebt) {
        uint256 targetDebt = (collateral * targetLtvBps) / BPS;
        deficitDebt = targetDebt > debt ? targetDebt - debt : 0;
    }

    /// @notice Validate share price hasn't dropped below minimum
    /// @param currentPrice Current share price in WAD
    /// @param minPrice Minimum acceptable share price in WAD
    /// @return valid True if price is acceptable
    function validateSharePrice(
        uint256 currentPrice,
        uint256 minPrice
    ) internal pure returns (bool valid) {
        valid = currentPrice >= minPrice;
    }
}
