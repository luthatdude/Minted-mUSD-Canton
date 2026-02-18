/// @title MorphoMarketRegistry Formal Verification Spec
/// @notice Certora spec for the Morpho Blue market whitelist registry
/// @dev Verifies market count bounds, whitelist consistency, and duplicate prevention

methods {
    function marketCount() external returns (uint256) envfree;
    function MAX_MARKETS() external returns (uint256) envfree;
    function isWhitelisted(bytes32) external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// CAPACITY BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Market count never exceeds MAX_MARKETS
invariant market_count_bounded()
    marketCount() <= MAX_MARKETS();

/// @notice addMarket reverts on zero market ID
rule add_market_rejects_zero_id() {
    env e;

    addMarket@withrevert(e, to_bytes32(0), "test");

    assert lastReverted,
        "addMarket accepted zero market ID";
}

/// @notice addMarket reverts when market is already whitelisted (no duplicates)
rule add_market_rejects_duplicate(bytes32 marketId, string label) {
    env e;
    require isWhitelisted(marketId);

    addMarket@withrevert(e, marketId, label);

    assert lastReverted,
        "addMarket accepted duplicate market ID";
}

/// @notice addMarket reverts when at MAX_MARKETS capacity
rule add_market_rejects_at_capacity(bytes32 marketId, string label) {
    env e;
    require marketCount() >= MAX_MARKETS();
    require !isWhitelisted(marketId);

    addMarket@withrevert(e, marketId, label);

    assert lastReverted,
        "addMarket succeeded at MAX_MARKETS capacity";
}

// ═══════════════════════════════════════════════════════════════════
// WHITELIST CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

/// @notice After addMarket, the market is whitelisted
rule add_market_sets_whitelist(bytes32 marketId, string label) {
    env e;
    require !isWhitelisted(marketId);
    require marketCount() < MAX_MARKETS();
    require marketId != to_bytes32(0);

    addMarket@withrevert(e, marketId, label);

    assert !lastReverted => isWhitelisted(marketId),
        "addMarket did not set isWhitelisted to true";
}

/// @notice After removeMarket, the market is not whitelisted
rule remove_market_clears_whitelist(bytes32 marketId) {
    env e;
    require isWhitelisted(marketId);

    removeMarket@withrevert(e, marketId);

    assert !lastReverted => !isWhitelisted(marketId),
        "removeMarket did not clear isWhitelisted";
}

/// @notice removeMarket reverts if market is not whitelisted
rule remove_market_rejects_unknown(bytes32 marketId) {
    env e;
    require !isWhitelisted(marketId);

    removeMarket@withrevert(e, marketId);

    assert lastReverted,
        "removeMarket accepted non-whitelisted market";
}

/// @notice addMarket followed by removeMarket restores count
rule add_remove_restores_count(bytes32 marketId, string label) {
    env e;
    require !isWhitelisted(marketId);
    require marketCount() < MAX_MARKETS();
    require marketId != to_bytes32(0);

    uint256 countBefore = marketCount();

    addMarket(e, marketId, label);
    removeMarket(e, marketId);

    assert marketCount() == countBefore,
        "add→remove did not restore market count";
}
