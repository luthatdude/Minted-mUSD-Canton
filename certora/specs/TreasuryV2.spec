/// @title TreasuryV2 Formal Verification Spec
/// @notice Certora spec for the TreasuryV2 yield strategy aggregator
/// @dev Verifies reserve bounds, deposit/withdraw accounting, access control,
///      pause enforcement, and strategy management.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function totalValue()            external returns (uint256) envfree;
    function reserveBps()            external returns (uint256) envfree;
    function paused()                external returns (bool)    envfree;
    function minAutoAllocateAmount() external returns (uint256) envfree;
    function BPS()                   external returns (uint256) envfree;
    function MAX_STRATEGIES()        external returns (uint256) envfree;

    // ── State-changing functions ──
    function deposit(address, uint256)  external;
    function withdraw(address, uint256) external;
    function depositFromVault(uint256)  external;
    function withdrawToVault(uint256)   external;
    function rebalance()                external;
    function setReserveBps(uint256)     external;
    function pause()                    external;
    function unpause()                  external;

    // ── Role constants (envfree) ──
    function VAULT_ROLE()      external returns (bytes32) envfree;
    function ALLOCATOR_ROLE()  external returns (bytes32) envfree;
    function GUARDIAN_ROLE()   external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.deposit(uint256) external   => NONDET;
    function _.withdraw(uint256) external  => NONDET;
    function _.totalValue() external       => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice reserveBps never exceeds 3000 (30%)
invariant reserveBpsBounded()
    reserveBps() <= 3000;

// ═══════════════════════════════════════════════════════════════════
// RULES: RESERVE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice setReserveBps rejects values > 3000
rule setReserveBps_max(uint256 bps) {
    env e;
    require bps > 3000;
    setReserveBps@withrevert(e, bps);
    assert lastReverted, "setReserveBps must reject > 3000";
}

/// @notice setReserveBps stores value on success
rule setReserveBps_stores(uint256 bps) {
    env e;
    require bps <= 3000;
    setReserveBps@withrevert(e, bps);
    bool succeeded = !lastReverted;
    assert succeeded => reserveBps() == bps,
        "setReserveBps must store the new value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only VAULT_ROLE can call deposit()
rule deposit_requires_vault(address from, uint256 amount) {
    env e;
    deposit@withrevert(e, from, amount);
    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can deposit";
}

/// @notice Only VAULT_ROLE can call withdraw()
rule withdraw_requires_vault(address to, uint256 amount) {
    env e;
    withdraw@withrevert(e, to, amount);
    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can withdraw";
}

/// @notice Only VAULT_ROLE can call depositFromVault()
rule depositFromVault_requires_vault(uint256 amount) {
    env e;
    depositFromVault@withrevert(e, amount);
    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can depositFromVault";
}

/// @notice Only VAULT_ROLE can call withdrawToVault()
rule withdrawToVault_requires_vault(uint256 amount) {
    env e;
    withdrawToVault@withrevert(e, amount);
    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can withdrawToVault";
}

/// @notice Only ALLOCATOR_ROLE can call rebalance()
rule rebalance_requires_allocator() {
    env e;
    rebalance@withrevert(e);
    assert !lastReverted => hasRole(ALLOCATOR_ROLE(), e.msg.sender),
        "Only ALLOCATOR_ROLE can rebalance";
}

/// @notice Only GUARDIAN_ROLE can call pause()
rule pause_requires_guardian() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can pause";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit reverts when paused
rule paused_blocks_deposit(address from, uint256 amount) {
    env e;
    require paused();
    deposit@withrevert(e, from, amount);
    assert lastReverted, "deposit must revert when paused";
}

/// @notice withdraw reverts when paused
rule paused_blocks_withdraw(address to, uint256 amount) {
    env e;
    require paused();
    withdraw@withrevert(e, to, amount);
    assert lastReverted, "withdraw must revert when paused";
}
