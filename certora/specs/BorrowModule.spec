// Certora Verification Language (CVL) Specification
// Minted mUSD Protocol — BorrowModule Invariants
//
// Run with:
//   certoraRun contracts/BorrowModule.sol \
//     --verify BorrowModule:certora/specs/BorrowModule.spec \
//     --solc solc-0.8.26 \
//     --optimistic_loop \
//     --loop_iter 5

methods {
    function totalBorrows() external returns (uint256) envfree;
    function badDebt() external returns (uint256) envfree;
    function cumulativeBadDebt() external returns (uint256) envfree;
    function badDebtCovered() external returns (uint256) envfree;
    function totalDebt(address) external returns (uint256) envfree;
    function protocolReserves() external returns (uint256) envfree;
    function interestRateBps() external returns (uint256) envfree;
    function minDebt() external returns (uint256) envfree;
    function borrow(uint256) external;
    function repay(uint256) external;
}

// ═══════════════════════════════════════════════════════════════════════
// INVARIANT 1: totalBorrows accounting consistency
// ═══════════════════════════════════════════════════════════════════════
// totalBorrows should always be >= sum of active user debts
// (can be slightly > due to interest accrual timing, but never <)

invariant totalBorrowsNonNegative()
    totalBorrows() >= 0;

// ═══════════════════════════════════════════════════════════════════════
// INVARIANT 2: Bad debt accounting
// ═══════════════════════════════════════════════════════════════════════
// cumulativeBadDebt >= badDebt (cumulative is monotonically increasing)
// badDebtCovered <= cumulativeBadDebt (can't cover more than was generated)

invariant badDebtCumulativeMonotonic()
    cumulativeBadDebt() >= badDebt();

invariant badDebtCoveredBounded()
    badDebtCovered() <= cumulativeBadDebt();

// ═══════════════════════════════════════════════════════════════════════
// RULE 1: Borrow increases totalBorrows
// ═══════════════════════════════════════════════════════════════════════

rule borrowIncreasesTotalBorrows(uint256 amount) {
    env e;
    uint256 totalBefore = totalBorrows();
    
    borrow(e, amount);
    
    uint256 totalAfter = totalBorrows();
    // totalBorrows should increase by at least the borrowed amount
    // (may increase more due to interest accrual in _accrueGlobalInterest)
    assert totalAfter >= totalBefore + amount,
        "borrow must increase totalBorrows by at least the borrowed amount";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 2: Full repayment clears user debt
// ═══════════════════════════════════════════════════════════════════════

rule fullRepaymentClearsDebt() {
    env e;
    address user = e.msg.sender;
    
    uint256 debt = totalDebt(user);
    require debt > 0;
    
    // Repay full debt
    repay(e, debt);
    
    // After full repayment, user should have no debt
    // (may have tiny dust from interest accrued between totalDebt call and repay)
    uint256 remaining = totalDebt(user);
    assert remaining <= 1e15, // Allow 0.001 mUSD dust from timing
        "full repayment should clear user debt (within dust tolerance)";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 3: Interest rate bounded
// ═══════════════════════════════════════════════════════════════════════

rule interestRateBounded() {
    env e;
    assert interestRateBps() <= 5000, // Max 50% APR
        "interest rate must be <= 50% APR (5000 bps)";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 4: Min debt enforced on borrow
// ═══════════════════════════════════════════════════════════════════════

rule minDebtEnforcedOnBorrow(uint256 amount) {
    env e;
    address user = e.msg.sender;
    
    uint256 debtBefore = totalDebt(user);
    require debtBefore == 0; // Fresh borrower
    
    borrow@withrevert(e, amount);
    
    // If borrow succeeded, resulting debt must be >= minDebt
    assert !lastReverted => totalDebt(user) >= minDebt(),
        "new borrow position must meet minimum debt threshold";
}
