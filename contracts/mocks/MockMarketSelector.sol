// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title MockMarketSelector
 * @notice Test mock for IPendleMarketSelector — returns pre-configured market info
 */
contract MockMarketSelector {
    struct MarketInfo {
        address market;
        address sy;
        address pt;
        uint256 expiry;
        uint256 timeToExpiry;
        uint256 totalPt;
        uint256 totalSy;
        uint256 tvlSy;
        uint256 impliedRate;
        uint256 impliedAPY;
        uint256 score;
    }

    address public configuredMarket;
    address public configuredSy;
    address public configuredPt;
    uint256 public configuredExpiry;

    bool public returnZeroMarket;
    bool public returnZeroPt;

    function configure(
        address _market,
        address _sy,
        address _pt,
        uint256 _expiry
    ) external {
        configuredMarket = _market;
        configuredSy = _sy;
        configuredPt = _pt;
        configuredExpiry = _expiry;
    }

    function setReturnZeroMarket(bool _flag) external {
        returnZeroMarket = _flag;
    }

    function setReturnZeroPt(bool _flag) external {
        returnZeroPt = _flag;
    }

    function selectBestMarket(string calldata)
        external
        view
        returns (address bestMarket, MarketInfo memory info)
    {
        if (returnZeroMarket) {
            return (address(0), info);
        }

        bestMarket = configuredMarket;
        info = MarketInfo({
            market: configuredMarket,
            sy: configuredSy,
            pt: returnZeroPt ? address(0) : configuredPt,
            expiry: configuredExpiry,
            timeToExpiry: configuredExpiry > block.timestamp
                ? configuredExpiry - block.timestamp
                : 0,
            totalPt: 1_000_000e6,
            totalSy: 1_000_000e6,
            tvlSy: 2_000_000e6,
            impliedRate: 1e17,  // 10%
            impliedAPY: 1000,   // 10% in bps
            score: 10000
        });
    }

    function isValidMarket(address) external pure returns (bool) {
        return true;
    }
}
