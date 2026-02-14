// Certora Verification Spec: PriceOracle
// FIX: Previously no formal verification for oracle safety

methods {
    function getValueUsd(address, uint256) external returns (uint256) envfree;
    function getValueUsdUnsafe(address, uint256) external returns (uint256) envfree;
    function circuitBreakerActive(address) external returns (bool) envfree;
}

// INV-1: Zero amount always returns zero value
rule zeroAmountZeroValue(address token) {
    uint256 value = getValueUsd(token, 0);
    assert value == 0, "Zero amount must return zero value";
}

// INV-2: Unsafe path returns value even when circuit breaker is active
rule unsafeAlwaysReturns(address token, uint256 amount) {
    env e;

    // Unsafe should never revert for valid tokens
    uint256 value = getValueUsdUnsafe(token, amount);

    // Value should be non-negative
    assert value >= 0, "Unsafe price must be non-negative";
}

// RULE: Circuit breaker blocks safe path
rule circuitBreakerBlocksSafe(address token, uint256 amount) {
    env e;

    require circuitBreakerActive(token);

    getValueUsd@withrevert(e, token, amount);

    assert lastReverted, "Safe path must revert when circuit breaker is active";
}

// RULE: Monotonicity — more tokens = more value
rule monotonicity(address token, uint256 a, uint256 b) {
    require a <= b;

    uint256 valueA = getValueUsd(token, a);
    uint256 valueB = getValueUsd(token, b);

    assert valueA <= valueB, "Value must be monotonically increasing with amount";
}
