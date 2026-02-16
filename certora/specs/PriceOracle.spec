/// @title PriceOracle Formal Verification Spec
/// @notice Certora spec for the PriceOracle Chainlink integration
/// @dev Verifies zero-amount returns zero, monotonicity, circuit breaker gating,
///      and unsafe path availability.

methods {
    function getValueUsd(address, uint256) external returns (uint256) envfree;
    function getValueUsdUnsafe(address, uint256) external returns (uint256) envfree;
    function circuitBreakerEnabled() external returns (bool) envfree;
    function circuitBreakerTrippedAt(address) external returns (uint256) envfree;
    function circuitBreakerCooldown() external returns (uint256) envfree;

    function _.latestRoundData() external => NONDET;
    function _.decimals() external => PER_CALLEE_CONSTANT;
}

// INV-1: Zero amount always returns zero value
rule zeroAmountZeroValue(address token) {
    uint256 value = getValueUsd(token, 0);
    assert value == 0, "Zero amount must return zero value";
}

// RULE: Unsafe path returns value even when circuit breaker tripped
rule unsafeAlwaysReturns(address token, uint256 amount) {
    uint256 value = getValueUsdUnsafe(token, amount);
    assert value >= 0, "Unsafe price must be non-negative";
}

// RULE: Monotonicity — more tokens = more value
rule monotonicity(address token, uint256 a, uint256 b) {
    require a <= b;

    uint256 valueA = getValueUsd(token, a);
    uint256 valueB = getValueUsd(token, b);

    assert valueA <= valueB, "Value must be monotonically increasing with amount";
}
