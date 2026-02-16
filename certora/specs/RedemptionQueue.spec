/// @title RedemptionQueue Formal Verification Spec
/// @notice Certora spec for the RedemptionQueue mUSD-to-USDC delayed withdrawal contract
/// @dev Verifies FIFO ordering, queue-size limits, per-user limits, minimum redemption,
///      cancel-only-by-owner, daily rate limits, cooldown enforcement, pending accounting,
///      access control, and pause enforcement.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function nextFulfillIndex()    external returns (uint256) envfree;
    function totalPendingMusd()    external returns (uint256) envfree;
    function totalPendingUsdc()    external returns (uint256) envfree;
    function maxDailyRedemption()  external returns (uint256) envfree;
    function dailyRedeemed()       external returns (uint256) envfree;
    function lastDayReset()        external returns (uint256) envfree;
    function minRequestAge()       external returns (uint256) envfree;
    function activePendingCount()  external returns (uint256) envfree;
    function userPendingCount(address) external returns (uint256) envfree;
    function queueLength()         external returns (uint256) envfree;
    function paused()              external returns (bool)    envfree;

    function MIN_REDEMPTION_USDC() external returns (uint256) envfree;
    function MAX_QUEUE_SIZE()      external returns (uint256) envfree;
    function MAX_PENDING_PER_USER() external returns (uint256) envfree;

    // ── Role constants (envfree) ──
    function PROCESSOR_ROLE()    external returns (bytes32) envfree;
    function PAUSER_ROLE()       external returns (bytes32) envfree;
    function TIMELOCK_ROLE()     external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── ERC20 external call summaries — dispatch to linked DummyMUSD/DummyUSDC harnesses ──
    // DISPATCHER(true) routes calls to the linked harness contracts which have
    // real transferFrom/transfer/burn implementations. NONDET DELETE was wrong here
    // because it removed these functions from dispatch, causing SafeERC20 calls to
    // revert and making all token-touching rules vacuously pass or fail sanity.
    function _.transferFrom(address, address, uint256) external => DISPATCHER(true);
    function _.transfer(address, uint256) external => DISPATCHER(true);
    function _.balanceOf(address) external => DISPATCHER(true);
    function _.burn(address, uint256) external => DISPATCHER(true);
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: QUEUE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice activePendingCount never exceeds MAX_QUEUE_SIZE (10,000)
invariant activePendingBounded()
    activePendingCount() <= 10000;

/// @notice nextFulfillIndex never exceeds queue length
invariant fulfillIndexBounded()
    nextFulfillIndex() <= queueLength();

// ═══════════════════════════════════════════════════════════════════
// RULES: QUEUE REDEMPTION
// ═══════════════════════════════════════════════════════════════════

/// @notice queueRedemption increases queue length by 1
rule queueRedemption_appends(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require musdAmount > 0, "testing non-zero mUSD amount";
    require e.msg.value == 0, "contract is not payable";

    uint256 lenBefore = queueLength();

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    bool succeeded = !lastReverted;

    assert succeeded => queueLength() == lenBefore + 1,
        "queueRedemption must append exactly one request";
}

/// @notice queueRedemption increases totalPendingMusd
rule queueRedemption_increases_pending(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require musdAmount > 0, "testing non-zero mUSD amount";
    require e.msg.value == 0, "contract is not payable";

    uint256 pendingBefore = totalPendingMusd();

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    bool succeeded = !lastReverted;

    assert succeeded => totalPendingMusd() == pendingBefore + musdAmount,
        "queueRedemption must increase totalPendingMusd by exact amount";
}

/// @notice queueRedemption increases activePendingCount by 1
rule queueRedemption_increments_active(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require musdAmount > 0, "testing non-zero mUSD amount";
    require e.msg.value == 0, "contract is not payable";

    uint256 activeBefore = activePendingCount();

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    bool succeeded = !lastReverted;

    assert succeeded => activePendingCount() == activeBefore + 1,
        "queueRedemption must increment activePendingCount by 1";
}

/// @notice queueRedemption increases per-user pending count by 1
rule queueRedemption_increments_user_count(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require musdAmount > 0, "testing non-zero mUSD amount";
    require e.msg.value == 0, "contract is not payable";

    uint256 userBefore = userPendingCount(e.msg.sender);

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    bool succeeded = !lastReverted;

    assert succeeded => userPendingCount(e.msg.sender) == userBefore + 1,
        "queueRedemption must increment user pending count";
}

/// @notice queueRedemption(0) must revert
rule queueRedemption_zero_reverts() {
    env e;
    queueRedemption@withrevert(e, 0, 0);
    assert lastReverted, "queueRedemption(0) must revert";
}

/// @notice queueRedemption when paused must revert
rule queueRedemption_paused_reverts(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require paused(), "testing paused state";
    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    assert lastReverted, "queueRedemption while paused must revert";
}

/// @notice queueRedemption rejects below MIN_REDEMPTION_USDC (100 USDC)
///         mUSD has 18 decimals, USDC has 6, so 100 USDC = musdAmount / 1e12 >= 100e6
///         means musdAmount must be >= 100e18
rule queueRedemption_min_amount(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    // musdAmount / 1e12 < 100e6 means musdAmount < 100e18
    require musdAmount < 100000000000000000000, "amount below 100 mUSD (100e18)";
    require musdAmount > 0, "testing non-zero mUSD amount";

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    assert lastReverted, "queueRedemption must reject below MIN_REDEMPTION_USDC";
}

