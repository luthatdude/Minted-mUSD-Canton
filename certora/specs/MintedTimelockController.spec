/// @title MintedTimelockController Formal Verification Spec
/// @notice Certora spec for the governance timelock with minimum delay floors
/// @dev Verifies operation lifecycle, minimum delay enforcement, and role separation

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function getMinDelay() external returns (uint256) envfree;
    function MIN_CRITICAL_DELAY() external returns (uint256) envfree;
    function MIN_EMERGENCY_DELAY() external returns (uint256) envfree;
    function isOperation(bytes32) external returns (bool) envfree;
    function isOperationPending(bytes32) external returns (bool) envfree;
    function isOperationReady(bytes32) external returns (bool) envfree;
    function isOperationDone(bytes32) external returns (bool) envfree;
    function getOperationState(bytes32) external returns (uint8) envfree;
    function getTimestamp(bytes32) external returns (uint256) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
    function PROPOSER_ROLE() external returns (bytes32) envfree;
    function EXECUTOR_ROLE() external returns (bytes32) envfree;
    function CANCELLER_ROLE() external returns (bytes32) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice Minimum delay is always >= MIN_EMERGENCY_DELAY (24 hours)
rule min_delay_floor_holds() {
    assert to_mathint(getMinDelay()) >= to_mathint(MIN_EMERGENCY_DELAY()),
        "minDelay must always be >= MIN_EMERGENCY_DELAY (24h)";
}

/// @notice Schedule creates a pending operation
rule schedule_creates_pending(bytes32 id, address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay) {
    env e;
    require !isOperation(id);

    schedule@withrevert(e, target, value, data, predecessor, salt, delay);
    bool succeeded = !lastReverted;

    assert succeeded => isOperationPending(id),
        "Scheduled operation must be pending";
}

/// @notice Pending operation has a future timestamp
rule pending_operation_has_timestamp(bytes32 id) {
    require isOperationPending(id);
    require !isOperationDone(id);

    assert to_mathint(getTimestamp(id)) > 0,
        "Pending operation must have a non-zero timestamp";
}

/// @notice Done operations cannot transition back to pending
rule done_operations_are_final(bytes32 id, address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay) {
    env e;
    require isOperationDone(id);

    schedule@withrevert(e, target, value, data, predecessor, salt, delay);

    assert lastReverted,
        "Cannot re-schedule an already completed operation";
}

/// @notice Non-proposers cannot schedule operations
rule only_proposer_can_schedule(address caller, address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay) {
    env e;
    require e.msg.sender == caller;
    require !hasRole(PROPOSER_ROLE(), caller);

    schedule@withrevert(e, target, value, data, predecessor, salt, delay);

    assert lastReverted,
        "Non-proposer must not be able to schedule operations";
}
