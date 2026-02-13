/// @title PriceOracle Formal Verification Spec
/// @notice Certora spec for oracle safety
/// @dev Verifies zero-amount identity, monotonicity, and deterministic pricing

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // These use block.timestamp internally (staleness/circuit breaker checks)
    // so they are NOT envfree
    function getValueUsd(address, uint256) external returns (uint256);
    function getValueUsdUnsafe(address, uint256) external returns (uint256);

    // Pure storage reads — envfree
    function circuitBreakerEnabled() external returns (bool) envfree;
    function circuitBreakerTrippedAt(address) external returns (uint256) envfree;
    function circuitBreakerCooldown() external returns (uint256) envfree;
    function maxDeviationBps() external returns (uint256) envfree;

    // Chainlink feed summaries (consistent within a rule invocation)
    function _.latestRoundData() external => PER_CALLEE_CONSTANT;
    function _.decimals() external => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ZERO AMOUNT IDENTITY
// ═══════════════════════════════════════════════════════════════════

/// @notice Zero amount always returns zero value
rule zeroAmountZeroValue(address token) {
    env e;
    uint256 value = getValueUsdUnsafe(e, token, 0);

    assert value == 0,
        "Zero amount must return zero value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: MONOTONICITY
// ═══════════════════════════════════════════════════════════════════

/// @notice More tokens → more value (same price feed, same timestamp)
rule monotonicity(address token, uint256 a, uint256 b) {
    env e;
    require a <= b;
    require b <= 1000000000000000000000000; // 1e24 bound to prevent overflow

    uint256 valueA = getValueUsdUnsafe(e, token, a);
    uint256 valueB = getValueUsdUnsafe(e, token, b);

    assert valueA <= valueB,
        "Value must be monotonically increasing with amount";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: DETERMINISM
// ═══════════════════════════════════════════════════════════════════

/// @notice Same inputs produce same output within a single block
rule deterministic_pricing(address token, uint256 amount) {
    env e;
    require amount <= 1000000000000000000000000; // 1e24

    uint256 value1 = getValueUsdUnsafe(e, token, amount);
    uint256 value2 = getValueUsdUnsafe(e, token, amount);

    assert value1 == value2,
        "Same inputs must produce same output";
}
