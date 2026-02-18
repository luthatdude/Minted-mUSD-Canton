/// @title MorphoMarketRegistry Formal Verification Spec
/// @notice Verifies manager-only whitelist updates and market-count bounds.

methods {
    function marketCount() external returns (uint256) envfree;
    function isWhitelisted(bytes32) external returns (bool) envfree;

    function MAX_MARKETS() external returns (uint256) envfree;
    function MANAGER_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    function addMarket(bytes32, string) external;
    function removeMarket(bytes32) external;
    function updateLabel(bytes32, string) external;
}

invariant market_count_within_cap()
    marketCount() <= MAX_MARKETS();

rule add_market_requires_manager(bytes32 marketId, string label) {
    env e;
    addMarket@withrevert(e, marketId, label);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "addMarket must be manager-gated";
}

rule remove_market_requires_manager(bytes32 marketId) {
    env e;
    removeMarket@withrevert(e, marketId);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "removeMarket must be manager-gated";
}

rule update_label_requires_manager(bytes32 marketId, string label) {
    env e;
    updateLabel@withrevert(e, marketId, label);

    assert !lastReverted => hasRole(MANAGER_ROLE(), e.msg.sender),
        "updateLabel must be manager-gated";
}

rule add_market_zero_id_reverts(string label) {
    env e;
    require hasRole(MANAGER_ROLE(), e.msg.sender);

    addMarket@withrevert(e, 0, label);

    assert lastReverted,
        "addMarket must reject zero marketId";
}

rule successful_add_sets_whitelist_flag(bytes32 marketId, string label) {
    env e;
    require marketId != 0;

    addMarket@withrevert(e, marketId, label);

    assert !lastReverted => isWhitelisted(marketId),
        "Successful addMarket must whitelist marketId";
}

rule successful_remove_clears_whitelist_flag(bytes32 marketId) {
    env e;
    require isWhitelisted(marketId);

    removeMarket@withrevert(e, marketId);

    assert !lastReverted => !isWhitelisted(marketId),
        "Successful removeMarket must clear whitelist flag";
}
