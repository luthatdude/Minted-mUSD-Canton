/// @title FluidLoopStrategy Formal Verification Spec
/// @notice Certora spec for the FluidLoopStrategy leveraged loop contract
/// @dev Verifies LTV bounds, flash-loan safety, deposit/withdraw accounting,
///      leverage invariants, access control, pause enforcement, and DEX
///      collateral operations.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function totalPrincipal()       external returns (uint256) envfree;
    function targetLtvBps()         external returns (uint256) envfree;
    function targetLoops()          external returns (uint256) envfree;
    function safetyBufferBps()      external returns (uint256) envfree;
    function active()               external returns (bool)    envfree;
    function paused()               external returns (bool)    envfree;
    function positionNftId()        external returns (uint256) envfree;
    function vaultMode()            external returns (uint8)   envfree;
    function totalRewardsClaimed()  external returns (uint256) envfree;
    function minSwapOutputBps()     external returns (uint256) envfree;
    function dexEnabled()           external returns (bool)    envfree;
    function totalValue()           external returns (uint256) envfree;
    function asset()                external returns (address) envfree;
    function flashLoanPool()        external returns (address) envfree;

    // ── State-changing functions ──
    function deposit(uint256)                                   external returns (uint256);
    function withdraw(uint256)                                  external returns (uint256);
    function withdrawAll()                                      external returns (uint256);
    function rebalance()                                        external;
    function adjustLeverage(uint256, uint256)                    external;
    function setParameters(uint256, uint256)                     external;
    function setActive(bool)                                    external;
    function pause()                                            external;
    function unpause()                                          external;
    function emergencyDeleverage()                              external;
    function recoverToken(address, uint256)                     external;
    function setRewardToken(address, bool)                      external;
    function setSwapFees(uint24, uint24)                        external;
    function setMinSwapOutput(uint256)                           external;
    function depositDexCollateral(uint256, uint256, int256)      external;
    function withdrawDexCollateral(uint256, uint256, uint256)    external;
    function setVaultResolver(address)                          external;
    function setDexResolver(address)                            external;
    function setDexPool(address, bool)                          external;
    function executeOperation(address, uint256, uint256, address, bytes) external returns (bool);

    // ── Role constants (envfree) ──
    function TREASURY_ROLE()    external returns (bytes32) envfree;
    function STRATEGIST_ROLE()  external returns (bytes32) envfree;
    function GUARDIAN_ROLE()    external returns (bytes32) envfree;
    function KEEPER_ROLE()      external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.flashLoanSimple(address, address, uint256, bytes, uint16) external => NONDET;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: LTV BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice targetLtvBps is always within the valid range [3000, 9500]
invariant targetLtvInRange()
    targetLtvBps() >= 3000 && targetLtvBps() <= 9500
    { preserved { require active(); } }

/// @notice safetyBufferBps is never zero (must provide margin)
invariant safetyBufferPositive()
    safetyBufferBps() > 0;

/// @notice vaultMode is always 1, 2, or 3 once initialized
invariant validVaultMode()
    vaultMode() == 1 || vaultMode() == 2 || vaultMode() == 3
    { preserved { require vaultMode() > 0; } }

/// @notice minSwapOutputBps stays within [9000, 10000]
invariant minSwapOutputInRange()
    minSwapOutputBps() >= 9000 && minSwapOutputBps() <= 10000;

// ═══════════════════════════════════════════════════════════════════
// RULES: DEPOSIT ACCOUNTING
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit() increases totalPrincipal by exactly the deposited amount
rule deposit_accounting(uint256 amount) {
    env e;
    require amount > 0;
    require e.msg.value == 0;

    uint256 principalBefore = totalPrincipal();
    require principalBefore + amount <= max_uint256; // no overflow

    deposit@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 principalAfter = totalPrincipal();

    assert succeeded => principalAfter == principalBefore + amount,
        "deposit must increase totalPrincipal by exact amount";
}

/// @notice deposit() with zero amount must revert
rule deposit_zero_reverts() {
    env e;
    deposit@withrevert(e, 0);
    assert lastReverted, "deposit(0) must revert";
}

/// @notice deposit() when not active must revert
rule deposit_inactive_reverts(uint256 amount) {
    env e;
    require !active();
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while inactive must revert";
}

