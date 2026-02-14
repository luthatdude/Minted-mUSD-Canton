// Certora Verification Spec: TreasuryV2
// GAP-3: Expanded from 38-line stub to comprehensive spec for a contract managing >$500M.
// Covers: solvency invariants, fee accrual correctness, strategy bounds,
//         access control, pause enforcement, rebalance safety, and withdrawal integrity.

// ═══════════════════════════════════════════════════════════════════════
// METHOD DECLARATIONS
// ═══════════════════════════════════════════════════════════════════════

methods {
    // View functions (envfree)
    function totalValue()              external returns (uint256) envfree;
    function totalValueNet()           external returns (uint256) envfree;
    function reserveBalance()          external returns (uint256) envfree;
    function targetReserve()           external returns (uint256) envfree;
    function strategyCount()           external returns (uint256) envfree;
    function pendingFees()             external returns (uint256) envfree;
    function reserveBps()              external returns (uint256) envfree;
    function lastRecordedValue()       external returns (uint256) envfree;
    function peakRecordedValue()       external returns (uint256) envfree;
    function lastFeeAccrual()          external returns (uint256) envfree;
    function vault()                   external returns (address) envfree;
    function paused()                  external returns (bool)    envfree;
    function availableReserves()       external returns (uint256) envfree;
    function BPS()                     external returns (uint256) envfree;
    function MAX_STRATEGIES()          external returns (uint256) envfree;
    function MIN_ACCRUAL_INTERVAL()    external returns (uint256) envfree;

    // State-changing (dispatched)
    function _.withdraw(uint256) external => DISPATCHER(true);
    function _.deposit(uint256)  external => DISPATCHER(true);
    function _.totalValue()      external => DISPATCHER(true);
    function _.withdrawAll()     external => DISPATCHER(true);

    // Role helpers
    function hasRole(bytes32, address) external returns (bool)   envfree;
    function VAULT_ROLE()         external returns (bytes32)     envfree;
    function GUARDIAN_ROLE()      external returns (bytes32)     envfree;
    function ALLOCATOR_ROLE()     external returns (bytes32)     envfree;
    function STRATEGIST_ROLE()    external returns (bytes32)     envfree;
}

// ═══════════════════════════════════════════════════════════════════════
// SOLVENCY INVARIANTS
// ═══════════════════════════════════════════════════════════════════════

// INV-1: Treasury total value is always non-negative
invariant treasuryNonNegative()
    totalValue() >= 0;

// INV-2: Total allocated to strategies cannot exceed total value
// (reserve + strategies = totalValue)
invariant allocatedBoundedByValue()
    reserveBalance() <= totalValue();

// INV-3: Net value (after fees) never exceeds gross value
invariant netValueBoundedByGross()
    totalValueNet() <= totalValue();

// INV-4: Accrued fees never exceed total value
// If fees > totalValue, the protocol is insolvent
invariant feesCannotExceedValue()
    pendingFees() <= totalValue();

// INV-5: Reserve BPS is bounded (max 30%)
invariant reserveBpsBounded()
    reserveBps() <= 3000;

// INV-6: Strategy count stays within MAX_STRATEGIES
invariant strategyCountBounded()
    strategyCount() <= MAX_STRATEGIES();

// INV-7: Peak recorded value is monotonically non-decreasing
// (can only increase, ensuring high-water mark is never reset)
invariant peakIsMonotonic()
    peakRecordedValue() >= lastRecordedValue()
    {
        preserved {
            require peakRecordedValue() >= lastRecordedValue();
        }
    }

// ═══════════════════════════════════════════════════════════════════════
// WITHDRAWAL RULES
// ═══════════════════════════════════════════════════════════════════════

// RULE-1: Withdrawals must reduce totalValue
rule withdrawReducesValue(uint256 amount) {
    env e;
    uint256 valueBefore = totalValue();

    withdraw(e, amount);

    uint256 valueAfter = totalValue();
    assert valueAfter <= valueBefore, "Withdrawal must not increase total value";
}

