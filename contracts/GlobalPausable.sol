// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "./interfaces/IGlobalPauseRegistry.sol";
import "./Errors.sol";


/// @title GlobalPausable
/// @notice Mixin providing `whenNotGloballyPaused` modifier.
///         Contracts inherit this alongside OZ Pausable for layered pause control.
/// @dev    - Local pause: per-contract granular control (existing behavior)
///         - Global pause: protocol-wide emergency stop (this mixin)
///         Both must be unpaused for operations to proceed.
abstract contract GlobalPausable {
    /// @notice The global pause registry (immutable after construction)
    IGlobalPauseRegistry public immutable globalPauseRegistry;

    /// @param _registry Address of the deployed GlobalPauseRegistry
    constructor(address _registry) {
        // Allow address(0) for backward-compatible deployments where global pause
        // is not yet configured. In that case, whenNotGloballyPaused is a no-op.
        globalPauseRegistry = IGlobalPauseRegistry(_registry);
    }

    /// @notice Reverts if the protocol is globally paused.
    ///         Designed to be composed with OZ `whenNotPaused`:
    ///           function deposit(...) external whenNotPaused whenNotGloballyPaused { ... }
    modifier whenNotGloballyPaused() {
        if (address(globalPauseRegistry) != address(0) && globalPauseRegistry.isGloballyPaused()) {
            revert GloballyPaused();
        }
        _;
    }
}
