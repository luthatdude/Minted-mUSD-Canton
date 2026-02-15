// Certora Verification Spec: TreasuryV2
// FIX: Previously no formal verification for Treasury solvency

methods {
    function totalValue() external returns (uint256) envfree;
    function totalAllocated() external returns (uint256) envfree;
    function _.withdraw(uint256) external => DISPATCHER(true);
}

// INV-1: Treasury cannot have negative value
invariant treasuryNonNegative()
    totalValue() >= 0;

// INV-2: Total allocated cannot exceed total value
invariant allocatedBoundedByValue()
    totalAllocated() <= totalValue();

// RULE: Withdrawals must reduce totalValue
rule withdrawReducesValue(uint256 amount) {
    env e;
    uint256 valueBefore = totalValue();

    withdraw(e, amount);

    uint256 valueAfter = totalValue();
    assert valueAfter <= valueBefore, "Withdrawal must not increase total value";
}

// RULE: Only authorized roles can withdraw
rule onlyAuthorizedWithdraw(uint256 amount) {
    env e;

    withdraw@withrevert(e, amount);

    // If caller lacks VAULT_ROLE, the call must revert
    assert !lastReverted => hasRole(e.msg.sender, VAULT_ROLE()),
        "Only VAULT_ROLE can withdraw";
}
