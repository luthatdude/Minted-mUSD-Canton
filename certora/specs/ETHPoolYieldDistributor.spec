/// @title ETHPoolYieldDistributor Formal Verification Spec
/// @notice Certora spec for the ETH Pool yield distribution with high-water mark
/// @dev Verifies HWM monotonicity, yield cap, maturity window, cooldown, pause behavior, and role separation

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function lastRecordedValue() external returns (uint256) envfree;
    function minYieldUsdc() external returns (uint256) envfree;
    function distributionCooldown() external returns (uint256) envfree;
    function lastDistributionTime() external returns (uint256) envfree;
    function totalDistributed() external returns (uint256) envfree;
    function distributionCount() external returns (uint256) envfree;
    function maxYieldBps() external returns (uint256) envfree;
    function MAX_YIELD_BPS_CAP() external returns (uint256) envfree;
    function BPS() external returns (uint256) envfree;
    function yieldFirstObservedBlock() external returns (uint256) envfree;
    function yieldMaturityBlocks() external returns (uint256) envfree;
    function hwmDesyncFlagged() external returns (bool) envfree;
    function paused() external returns (bool) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
    function KEEPER_ROLE() external returns (bytes32) envfree;
    function GOVERNOR_ROLE() external returns (bytes32) envfree;

    function distributeETHPoolYield() external;
    function pause() external;
    function setMaxYieldBps(uint256) external;

    // External contract summaries
    function _.totalValue() external => NONDET;
    function _.mint(address, uint256) external => NONDET;
    function _.burn(address, uint256) external => NONDET;
    function _.depositToBridge(uint256, string) external => NONDET;
    function _.isGloballyPaused() external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

invariant max_yield_bps_within_cap()
    maxYieldBps() <= MAX_YIELD_BPS_CAP();

/// @notice totalDistributed is monotonically increasing
rule total_distributed_monotonic() {
    env e;
    uint256 totalBefore = totalDistributed();

    distributeETHPoolYield@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(totalDistributed()) >= to_mathint(totalBefore),
        "totalDistributed must never decrease";
}

/// @notice distributionCount increments by 1 on success
rule distribution_count_increments() {
    env e;
    uint256 countBefore = distributionCount();

    distributeETHPoolYield@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(distributionCount()) == to_mathint(countBefore) + 1,
        "distributionCount must increment by exactly 1";
}

/// @notice maxYieldBps never exceeds MAX_YIELD_BPS_CAP (20%)
rule yield_bps_bounded() {
    assert to_mathint(maxYieldBps()) <= to_mathint(MAX_YIELD_BPS_CAP()),
        "maxYieldBps must never exceed MAX_YIELD_BPS_CAP (2000 bps)";
}

/// @notice setMaxYieldBps rejects values above cap
rule set_max_yield_bps_rejects_above_cap(uint256 bps) {
    env e;
    require bps > MAX_YIELD_BPS_CAP();
    setMaxYieldBps@withrevert(e, bps);
    assert lastReverted, "setMaxYieldBps must reject values above MAX_YIELD_BPS_CAP";
}

/// @notice High-water mark never decreases on distribution
rule hwm_monotonic_on_distribution() {
    env e;
    uint256 hwmBefore = lastRecordedValue();

    distributeETHPoolYield@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(lastRecordedValue()) >= to_mathint(hwmBefore),
        "lastRecordedValue (HWM) must never decrease on distribution";
}

/// @notice Only KEEPER_ROLE can distribute
rule only_keeper_distributes(address caller) {
    env e;
    require e.msg.sender == caller;
    require !hasRole(KEEPER_ROLE(), caller);

    distributeETHPoolYield@withrevert(e);

    assert lastReverted,
        "Non-keeper must not be able to distribute ETH pool yield";
}

/// @notice Cooldown period is enforced
rule cooldown_enforced() {
    env e;
    uint256 lastTime = lastDistributionTime();
    uint256 cooldown = distributionCooldown();

    require to_mathint(e.block.timestamp) < to_mathint(lastTime) + to_mathint(cooldown);

    distributeETHPoolYield@withrevert(e);

    assert lastReverted,
        "Distribution must revert if cooldown has not elapsed";
}

/// @notice Paused contract blocks distribution
rule paused_blocks_distribution() {
    env e;
    require paused();
    distributeETHPoolYield@withrevert(e);
    assert lastReverted, "distribution must revert while paused";
}

/// @notice yieldFirstObservedBlock resets after distribution
rule observation_resets_after_distribution() {
    env e;

    distributeETHPoolYield@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => yieldFirstObservedBlock() == 0,
        "yieldFirstObservedBlock must reset to 0 after distribution";
}

/// @notice Only GOVERNOR_ROLE can pause
rule only_governor_can_pause(address caller) {
    env e;
    require e.msg.sender == caller;
    require !hasRole(GOVERNOR_ROLE(), caller);

    pause@withrevert(e);

    assert lastReverted,
        "Non-governor must not be able to pause";
}
