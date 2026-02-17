/// @title DepositRouter Formal Verification Spec (H-03)
/// @notice Certora spec for the DepositRouter cross-chain deposit contract
/// @dev Verifies fee accounting, deposit bounds, nonce monotonicity, and pending state

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function deposit(uint256) external returns (uint64);
    function depositFor(address, uint256) external returns (uint64);
    function previewDeposit(uint256) external returns (uint256, uint256) envfree;
    function quoteBridgeCost() external returns (uint256) envfree;
    function isDepositComplete(uint64) external returns (bool) envfree;
    function feeBps() external returns (uint256) envfree;
    function accumulatedFees() external returns (uint256) envfree;
    function markDepositComplete(uint64) external;
    function markDepositsComplete(uint64[]) external;
    function setFee(uint256) external;
    function paused() external returns (bool) envfree;

    // ── External contract summaries ──
    // Without these, Certora uses HAVOC dispatching for external calls,
    // which can modify DepositRouter storage (breaking completion_is_final).
    function _.transfer(address, uint256) external => NONDET;
    function _.transferFrom(address, address, uint256) external => NONDET;
    function _.balanceOf(address) external => PER_CALLEE_CONSTANT;
    function _.allowance(address, address) external => PER_CALLEE_CONSTANT;
    function _.sendPayloadToEvm(uint16, address, bytes, uint256, uint256) external => NONDET;
    function _.quoteEVMDeliveryPrice(uint16, uint256, uint256) external => PER_CALLEE_CONSTANT;
    function _.transferTokensWithPayload(address, uint256, uint16, bytes32, uint32, bytes) external => NONDET;
    function _.wrappedAsset(uint16, bytes32) external => PER_CALLEE_CONSTANT;
    function _.forceApprove(address, uint256) external => NONDET;
    function _.approve(address, uint256) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: FEE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Fee can never exceed 500 bps (5%)
invariant fee_cap()
    feeBps() <= 500;

// ═══════════════════════════════════════════════════════════════════
// RULES: DEPOSIT CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

/// @notice Deposit preview matches net + fee = amount
rule deposit_fee_accounting(uint256 amount) {
    uint256 netAmount;
    uint256 fee;
    netAmount, fee = previewDeposit(amount);

    assert netAmount + fee == amount,
        "Fee decomposition mismatch: net + fee != amount";
}

/// @notice Accumulated fees only increase during deposits
rule fees_monotonic_on_deposit(uint256 amount) {
    env e;
    uint256 feesBefore = accumulatedFees();

    deposit(e, amount);

    assert accumulatedFees() >= feesBefore,
        "Deposit decreased fee accumulator";
}

/// @notice Deposit below MIN_DEPOSIT (1 USDC) reverts
rule deposit_rejects_below_minimum(uint256 amount) {
    env e;
    require amount > 0;
    require amount < 1000000; // 1e6 = 1 USDC

    deposit@withrevert(e, amount);

    assert lastReverted,
        "Deposit below minimum succeeded";
}

/// @notice Deposit above MAX_DEPOSIT reverts
rule deposit_rejects_above_maximum(uint256 amount) {
    env e;
    require amount > 1000000000000; // 1_000_000e6

    deposit@withrevert(e, amount);

    assert lastReverted,
        "Deposit above maximum succeeded";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PENDING DEPOSIT FINALITY
// ═══════════════════════════════════════════════════════════════════

/// @notice Once completed, a deposit stays completed forever
/// @dev Tests that NO function can undo completion. Uses f@withrevert
///      to avoid vacuity (markDepositComplete reverts on already-completed deposits).
rule completion_is_final(uint64 seqNum) {
    env e;
    require isDepositComplete(seqNum) == true;

    // After any state transition, still complete
    calldataarg args;
    method f;
    f@withrevert(e, args);

    assert isDepositComplete(seqNum) == true,
        "Completed deposit reverted to pending";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSED STATE
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused contract blocks deposits
rule paused_blocks_deposit(uint256 amount) {
    env e;
    require paused();

    deposit@withrevert(e, amount);

    assert lastReverted,
        "Deposit succeeded while paused";
}
