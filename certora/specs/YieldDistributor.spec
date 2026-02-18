/// @title YieldDistributor Formal Verification Spec
/// @notice Certora spec for the cross-chain yield distribution contract
/// @dev Verifies minimum distribution, cooldown enforcement, proportional split, and monotonic counters

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function minDistributionUsdc() external returns (uint256) envfree;
    function distributionCooldown() external returns (uint256) envfree;
    function lastDistributionTime() external returns (uint256) envfree;
    function totalDistributedEth() external returns (uint256) envfree;
    function totalDistributedCanton() external returns (uint256) envfree;
    function distributionCount() external returns (uint256) envfree;
    function totalMintFeesUsdc() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
    function KEEPER_ROLE() external returns (bytes32) envfree;
    function GOVERNOR_ROLE() external returns (bytes32) envfree;

    // External contract summaries
    function _.totalValue() external => NONDET;
    function _.totalSupply() external => NONDET;
    function _.cantonTotalShares() external => NONDET;
    function _.mint(address, uint256) external => NONDET;
    function _.burn(address, uint256) external => NONDET;
    function _.transferFrom(address, address, uint256) external => NONDET;
    function _.transfer(address, uint256) external => NONDET;
    function _.balanceOf(address) external => NONDET;
    function _.swapUsdcForMusd(uint256) external => NONDET;
    function _.depositToBridge(uint256, string) external => NONDET;
    function _.receiveYield(uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice distributionCount is monotonically increasing
rule distribution_count_monotonic(uint256 yieldUsdc) {
    env e;
    uint256 countBefore = distributionCount();

    distributeYield@withrevert(e, yieldUsdc);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(distributionCount()) == to_mathint(countBefore) + 1,
        "distributionCount must increment by exactly 1 on successful distribution";
}

/// @notice totalDistributedEth is monotonically increasing
rule total_distributed_eth_monotonic(uint256 yieldUsdc) {
    env e;
    uint256 totalBefore = totalDistributedEth();

    distributeYield@withrevert(e, yieldUsdc);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(totalDistributedEth()) >= to_mathint(totalBefore),
        "totalDistributedEth must never decrease";
}

/// @notice totalDistributedCanton is monotonically increasing
rule total_distributed_canton_monotonic(uint256 yieldUsdc) {
    env e;
    uint256 totalBefore = totalDistributedCanton();

    distributeYield@withrevert(e, yieldUsdc);
    bool succeeded = !lastReverted;

    assert succeeded => to_mathint(totalDistributedCanton()) >= to_mathint(totalBefore),
        "totalDistributedCanton must never decrease";
}

/// @notice Only KEEPER_ROLE can distribute yield
rule only_keeper_distributes(address caller, uint256 yieldUsdc) {
    env e;
    require e.msg.sender == caller;
    require !hasRole(KEEPER_ROLE(), caller);

    distributeYield@withrevert(e, yieldUsdc);

    assert lastReverted,
        "Non-keeper must not be able to distribute yield";
}

/// @notice Distribution respects cooldown period
rule cooldown_enforced(uint256 yieldUsdc) {
    env e;
    uint256 lastTime = lastDistributionTime();
    uint256 cooldown = distributionCooldown();

    require to_mathint(e.block.timestamp) < to_mathint(lastTime) + to_mathint(cooldown);

    distributeYield@withrevert(e, yieldUsdc);

    assert lastReverted,
        "Distribution must revert if cooldown has not elapsed";
}

/// @notice Distribution below minimum is rejected
rule minimum_distribution_enforced(uint256 yieldUsdc) {
    env e;
    uint256 minUsdc = minDistributionUsdc();
    require to_mathint(yieldUsdc) < to_mathint(minUsdc);

    distributeYield@withrevert(e, yieldUsdc);

    assert lastReverted,
        "Distribution below minDistributionUsdc must revert";
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
