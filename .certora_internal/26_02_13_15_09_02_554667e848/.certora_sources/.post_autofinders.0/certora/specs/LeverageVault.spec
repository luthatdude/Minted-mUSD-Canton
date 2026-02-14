/// @title LeverageVault Formal Verification Spec
/// @notice Certora spec for leverage position safety
/// @dev Verifies leverage bounds and pause enforcement

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function maxLeverageX10() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;

    // External call summaries (BorrowModule, CollateralVault, ERC20)
    function _.transferFrom(address, address, uint256) external => NONDET;
    function _.transfer(address, uint256) external => NONDET;
    function _.approve(address, uint256) external => NONDET;
    function _.balanceOf(address) external => PER_CALLEE_CONSTANT;
    function _.decimals() external => PER_CALLEE_CONSTANT;
    function _.getValueUsd(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.getValueUsdUnsafe(address, uint256) external => PER_CALLEE_CONSTANT;
    function _.collateralFactor(address) external => PER_CALLEE_CONSTANT;
    function _.healthFactor(address) external => PER_CALLEE_CONSTANT;
    function _.borrow(address, uint256) external => NONDET;
    function _.repay(address, uint256) external => NONDET;
    function _.deposit(address, address, uint256) external => NONDET;
    function _.withdraw(address, address, uint256, address, bool) external => NONDET;
    function _.mint(address, uint256) external => NONDET;
    function _.burn(address, uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LEVERAGE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice maxLeverageX10 stays within bounds [10, 40] (1.0x to 4.0x)
rule leverage_bounded(method f) {
    env e;
    calldataarg args;
    require maxLeverageX10() >= 10 && maxLeverageX10() <= 40;

    f(e, args);

    assert maxLeverageX10() >= 10 && maxLeverageX10() <= 40,
        "maxLeverageX10 out of bounds [10, 40]";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused contract blocks opening positions
rule paused_blocks_open() {
    env e;
    require paused();

    address collateralToken;
    uint256 initialAmount;
    uint256 targetLeverageX10;
    uint256 maxLoopsOverride;
    uint256 userDeadline;

    openLeveragedPosition@withrevert(e, collateralToken, initialAmount,
        targetLeverageX10, maxLoopsOverride, userDeadline);

    assert lastReverted,
        "Opening position while paused must revert";
}

/// @notice Paused contract blocks closing positions
rule paused_blocks_close() {
    env e;
    require paused();
    uint256 minCollateralOut;

    closeLeveragedPosition@withrevert(e, minCollateralOut);

    assert lastReverted,
        "Closing position while paused must revert";
}
