// Certora Verification Spec: LeverageVault
// FIX: Previously no formal verification for leverage safety

methods {
    function positions(address) external returns (uint256, uint256, uint256, bool) envfree;
    function maxLeverage() external returns (uint256) envfree;
    function collateralVault() external returns (address) envfree;
    function borrowModule() external returns (address) envfree;
}

// RULE: Opening a position with zero collateral must revert
rule openRequiresCollateral() {
    env e;

    openLeveragedPosition@withrevert(e, 0, 0);

    assert lastReverted, "Opening with zero collateral must revert";
}

// RULE: Closing must repay all debt
rule closeRepaysDebt() {
    env e;

    uint256 collateralBefore;
    uint256 debtBefore;
    uint256 leverageBefore;
    bool activeBefore;
    (collateralBefore, debtBefore, leverageBefore, activeBefore) = positions(e.msg.sender);

    require activeBefore;

    closeLeveragedPosition(e);

    uint256 collateralAfter;
    uint256 debtAfter;
    uint256 leverageAfter;
    bool activeAfter;
    (collateralAfter, debtAfter, leverageAfter, activeAfter) = positions(e.msg.sender);

    assert debtAfter == 0, "After close, debt must be zero";
    assert !activeAfter, "After close, position must be inactive";
}

// RULE: Emergency close can only be called by authorized roles
rule emergencyCloseAuthorized() {
    env e;
    address user;

    emergencyClosePosition@withrevert(e, user);

    assert !lastReverted => (e.msg.sender == user || hasRole(e.msg.sender, LEVERAGE_VAULT_ROLE())),
        "Emergency close requires LEVERAGE_VAULT_ROLE or being the user";
}

// RULE: withdrawFor with skipHealthCheck restricts recipient
rule skipHealthCheckRecipientRestricted(address user, address token, uint256 amount, address recipient) {
    env e;

    withdrawFor@withrevert(e, user, token, amount, recipient, true);

    assert !lastReverted => (recipient == e.msg.sender || recipient == user),
        "Skip health check must restrict recipient to caller or user";
}
