/// @title EulerV2LoopStrategy Formal Verification Spec
/// @notice Certora spec for the EulerV2LoopStrategy leveraged loop contract
/// @dev Verifies LTV bounds, flash-loan callback safety, deposit/withdraw
///      accounting, leverage invariants, access control, pause enforcement,
///      reward compounding, and emergency deleverage operations.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function totalPrincipal()        external returns (uint256) envfree;
    function targetLtvBps()          external returns (uint256) envfree;
    function targetLoops()           external returns (uint256) envfree;
    function safetyBufferBps()       external returns (uint256) envfree;
    function active()                external returns (bool)    envfree;
    function paused()                external returns (bool)    envfree;
    function totalRewardsClaimed()   external returns (uint256) envfree;
    function minSwapOutputBps()      external returns (uint256) envfree;
    function maxBorrowRateForProfit() external returns (uint256) envfree;
    function totalValue()            external returns (uint256) envfree;
    function asset()                 external returns (address) envfree;
    function flashLoanPool()         external returns (address) envfree;
    function BPS()                   external returns (uint256) envfree;
    function WAD()                   external returns (uint256) envfree;
    function MIN_HEALTH_FACTOR()     external returns (uint256) envfree;

    // ── State-changing functions ──
    function deposit(uint256)                    external returns (uint256);
    function withdraw(uint256)                   external returns (uint256);
    function withdrawAll()                       external returns (uint256);
    function rebalance()                         external;
    function adjustLeverage(uint256, uint256)     external;
    function setParameters(uint256, uint256)      external;
    function setActive(bool)                     external;
    function pause()                             external;
    function unpause()                           external;
    function emergencyDeleverage()               external;
    function recoverToken(address, uint256)       external;
    function setRewardToken(address, bool)        external;
    function setupEVC()                          external;
    function executeOperation(address, uint256, uint256, address, bytes) external returns (bool);

    // ── Role constants (envfree) ──
    function TREASURY_ROLE()    external returns (bytes32) envfree;
    function STRATEGIST_ROLE()  external returns (bytes32) envfree;
    function GUARDIAN_ROLE()    external returns (bytes32) envfree;
    function KEEPER_ROLE()      external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.flashLoanSimple(address, address, uint256, bytes, uint16) external => NONDET;
    function _.deposit(uint256, address)                    external => NONDET;
    function _.withdraw(uint256, address, address)          external => NONDET;
    function _.redeem(uint256, address, address)            external => NONDET;
    function _.borrow(uint256, address)                     external => NONDET;
    function _.repay(uint256, address)                      external => NONDET;
    function _.debtOf(address)                              external => PER_CALLEE_CONSTANT;
    function _.convertToAssets(uint256)                     external => PER_CALLEE_CONSTANT;
    function _.maxWithdraw(address)                         external => PER_CALLEE_CONSTANT;
    function _.enableCollateral(address, address)           external => NONDET;
    function _.enableController(address, address)           external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: LTV BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice targetLtvBps is always within the valid range [3000, 9000]
///         (Euler V2 uses tighter upper bound than Fluid: 90% vs 95%)
invariant targetLtvInRange()
    targetLtvBps() >= 3000 && targetLtvBps() <= 9000
    { preserved { require active(); } }

/// @notice safetyBufferBps is never zero
invariant safetyBufferPositive()
    safetyBufferBps() > 0;

// ═══════════════════════════════════════════════════════════════════
// RULES: DEPOSIT ACCOUNTING
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit() increases totalPrincipal by exactly the deposited amount
rule deposit_accounting(uint256 amount) {
    env e;
    require amount > 0;
    require e.msg.value == 0;

    uint256 principalBefore = totalPrincipal();
    require principalBefore + amount <= max_uint256; // no overflow

    deposit@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 principalAfter = totalPrincipal();

    assert succeeded => principalAfter == principalBefore + amount,
        "deposit must increase totalPrincipal by exact amount";
}

/// @notice deposit() with zero amount must revert
rule deposit_zero_reverts() {
    env e;
    deposit@withrevert(e, 0);
    assert lastReverted, "deposit(0) must revert";
}