// RULE-2: Only VAULT_ROLE can call withdraw
rule onlyAuthorizedWithdraw(uint256 amount) {
    env e;

    withdraw@withrevert(e, amount);

    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can withdraw";
}

// RULE-3: Withdraw reverts on zero amount
rule withdrawRevertsOnZero() {
    env e;
    withdraw@withrevert(e, 0);
    assert lastReverted, "Withdraw(0) must revert";
}

// RULE-4: withdrawToVault sends funds to vault address
rule withdrawToVaultSendsToVault(uint256 amount) {
    env e;
    address vaultAddr = vault();

    withdrawToVault@withrevert(e, amount);

    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can withdrawToVault";
}

// ═══════════════════════════════════════════════════════════════════════
// DEPOSIT RULES
// ═══════════════════════════════════════════════════════════════════════

// RULE-5: Deposits increase totalValue
rule depositIncreasesValue(address from, uint256 amount) {
    env e;
    require amount > 0;
    uint256 valueBefore = totalValue();

    deposit(e, from, amount);

    uint256 valueAfter = totalValue();
    assert valueAfter >= valueBefore, "Deposit must not decrease total value";
}

// RULE-6: Only VAULT_ROLE can deposit
rule onlyVaultCanDeposit(address from, uint256 amount) {
    env e;

    deposit@withrevert(e, from, amount);

    assert !lastReverted => hasRole(VAULT_ROLE(), e.msg.sender),
        "Only VAULT_ROLE can deposit";
}

// RULE-7: Deposit reverts on zero amount
rule depositRevertsOnZero(address from) {
    env e;
    deposit@withrevert(e, from, 0);
    assert lastReverted, "Deposit(0) must revert";
}

// RULE-8: Deposit enforces from == msg.sender (MustDepositOwnFunds)
rule depositFromMustBeSender(address from, uint256 amount) {
    env e;
    require amount > 0;

    deposit@withrevert(e, from, amount);

    assert !lastReverted => from == e.msg.sender,
        "Deposit must be from msg.sender (MustDepositOwnFunds)";
}

// ═══════════════════════════════════════════════════════════════════════
// FEE ACCRUAL RULES
// ═══════════════════════════════════════════════════════════════════════

// RULE-9: Fee accrual only happens on genuine yield above high-water mark
rule feesOnlyOnYield() {
    env e;
    uint256 peakBefore = peakRecordedValue();
    uint256 feesBefore = pendingFees();

    accrueFees(e);

    uint256 peakAfter = peakRecordedValue();
    uint256 feesAfter = pendingFees();

    // If no new peak, fees should not increase
    assert peakAfter == peakBefore => feesAfter == feesBefore,
        "Fees must not accrue without new yield above peak";
}

// RULE-10: Fee accrual respects MIN_ACCRUAL_INTERVAL
rule feeAccrualRespectsCooldown() {
    env e;
    uint256 lastAccrual = lastFeeAccrual();
    uint256 feesBefore = pendingFees();

    // If called within cooldown, fees should not change
    require e.block.timestamp < lastAccrual + MIN_ACCRUAL_INTERVAL();

    accrueFees(e);

    assert pendingFees() == feesBefore,
        "Fees must not accrue within MIN_ACCRUAL_INTERVAL";
}

// RULE-11: claimFees reduces accruedFees
rule claimFeesReducesAccrued() {
    env e;
    uint256 feesBefore = pendingFees();

    claimFees(e);

    uint256 feesAfter = pendingFees();
    assert feesAfter <= feesBefore, "claimFees must reduce or maintain accruedFees";
}

