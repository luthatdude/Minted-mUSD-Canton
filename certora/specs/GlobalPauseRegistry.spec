/// @title GlobalPauseRegistry Formal Verification Spec
/// @notice Certora spec for the global circuit-breaker pause registry
/// @dev Verifies pause/unpause separation of duties, toggle consistency, and no double-action

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function isGloballyPaused() external returns (bool) envfree;
    function lastPausedAt() external returns (uint256) envfree;
    function lastUnpausedAt() external returns (uint256) envfree;
    function GUARDIAN_ROLE() external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice pauseGlobal transitions from unpaused to paused
rule pause_sets_globally_paused() {
    env e;
    bool pausedBefore = isGloballyPaused();
    require !pausedBefore, "Must start unpaused to test pause";

    pauseGlobal@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => isGloballyPaused(),
        "pauseGlobal must set isGloballyPaused to true";
}

/// @notice unpauseGlobal transitions from paused to unpaused
rule unpause_clears_globally_paused() {
    env e;
    bool pausedBefore = isGloballyPaused();
    require pausedBefore, "Must start paused to test unpause";

    unpauseGlobal@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => !isGloballyPaused(),
        "unpauseGlobal must set isGloballyPaused to false";
}

/// @notice pauseGlobal reverts when already paused (no double-pause)
rule no_double_pause() {
    env e;
    require isGloballyPaused();

    pauseGlobal@withrevert(e);

    assert lastReverted, "pauseGlobal must revert when already paused";
}

/// @notice unpauseGlobal reverts when already unpaused (no double-unpause)
rule no_double_unpause() {
    env e;
    require !isGloballyPaused();

    unpauseGlobal@withrevert(e);

    assert lastReverted, "unpauseGlobal must revert when already unpaused";
}

/// @notice pauseGlobal updates lastPausedAt timestamp
rule pause_updates_timestamp() {
    env e;
    require !isGloballyPaused();
    uint256 tsBefore = lastPausedAt();

    pauseGlobal@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => lastPausedAt() == e.block.timestamp,
        "pauseGlobal must update lastPausedAt to current block timestamp";
}

/// @notice unpauseGlobal updates lastUnpausedAt timestamp
rule unpause_updates_timestamp() {
    env e;
    require isGloballyPaused();
    uint256 tsBefore = lastUnpausedAt();

    unpauseGlobal@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => lastUnpausedAt() == e.block.timestamp,
        "unpauseGlobal must update lastUnpausedAt to current block timestamp";
}

/// @notice Only GUARDIAN_ROLE can successfully pause
rule only_guardian_can_pause(address caller) {
    env e;
    require e.msg.sender == caller;
    require !isGloballyPaused();
    require !hasRole(GUARDIAN_ROLE(), caller);

    pauseGlobal@withrevert(e);

    assert lastReverted,
        "Non-guardian must not be able to pauseGlobal";
}

/// @notice Only DEFAULT_ADMIN_ROLE can successfully unpause
rule only_admin_can_unpause(address caller) {
    env e;
    require e.msg.sender == caller;
    require isGloballyPaused();
    require !hasRole(DEFAULT_ADMIN_ROLE(), caller);

    unpauseGlobal@withrevert(e);

    assert lastReverted,
        "Non-admin must not be able to unpauseGlobal";
}
