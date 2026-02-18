/// @title MintedTimelockController Formal Verification Spec
/// @notice Verifies role-gated timelock controls and operation-state consistency.

methods {
    function MIN_CRITICAL_DELAY() external returns (uint256) envfree;
    function MIN_EMERGENCY_DELAY() external returns (uint256) envfree;

    function isPending(bytes32) external returns (bool) envfree;
    function isReady(bytes32) external returns (bool) envfree;
    function isDone(bytes32) external returns (bool) envfree;
    function readyAt(bytes32) external returns (uint256) envfree;

    function PROPOSER_ROLE() external returns (bytes32) envfree;
    function CANCELLER_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function schedule(address, uint256, bytes, bytes32, bytes32, uint256) external;
    function cancel(bytes32) external;
}

rule critical_delay_not_below_emergency_floor() {
    assert MIN_CRITICAL_DELAY() >= MIN_EMERGENCY_DELAY(),
        "Critical delay floor must be >= emergency delay floor";
}

rule operation_states_are_mutually_exclusive(bytes32 id) {
    bool pending = isPending(id);
    bool ready = isReady(id);
    bool done = isDone(id);

    assert !(pending && ready),
        "Operation cannot be pending and ready simultaneously";
    assert !(pending && done),
        "Operation cannot be pending and done simultaneously";
    assert !(ready && done),
        "Operation cannot be ready and done simultaneously";
}

rule schedule_requires_proposer(
    address target,
    uint256 value,
    bytes data,
    bytes32 predecessor,
    bytes32 salt,
    uint256 delay
) {
    env e;
    schedule@withrevert(e, target, value, data, predecessor, salt, delay);

    assert !lastReverted => hasRole(PROPOSER_ROLE(), e.msg.sender),
        "schedule must be proposer-gated";
}

rule cancel_requires_canceller(bytes32 id) {
    env e;
    cancel@withrevert(e, id);

    assert !lastReverted => hasRole(CANCELLER_ROLE(), e.msg.sender),
        "cancel must be canceller-gated";
}
