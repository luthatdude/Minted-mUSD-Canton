/// @title ETHPool Formal Verification Spec
/// @notice Verifies role gates, pause enforcement, and core admin invariants.

methods {
    function poolCap() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;

    function PAUSER_ROLE() external returns (bytes32) envfree;
    function STRATEGY_MANAGER_ROLE() external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function deployToStrategy(uint256) external;
    function withdrawFromStrategy(uint256) external;
    function setPoolCap(uint256) external;
    function pause() external;
    function unpause() external;
    function stakeWithToken(address, uint256, uint8) external;
    function unstake(uint256) external;
}

rule pause_requires_pauser() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(PAUSER_ROLE(), e.msg.sender),
        "pause must be PAUSER_ROLE-gated";
}

rule unpause_requires_admin() {
    env e;
    unpause@withrevert(e);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "unpause must be DEFAULT_ADMIN_ROLE-gated";
}

rule deploy_to_strategy_requires_strategy_manager(uint256 amount) {
    env e;
    deployToStrategy@withrevert(e, amount);
    assert !lastReverted => hasRole(STRATEGY_MANAGER_ROLE(), e.msg.sender),
        "deployToStrategy must be STRATEGY_MANAGER_ROLE-gated";
}

rule withdraw_from_strategy_requires_strategy_manager(uint256 amount) {
    env e;
    withdrawFromStrategy@withrevert(e, amount);
    assert !lastReverted => hasRole(STRATEGY_MANAGER_ROLE(), e.msg.sender),
        "withdrawFromStrategy must be STRATEGY_MANAGER_ROLE-gated";
}

rule set_pool_cap_stores_on_success(uint256 newCap) {
    env e;
    require newCap > 0;
    setPoolCap@withrevert(e, newCap);
    bool succeeded = !lastReverted;
    assert succeeded => poolCap() == newCap,
        "setPoolCap must store the supplied cap on success";
}

rule paused_blocks_stake_with_token(address token, uint256 amount, uint8 tier) {
    env e;
    require paused();
    stakeWithToken@withrevert(e, token, amount, tier);
    assert lastReverted, "stakeWithToken must revert while paused";
}

rule paused_blocks_unstake(uint256 positionId) {
    env e;
    require paused();
    unstake@withrevert(e, positionId);
    assert lastReverted, "unstake must revert while paused";
}
