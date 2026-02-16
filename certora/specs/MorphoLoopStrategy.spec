/// @title MorphoLoopStrategy Formal Verification Spec
/// @notice Certora spec for the MorphoLoopStrategy leveraged USDC loop contract
/// @dev Verifies LTV bounds, loop-count limits, deposit/withdraw accounting,
///      principal conservation, profitability gate, access control, pause
///      enforcement, and emergency deleverage operations.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function totalPrincipal()         external returns (uint256) envfree;
    function targetLtvBps()           external returns (uint256) envfree;
    function targetLoops()            external returns (uint256) envfree;
    function safetyBufferBps()        external returns (uint256) envfree;
    function active()                 external returns (bool)    envfree;
    function paused()                 external returns (bool)    envfree;
    function totalValue()             external returns (uint256) envfree;
    function asset()                  external returns (address) envfree;
    function maxBorrowRateForProfit() external returns (uint256) envfree;
    function minSupplyRateRequired()  external returns (uint256) envfree;
    function BPS()                    external returns (uint256) envfree;
    function MAX_LOOPS()              external returns (uint256) envfree;

    // ── State-changing functions ──
    function deposit(uint256)                    external returns (uint256);
    function withdraw(uint256)                   external returns (uint256);
    function withdrawAll()                       external returns (uint256);
    function setParameters(uint256, uint256)      external;
    function setSafetyBuffer(uint256)             external;
    function setProfitabilityParams(uint256, uint256) external;
    function setActive(bool)                     external;
    function pause()                             external;
    function unpause()                           external;
    function emergencyDeleverage()               external;
    function recoverToken(address, uint256)       external;

    // ── Role constants (envfree) ──
    function TREASURY_ROLE()    external returns (bytes32) envfree;
    function STRATEGIST_ROLE()  external returns (bytes32) envfree;
    function GUARDIAN_ROLE()    external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.supplyCollateral(IMorphoBlue.MarketParams, uint256, address, bytes) external => NONDET;
    function _.borrow(IMorphoBlue.MarketParams, uint256, uint256, address, address) external => NONDET;
    function _.repay(IMorphoBlue.MarketParams, uint256, uint256, address, bytes) external => NONDET;
    function _.withdrawCollateral(IMorphoBlue.MarketParams, uint256, address, address) external => NONDET;
    function _.position(bytes32, address) external => NONDET;
    function _.market(bytes32) external => NONDET;
    function _.idToMarketParams(bytes32) external => NONDET;
    function _.borrowRateView(IMorphoBlue.MarketParams, MorphoMarket) external => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: LTV & LOOP BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice targetLtvBps is always within [5000, 8500]
invariant targetLtvInRange()
    targetLtvBps() >= 5000 && targetLtvBps() <= 8500
    { preserved { require active(); } }

/// @notice targetLoops never exceeds MAX_LOOPS (5)
invariant loopCountBounded()
    targetLoops() <= 5;

/// @notice safetyBufferBps stays within [200, 2000]
invariant safetyBufferInRange()
    safetyBufferBps() >= 200 && safetyBufferBps() <= 2000;

// ═══════════════════════════════════════════════════════════════════
// RULES: DEPOSIT ACCOUNTING
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit() increases totalPrincipal by exactly the deposited amount
rule deposit_accounting(uint256 amount) {
    env e;
    require amount > 0;
    require e.msg.value == 0;

    uint256 principalBefore = totalPrincipal();
    require principalBefore + amount <= max_uint256;

    deposit@withrevert(e, amount);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == principalBefore + amount,
        "deposit must increase totalPrincipal by exact amount";
}

/// @notice deposit(0) must revert
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

    assert succeeded => totalPrincipal() <= principalBefore,
        "withdraw must not increase totalPrincipal";
}

/// @notice withdraw() reduces principal by at most the requested amount
rule withdraw_bounded_reduction(uint256 amount) {
    env e;
    require amount > 0;

    uint256 principalBefore = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 reduction = principalBefore - totalPrincipal();

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
// RULES: PARAMETER SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice setParameters rejects LTV outside [5000, 8500]
rule setParameters_ltv_bounds(uint256 ltv, uint256 loops) {
    env e;
    require ltv > 8500 || ltv < 5000;

    setParameters@withrevert(e, ltv, loops);
    assert lastReverted, "setParameters must reject LTV outside [5000, 8500]";
}

/// @notice setParameters rejects loops > MAX_LOOPS (5)
rule setParameters_loop_bounds(uint256 ltv, uint256 loops) {
    env e;
    require loops > 5;
    require ltv >= 5000 && ltv <= 8500;

    setParameters@withrevert(e, ltv, loops);
    assert lastReverted, "setParameters must reject loops > MAX_LOOPS";
}

/// @notice setParameters preserves ranges on success
rule setParameters_preserves_range(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    bool succeeded = !lastReverted;

    assert succeeded => (targetLtvBps() >= 5000 && targetLtvBps() <= 8500),
        "After setParameters, targetLtvBps must be in [5000, 8500]";
    assert succeeded => targetLoops() <= 5,
        "After setParameters, targetLoops must be <= MAX_LOOPS";
}

/// @notice setSafetyBuffer rejects values outside [200, 2000]
rule setSafetyBuffer_bounds(uint256 buf) {
    env e;
    require buf < 200 || buf > 2000;

    setSafetyBuffer@withrevert(e, buf);
    assert lastReverted, "setSafetyBuffer must reject values outside [200, 2000]";
}

/// @notice setProfitabilityParams rejects borrow rate > 50%
rule setProfitability_maxBorrow(uint256 maxBorrow, uint256 minSupply) {
    env e;
    require maxBorrow > 500000000000000000; // 0.50e18

    setProfitabilityParams@withrevert(e, maxBorrow, minSupply);
    assert lastReverted, "setProfitabilityParams must reject maxBorrowRate > 50%";
}

/// @notice setProfitabilityParams rejects supply rate > 50%
rule setProfitability_maxSupply(uint256 maxBorrow, uint256 minSupply) {
    env e;
    require minSupply > 500000000000000000; // 0.50e18
    require maxBorrow <= 500000000000000000;

    setProfitabilityParams@withrevert(e, maxBorrow, minSupply);
    assert lastReverted, "setProfitabilityParams must reject minSupplyRate > 50%";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PRINCIPAL CONSERVATION
// ═══════════════════════════════════════════════════════════════════

/// @notice emergencyDeleverage does not change totalPrincipal
rule emergency_preserves_principal() {
    env e;
    uint256 before = totalPrincipal();

    emergencyDeleverage@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "emergencyDeleverage must not change totalPrincipal";
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

/// @notice Only STRATEGIST_ROLE can call setParameters()
rule setParameters_requires_strategist(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setParameters";
}

/// @notice Only STRATEGIST_ROLE can call setSafetyBuffer()
rule setSafetyBuffer_requires_strategist(uint256 buf) {
    env e;
    setSafetyBuffer@withrevert(e, buf);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setSafetyBuffer";
}

/// @notice Only STRATEGIST_ROLE can call setProfitabilityParams()
rule setProfitability_requires_strategist(uint256 a, uint256 b) {
    env e;
    setProfitabilityParams@withrevert(e, a, b);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setProfitabilityParams";
}

/// @notice Only STRATEGIST_ROLE can call setActive()
rule setActive_requires_strategist(bool a) {
    env e;
    setActive@withrevert(e, a);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setActive";
}

/// @notice Only GUARDIAN_ROLE can call emergencyDeleverage()
rule emergency_requires_guardian() {
    env e;
    emergencyDeleverage@withrevert(e);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can emergencyDeleverage";
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
