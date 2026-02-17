// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ISY
/// @notice Pendle Standardized Yield (read-only) interface for PendleMarketSelector.
/// Import this instead of redeclaring inline.
/// @dev Consumer: PendleMarketSelector
interface ISY {
    function yieldToken() external view returns (address);
    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
    function exchangeRate() external view returns (uint256);
}
