// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPendleMarketSelector
/// @notice Interface for PendleMarketSelector used by PendleStrategyV2.
/// Import this instead of redeclaring inline.
/// @dev Consumer: PendleStrategyV2
interface IPendleMarketSelector {
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

    function selectBestMarket(string calldata category)
        external
        view
        returns (address bestMarket, MarketInfo memory info);

    function isValidMarket(address market) external view returns (bool);
}
