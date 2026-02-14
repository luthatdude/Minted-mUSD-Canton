/// @title BorrowModule Formal Verification Spec
/// @notice Certora spec for the BorrowModule debt management contract
/// @dev Verifies debt accounting, health factor enforcement, and interest invariants

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Truly envfree (pure storage reads, no external calls) ──
    function totalBorrows() external returns (uint256) envfree;
    function minDebt() external returns (uint256) envfree;
    function protocolReserves() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function positions(address) external returns (uint256, uint256, uint256) envfree;
    function lastGlobalAccrualTime() external returns (uint256) envfree;

    // ── NOT envfree (call external oracle/vault/interestRateModel or use block.timestamp) ──
    function totalDebt(address) external returns (uint256);
    function healthFactor(address) external returns (uint256);
    function healthFactorUnsafe(address) external returns (uint256);
    function maxBorrow(address) external returns (uint256);
    function borrowCapacity(address) external returns (uint256);
    function borrow(uint256) external;
    function repay(uint256) external;
    function withdrawCollateral(address, uint256) external;
    function reduceDebt(address, uint256) external;
    function accrueInterest(address) external;

    // ── External contract summaries ──
    // PER_CALLEE_CONSTANT: same inputs → same outputs within a single rule.
    function _.calculateInterest(uint256, uint256, uint256, uint256) external => PER_CALLEE_CONSTANT;
    function _.splitInterest(uint256) external => PER_CALLEE_CONSTANT;
    function _.getBorrowRateAnnual(uint256, uint256) external => PER_CALLEE_CONSTANT;
    function _.getSupplyRateAnnual(uint256, uint256) external => PER_CALLEE_CONSTANT;
    function _.utilizationRate(uint256, uint256) external => PER_CALLEE_CONSTANT;
    function _.totalValue() external => PER_CALLEE_CONSTANT;
    function _.getValueUsd(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.getValueUsdUnsafe(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.deposits(address, address) external => PER_CALLEE_CONSTANT;
    function _.getSupportedTokens() external => NONDET;
    function _.getConfig(address) external => PER_CALLEE_CONSTANT;
    function _.withdraw(address, uint256, address) external => NONDET;
    function _.mint(address, uint256) external => NONDET;
    function _.burn(address, uint256) external => NONDET;
    function _.receiveInterest(uint256) external => NONDET;
    function _.forceApprove(address, uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: BORROW SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice Borrow increases totalBorrows by at least the borrowed amount
/// @dev Uses @withrevert: asserts the property only when borrow succeeds,
///      avoiding vacuity from paths that legitimately revert (access control, capacity, etc.)
rule borrow_increases_total_borrows(uint256 amount) {
    env e;
    require amount > 0;
    require e.msg.value == 0;
    require !paused();

    uint256 totalBefore = totalBorrows();

    borrow@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 totalAfter = totalBorrows();
    // If borrow succeeded, totalBorrows must have increased by at least amount
    // (may increase by more due to global interest accrual in _accrueGlobalInterest)
    assert succeeded => totalAfter >= totalBefore + amount,
        "totalBorrows didn't increase by borrow amount";
}

/// @notice First borrow must respect minimum debt requirement
rule borrow_respects_min_debt(uint256 amount) {
    env e;
    require totalDebt(e, e.msg.sender) == 0; // First borrow
    require amount > 0;
    require amount < minDebt();

    borrow@withrevert(e, amount);

    assert lastReverted,
        "Borrow below minDebt succeeded";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: REPAY CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

/// @notice Repay decreases totalBorrows (isolated from interest accrual)
/// @dev Requires no time elapsed since last accrual to isolate repay's accounting
///      from _accrueGlobalInterest, which can increase totalBorrows by routed interest.
///      Without this, a counter-example exists where accrued interest > repaid amount.
rule repay_decreases_total_borrows(uint256 amount) {
    env e;
    require amount > 0;
    require e.msg.value == 0;

    // Isolate repay accounting: no time elapsed → no interest accrual
    uint256 pBefore; uint256 aBefore; uint256 tBefore;
    (pBefore, aBefore, tBefore) = positions(e.msg.sender);
    require pBefore + aBefore > 0;                          // Must have debt
    require e.block.timestamp == tBefore;                    // No user interest elapsed
    require e.block.timestamp == lastGlobalAccrualTime();    // No global interest elapsed

    uint256 totalBefore = totalBorrows();
    require totalBefore > 0;

    repay(e, amount);

    uint256 totalAfter = totalBorrows();
    assert totalAfter < totalBefore,
        "Repay didn't decrease totalBorrows";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: INTEREST ACCRUAL
// ═══════════════════════════════════════════════════════════════════

/// @notice Interest accrual for zero-debt user doesn't create debt
/// @dev This rule passes because _accrueInterest early-returns when
///      principal == 0 && accruedInterest == 0.
rule no_phantom_interest(address user) {
    env e;
    require totalDebt(e, user) == 0;

    accrueInterest(e, user);

    assert totalDebt(e, user) == 0,
        "Interest accrual created phantom debt";
}

/// @notice Interest accrual never decreases stored debt (principal + accruedInterest)
/// @dev Reads positions storage directly to avoid totalDebt() view projection artifacts.
///      totalDebt() projects pending interest using calculateInterest(), which can differ
///      before vs after accrual due to totalBorrows changes in _accrueGlobalInterest().
///      Stored debt only increases because _accrueInterest does pos.accruedInterest += interest.
rule interest_never_decreases_debt(address user) {
    env e;
    uint256 pBefore; uint256 aBefore; uint256 tBefore;
    (pBefore, aBefore, tBefore) = positions(user);
    uint256 storedDebtBefore = pBefore + aBefore;
    require storedDebtBefore > 0;

    accrueInterest(e, user);

    uint256 pAfter; uint256 aAfter; uint256 tAfter;
    (pAfter, aAfter, tAfter) = positions(user);
    uint256 storedDebtAfter = pAfter + aAfter;
    assert storedDebtAfter >= storedDebtBefore,
        "Interest accrual decreased debt";
}

/// @notice After repay, debt is either fully cleared or stays above minDebt
/// @dev The contract auto-closes positions where remaining < minDebt
rule repay_auto_close_invariant(uint256 amount) {
    env e;
    require amount > 0;

    repay(e, amount);

    uint256 debtAfter = totalDebt(e, e.msg.sender);
    assert debtAfter == 0 || debtAfter >= minDebt(),
        "Repay left debt below minDebt";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSED STATE
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused contract blocks borrowing
rule paused_blocks_borrow(uint256 amount) {
    env e;
    require paused();

    borrow@withrevert(e, amount);

    assert lastReverted,
        "Borrow succeeded while paused";
}

/// @notice Paused contract blocks repaying
rule paused_blocks_repay(uint256 amount) {
    env e;
    require paused();

    repay@withrevert(e, amount);

    assert lastReverted,
        "Repay succeeded while paused";
}

/// @notice Paused contract blocks collateral withdrawal
rule paused_blocks_withdrawal(address token, uint256 amount) {
    env e;
    require paused();

    withdrawCollateral@withrevert(e, token, amount);

    assert lastReverted,
        "Withdrawal succeeded while paused";
}
