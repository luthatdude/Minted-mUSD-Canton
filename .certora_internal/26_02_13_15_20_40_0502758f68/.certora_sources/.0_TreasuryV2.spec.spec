/// @title TreasuryV2 Formal Verification Spec
/// @notice Certora spec for Treasury pause enforcement and reserve bounds
/// @dev Verifies access control and parameter safety

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function reserveBps() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function vault() external returns (address) envfree;

    // External call summaries (strategies, ERC20 asset)
    function _.totalValue() external => PER_CALLEE_CONSTANT;
    function _.balanceOf(address) external => PER_CALLEE_CONSTANT;
    function _.transfer(address, uint256) external => NONDET;
    function _.transferFrom(address, address, uint256) external => NONDET;
    function _.approve(address, uint256) external => NONDET;
    function _.withdraw(uint256) external => NONDET;
    function _.deposit(uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused contract blocks withdrawals
rule paused_blocks_withdraw(address to, uint256 amount) {
    env e;
    require paused();

    withdraw@withrevert(e, to, amount);

    assert lastReverted,
        "Withdrawal succeeded while paused";
}

/// @notice Paused contract blocks vault withdrawals
rule paused_blocks_withdrawToVault(uint256 amount) {
    env e;
    require paused();

    withdrawToVault@withrevert(e, amount);

    assert lastReverted,
        "withdrawToVault succeeded while paused";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: RESERVE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Reserve BPS never exceeds 100% (inductive)
rule reserve_bps_bounded(method f)
    filtered {
        // Exclude UUPS upgrade methods — delegatecall target is unconstrained
        f -> f.selector != sig:upgradeToAndCall(address, bytes).selector
    }
{
    env e;
    calldataarg args;
    require reserveBps() <= 10000;

    f(e, args);

    assert reserveBps() <= 10000,
        "Reserve BPS exceeded 100%";
}
