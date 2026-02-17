// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IYieldAdapter.sol";

/**
 * @title MorphoBlueAdapter
 * @notice IYieldAdapter for Morpho Blue markets.
 *         Reads market state + IRM for supply/borrow APY.
 */

interface IMorphoBlueForAdapter {
    struct MarketData {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }
    function market(bytes32 id) external view returns (MarketData memory);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
}

interface IMorphoIRMForAdapter {
    function borrowRateView(
        IMorphoBlueForAdapter.MarketParams calldata params,
        IMorphoBlueForAdapter.MarketData calldata data
    ) external view returns (uint256);
}

contract MorphoBlueAdapter is IYieldAdapter {
    uint256 private constant SECONDS_PER_YEAR = 365.25 days;
    uint256 private constant BPS = 10_000;
    /// @dev Morpho fee is stored as a WAD fraction (1e18 = 100%) in market().fee
    /// No more hardcoded FEE_BPS — we read it directly from the market state

    function verify(
        address venue,
        bytes32 extraData   // marketId
    ) external view override returns (
        uint256 supplyApyBps,
        uint256 borrowApyBps,
        uint256 tvlUsd6,
        uint256 utilizationBps,
        bool available
    ) {
        IMorphoBlueForAdapter morpho = IMorphoBlueForAdapter(venue);

        IMorphoBlueForAdapter.MarketData memory data = morpho.market(extraData);
        IMorphoBlueForAdapter.MarketParams memory params = morpho.idToMarketParams(extraData);

        uint256 totalSup = uint256(data.totalSupplyAssets);
        uint256 totalBor = uint256(data.totalBorrowAssets);

        // Utilization
        utilizationBps = totalSup > 0 ? (totalBor * BPS) / totalSup : 0;

        // Borrow rate from IRM
        uint256 borrowRateAnnual = 0;
        if (params.irm != address(0)) {
            try IMorphoIRMForAdapter(params.irm).borrowRateView(params, data)
                returns (uint256 ratePerSec) {
                borrowRateAnnual = ratePerSec * SECONDS_PER_YEAR;
            } catch {}
        }

        borrowApyBps = borrowRateAnnual / 1e14;

        // Supply rate = borrow_rate * utilization * (1 - fee)
        // fee is stored as WAD in market state (e.g., 0.1e18 = 10%)
        uint256 feeWad = uint256(data.fee);
        uint256 oneMinusFee = feeWad >= 1e18 ? 0 : (1e18 - feeWad);
        supplyApyBps = totalSup > 0
            ? (borrowRateAnnual * totalBor * oneMinusFee) / (totalSup * 1e18) / 1e14
            : 0;

        tvlUsd6 = totalSup;
        available = true;
    }

    function protocolName() external pure override returns (string memory) {
        return "Morpho Blue";
    }

    function protocolId() external pure override returns (uint256) {
        return 2; // MorphoBlue
    }
}