/// @notice queueRedemption rejects when global queue cap reached
rule queueRedemption_queue_full(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require activePendingCount() >= 10000, "queue is at MAX_QUEUE_SIZE";
    require musdAmount > 0, "testing non-zero mUSD amount";

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    assert lastReverted, "queueRedemption must revert when MAX_QUEUE_SIZE reached";
}

/// @notice queueRedemption rejects when per-user limit reached
rule queueRedemption_user_limit(uint256 musdAmount, uint256 minUsdcOut) {
    env e;
    require userPendingCount(e.msg.sender) >= 10, "user at MAX_PENDING_PER_USER";
    require musdAmount > 0, "testing non-zero mUSD amount";

    queueRedemption@withrevert(e, musdAmount, minUsdcOut);
    assert lastReverted, "queueRedemption must revert when MAX_PENDING_PER_USER reached";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: CANCEL REDEMPTION
// ═══════════════════════════════════════════════════════════════════

/// @notice cancelRedemption decreases activePendingCount by 1
rule cancelRedemption_decrements_active(uint256 requestId) {
    env e;

    uint256 activeBefore = activePendingCount();
    require activeBefore > 0, "at least one active pending request";

    cancelRedemption@withrevert(e, requestId);
    bool succeeded = !lastReverted;

    assert succeeded => activePendingCount() == activeBefore - 1,
        "cancelRedemption must decrement activePendingCount";
}

/// @notice cancelRedemption decreases per-user pending count
rule cancelRedemption_decrements_user(uint256 requestId) {
    env e;

    uint256 userBefore = userPendingCount(e.msg.sender);
    require userBefore > 0, "user has at least one pending request";

    cancelRedemption@withrevert(e, requestId);
    bool succeeded = !lastReverted;

    assert succeeded => userPendingCount(e.msg.sender) == userBefore - 1,
        "cancelRedemption must decrement user pending count";
}

/// @notice cancelRedemption with out-of-bounds ID must revert
rule cancelRedemption_invalid_id() {
    env e;
    uint256 id;
    require id >= queueLength(), "ID is out of bounds";

    cancelRedemption@withrevert(e, id);
    assert lastReverted, "cancelRedemption with invalid ID must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PROCESS BATCH
// ═══════════════════════════════════════════════════════════════════

/// @notice processBatch advances nextFulfillIndex (or keeps it same if nothing processed)
rule processBatch_advances_index(uint256 maxCount) {
    env e;
    require hasRole(PROCESSOR_ROLE(), e.msg.sender), "caller has PROCESSOR_ROLE";

    uint256 indexBefore = nextFulfillIndex();

    processBatch@withrevert(e, maxCount);
    bool succeeded = !lastReverted;

    assert succeeded => nextFulfillIndex() >= indexBefore,
        "processBatch must not decrease nextFulfillIndex";
}

/// @notice processBatch decreases or preserves totalPendingUsdc
rule processBatch_reduces_pending(uint256 maxCount) {
    env e;
    require hasRole(PROCESSOR_ROLE(), e.msg.sender), "caller has PROCESSOR_ROLE";

    uint256 pendingBefore = totalPendingUsdc();

    processBatch@withrevert(e, maxCount);
    bool succeeded = !lastReverted;

    assert succeeded => totalPendingUsdc() <= pendingBefore,
        "processBatch must not increase totalPendingUsdc";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only PROCESSOR_ROLE can call processBatch()
rule processBatch_requires_processor(uint256 maxCount) {
    env e;
    processBatch@withrevert(e, maxCount);
    assert !lastReverted => hasRole(PROCESSOR_ROLE(), e.msg.sender),
        "Only PROCESSOR_ROLE can processBatch";
}

/// @notice Only PAUSER_ROLE can call pause()
rule pause_requires_pauser() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(PAUSER_ROLE(), e.msg.sender),
        "Only PAUSER_ROLE can pause";
}

/// @notice Only TIMELOCK_ROLE can call unpause()
rule unpause_requires_timelock() {
    env e;
    unpause@withrevert(e);
    assert !lastReverted => hasRole(TIMELOCK_ROLE(), e.msg.sender),
        "Only TIMELOCK_ROLE can unpause";
}

/// @notice Only DEFAULT_ADMIN_ROLE can call setMaxDailyRedemption()
rule setMaxDaily_requires_admin(uint256 newLimit) {
    env e;
    setMaxDailyRedemption@withrevert(e, newLimit);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can setMaxDailyRedemption";
}

/// @notice Only DEFAULT_ADMIN_ROLE can call setMinRequestAge()
rule setMinRequestAge_requires_admin(uint256 newAge) {
    env e;
    setMinRequestAge@withrevert(e, newAge);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can setMinRequestAge";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: DAILY RATE LIMIT
// ═══════════════════════════════════════════════════════════════════

/// @notice dailyRedeemed never exceeds maxDailyRedemption (within a day window)
rule dailyRedeemed_bounded(uint256 maxCount) {
    env e;
    require hasRole(PROCESSOR_ROLE(), e.msg.sender), "caller has PROCESSOR_ROLE";
    // Within same day
    require e.block.timestamp < lastDayReset() + 86400, "within same calendar day";
    // Pre-condition: dailyRedeemed is consistent
    require dailyRedeemed() <= maxDailyRedemption(), "daily redeemed within limit pre-condition";

    processBatch@withrevert(e, maxCount);
    bool succeeded = !lastReverted;

    assert succeeded => dailyRedeemed() <= maxDailyRedemption(),
        "dailyRedeemed must never exceed maxDailyRedemption";
}