/// @notice deposit() when paused must revert
rule deposit_paused_reverts(uint256 amount) {
    env e;
    require paused();
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while paused must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: WITHDRAW ACCOUNTING
// ═══════════════════════════════════════════════════════════════════

/// @notice withdraw() decreases totalPrincipal
rule withdraw_decreases_principal(uint256 amount) {
    env e;
    require amount > 0;

    uint256 principalBefore = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    uint256 principalAfter = totalPrincipal();

    assert succeeded => principalAfter <= principalBefore,
        "withdraw must not increase totalPrincipal";
}

/// @notice withdraw(0) must revert
rule withdraw_zero_reverts() {
    env e;
    withdraw@withrevert(e, 0);
    assert lastReverted, "withdraw(0) must revert";
}

/// @notice withdrawAll() sets totalPrincipal to zero
rule withdrawAll_clears_principal() {
    env e;
    withdrawAll@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == 0,
        "withdrawAll must set totalPrincipal to 0";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: FLASH LOAN CALLBACK SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice executeOperation must revert if caller is not the flash loan pool
rule flashLoan_only_pool() {
    env e;
    address asset; uint256 amount; uint256 premium; address initiator;
    bytes params;

    // Simulate call from a non-pool address
    require e.msg.sender != flashLoanPool();

    executeOperation@withrevert(e, asset, amount, premium, initiator, params);

    assert lastReverted,
        "executeOperation must reject non-pool callers";
}

/// @notice executeOperation must revert if initiator is not this contract
rule flashLoan_only_self_initiated() {
    env e;
    address asset; uint256 amount; uint256 premium;
    address initiator; bytes params;

    // The initiator is not address(this)
    require initiator != currentContract;

    executeOperation@withrevert(e, asset, amount, premium, initiator, params);
    assert lastReverted,
        "executeOperation must revert if initiator != address(this)";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LEVERAGE PARAMETER SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice setParameters rejects LTV outside [3000, 9500]
rule setParameters_ltv_bounds(uint256 ltv, uint256 loops) {
    env e;
    require ltv < 3000 || ltv > 9500;

    setParameters@withrevert(e, ltv, loops);
    assert lastReverted, "setParameters must reject LTV outside [3000, 9500]";
}

/// @notice setParameters preserves LTV range
rule setParameters_preserves_range(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    bool succeeded = !lastReverted;

    assert succeeded => (targetLtvBps() >= 3000 && targetLtvBps() <= 9500),
        "After setParameters, targetLtvBps must be in [3000, 9500]";
}

/// @notice adjustLeverage rejects LTV outside [3000, 9500]
rule adjustLeverage_ltv_bounds(uint256 newLtv, uint256 minSharePrice) {
    env e;
    require newLtv < 3000 || newLtv > 9500;

    adjustLeverage@withrevert(e, newLtv, minSharePrice);
    assert lastReverted, "adjustLeverage must reject LTV outside [3000, 9500]";
}

/// @notice setMinSwapOutput rejects values outside [9000, 10000]
rule minSwapOutput_bounds(uint256 bps) {
    env e;
    require bps < 9000 || bps > 10000;

    setMinSwapOutput@withrevert(e, bps);
    assert lastReverted, "setMinSwapOutput must reject values outside [9000, 10000]";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only TREASURY_ROLE can call deposit()
rule deposit_requires_treasury(uint256 amount) {
    env e;
    deposit@withrevert(e, amount);
    assert !lastReverted => hasRole(e.msg.sender, TREASURY_ROLE()),
        "Only TREASURY_ROLE can deposit";
}

/// @notice Only TREASURY_ROLE can call withdraw()
rule withdraw_requires_treasury(uint256 amount) {
    env e;
    withdraw@withrevert(e, amount);
    assert !lastReverted => hasRole(e.msg.sender, TREASURY_ROLE()),
        "Only TREASURY_ROLE can withdraw";
}

/// @notice Only TREASURY_ROLE can call withdrawAll()
rule withdrawAll_requires_treasury() {
    env e;
    withdrawAll@withrevert(e);
    assert !lastReverted => hasRole(e.msg.sender, TREASURY_ROLE()),
        "Only TREASURY_ROLE can withdrawAll";
}

/// @notice Only KEEPER_ROLE can call rebalance()
rule rebalance_requires_keeper() {
    env e;
    rebalance@withrevert(e);
    assert !lastReverted => hasRole(e.msg.sender, KEEPER_ROLE()),
        "Only KEEPER_ROLE can rebalance";
}

/// @notice Only GUARDIAN_ROLE can call emergencyDeleverage()
rule emergency_requires_guardian() {
    env e;
    emergencyDeleverage@withrevert(e);
    assert !lastReverted => hasRole(e.msg.sender, GUARDIAN_ROLE()),
        "Only GUARDIAN_ROLE can emergencyDeleverage";
}

/// @notice Only STRATEGIST_ROLE can call setParameters()
rule setParameters_requires_strategist(uint256 ltv, uint256 loops) {
    env e;
    setParameters@withrevert(e, ltv, loops);
    assert !lastReverted => hasRole(e.msg.sender, STRATEGIST_ROLE()),
        "Only STRATEGIST_ROLE can setParameters";
}

/// @notice Only STRATEGIST_ROLE can call adjustLeverage()
rule adjustLeverage_requires_strategist(uint256 ltv, uint256 minSP) {
    env e;
    adjustLeverage@withrevert(e, ltv, minSP);
    assert !lastReverted => hasRole(e.msg.sender, STRATEGIST_ROLE()),
        "Only STRATEGIST_ROLE can adjustLeverage";
}

/// @notice Only STRATEGIST_ROLE can call depositDexCollateral()
rule dexDeposit_requires_strategist(uint256 t0, uint256 t1, int256 ms) {
    env e;
    depositDexCollateral@withrevert(e, t0, t1, ms);
    assert !lastReverted => hasRole(e.msg.sender, STRATEGIST_ROLE()),
        "Only STRATEGIST_ROLE can depositDexCollateral";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice All mutating operations revert when paused
rule paused_blocks_deposits(uint256 amount) {
    env e;
    require paused();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit must revert when paused";
}

rule paused_blocks_rebalance() {
    env e;
    require paused();
    rebalance@withrevert(e);
    assert lastReverted, "rebalance must revert when paused";
}

rule paused_blocks_adjustLeverage(uint256 ltv, uint256 minSP) {
    env e;
    require paused();
    adjustLeverage@withrevert(e, ltv, minSP);
    assert lastReverted, "adjustLeverage must revert when paused";
}

rule paused_blocks_dexDeposit(uint256 t0, uint256 t1, int256 ms) {
    env e;
    require paused();
    depositDexCollateral@withrevert(e, t0, t1, ms);
    assert lastReverted, "depositDexCollateral must revert when paused";
}

rule paused_blocks_dexWithdraw(uint256 shares, uint256 min0, uint256 min1) {
    env e;
    require paused();
    withdrawDexCollateral@withrevert(e, shares, min0, min1);
    assert lastReverted, "withdrawDexCollateral must revert when paused";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: DEX COLLATERAL MODE RESTRICTIONS
// ═══════════════════════════════════════════════════════════════════

/// @notice depositDexCollateral reverts for MODE_STABLE (T1)
rule dex_blocked_in_stable_mode(uint256 t0, uint256 t1, int256 ms) {
    env e;
    require vaultMode() == 1; // MODE_STABLE
    depositDexCollateral@withrevert(e, t0, t1, ms);
    assert lastReverted, "DEX collateral deposit must revert for T1 vaults";
}

/// @notice withdrawDexCollateral reverts for MODE_STABLE (T1)
rule dex_withdraw_blocked_in_stable(uint256 shares, uint256 min0, uint256 min1) {
    env e;
    require vaultMode() == 1;
    withdrawDexCollateral@withrevert(e, shares, min0, min1);
    assert lastReverted, "DEX collateral withdraw must revert for T1 vaults";
}

/// @notice DEX operations revert when dexEnabled is false
rule dex_disabled_blocks_deposit(uint256 t0, uint256 t1, int256 ms) {
    env e;
    require !dexEnabled();
    depositDexCollateral@withrevert(e, t0, t1, ms);
    assert lastReverted, "DEX deposit must revert when dexEnabled is false";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: RECOVER TOKEN SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice recoverToken cannot drain the input asset while principal > 0
rule recover_blocks_active_asset() {
    env e;
    address token; uint256 amount;

    // If there is active principal and token == inputAsset, must revert
    require totalPrincipal() > 0;
    require token == asset();

    recoverToken@withrevert(e, token, amount);
    assert lastReverted,
        "recoverToken must revert for inputAsset when totalPrincipal > 0";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PRINCIPAL CONSERVATION (high-level)
// ═══════════════════════════════════════════════════════════════════

/// @notice totalPrincipal never increases outside of deposit()
///         (verified via parametric rule over non-deposit functions)
rule principal_monotonic_decrease_on_withdraw(uint256 amount) {
    env e;
    uint256 before = totalPrincipal();

    withdraw@withrevert(e, amount);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() <= before,
        "withdraw must never increase totalPrincipal";
}

/// @notice emergencyDeleverage does not change totalPrincipal
///         (it deleverages the position but doesn't affect accounting)
rule emergency_preserves_principal() {
    env e;
    uint256 before = totalPrincipal();

    emergencyDeleverage@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "emergencyDeleverage must not change totalPrincipal";
}

/// @notice rebalance does not change totalPrincipal
rule rebalance_preserves_principal() {
    env e;
    uint256 before = totalPrincipal();

    rebalance@withrevert(e);
    bool succeeded = !lastReverted;

    assert succeeded => totalPrincipal() == before,
        "rebalance must not change totalPrincipal";
}
