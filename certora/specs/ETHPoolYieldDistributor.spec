/// @title ETHPoolYieldDistributor Formal Verification Spec
/// @notice Verifies keeper/governor gates, pause behavior, and yield-cap bound.

methods {
    function paused() external returns (bool) envfree;
    function maxYieldBps() external returns (uint256) envfree;
    function MAX_YIELD_BPS_CAP() external returns (uint256) envfree;

    function KEEPER_ROLE() external returns (bytes32) envfree;
    function GOVERNOR_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function distributeETHPoolYield() external;
    function pause() external;
    function setMaxYieldBps(uint256) external;
}

invariant max_yield_bps_within_cap()
    maxYieldBps() <= MAX_YIELD_BPS_CAP();

rule distribute_requires_keeper() {
    env e;
    distributeETHPoolYield@withrevert(e);
    assert !lastReverted => hasRole(KEEPER_ROLE(), e.msg.sender),
        "distributeETHPoolYield must be KEEPER_ROLE-gated";
}

rule pause_requires_governor() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(GOVERNOR_ROLE(), e.msg.sender),
        "pause must be GOVERNOR_ROLE-gated";
}

rule paused_blocks_distribution() {
    env e;
    require paused();
    distributeETHPoolYield@withrevert(e);
    assert lastReverted, "distribution must revert while paused";
}

rule set_max_yield_bps_rejects_above_cap(uint256 bps) {
    env e;
    require bps > MAX_YIELD_BPS_CAP();
    setMaxYieldBps@withrevert(e, bps);
    assert lastReverted, "setMaxYieldBps must reject values above MAX_YIELD_BPS_CAP";
}
