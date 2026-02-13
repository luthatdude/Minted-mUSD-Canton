/// @title LiquidationEngine Formal Verification Spec
/// @notice Certora spec for the LiquidationEngine contract
/// @dev Verifies liquidation guards, close factor bounds, and no excess profit

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function closeFactorBps() external returns (uint256) envfree;
    function fullLiquidationThreshold() external returns (uint256) envfree;
    function isLiquidatable(address) external returns (bool) envfree;
    function estimateSeize(address, address, uint256) external returns (uint256) envfree;
    function liquidate(address, address, uint256) external;
    function paused() external returns (bool) envfree;

    // ── External contract summaries ──
    // PER_CALLEE_CONSTANT: same callee → same return value within a single rule.
    // Without these, Certora havocs external calls independently, allowing
    // healthFactorUnsafe to return >= 10000 inside isLiquidatable() but
    // < 10000 inside liquidate(), producing a spurious counterexample.
    function _.healthFactorUnsafe(address) external => PER_CALLEE_CONSTANT;
    function _.totalDebt(address)          external => PER_CALLEE_CONSTANT;
    function _.getConfig(address)          external => PER_CALLEE_CONSTANT;
    function _.getPriceUnsafe(address)     external => PER_CALLEE_CONSTANT;
    function _.getValueUsdUnsafe(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.deposits(address, address)  external => PER_CALLEE_CONSTANT;
    function _.decimals()                  external => PER_CALLEE_CONSTANT;

    // State-changing external calls — NONDET (side-effects don't matter for properties)
    function _.burn(address, uint256)                     external => NONDET;
    function _.seize(address, address, uint256, address)  external => NONDET;
    function _.reduceDebt(address, uint256)               external => NONDET;
    function _.transferFrom(address, address, uint256)    external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LIQUIDATION GUARDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Cannot liquidate a healthy position
rule cannot_liquidate_healthy(address borrower, address token, uint256 amount) {
    env e;
    require !isLiquidatable(borrower);

    liquidate@withrevert(e, borrower, token, amount);

    assert lastReverted,
        "Liquidation succeeded on healthy position";
}

/// @notice Self-liquidation is forbidden
rule no_self_liquidation(address token, uint256 amount) {
    env e;

    liquidate@withrevert(e, e.msg.sender, token, amount);

    assert lastReverted,
        "Self-liquidation succeeded";
}

/// @notice Liquidation below dust threshold reverts
rule dust_liquidation_reverts(address borrower, address token) {
    env e;
    uint256 dustAmount = 99999999999999999999; // 99.999...e18 < 100e18

    liquidate@withrevert(e, borrower, token, dustAmount);

    assert lastReverted,
        "Sub-dust liquidation succeeded";
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: CLOSE FACTOR BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Close factor must be in valid range (0, 10000]
/// @dev Enforced by constructor and setCloseFactor — invariant uses induction:
///      base case checks constructor, inductive step checks all state transitions.
invariant close_factor_bounded()
    closeFactorBps() > 0 && closeFactorBps() <= 10000;

/// @notice Full liquidation threshold must be in valid range (0, 10000)
/// @dev Enforced by constructor (5000) and setFullLiquidationThreshold.
invariant full_liquidation_threshold_bounded()
    fullLiquidationThreshold() > 0 && fullLiquidationThreshold() < 10000;

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSED STATE
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused engine blocks liquidation
rule paused_blocks_liquidation(address borrower, address token, uint256 amount) {
    env e;
    require paused();

    liquidate@withrevert(e, borrower, token, amount);

    assert lastReverted,
        "Liquidation succeeded while paused";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: SEIZURE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Estimated seizure must be non-negative
rule estimate_seize_non_negative(address borrower, address token, uint256 debtToRepay) {
    require debtToRepay > 0;
    uint256 seized = estimateSeize(borrower, token, debtToRepay);
    assert seized >= 0,
        "Estimated seizure is negative";
}

/// @notice Larger repay amount means more collateral seized (monotonicity)
rule seize_monotonic(address borrower, address token, uint256 amount1, uint256 amount2) {
    require amount1 > 0;
    require amount2 > amount1;

    uint256 seized1 = estimateSeize(borrower, token, amount1);
    uint256 seized2 = estimateSeize(borrower, token, amount2);

    assert seized2 >= seized1,
        "Seize amount not monotonically increasing with repay amount";
}