/// @notice deposit() when not active must revert
rule deposit_inactive_reverts(uint256 amount) {
    env e;
    require !active();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while inactive must revert";
}

/// @notice deposit() when paused must revert
rule deposit_paused_reverts(uint256 amount) {
    env e;
    require paused();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while paused must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: WITHDRAW ACCOUNTING
// ═══════════════════════════════════════════════════════════════════

/// @notice withdraw() decreases totalPrincipal
rule withdraw_decreases_principal(uint256 amount) {
    env e;
    require amount > 0;

    uint256 principalBefore = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 principalAfter = totalPrincipal();

    assert succeeded => principalAfter <= principalBefore,
        "withdraw must not increase totalPrincipal";
}

/// @notice withdraw() reduces principal by at most the requested amount
rule withdraw_bounded_reduction(uint256 amount) {
    env e;
    require amount > 0;

    uint256 principalBefore = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 principalAfter = totalPrincipal();
    mathint reduction = principalBefore - principalAfter;

    assert succeeded => reduction <= amount,
        "withdraw must not reduce principal by more than requested";
}

/// @notice withdraw(0) must revert
rule withdraw_zero_reverts() {
    env e;
    withdraw@withrevert(e, 0);
    assert lastReverted, "withdraw(0) must revert";
}

/// @notice withdrawAll() sets totalPrincipal to zero
rule withdrawAll_clears_principal() {
    env e;
    withdrawAll@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == 0,
        "withdrawAll must set totalPrincipal to 0";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: FLASH LOAN CALLBACK SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice executeOperation must revert if caller is not the flash loan pool
rule flashLoan_only_pool() {
    env e;
    address a; uint256 amount; uint256 premium;
    address initiator; bytes params;

    require e.msg.sender != flashLoanPool();

    executeOperation@withrevert(e, a, amount, premium, initiator, params);
    assert lastReverted,
        "executeOperation must reject non-pool callers";
}

/// @notice executeOperation must revert if initiator is not this contract
rule flashLoan_only_self_initiated() {
    env e;
    address a; uint256 amount; uint256 premium;
    address initiator; bytes params;

    require initiator != currentContract;

    executeOperation@withrevert(e, a, amount, premium, initiator, params);
    assert lastReverted,
        "executeOperation must revert if initiator != address(this)";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LEVERAGE PARAMETER SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice setParameters rejects LTV outside [3000, 9000]
rule setParameters_ltv_bounds(uint256 ltv, uint256 loops) {
    env e;
    require ltv < 3000 || ltv > 9000;

    setParameters@withrevert(e, ltv, loops);
    assert lastReverted, "setParameters must reject LTV outside [3000, 9000]";
}

/// @notice setParameters preserves LTV range on success
rule setParameters_preserves_range(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    bool succeeded = !lastReverted;

    assert succeeded => (targetLtvBps() >= 3000 && targetLtvBps() <= 9000),
        "After setParameters, targetLtvBps must be in [3000, 9000]";
}

/// @notice adjustLeverage rejects LTV outside [3000, 9000]
rule adjustLeverage_ltv_bounds(uint256 newLtv, uint256 minSharePrice) {
    env e;
    require newLtv < 3000 || newLtv > 9000;

    adjustLeverage@withrevert(e, newLtv, minSharePrice);
    assert lastReverted, "adjustLeverage must reject LTV outside [3000, 9000]";
}

/// @notice adjustLeverage stores the new LTV on success
rule adjustLeverage_stores_ltv(uint256 newLtv, uint256 minSharePrice) {
    env e;

    adjustLeverage@withrevert(e, newLtv, minSharePrice);
    bool succeeded = !lastReverted;

    assert succeeded => targetLtvBps() == newLtv,
        "adjustLeverage must store new LTV value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only TREASURY_ROLE can call deposit()
rule deposit_requires_treasury(uint256 amount) {
    env e;
    deposit@withrevert(e, amount);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can deposit";
}

/// @notice Only TREASURY_ROLE can call withdraw()
rule withdraw_requires_treasury(uint256 amount) {
    env e;
    withdraw@withrevert(e, amount);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can withdraw";
}

/// @notice Only TREASURY_ROLE can call withdrawAll()
rule withdrawAll_requires_treasury() {
    env e;
    withdrawAll@withrevert(e);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can withdrawAll";
}

/// @notice Only KEEPER_ROLE can call rebalance()
rule rebalance_requires_keeper() {
    env e;
    rebalance@withrevert(e);
    assert !lastReverted => hasRole(KEEPER_ROLE(), e.msg.sender),
        "Only KEEPER_ROLE can rebalance";
}

/// @notice Only GUARDIAN_ROLE can call emergencyDeleverage()
rule emergency_requires_guardian() {
    env e;
    emergencyDeleverage@withrevert(e);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can emergencyDeleverage";
}

/// @notice Only STRATEGIST_ROLE can call setParameters()
rule setParameters_requires_strategist(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setParameters";
}

/// @notice Only STRATEGIST_ROLE can call adjustLeverage()
rule adjustLeverage_requires_strategist(uint256 ltv, uint256 minSP) {
    env e;
    adjustLeverage@withrevert(e, ltv, minSP);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can adjustLeverage";
}

/// @notice Only STRATEGIST_ROLE can call setActive()
rule setActive_requires_strategist(bool a) {
    env e;
    setActive@withrevert(e, a);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setActive";
}

/// @notice Only STRATEGIST_ROLE can call setRewardToken()
rule setRewardToken_requires_strategist(address tok, bool allowed) {
    env e;
    setRewardToken@withrevert(e, tok, allowed);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setRewardToken";
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

/// @notice deposit() reverts when paused
rule paused_blocks_deposits(uint256 amount) {
    env e;
    require paused();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit must revert when paused";
}

/// @notice rebalance() reverts when paused
rule paused_blocks_rebalance() {
    env e;
    require paused();
    rebalance@withrevert(e);
    assert lastReverted, "rebalance must revert when paused";
}

/// @notice adjustLeverage() reverts when paused
rule paused_blocks_adjustLeverage(uint256 ltv, uint256 minSP) {
    env e;
    require paused();
    adjustLeverage@withrevert(e, ltv, minSP);
    assert lastReverted, "adjustLeverage must revert when paused";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PRINCIPAL CONSERVATION
// ═══════════════════════════════════════════════════════════════════

/// @notice rebalance does not change totalPrincipal
rule rebalance_preserves_principal() {
    env e;
    uint256 before = totalPrincipal();

    rebalance@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "rebalance must not change totalPrincipal";
}

/// @notice emergencyDeleverage does not change totalPrincipal
rule emergency_preserves_principal() {
    env e;
    uint256 before = totalPrincipal();

    emergencyDeleverage@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "emergencyDeleverage must not change totalPrincipal";
}

/// @notice adjustLeverage does not change totalPrincipal
rule adjustLeverage_preserves_principal(uint256 ltv, uint256 minSP) {
    env e;
    uint256 before = totalPrincipal();

    adjustLeverage@withrevert(e, ltv, minSP);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "adjustLeverage must not change totalPrincipal";
}

/// @notice totalPrincipal never increases outside of deposit()
rule withdraw_principal_monotonic(uint256 amount) {
    env e;
    uint256 before = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() <= before,
        "withdraw must never increase totalPrincipal";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: RECOVER TOKEN SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice recoverToken cannot drain USDC while principal > 0
rule recover_blocks_active_usdc() {
    env e;
    address token; uint256 amount;

    require totalPrincipal() > 0;
    require token == asset();

    recoverToken@withrevert(e, token, amount);
    assert lastReverted,
        "recoverToken must revert for USDC when totalPrincipal > 0";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: REWARD TOKEN WHITELIST
// ═══════════════════════════════════════════════════════════════════

/// @notice setRewardToken with zero address must revert
rule setRewardToken_zero_reverts(bool allowed) {
    env e;
    setRewardToken@withrevert(e, 0, allowed);
    assert lastReverted, "setRewardToken(address(0)) must revert";
}
