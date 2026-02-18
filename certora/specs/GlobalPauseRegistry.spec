/// @title GlobalPauseRegistry Formal Verification Spec
/// @notice Verifies global pause state transitions and role-gated controls.

methods {
    function isGloballyPaused() external returns (bool) envfree;
    function lastPausedAt() external returns (uint256) envfree;
    function lastUnpausedAt() external returns (uint256) envfree;

    function GUARDIAN_ROLE() external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function pauseGlobal() external;
    function unpauseGlobal() external;
}

rule pause_requires_guardian() {
    env e;
    pauseGlobal@withrevert(e);

    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "pauseGlobal must be guardian-gated";
}

rule unpause_requires_admin() {
    env e;
    unpauseGlobal@withrevert(e);

    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "unpauseGlobal must be admin-gated";
}

rule pause_sets_global_flag_on_success() {
    env e;
    pauseGlobal@withrevert(e);

    assert !lastReverted => isGloballyPaused(),
        "Successful pauseGlobal must set paused=true";
}

rule unpause_clears_global_flag_on_success() {
    env e;
    unpauseGlobal@withrevert(e);

    assert !lastReverted => !isGloballyPaused(),
        "Successful unpauseGlobal must set paused=false";
}

rule pause_reverts_if_already_paused() {
    env e;
    require isGloballyPaused();

    pauseGlobal@withrevert(e);

    assert lastReverted,
        "pauseGlobal must revert when already paused";
}

rule unpause_reverts_if_not_paused() {
    env e;
    require !isGloballyPaused();

    unpauseGlobal@withrevert(e);

    assert lastReverted,
        "unpauseGlobal must revert when not paused";
}
