// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../TimelockGoverned.sol";

/**
 * @title MockTimelockGoverned
 * @notice Minimal concrete contract inheriting TimelockGoverned for testing
 *         setTimelock(), _setTimelock(), and onlyTimelock modifier in isolation.
 */
contract MockTimelockGoverned is TimelockGoverned {
    uint256 public value;

    constructor(address _timelock) {
        _setTimelock(_timelock);
    }

    /// @notice Timelock-gated setter for testing onlyTimelock modifier
    function setValue(uint256 _value) external onlyTimelock {
        value = _value;
    }

    /// @notice Expose _setTimelock for testing the internal initialiser revert
    function initializeTimelock(address _timelock) external {
        _setTimelock(_timelock);
    }
}
