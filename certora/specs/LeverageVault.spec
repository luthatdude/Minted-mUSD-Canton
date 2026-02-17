/// @title LeverageVault Formal Verification Spec
/// @notice Certora spec for the LeverageVault single-tx leveraged positions
/// @dev Verifies position lifecycle, leverage bounds, access control, pause, and emergency ops.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function maxLeverageX10()       external returns (uint256) envfree;
    function paused()               external returns (bool)    envfree;

    // ── State-changing functions ──
    function openLeveragedPosition(address, uint256, uint256, uint256, uint256) external returns (uint256, uint256, uint256);
    function closeLeveragedPosition(uint256) external returns (uint256);
    function closeLeveragedPositionWithMusd(uint256, uint256) external returns (uint256);
    function emergencyClosePosition(address) external;
    function setMaxLeverage(uint256) external;
    function pause() external;
    function unpause() external;

    // ── Role constants (envfree) ──
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.depositFor(address, address, uint256)        external => NONDET;
    function _.withdrawFor(address, address, uint256, address, bool) external => NONDET;
    function _.borrow(address, uint256)                     external => NONDET;
    function _.repay(address, uint256)                      external => NONDET;
    function _.getConfig(address) external                  => NONDET;
    function _.getDebt(address) external                    => PER_CALLEE_CONSTANT;
    function _.mint(address, uint256) external              => NONDET;
    function _.burn(address, uint256) external              => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice maxLeverageX10 is always in [10, 40] (1x to 4x)
invariant maxLeverageInRange()
    maxLeverageX10() >= 10 && maxLeverageX10() <= 40;

// ═══════════════════════════════════════════════════════════════════
// RULES: OPEN POSITION
// ═══════════════════════════════════════════════════════════════════

/// @notice Opening with zero collateral must revert
rule openRequiresCollateral() {
    env e;
    address token; uint256 targetLev; uint256 maxLoops; uint256 deadline;
    openLeveragedPosition@withrevert(e, token, 0, targetLev, maxLoops, deadline);
    assert lastReverted, "Opening with zero collateral must revert";
}

/// @notice Opening with leverage < 1x (< 10) must revert
rule openRejectsLowLeverage() {
    env e;
    address token; uint256 amount; uint256 maxLoops; uint256 deadline;
    openLeveragedPosition@withrevert(e, token, amount, 9, maxLoops, deadline);
    assert lastReverted, "Opening with leverage < 10 must revert";
}

/// @notice Opening when paused must revert
rule openBlockedWhenPaused() {
    env e;
    require paused();
    address token; uint256 amount; uint256 lev; uint256 loops; uint256 dl;
    openLeveragedPosition@withrevert(e, token, amount, lev, loops, dl);
    assert lastReverted, "Opening position while paused must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: CLOSE POSITION
// ═══════════════════════════════════════════════════════════════════

/// @notice Closing when paused must revert
rule closeBlockedWhenPaused() {
    env e;
    require paused();
    closeLeveragedPosition@withrevert(e, 0);
    assert lastReverted, "Closing position while paused must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LEVERAGE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice setMaxLeverage rejects values < 10 (1x)
rule setMaxLeverage_min() {
    env e;
    setMaxLeverage@withrevert(e, 9);
    assert lastReverted, "setMaxLeverage must reject < 10";
}

/// @notice setMaxLeverage rejects values > 40 (4x)
rule setMaxLeverage_max() {
    env e;
    setMaxLeverage@withrevert(e, 41);
    assert lastReverted, "setMaxLeverage must reject > 40";
}

/// @notice setMaxLeverage stores value on success
rule setMaxLeverage_stores(uint256 val) {
    env e;
    require val >= 10 && val <= 40;
    setMaxLeverage@withrevert(e, val);
    bool succeeded = !lastReverted;
    assert succeeded => maxLeverageX10() == val,
        "setMaxLeverage must store the new value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only DEFAULT_ADMIN_ROLE can call emergencyClosePosition()
rule emergencyClose_requires_admin(address user) {
    env e;
    emergencyClosePosition@withrevert(e, user);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can emergencyClosePosition";
}
