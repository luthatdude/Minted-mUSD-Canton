/// @title API3OracleAdapter Formal Verification Spec
/// @notice Certora spec for the API3 dAPI price feed adapter
/// @dev Verifies stale period bounds, source identity, and admin operations

methods {
    function source() external returns (string memory) envfree;
    function supportsToken(address) external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE IDENTITY
// ═══════════════════════════════════════════════════════════════════

/// @notice source() always returns "API3"
rule source_is_api3() {
    string memory src = source();
    // String comparison via hash
    assert keccak256(bytes(src)) == keccak256(bytes("API3")),
        "source() did not return API3";
}

// ═══════════════════════════════════════════════════════════════════
// PROXY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice setProxy rejects zero token address
rule set_proxy_rejects_zero_token(address proxy, uint256 stalePeriod, uint8 decimals) {
    env e;

    setProxy@withrevert(e, 0, proxy, stalePeriod, decimals);

    assert lastReverted,
        "setProxy accepted zero token address";
}

/// @notice setProxy rejects zero proxy address
rule set_proxy_rejects_zero_proxy(address token, uint256 stalePeriod, uint8 decimals) {
    env e;
    require token != address(0);

    setProxy@withrevert(e, token, 0, stalePeriod, decimals);

    assert lastReverted,
        "setProxy accepted zero proxy address";
}

/// @notice setProxy rejects zero stale period
rule set_proxy_rejects_zero_stale_period(address token, address proxy, uint8 decimals) {
    env e;
    require token != address(0);
    require proxy != address(0);

    setProxy@withrevert(e, token, proxy, 0, decimals);

    assert lastReverted,
        "setProxy accepted zero stale period";
}

/// @notice setProxy rejects stale period > 48 hours
rule set_proxy_rejects_excessive_stale_period(address token, address proxy, uint8 decimals) {
    env e;
    require token != address(0);
    require proxy != address(0);
    uint256 tooLong = 172801; // > 48 * 3600

    setProxy@withrevert(e, token, proxy, tooLong, decimals);

    assert lastReverted,
        "setProxy accepted stale period > 48 hours";
}

// ═══════════════════════════════════════════════════════════════════
// TOKEN SUPPORT
// ═══════════════════════════════════════════════════════════════════

/// @notice After setProxy, supportsToken returns true
rule set_proxy_enables_support(address token, address proxy, uint256 stalePeriod, uint8 decimals) {
    env e;
    require token != address(0);
    require proxy != address(0);
    require stalePeriod > 0 && stalePeriod <= 172800; // <= 48h

    setProxy@withrevert(e, token, proxy, stalePeriod, decimals);

    assert !lastReverted => supportsToken(token),
        "setProxy did not enable token support";
}

/// @notice After removeProxy, supportsToken returns false
rule remove_proxy_disables_support(address token) {
    env e;
    require supportsToken(token);

    removeProxy@withrevert(e, token);

    assert !lastReverted => !supportsToken(token),
        "removeProxy did not disable token support";
}

/// @notice getPrice reverts for unsupported token
rule get_price_reverts_unsupported(address token) {
    env e;
    require !supportsToken(token);

    getPrice@withrevert(e, token);

    assert lastReverted,
        "getPrice succeeded for unsupported token";
}
