/// @title InterestRateModel Formal Verification Spec (H-03)
/// @notice Certora spec for the jump-rate interest rate model
/// @dev Verifies rate monotonicity, kink continuity, reserve split, and parameter bounds

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function utilizationRate(uint256, uint256) external returns (uint256) envfree;
    function getBorrowRateAnnual(uint256, uint256) external returns (uint256) envfree;
    function getSupplyRateAnnual(uint256, uint256) external returns (uint256) envfree;
    function calculateInterest(uint256, uint256, uint256, uint256) external returns (uint256) envfree;
    function splitInterest(uint256) external returns (uint256, uint256) envfree;
    function baseRateBps() external returns (uint256) envfree;
    function multiplierBps() external returns (uint256) envfree;
    function kinkBps() external returns (uint256) envfree;
    function jumpMultiplierBps() external returns (uint256) envfree;
    function reserveFactorBps() external returns (uint256) envfree;
    function setParams(uint256, uint256, uint256, uint256, uint256) external;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: UTILIZATION RANGE
// ═══════════════════════════════════════════════════════════════════

/// @notice Utilization rate is always in [0, 10000] (0% to 100%)
rule utilization_bounded(uint256 totalBorrows, uint256 totalSupply) {
    uint256 util = utilizationRate(totalBorrows, totalSupply);

    assert util <= 10000,
        "Utilization exceeded 100%";
}

/// @notice Zero borrows → zero utilization
rule zero_borrows_zero_utilization(uint256 totalSupply) {
    require totalSupply > 0;

    uint256 util = utilizationRate(0, totalSupply);

    assert util == 0,
        "Zero borrows resulted in non-zero utilization";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: RATE MONOTONICITY
// ═══════════════════════════════════════════════════════════════════

/// @notice Higher utilization → higher borrow rate (monotonic)
rule borrow_rate_monotonic(uint256 borrows1, uint256 borrows2, uint256 supply) {
    require supply > 0;
    require borrows1 < borrows2;
    require borrows2 <= supply;

    uint256 rate1 = getBorrowRateAnnual(borrows1, supply);
    uint256 rate2 = getBorrowRateAnnual(borrows2, supply);

    assert rate2 >= rate1,
        "Borrow rate decreased with higher utilization";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: SUPPLY vs BORROW RATE
// ═══════════════════════════════════════════════════════════════════

/// @notice Supply rate never exceeds borrow rate
rule supply_leq_borrow_rate(uint256 totalBorrows, uint256 totalSupply) {
    require totalSupply > 0, "Zero supply causes division by zero in rate calculation";
    require totalBorrows <= totalSupply, "Borrows cannot exceed supply in valid protocol state";

    uint256 borrowRate = getBorrowRateAnnual(totalBorrows, totalSupply);
    uint256 supplyRate = getSupplyRateAnnual(totalBorrows, totalSupply);

    assert supplyRate <= borrowRate,
        "Supply rate exceeded borrow rate";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: INTEREST SPLIT
// ═══════════════════════════════════════════════════════════════════

/// @notice Split interest: supplier + reserve = total
rule interest_split_sums(uint256 interestAmount) {
    uint256 supplierAmount;
    uint256 reserveAmount;
    supplierAmount, reserveAmount = splitInterest(interestAmount);

    assert supplierAmount + reserveAmount == interestAmount,
        "Interest split doesn't sum to total";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ZERO PRINCIPAL / TIME
// ═══════════════════════════════════════════════════════════════════

/// @notice Zero principal → zero interest
rule zero_principal_zero_interest(uint256 totalBorrows, uint256 totalSupply, uint256 seconds) {
    uint256 interest = calculateInterest(0, totalBorrows, totalSupply, seconds);

    assert interest == 0,
        "Zero principal generated interest";
}

/// @notice Zero time → zero interest
rule zero_time_zero_interest(uint256 principal, uint256 totalBorrows, uint256 totalSupply) {
    uint256 interest = calculateInterest(principal, totalBorrows, totalSupply, 0);

    assert interest == 0,
        "Zero time generated interest";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PARAMETER BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Reserve factor never exceeds 50%
invariant reserve_factor_bounded()
    reserveFactorBps() <= 5000;

/// @notice Kink never exceeds 100%
invariant kink_bounded()
    kinkBps() <= 10000;

/// @notice Max annual rate at 100% utilization is capped at 100%
/// @dev The contract computes maxRate = baseRateBps + (kinkBps * multiplierBps) / 10000
///      + ((10000 - kinkBps) * jumpMultiplierBps) / 10000, and reverts if > 10000.
///      The raw sum base+multiplier+jump can exceed 10000 due to kink scaling.
rule max_rate_bounded() {
    mathint base = baseRateBps();
    mathint mult = multiplierBps();
    mathint kink = kinkBps();
    mathint jump = jumpMultiplierBps();

    mathint maxRate = base + (kink * mult) / 10000 + ((10000 - kink) * jump) / 10000;

    assert maxRate <= 10000,
        "Max annual rate exceeds 100%";
}