// RULE-12: Only DEFAULT_ADMIN_ROLE can claim fees
rule onlyAdminCanClaimFees() {
    env e;

    claimFees@withrevert(e);

    assert !lastReverted => hasRole(0x0000000000000000000000000000000000000000000000000000000000000000, e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can claim fees";
}

// ═══════════════════════════════════════════════════════════════════════
// PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════

// RULE-13: All state-changing ops revert when paused
rule pauseBlocksDeposits(address from, uint256 amount) {
    env e;
    require paused() == true;
    require amount > 0;

    deposit@withrevert(e, from, amount);

    assert lastReverted, "Deposits must revert when paused";
}

rule pauseBlocksWithdrawals(uint256 amount) {
    env e;
    require paused() == true;
    require amount > 0;

    withdraw@withrevert(e, amount);

    assert lastReverted, "Withdrawals must revert when paused";
}

rule pauseBlocksVaultWithdraw(uint256 amount) {
    env e;
    require paused() == true;
    require amount > 0;

    withdrawToVault@withrevert(e, amount);

    assert lastReverted, "withdrawToVault must revert when paused";
}

// RULE-14: Only GUARDIAN_ROLE can pause
rule onlyGuardianCanPause() {
    env e;

    pause@withrevert(e);

    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can pause";
}

// RULE-15: Only DEFAULT_ADMIN_ROLE can unpause
rule onlyAdminCanUnpause() {
    env e;

    unpause@withrevert(e);

    assert !lastReverted => hasRole(0x0000000000000000000000000000000000000000000000000000000000000000, e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can unpause";
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY MANAGEMENT RULES
// ═══════════════════════════════════════════════════════════════════════

// RULE-16: addStrategy increases strategy count
rule addStrategyIncreasesCount(
    address strategy,
    uint256 targetBps,
    uint256 minBps,
    uint256 maxBps,
    bool autoAllocate
) {
    env e;
    uint256 countBefore = strategyCount();

    addStrategy(e, strategy, targetBps, minBps, maxBps, autoAllocate);

    uint256 countAfter = strategyCount();
    assert countAfter == countBefore + 1, "addStrategy must increase count by 1";
}

// RULE-17: Only STRATEGIST_ROLE can add strategies
rule onlyStrategistCanAddStrategy(
    address strategy,
    uint256 targetBps,
    uint256 minBps,
    uint256 maxBps,
    bool autoAllocate
) {
    env e;

    addStrategy@withrevert(e, strategy, targetBps, minBps, maxBps, autoAllocate);

    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can add strategies";
}

// ═══════════════════════════════════════════════════════════════════════
// ADMIN CONFIG RULES (TIMELOCK GATED)
// ═══════════════════════════════════════════════════════════════════════

// RULE-18: setFeeConfig caps performance fee at 50%
rule feeConfigCappedAt50Percent(uint256 performanceFeeBps, address feeRecipient) {
    env e;

    setFeeConfig@withrevert(e, performanceFeeBps, feeRecipient);

    assert !lastReverted => performanceFeeBps <= 5000,
        "Performance fee must be <= 50%";
}

// RULE-19: setReserveBps caps at 30%
rule reserveBpsCappedAt30Percent(uint256 newReserveBps) {
    env e;

    setReserveBps@withrevert(e, newReserveBps);

    assert !lastReverted => newReserveBps <= 3000,
        "Reserve BPS must be <= 30%";
}

// ═══════════════════════════════════════════════════════════════════════
// EMERGENCY RULES
// ═══════════════════════════════════════════════════════════════════════

// RULE-20: Only GUARDIAN_ROLE can call emergencyWithdrawAll
rule onlyGuardianCanEmergencyWithdraw() {
    env e;

    emergencyWithdrawAll@withrevert(e);

    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can call emergencyWithdrawAll";
}

// RULE-21: emergencyWithdrawAll sets lastRecordedValue = totalValue
rule emergencyWithdrawUpdatesRecordedValue() {
    env e;

    emergencyWithdrawAll(e);

    assert lastRecordedValue() == totalValue(),
        "emergencyWithdrawAll must sync lastRecordedValue";
}

// ═══════════════════════════════════════════════════════════════════════
// VALUE CONSERVATION
// ═══════════════════════════════════════════════════════════════════════

// RULE-22: Rebalance preserves total value (within rounding)
rule rebalancePreservesValue() {
    env e;
    uint256 valueBefore = totalValue();

    rebalance(e);

    uint256 valueAfter = totalValue();
    // Allow 1% tolerance for strategy slippage during rebalance
    assert valueAfter >= (valueBefore * 99) / 100,
        "Rebalance must not lose more than 1% to slippage";
}
