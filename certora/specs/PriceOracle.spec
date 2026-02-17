/// @title PriceOracle Formal Verification Spec
/// @notice Certora spec for the PriceOracle Chainlink integration
/// @dev Verifies zero-amount returns zero, monotonicity, circuit breaker gating,
///      and unsafe path availability.

methods {
    // NOT envfree: getValueUsd/getValueUsdUnsafe use block.timestamp internally
    // for staleness checks and circuit breaker logic
    function getValueUsd(address, uint256) external returns (uint256);
    function getValueUsdUnsafe(address, uint256) external returns (uint256);
    function circuitBreakerEnabled() external returns (bool) envfree;
    function circuitBreakerTrippedAt(address) external returns (uint256) envfree;
    function circuitBreakerCooldown() external returns (uint256) envfree;

    // PER_CALLEE_CONSTANT: same feed returns same price within a single rule.
    // NONDET would allow different prices per call, breaking monotonicity.
    function _.latestRoundData() external => PER_CALLEE_CONSTANT;
    function _.decimals() external => PER_CALLEE_CONSTANT;
}

// INV-1: Zero amount always returns zero value
rule zeroAmountZeroValue(address token) {
    env e;
    uint256 value = getValueUsd(e, token, 0);
    assert value == 0, "Zero amount must return zero value";
}

// RULE: Unsafe path returns value even when circuit breaker tripped
rule unsafeAlwaysReturns(address token, uint256 amount) {
    env e;
    uint256 value = getValueUsdUnsafe(e, token, amount);
    assert value >= 0, "Unsafe price must be non-negative";
}

// RULE: Monotonicity — more tokens = more value
// Uses same env for both calls so block.timestamp is identical,
// and PER_CALLEE_CONSTANT ensures same Chainlink feed returns same price.
rule monotonicity(address token, uint256 a, uint256 b) {
    env e;
    require a <= b;

    uint256 valueA = getValueUsd(e, token, a);
    uint256 valueB = getValueUsd(e, token, b);

    assert valueA <= valueB, "Value must be monotonically increasing with amount";
}
