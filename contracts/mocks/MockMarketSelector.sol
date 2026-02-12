// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../interfaces/IPendleMarketSelector.sol";

/**
 * @title MockMarketSelector
 * @notice Simplified mock for testing PendleStrategyV2 without Pendle Oracle dependency
 */
contract MockMarketSelector {
    address private _bestMarket;
    address private _sy;
    address private _pt;
    uint256 private _expiry;

    bool public returnZeroMarket;
    bool public returnZeroPt;

    function configure(
        address market_,
        address sy_,
        address pt_,
        uint256 expiry_
    ) external {
        _bestMarket = market_;
        _sy = sy_;
        _pt = pt_;
        _expiry = expiry_;
    }

    function setReturnZeroMarket(bool val) external {
        returnZeroMarket = val;
    }

    function setReturnZeroPt(bool val) external {
        returnZeroPt = val;
    }

    function selectBestMarket(
        string calldata
    )
        external
        view
        returns (address bestMarket, IPendleMarketSelector.MarketInfo memory info)
    {
        bestMarket = returnZeroMarket ? address(0) : _bestMarket;

        info = IPendleMarketSelector.MarketInfo({
            market: bestMarket,
            sy: _sy,
            pt: returnZeroPt ? address(0) : _pt,
            expiry: _expiry,
            timeToExpiry: _expiry > block.timestamp
                ? _expiry - block.timestamp
                : 0,
            totalPt: 100_000_000e18,
            totalSy: 100_000_000e18,
            tvlSy: 50_000_000e6,
            impliedRate: 100_000_000,
            impliedAPY: 1200,
            score: 8000
        });
    }

    function isValidMarket(address market) external view returns (bool) {
        return market == _bestMarket;
    }
}
