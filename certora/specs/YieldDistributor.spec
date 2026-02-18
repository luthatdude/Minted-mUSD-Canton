/// @title YieldDistributor Formal Verification Spec
/// @notice Verifies keeper/governor gates and paused-state enforcement.

methods {
    function paused() external returns (bool) envfree;
    function minDistributionUsdc() external returns (uint256) envfree;
    function distributionCooldown() external returns (uint256) envfree;

    function KEEPER_ROLE() external returns (bytes32) envfree;
    function GOVERNOR_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function distributeYield(uint256) external;
    function setMinDistribution(uint256) external;
    function setDistributionCooldown(uint256) external;
    function pause() external;
    function unpause() external;
}

rule distribute_requires_keeper(uint256 amount) {
    env e;
    distributeYield@withrevert(e, amount);
    assert !lastReverted => hasRole(KEEPER_ROLE(), e.msg.sender),
        "distributeYield must be KEEPER_ROLE-gated";
}

rule paused_blocks_distribution(uint256 amount) {
    env e;
    require paused();
    distributeYield@withrevert(e, amount);
    assert lastReverted, "distributeYield must revert while paused";
}

rule pause_requires_governor() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(GOVERNOR_ROLE(), e.msg.sender),
        "pause must be GOVERNOR_ROLE-gated";
}

rule unpause_requires_governor() {
    env e;
    unpause@withrevert(e);
    assert !lastReverted => hasRole(GOVERNOR_ROLE(), e.msg.sender),
        "unpause must be GOVERNOR_ROLE-gated";
}

rule set_min_distribution_stores(uint256 nextMin) {
    env e;
    setMinDistribution@withrevert(e, nextMin);
    bool succeeded = !lastReverted;
    assert succeeded => minDistributionUsdc() == nextMin,
        "setMinDistribution must store the supplied value on success";
}

rule set_distribution_cooldown_stores(uint256 nextCooldown) {
    env e;
    setDistributionCooldown@withrevert(e, nextCooldown);
    bool succeeded = !lastReverted;
    assert succeeded => distributionCooldown() == nextCooldown,
        "setDistributionCooldown must store the supplied value on success";
}
