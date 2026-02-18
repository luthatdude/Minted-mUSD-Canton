/// @title YieldVerifier Formal Verification Spec
/// @notice Verifies manager-only mutation paths and tolerance semantics.

methods {
    function DEFAULT_TOLERANCE_BPS() external returns (uint256) envfree;
    function MAX_PROTOCOL_ID() external returns (uint256) envfree;
    function MANAGER_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function customTolerance(uint256) external returns (uint256) envfree;
    function getTolerance(uint256) external returns (uint256) envfree;
    function hasAdapter(uint256) external returns (bool) envfree;

    function registerAdapter(uint256, address) external;
    function deactivateAdapter(uint256) external;
    function setTolerance(uint256, uint256) external;

    function _.protocolName() external => PER_CALLEE_CONSTANT;
}

rule default_tolerance_constant_is_750bps() {
    assert DEFAULT_TOLERANCE_BPS() == 750,
        "DEFAULT_TOLERANCE_BPS must remain 750";
}

rule register_adapter_requires_manager(uint256 protocolId, address adapter) {
    env e;
    registerAdapter@withrevert(e, protocolId, adapter);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "registerAdapter must be manager-gated";
}

rule deactivate_adapter_requires_manager(uint256 protocolId) {
    env e;
    deactivateAdapter@withrevert(e, protocolId);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "deactivateAdapter must be manager-gated";
}

rule set_tolerance_requires_manager(uint256 protocolId, uint256 toleranceBps) {
    env e;
    setTolerance@withrevert(e, protocolId, toleranceBps);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "setTolerance must be manager-gated";
}

rule protocol_id_upper_bound_enforced(uint256 protocolId, address adapter) {
    env e;
    require hasRole(MANAGER_ROLE(), e.msg.sender);
    require adapter != 0;
    require protocolId > MAX_PROTOCOL_ID();

    registerAdapter@withrevert(e, protocolId, adapter);

    assert lastReverted,
        "registerAdapter must reject protocolId > MAX_PROTOCOL_ID";
}

rule zero_adapter_is_rejected(uint256 protocolId) {
    env e;
    require hasRole(MANAGER_ROLE(), e.msg.sender);
    require protocolId <= MAX_PROTOCOL_ID();

    registerAdapter@withrevert(e, protocolId, 0);

    assert lastReverted,
        "registerAdapter must reject zero adapter address";
}

rule tolerance_falls_back_to_default_when_unset(uint256 protocolId) {
    require customTolerance(protocolId) == 0;

    assert getTolerance(protocolId) == DEFAULT_TOLERANCE_BPS(),
        "Unset tolerance must resolve to DEFAULT_TOLERANCE_BPS";
}

rule set_tolerance_updates_effective_value(uint256 protocolId, uint256 toleranceBps) {
    env e;
    setTolerance@withrevert(e, protocolId, toleranceBps);

    bool succeeded = !lastReverted;
    uint256 expected = toleranceBps > 0 ? toleranceBps : DEFAULT_TOLERANCE_BPS();

    assert succeeded => getTolerance(protocolId) == expected,
        "Successful setTolerance must update effective tolerance";
}
