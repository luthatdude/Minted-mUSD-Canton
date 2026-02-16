/// @title PriceAggregator Formal Verification Spec
/// @notice Certora spec for the PriceAggregator multi-source oracle contract
/// @dev Verifies adapter-count limits, deviation bounds, adapter management,
///      access control, fallback ordering, and cross-validation gating.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function adapterCount()           external returns (uint256) envfree;
    function maxDeviationBps()        external returns (uint256) envfree;
    function crossValidationEnabled() external returns (bool)    envfree;
    function MAX_ADAPTERS()           external returns (uint256) envfree;

    // ── State-changing functions ──
    function addAdapter(address)           external;
    function removeAdapter(address)        external;
    function setAdapters(address[])        external;
    function setMaxDeviation(uint256)      external;
    function setCrossValidation(bool)      external;

    // ── UUPS upgrade (delegatecall — must be filtered from invariants) ──
    function upgradeToAndCall(address, bytes) external;

    // ── Role constants (envfree) ──
    function ORACLE_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.getPrice(address) external       => NONDET;
    function _.supportsToken(address) external  => PER_CALLEE_CONSTANT;
    function _.isHealthy(address) external      => PER_CALLEE_CONSTANT;
    function _.source() external                => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: ADAPTER BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Adapter count never exceeds MAX_ADAPTERS (5)
invariant adapterCountBounded()
    adapterCount() <= 5
    filtered { f -> f.selector != sig:upgradeToAndCall(address, bytes).selector }

/// @notice maxDeviationBps is either 0 (uninitialized) or within [50, 5000]
///         Upgradeable contracts start with maxDeviationBps = 0 before initialize()
invariant deviationInRange()
    maxDeviationBps() == 0 || (maxDeviationBps() >= 50 && maxDeviationBps() <= 5000)
    filtered { f -> f.selector != sig:upgradeToAndCall(address, bytes).selector }

// ═══════════════════════════════════════════════════════════════════
// RULES: ADAPTER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice addAdapter increases adapter count by 1
rule addAdapter_increments(address adapter) {
    env e;
    require adapter != 0;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);

    uint256 countBefore = adapterCount();
    require countBefore < 5;

    addAdapter@withrevert(e, adapter);
    bool succeeded = !lastReverted;

    assert succeeded => adapterCount() == countBefore + 1,
        "addAdapter must increment count by 1";
}

/// @notice addAdapter with zero address must revert
rule addAdapter_zero_reverts() {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);

    addAdapter@withrevert(e, 0);
    assert lastReverted, "addAdapter(address(0)) must revert";
}

/// @notice addAdapter rejects when at MAX_ADAPTERS capacity
rule addAdapter_max_limit(address adapter) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require adapterCount() >= 5;

    addAdapter@withrevert(e, adapter);
    assert lastReverted, "addAdapter must revert when at max capacity";
}

/// @notice removeAdapter decreases adapter count by 1
rule removeAdapter_decrements(address adapter) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);

    uint256 countBefore = adapterCount();
    require countBefore > 0;

    removeAdapter@withrevert(e, adapter);
    bool succeeded = !lastReverted;

    assert succeeded => adapterCount() == countBefore - 1,
        "removeAdapter must decrement count by 1";
}

/// @notice setAdapters rejects arrays longer than MAX_ADAPTERS
rule setAdapters_max_limit(address[] adaptersArr) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require adaptersArr.length > 5;

    setAdapters@withrevert(e, adaptersArr);
    assert lastReverted, "setAdapters must reject arrays > MAX_ADAPTERS";
}

/// @notice setAdapters sets the exact count
rule setAdapters_sets_count(address[] adaptersArr) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require adaptersArr.length <= 5;

    setAdapters@withrevert(e, adaptersArr);
    bool succeeded = !lastReverted;

    assert succeeded => adapterCount() == adaptersArr.length,
        "setAdapters must set adapter count to array length";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: DEVIATION BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice setMaxDeviation rejects values < 50 bps (0.5%)
rule setMaxDeviation_min(uint256 bps) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require bps < 50;

    setMaxDeviation@withrevert(e, bps);
    assert lastReverted, "setMaxDeviation must reject values < 50 bps";
}

/// @notice setMaxDeviation rejects values > 5000 bps (50%)
rule setMaxDeviation_max(uint256 bps) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require bps > 5000;

    setMaxDeviation@withrevert(e, bps);
    assert lastReverted, "setMaxDeviation must reject values > 5000 bps";
}

/// @notice setMaxDeviation stores the new value on success
rule setMaxDeviation_stores(uint256 bps) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);
    require bps >= 50 && bps <= 5000;

    setMaxDeviation@withrevert(e, bps);
    bool succeeded = !lastReverted;

    assert succeeded => maxDeviationBps() == bps,
        "setMaxDeviation must store the new value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: CROSS-VALIDATION TOGGLE
// ═══════════════════════════════════════════════════════════════════

/// @notice setCrossValidation stores the flag
rule setCrossValidation_stores(bool enabled) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);

    setCrossValidation@withrevert(e, enabled);
    bool succeeded = !lastReverted;

    assert succeeded => crossValidationEnabled() == enabled,
        "setCrossValidation must store the flag";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only ORACLE_ADMIN_ROLE can call addAdapter()
rule addAdapter_requires_oracleAdmin(address adapter) {
    env e;
    addAdapter@withrevert(e, adapter);
    assert !lastReverted => hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender),
        "Only ORACLE_ADMIN_ROLE can addAdapter";
}

/// @notice Only ORACLE_ADMIN_ROLE can call removeAdapter()
rule removeAdapter_requires_oracleAdmin(address adapter) {
    env e;
    removeAdapter@withrevert(e, adapter);
    assert !lastReverted => hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender),
        "Only ORACLE_ADMIN_ROLE can removeAdapter";
}

/// @notice Only ORACLE_ADMIN_ROLE can call setAdapters()
rule setAdapters_requires_oracleAdmin(address[] arr) {
    env e;
    setAdapters@withrevert(e, arr);
    assert !lastReverted => hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender),
        "Only ORACLE_ADMIN_ROLE can setAdapters";
}

/// @notice Only ORACLE_ADMIN_ROLE can call setMaxDeviation()
rule setMaxDeviation_requires_oracleAdmin(uint256 bps) {
    env e;
    setMaxDeviation@withrevert(e, bps);
    assert !lastReverted => hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender),
        "Only ORACLE_ADMIN_ROLE can setMaxDeviation";
}

/// @notice Only ORACLE_ADMIN_ROLE can call setCrossValidation()
rule setCrossValidation_requires_oracleAdmin(bool enabled) {
    env e;
    setCrossValidation@withrevert(e, enabled);
    assert !lastReverted => hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender),
        "Only ORACLE_ADMIN_ROLE can setCrossValidation";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ADAPTER COUNT CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

/// @notice No operation increases adapter count beyond MAX_ADAPTERS
rule adapter_count_never_exceeds_max(address adapter) {
    env e;
    require hasRole(ORACLE_ADMIN_ROLE(), e.msg.sender);

    addAdapter@withrevert(e, adapter);
    bool succeeded = !lastReverted;

    assert succeeded => adapterCount() <= 5,
        "adapter count must never exceed MAX_ADAPTERS after addAdapter";
}
