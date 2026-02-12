// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPendlePT
/// @notice Pendle Principal Token interface.
/// Import this instead of redeclaring inline.
/// @dev Consumer: PendleStrategyV2
interface IPendlePT {
    function SY() external view returns (address);
    function YT() external view returns (address);
    function isExpired() external view returns (bool);
    function expiry() external view returns (uint256);
}
