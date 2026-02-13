/// @title BorrowModule Formal Verification Spec
/// @notice Certora spec for the BorrowModule debt management contract
/// @dev Verifies debt accounting, health factor enforcement, and interest invariants

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function totalBorrows() external returns (uint256) envfree;
    function totalDebt(address) external returns (uint256) envfree;
    function healthFactor(address) external returns (uint256) envfree;
    function healthFactorUnsafe(address) external returns (uint256) envfree;
    function maxBorrow(address) external returns (uint256) envfree;
    function borrowCapacity(address) external returns (uint256) envfree;
    function minDebt() external returns (uint256) envfree;
    function protocolReserves() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: BORROW SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice Borrow must maintain healthy position (HF >= 1.0)
rule borrow_maintains_health_factor(uint256 amount) {
    env e;
    require amount > 0;

    borrow(e, amount);

    // After successful borrow, health factor must be >= 10000 (1.0)
    uint256 hf = healthFactor(e.msg.sender);
    assert hf >= 10000,
        "Borrow resulted in unhealthy position";
}

/// @notice Borrow must respect minimum debt requirement
rule borrow_respects_min_debt(uint256 amount) {
    env e;
    uint256 debtBefore = totalDebt(e.msg.sender);
    require debtBefore == 0; // First borrow
    require amount > 0;
    require amount < minDebt();

    borrow@withrevert(e, amount);

    assert lastReverted,
        "Borrow below minDebt succeeded";
}

/// @notice Borrow increases totalBorrows by exact amount
rule borrow_increases_total_borrows(uint256 amount) {
    env e;
    uint256 totalBefore = totalBorrows();
    uint256 debtBefore = totalDebt(e.msg.sender);

    borrow(e, amount);

    uint256 totalAfter = totalBorrows();
    // totalBorrows should increase by amount (interest may also be accrued)
    assert totalAfter >= totalBefore + amount,
        "totalBorrows didn't increase by borrow amount";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: REPAY CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

/// @notice Repay decreases user debt
rule repay_decreases_debt(uint256 amount) {
    env e;
    uint256 debtBefore = totalDebt(e.msg.sender);
    require debtBefore > 0;
    require amount > 0;
    require amount <= debtBefore;

    repay(e, amount);

    uint256 debtAfter = totalDebt(e.msg.sender);
    assert debtAfter < debtBefore,
        "Repay didn't decrease debt";
}

/// @notice Full repay sets debt to zero
rule full_repay_clears_debt() {
    env e;
    uint256 debt = totalDebt(e.msg.sender);
    require debt > 0;

    repay(e, debt);

    assert totalDebt(e.msg.sender) == 0,
        "Full repay didn't clear debt to zero";
}

/// @notice Partial repay must maintain minimum debt
rule partial_repay_maintains_min_debt(uint256 amount) {
    env e;
    uint256 debtBefore = totalDebt(e.msg.sender);
    uint256 min = minDebt();
    require debtBefore > min;
    require amount > 0;
    require debtBefore - amount < min; // Remaining would be below min
    require debtBefore - amount > 0;   // Not full repay

    repay@withrevert(e, amount);

    assert lastReverted,
        "Partial repay left debt below minDebt";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: WITHDRAWAL SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice Withdrawal must maintain healthy position
rule withdrawal_maintains_health_factor(address token, uint256 amount) {
    env e;
    uint256 debtBefore = totalDebt(e.msg.sender);
    require debtBefore > 0;

    withdrawCollateral(e, token, amount);

    // After successful withdrawal, health factor must be >= 10000
    uint256 hf = healthFactor(e.msg.sender);
    assert hf >= 10000,
        "Withdrawal resulted in unhealthy position";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: INTEREST ACCRUAL
// ═══════════════════════════════════════════════════════════════════

/// @notice Interest accrual never decreases debt
rule interest_never_decreases_debt(address user) {
    env e;
    uint256 debtBefore = totalDebt(user);
    require debtBefore > 0;

    accrueInterest(e, user);

    assert totalDebt(user) >= debtBefore,
        "Interest accrual decreased debt";
}

/// @notice Interest accrual for zero debt doesn't create debt
rule no_phantom_interest(address user) {
    env e;
    require totalDebt(user) == 0;

    accrueInterest(e, user);

    assert totalDebt(user) == 0,
        "Interest accrual created phantom debt";
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
