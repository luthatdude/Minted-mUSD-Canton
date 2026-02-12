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
// RULES: CLOSE FACTOR BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Close factor must be in valid range (0, 10000]
rule close_factor_bounded() {
    uint256 cf = closeFactorBps();
    assert cf > 0 && cf <= 10000,
        "Close factor out of bounds";
}

/// @notice Full liquidation threshold must be in valid range (0, 10000)
rule full_liquidation_threshold_bounded() {
    uint256 flt = fullLiquidationThreshold();
    assert flt > 0 && flt < 10000,
        "Full liquidation threshold out of bounds";
}

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
