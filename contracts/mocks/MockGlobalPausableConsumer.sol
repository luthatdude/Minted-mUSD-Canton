// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../GlobalPausable.sol";

/**
 * @title MockGlobalPausableConsumer
 * @notice Minimal contract inheriting GlobalPausable for testing the
 *         `whenNotGloballyPaused` modifier in isolation.
 */
contract MockGlobalPausableConsumer is GlobalPausable {
    uint256 public counter;

    constructor(address _registry) GlobalPausable(_registry) {}

    /// @notice Guarded function — reverts when globally paused
    function doSomething() external whenNotGloballyPaused returns (bool) {
        counter += 1;
        return true;
    }

    /// @notice Unguarded function — always succeeds
    function doUnguarded() external pure returns (bool) {
        return true;
    }
}
