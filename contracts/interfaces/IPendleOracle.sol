// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPendleOracle
/// @notice Pendle Oracle interface for rate conversions.
/// Import this instead of redeclaring inline.
/// @dev Consumer: PendleMarketSelector
interface IPendleOracle {
    function getPtToSyRate(address market, uint32 duration) external view returns (uint256);
    function getYtToSyRate(address market, uint32 duration) external view returns (uint256);
    function getLpToSyRate(address market, uint32 duration) external view returns (uint256);
}
