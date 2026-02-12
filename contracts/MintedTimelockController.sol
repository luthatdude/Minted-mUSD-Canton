// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title MintedTimelockController
 * @notice Central timelock for ALL admin operations across the Minted mUSD protocol.
 * @dev Replaces 30+ hand-rolled timelock patterns with a single, audited, battle-tested
 *      OpenZeppelin TimelockController.
 *
 * KEY BENEFITS:
 * 1. Single point to enumerate ALL pending operations (via OperationState queries)
 * 2. Consistent overwrite protection (built into OZ — cannot schedule over existing operation)
 * 3. Role-based access: PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE
 * 4. Batch operations: schedule multiple contract calls atomically
 * 5. Audited by OpenZeppelin — no hand-rolled bugs
 *
 * ARCHITECTURE:
 * - This contract is the DEFAULT_ADMIN_ROLE owner of all protocol contracts
 * - Admin operations are proposed here with a 48h delay
 * - Anyone with EXECUTOR_ROLE can execute after the delay
 * - CANCELLER_ROLE can cancel pending operations
 *
 * MIGRATION:
 * 1. Deploy MintedTimelockController with proposers, executors, and admin
 * 2. Grant DEFAULT_ADMIN_ROLE on each protocol contract to this timelock
 * 3. Admin renounces direct admin roles on protocol contracts
 * 4. All future admin operations go through this timelock
 *
 * USAGE EXAMPLE:
 *   // Schedule a PriceOracle.setFeed() call:
 *   bytes memory data = abi.encodeCall(PriceOracle.executeSetFeed, ());
 *   timelock.schedule(address(oracle), 0, data, bytes32(0), salt, 48 hours);
 *   // ... wait 48 hours ...
 *   timelock.execute(address(oracle), 0, data, bytes32(0), salt);
 */
contract MintedTimelockController is TimelockController {
    /// @notice Minimum delay for critical operations (48 hours)
    uint256 public constant MIN_CRITICAL_DELAY = 48 hours;

    /// @notice Minimum delay for emergency operations (24 hours)
    uint256 public constant MIN_EMERGENCY_DELAY = 24 hours;

    /**
     * @param minDelay Initial minimum delay for operations (should be 48 hours)
     * @param proposers Addresses that can schedule operations (protocol multisig)
     * @param executors Addresses that can execute ready operations (can include address(0) for anyone)
     * @param admin Address that can change timelock settings (should be address(0) after setup)
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        require(minDelay >= MIN_EMERGENCY_DELAY, "DELAY_TOO_SHORT");
    }

    /// @notice Check if an operation is pending (scheduled but not yet executable)
    function isPending(bytes32 id) public view returns (bool) {
        return isOperationPending(id);
    }

    /// @notice Check if an operation is ready to execute
    function isReady(bytes32 id) public view returns (bool) {
        return isOperationReady(id);
    }

    /// @notice Check if an operation has been executed
    function isDone(bytes32 id) public view returns (bool) {
        return isOperationDone(id);
    }

    /// @notice Get the timestamp when an operation becomes executable
    function readyAt(bytes32 id) public view returns (uint256) {
        return getTimestamp(id);
    }
}
