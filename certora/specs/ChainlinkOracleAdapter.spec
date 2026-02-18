/// @title ChainlinkOracleAdapter Formal Verification Spec
/// @notice Certora spec for the Chainlink price feed adapter
/// @dev Verifies feed management, source identity, and stale period bounds

methods {
    function source() external returns (string memory) envfree;
    function supportsToken(address) external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE IDENTITY
// ═══════════════════════════════════════════════════════════════════

/// @notice source() always returns "Chainlink"
rule source_is_chainlink() {
    string memory src = source();
    assert keccak256(bytes(src)) == keccak256(bytes("Chainlink")),
        "source() did not return Chainlink";
}

// ═══════════════════════════════════════════════════════════════════
// FEED MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice setFeed rejects zero token address
rule set_feed_rejects_zero_token(address feed, uint256 stalePeriod, uint8 decimals) {
    env e;

    setFeed@withrevert(e, 0, feed, stalePeriod, decimals);

    assert lastReverted,
        "setFeed accepted zero token address";
}

/// @notice setFeed rejects zero feed address
rule set_feed_rejects_zero_feed(address token, uint256 stalePeriod, uint8 decimals) {
    env e;
    require token != address(0);

    setFeed@withrevert(e, token, 0, stalePeriod, decimals);

    assert lastReverted,
        "setFeed accepted zero feed address";
}

/// @notice setFeed rejects zero stale period
rule set_feed_rejects_zero_stale(address token, address feed, uint8 decimals) {
    env e;
    require token != address(0);
    require feed != address(0);

    setFeed@withrevert(e, token, feed, 0, decimals);

    assert lastReverted,
        "setFeed accepted zero stale period";
}

/// @notice setFeed rejects stale period > 48 hours
rule set_feed_rejects_excessive_stale(address token, address feed, uint8 decimals) {
    env e;
    require token != address(0);
    require feed != address(0);
    uint256 tooLong = 172801;

    setFeed@withrevert(e, token, feed, tooLong, decimals);

    assert lastReverted,
        "setFeed accepted stale period > 48 hours";
}

// ═══════════════════════════════════════════════════════════════════
// TOKEN SUPPORT
// ═══════════════════════════════════════════════════════════════════

/// @notice After setFeed, supportsToken returns true
rule set_feed_enables_support(address token, address feed, uint256 stalePeriod, uint8 decimals) {
    env e;
    require token != address(0);
    require feed != address(0);
    require stalePeriod > 0 && stalePeriod <= 172800;

    setFeed@withrevert(e, token, feed, stalePeriod, decimals);

    assert !lastReverted => supportsToken(token),
        "setFeed did not enable token support";
}

/// @notice After removeFeed, supportsToken returns false
rule remove_feed_disables_support(address token) {
    env e;
    require supportsToken(token);

    removeFeed@withrevert(e, token);

    assert !lastReverted => !supportsToken(token),
        "removeFeed did not disable token support";
}

/// @notice getPrice reverts for unsupported token
rule get_price_reverts_unsupported(address token) {
    env e;
    require !supportsToken(token);

    getPrice@withrevert(e, token);

    assert lastReverted,
        "getPrice succeeded for unsupported token";
}
