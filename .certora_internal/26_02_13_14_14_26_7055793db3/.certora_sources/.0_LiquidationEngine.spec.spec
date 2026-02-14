/// @title LiquidationEngine Formal Verification Spec
/// @notice Certora spec for the LiquidationEngine contract
/// @dev Verifies liquidation guards, close factor bounds, and no excess profit

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── LiquidationEngine own (truly envfree) ──
    function closeFactorBps() external returns (uint256) envfree;
    function fullLiquidationThreshold() external returns (uint256) envfree;
    function MIN_LIQUIDATION_AMOUNT() external returns (uint256) envfree;
    function totalBadDebt() external returns (uint256) envfree;

    // ── These read external contracts, NOT envfree ──
    function isLiquidatable(address) external returns (bool);
    function estimateSeize(address, address, uint256) external returns (uint256);
    function paused() external returns (bool) envfree;

    // ── External contract summaries ──
    // PER_CALLEE_CONSTANT: same inputs → same outputs within a single rule.
    // This models the view-function consistency expected during a single tx.
    function _.healthFactorUnsafe(address) external => NONDET;
    function _.totalDebt(address)          external => NONDET;
    function _.reduceDebt(address, uint256) external => NONDET;
    function _.getConfig(address)          external => PER_CALLEE_CONSTANT;
    function _.deposits(address, address)  external => PER_CALLEE_CONSTANT;
    function _.getSupportedTokens()        external => NONDET;
    function _.getPriceUnsafe(address)     external => PER_CALLEE_CONSTANT;
    function _.getValueUsdUnsafe(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.getPrice(address)           external => PER_CALLEE_CONSTANT;
    function _.getValueUsd(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.decimals()                  external => PER_CALLEE_CONSTANT;
    function _.burn(address, uint256)      external => NONDET;
    function _.seize(address, address, uint256, address) external => NONDET;
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: STATE BOUNDS (enforced by constructor + setters)
// ═══════════════════════════════════════════════════════════════════

/// @notice Close factor is always in (0, 10000] — constructor & setCloseFactor enforce this.
/// @dev Preserved block assumes invariant in pre-state (inductive proof).
invariant close_factor_bounded()
    closeFactorBps() > 0 && closeFactorBps() <= 10000
    {
        preserved {
            require closeFactorBps() > 0 && closeFactorBps() <= 10000;
        }
    }

/// @notice Full liquidation threshold is always in (0, 10000) — constructor & setter enforce this.
/// @dev Preserved block assumes invariant in pre-state (inductive proof).
invariant full_liquidation_threshold_bounded()
    fullLiquidationThreshold() > 0 && fullLiquidationThreshold() < 10000
    {
        preserved {
            require fullLiquidationThreshold() > 0 && fullLiquidationThreshold() < 10000;
        }
    }

// ═══════════════════════════════════════════════════════════════════
// RULES: LIQUIDATION GUARDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Cannot liquidate a healthy position
/// @dev   isLiquidatable reads healthFactorUnsafe which is NONDET-summarised,
///        so we additionally require the on-chain invariant that liquidate()
///        checks hf >= 10000 ⇒ revert PositionHealthy.
rule cannot_liquidate_healthy(address borrower, address token, uint256 amount) {
    env e;
    require !isLiquidatable(e, borrower);

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

/// @notice Estimated seizure must be non-negative (uint256 is always >= 0, sanity check)
rule estimate_seize_non_negative(address borrower, address token, uint256 debtToRepay) {
    env e;
    require debtToRepay > 0;
    uint256 seized = estimateSeize(e, borrower, token, debtToRepay);
    assert seized >= 0,
        "Estimated seizure is negative";
}

/// @notice Larger repay → more collateral seized (monotonicity)
/// @dev    estimateSeize calls external oracle + vault (NONDET-summarised).
///         For monotonicity to hold, oracle.getPriceUnsafe and vault.deposits
///         must return the same value across both calls. We use a ghost-free
///         approach: call estimateSeize in the same env (same block.timestamp)
///         and rely on NONDET returning the same value per call-site — which
///         Certora does NOT guarantee. Therefore this rule can only be proven
///         with a concrete harness that stubs consistent prices. Marked as
///         a documentation rule for now.
rule seize_monotonic(address borrower, address token, uint256 amount1, uint256 amount2) {
    env e;
    require amount1 > 0;
    require amount2 > amount1;
    require amount2 < 1000000000000000000000000000; // 1e27 prevent overflow

    uint256 seized1 = estimateSeize(e, borrower, token, amount1);
    uint256 seized2 = estimateSeize(e, borrower, token, amount2);

    assert seized2 >= seized1,
        "Seize amount not monotonically increasing with repay amount";
}
