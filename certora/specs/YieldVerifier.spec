/// @title YieldVerifier Formal Verification Spec
/// @notice Certora spec for the on-chain yield verification layer
/// @dev Verifies adapter registration bounds, deactivation behavior, tolerance defaults

methods {
    function DEFAULT_TOLERANCE_BPS() external returns (uint256) envfree;
    function MAX_PROTOCOL_ID() external returns (uint256) envfree;
    function adapterCount() external returns (uint256) envfree;
    function hasAdapter(uint256) external returns (bool) envfree;
    function getTolerance(uint256) external returns (uint256) envfree;
    function customTolerance(uint256) external returns (uint256) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// ADAPTER REGISTRATION BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Protocol ID must not exceed MAX_PROTOCOL_ID
rule register_rejects_invalid_protocol_id(uint256 protocolId, address adapter) {
    env e;
    require protocolId > MAX_PROTOCOL_ID();

    registerAdapter@withrevert(e, protocolId, adapter);

    assert lastReverted,
        "registerAdapter accepted protocolId > MAX_PROTOCOL_ID";
}

/// @notice registerAdapter rejects zero address adapter
rule register_rejects_zero_adapter(uint256 protocolId) {
    env e;
    require protocolId <= MAX_PROTOCOL_ID();

    registerAdapter@withrevert(e, protocolId, 0);

    assert lastReverted,
        "registerAdapter accepted zero address adapter";
}

// ═══════════════════════════════════════════════════════════════════
// DEACTIVATION
// ═══════════════════════════════════════════════════════════════════

/// @notice After deactivation, hasAdapter returns false
rule deactivated_adapter_not_active(uint256 protocolId) {
    env e;
    require hasAdapter(protocolId);

    deactivateAdapter@withrevert(e, protocolId);

    assert !lastReverted => !hasAdapter(protocolId),
        "Deactivated adapter still reported as active";
}

// ═══════════════════════════════════════════════════════════════════
// TOLERANCE DEFAULTS
// ═══════════════════════════════════════════════════════════════════

/// @notice getTolerance returns DEFAULT_TOLERANCE_BPS when no custom tolerance set
rule default_tolerance_when_not_custom(uint256 protocolId) {
    require customTolerance(protocolId) == 0;

    uint256 tolerance = getTolerance(protocolId);

    assert tolerance == DEFAULT_TOLERANCE_BPS(),
        "getTolerance did not return default when custom is 0";
}

/// @notice getTolerance returns custom value when set
rule custom_tolerance_returned(uint256 protocolId) {
    require customTolerance(protocolId) > 0;

    uint256 tolerance = getTolerance(protocolId);

    assert tolerance == customTolerance(protocolId),
        "getTolerance did not return custom tolerance";
}
