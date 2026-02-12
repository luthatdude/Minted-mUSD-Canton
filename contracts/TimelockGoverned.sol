// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title TimelockGoverned
 * @notice Base contract for all protocol contracts that delegate admin
 *         operations to a MintedTimelockController.
 *
 * @dev REPLACES the per-contract request/cancel/execute + pending-variable
 *      pattern with a single `onlyTimelock` modifier.  The scheduling delay,
 *      cancellation, overwrite-protection, and event emission are all handled
 *      by the OZ TimelockController — no hand-rolled state needed.
 *
 * INTEGRATION PATTERN:
 *   1. Inherit TimelockGoverned
 *   2. Call `_setTimelock(addr)` in the constructor
 *   3. Mark admin setters with `onlyTimelock`
 *   4. Operations are scheduled on the MintedTimelockController,
 *      which calls the setter after the delay expires.
 */
abstract contract TimelockGoverned {
    /// @notice Address of the MintedTimelockController that gates admin ops
    address public timelock;

    event TimelockUpdated(address indexed oldTimelock, address indexed newTimelock);

    error OnlyTimelock();
    error ZeroTimelock();

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    /**
     * @notice Migrate to a new timelock controller.
     * @dev Must be called *through* the current timelock (i.e. scheduled +
     *      executed as a normal timelocked operation).
     */
    function setTimelock(address _timelock) external onlyTimelock {
        if (_timelock == address(0)) revert ZeroTimelock();
        emit TimelockUpdated(timelock, _timelock);
        timelock = _timelock;
    }

    /**
     * @dev Internal initialiser — called once in the constructor (or
     *      `initialize()` for upgradeable variants).
     */
    function _setTimelock(address _timelock) internal {
        if (_timelock == address(0)) revert ZeroTimelock();
        timelock = _timelock;
        emit TimelockUpdated(address(0), _timelock);
    }
}
