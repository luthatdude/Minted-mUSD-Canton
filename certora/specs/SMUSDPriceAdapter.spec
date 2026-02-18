/// @title SMUSDPriceAdapter Formal Verification Spec
/// @notice Certora spec for the Chainlink-compatible sMUSD price feed
/// @dev Verifies price clamping, decimals consistency, and rate limiting

methods {
    function decimals() external returns (uint8) envfree;
    function minSharePrice() external returns (uint256) envfree;
    function maxSharePrice() external returns (uint256) envfree;
    function minTotalSupply() external returns (uint256) envfree;
    function maxPriceChangePerBlock() external returns (uint256) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// INTERFACE CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

/// @notice decimals() always returns 8 (Chainlink convention)
rule decimals_is_8() {
    assert decimals() == 8,
        "decimals() did not return 8";
}

// ═══════════════════════════════════════════════════════════════════
// PRICE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice minSharePrice is always less than maxSharePrice
rule price_bounds_ordered() {
    assert minSharePrice() < maxSharePrice(),
        "minSharePrice >= maxSharePrice";
}

/// @notice setSharePriceBounds reverts when min >= max
rule set_bounds_rejects_invalid_order(uint256 minPrice, uint256 maxPrice) {
    env e;
    require maxPrice <= minPrice;

    setSharePriceBounds@withrevert(e, minPrice, maxPrice);

    assert lastReverted,
        "setSharePriceBounds accepted min >= max";
}

/// @notice setSharePriceBounds reverts when min is zero
rule set_bounds_rejects_zero_min(uint256 maxPrice) {
    env e;

    setSharePriceBounds@withrevert(e, 0, maxPrice);

    assert lastReverted,
        "setSharePriceBounds accepted zero min";
}

/// @notice setSharePriceBounds reverts when max exceeds 10e8 ($10)
rule set_bounds_rejects_extreme_max(uint256 minPrice) {
    env e;
    uint256 extremeMax = 1000000001; // > 10e8

    setSharePriceBounds@withrevert(e, minPrice, extremeMax);

    assert lastReverted,
        "setSharePriceBounds accepted max > $10";
}

// ═══════════════════════════════════════════════════════════════════
// DONATION PROTECTION
// ═══════════════════════════════════════════════════════════════════

/// @notice setDonationProtection rejects zero minTotalSupply
rule donation_protection_rejects_zero_supply() {
    env e;

    setDonationProtection@withrevert(e, 0, 5000000); // 0 supply, 0.05e8 change

    assert lastReverted,
        "setDonationProtection accepted zero minTotalSupply";
}

/// @notice setDonationProtection rejects zero maxPriceChange
rule donation_protection_rejects_zero_change() {
    env e;

    setDonationProtection@withrevert(e, 1000000000000000000000, 0); // 1000e18 supply, 0 change

    assert lastReverted,
        "setDonationProtection accepted zero maxPriceChange";
}

/// @notice setDonationProtection rejects excessive maxPriceChange (>0.50e8)
rule donation_protection_rejects_extreme_change() {
    env e;
    uint256 extremeChange = 50000001; // > 0.50e8

    setDonationProtection@withrevert(e, 1000000000000000000000, extremeChange);

    assert lastReverted,
        "setDonationProtection accepted maxPriceChange > $0.50";
}

// ═══════════════════════════════════════════════════════════════════
// LATEST ROUND DATA
// ═══════════════════════════════════════════════════════════════════

/// @notice latestRoundData answer is always within [minSharePrice, maxSharePrice]
rule price_answer_within_bounds() {
    env e;
    uint80 roundId;
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;

    roundId, answer, startedAt, updatedAt, answeredInRound = latestRoundData@withrevert(e);

    // If it didn't revert, answer must be within bounds
    assert !lastReverted => (answer >= 0 && uint256(answer) >= minSharePrice() && uint256(answer) <= maxSharePrice()),
        "Price answer outside [minSharePrice, maxSharePrice]";
}
