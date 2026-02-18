/// @title UniswapV3TWAPOracle Formal Verification Spec
/// @notice Verifies constructor-established invariants and constant bounds.

methods {
    function factory() external returns (address) envfree;
    function MAX_TWAP_DEVIATION_BPS() external returns (uint256) envfree;
    function MIN_TWAP_DURATION() external returns (uint32) envfree;

    function getTWAPQuote(address, address, uint24, uint32, uint256) external returns (uint256);
}

invariant factory_address_is_non_zero()
    factory() != 0;

rule max_deviation_constant_is_5_percent() {
    assert MAX_TWAP_DEVIATION_BPS() == 500,
        "MAX_TWAP_DEVIATION_BPS must remain 500 (5%)";
}

rule min_duration_constant_is_5_minutes() {
    assert MIN_TWAP_DURATION() == 300,
        "MIN_TWAP_DURATION must remain 300 seconds";
}

rule twap_quote_does_not_mutate_factory(
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint32 twapDuration,
    uint256 amountIn
) {
    env e;
    address factoryBefore = factory();

    getTWAPQuote@withrevert(e, tokenIn, tokenOut, fee, twapDuration, amountIn);

    assert factory() == factoryBefore,
        "getTWAPQuote must not mutate immutable factory address";
}
