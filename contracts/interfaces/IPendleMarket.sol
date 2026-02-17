// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPendleMarket
/// @notice Pendle Market interface — superset used by PendleMarketSelector and PendleStrategyV2.
/// Import this instead of redeclaring inline.
/// @dev Consumers: PendleMarketSelector, PendleStrategyV2
interface IPendleMarket {
    function readTokens() external view returns (address sy, address pt, address yt);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);

    /// @notice Market internal storage — totalPt, totalSy, lastLnImpliedRate, etc.
    /// @dev Used by PendleMarketSelector for TVL/rate scoring
    function _storage() external view returns (
        int128 totalPt,
        int128 totalSy,
        uint96 lastLnImpliedRate,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext
    );
}
