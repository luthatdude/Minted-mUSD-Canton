// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title IGlobalPauseRegistry
/// @notice Interface for the protocol-wide pause registry.
///         Contracts check `isGloballyPaused()` in addition to their local pause state.
interface IGlobalPauseRegistry {
    /// @notice Returns true if the entire protocol is paused
    function isGloballyPaused() external view returns (bool);

    /// @notice Emitted when global pause state changes
    event GlobalPauseStateChanged(bool paused, address indexed caller);
}
