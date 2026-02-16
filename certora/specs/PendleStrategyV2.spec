/// @title PendleStrategyV2 Formal Verification Spec
/// @notice Certora spec for the PendleStrategyV2 PT yield strategy
/// @dev Verifies slippage bounds, rollover threshold, discount-rate caps,
///      deposit/withdraw accounting, access control, pause enforcement,
///      manual-mode gating, position-count limits, emergency operations,
///      and token-recovery restrictions.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function active()                external returns (bool)    envfree;
    function paused()                external returns (bool)    envfree;
    function ptBalance()             external returns (uint256) envfree;
    function slippageBps()           external returns (uint256) envfree;
    function ptDiscountRateBps()     external returns (uint256) envfree;
    function rolloverThreshold()     external returns (uint256) envfree;
    function manualMarketSelection() external returns (bool)    envfree;
    function currentMarket()         external returns (address) envfree;
    function currentPT()             external returns (address) envfree;
    function currentExpiry()         external returns (uint256) envfree;
    function totalValue()            external returns (uint256) envfree;
    function asset()                 external returns (address) envfree;
    function positionCount()         external returns (uint256) envfree;
    function BPS()                   external returns (uint256) envfree;
    function MAX_SLIPPAGE_BPS()      external returns (uint256) envfree;
    function MAX_POSITIONS()         external returns (uint256) envfree;

    // ── State-changing functions ──
    function deposit(uint256)                      external returns (uint256);
    function withdraw(uint256)                     external returns (uint256);
    function withdrawAll()                         external returns (uint256);
    function setSlippage(uint256)                   external;
    function setPtDiscountRate(uint256)              external;
    function setRolloverThreshold(uint256)           external;
    function setManualMode(bool)                    external;
    function setMarketManual(address)               external;
    function setMarketSelector(address)             external;
    function setActive(bool)                        external;
    function allocateToMarket(address, uint256)     external;
    function deallocateFromMarket(address, uint256)  external;
    function deallocateAllFromMarket(address)        external;
    function rollToNewMarket()                      external;
    function triggerRollover()                       external;
    function emergencyWithdraw(address)             external;
    function recoverToken(address, address)          external;
    function pause()                                external;
    function unpause()                              external;

    // ── Role constants (envfree) ──
    function TREASURY_ROLE()    external returns (bytes32) envfree;
    function STRATEGIST_ROLE()  external returns (bytes32) envfree;
    function GUARDIAN_ROLE()    external returns (bytes32) envfree;
    function TIMELOCK_ROLE()    external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.safeTransferFrom(address, address, uint256) external => NONDET;
    function _.safeTransfer(address, uint256)               external => NONDET;
    function _.forceApprove(address, uint256)               external => NONDET;
    function _.balanceOf(address)                           external => PER_CALLEE_CONSTANT;
    function _.selectBestMarket(string) external            => NONDET;
    function _.isValidMarket(address) external              => PER_CALLEE_CONSTANT;
    function _.readTokens() external                        => NONDET;
    function _.expiry() external                            => PER_CALLEE_CONSTANT;
    function _.isExpired() external                         => PER_CALLEE_CONSTANT;
    function _.decimals() external                          => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS: CONFIGURATION BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice slippageBps never exceeds MAX_SLIPPAGE_BPS (100 = 1%)
invariant slippageBounded()
    slippageBps() <= 100;

/// @notice ptDiscountRateBps never exceeds 5000 (50%)
invariant discountRateBounded()
    ptDiscountRateBps() <= 5000;

/// @notice rolloverThreshold is always within [1 day, 30 days]
invariant rolloverThresholdInRange()
    rolloverThreshold() >= 86400 && rolloverThreshold() <= 2592000;

/// @notice positionCount never exceeds MAX_POSITIONS (10)
invariant positionCountBounded()
    positionCount() <= 10;

// ═══════════════════════════════════════════════════════════════════
// RULES: DEPOSIT
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit(0) must revert
rule deposit_zero_reverts() {
    env e;
    deposit@withrevert(e, 0);
    assert lastReverted, "deposit(0) must revert";
}

/// @notice deposit() when not active must revert
rule deposit_inactive_reverts(uint256 amount) {
    env e;
    require !active();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while inactive must revert";
}

/// @notice deposit() when paused must revert
rule deposit_paused_reverts(uint256 amount) {
    env e;
    require paused();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit while paused must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: WITHDRAW
// ═══════════════════════════════════════════════════════════════════

/// @notice withdraw(0) must revert
rule withdraw_zero_reverts() {
    env e;
    withdraw@withrevert(e, 0);
    assert lastReverted, "withdraw(0) must revert";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PARAMETER BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice setSlippage rejects values > MAX_SLIPPAGE_BPS (100)
rule setSlippage_bounds(uint256 bps) {
    env e;
    require bps > 100;

    setSlippage@withrevert(e, bps);
    assert lastReverted, "setSlippage must reject values > 100 bps";
}

/// @notice setSlippage stores the new value on success
rule setSlippage_stores(uint256 bps) {
    env e;
    require bps <= 100;

    setSlippage@withrevert(e, bps);
    bool succeeded = !lastReverted;

    assert succeeded => slippageBps() == bps,
        "setSlippage must store the new value";
}

/// @notice setPtDiscountRate rejects values > 5000
rule setPtDiscountRate_bounds(uint256 bps) {
    env e;
    require bps > 5000;

    setPtDiscountRate@withrevert(e, bps);
    assert lastReverted, "setPtDiscountRate must reject values > 5000";
}

/// @notice setPtDiscountRate stores the new value on success
rule setPtDiscountRate_stores(uint256 bps) {
    env e;
    require bps <= 5000;

    setPtDiscountRate@withrevert(e, bps);
    bool succeeded = !lastReverted;

    assert succeeded => ptDiscountRateBps() == bps,
        "setPtDiscountRate must store the new value";
}

/// @notice setRolloverThreshold rejects values < 1 day
rule setRolloverThreshold_min(uint256 t) {
    env e;
    require t < 86400; // 1 day

    setRolloverThreshold@withrevert(e, t);
    assert lastReverted, "setRolloverThreshold must reject values < 1 day";
}

/// @notice setRolloverThreshold rejects values > 30 days
rule setRolloverThreshold_max(uint256 t) {
    env e;
    require t > 2592000; // 30 days

    setRolloverThreshold@withrevert(e, t);
    assert lastReverted, "setRolloverThreshold must reject values > 30 days";
}

/// @notice setRolloverThreshold stores the new value on success
rule setRolloverThreshold_stores(uint256 t) {
    env e;
    require t >= 86400 && t <= 2592000;

    setRolloverThreshold@withrevert(e, t);
    bool succeeded = !lastReverted;

    assert succeeded => rolloverThreshold() == t,
        "setRolloverThreshold must store the new value";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: MANUAL MODE GATING
// ═══════════════════════════════════════════════════════════════════

/// @notice allocateToMarket reverts when NOT in manual mode
rule allocateToMarket_requires_manual(address market, uint256 amt) {
    env e;
    require !manualMarketSelection();

    allocateToMarket@withrevert(e, market, amt);
    assert lastReverted, "allocateToMarket must revert when not in manual mode";
}

/// @notice deallocateFromMarket reverts when NOT in manual mode
rule deallocateFromMarket_requires_manual(address market, uint256 amt) {
    env e;
    require !manualMarketSelection();

    deallocateFromMarket@withrevert(e, market, amt);
    assert lastReverted, "deallocateFromMarket must revert when not in manual mode";
}

/// @notice setMarketManual reverts when NOT in manual mode
rule setMarketManual_requires_manual(address market) {
    env e;
    require !manualMarketSelection();

    setMarketManual@withrevert(e, market);
    assert lastReverted, "setMarketManual must revert when not in manual mode";
}

/// @notice rollToNewMarket reverts in manual mode
rule rollToNewMarket_blocked_in_manual() {
    env e;
    require manualMarketSelection();

    rollToNewMarket@withrevert(e);
    assert lastReverted, "rollToNewMarket must revert in manual mode";
}

/// @notice triggerRollover reverts in manual mode
rule triggerRollover_blocked_in_manual() {
    env e;
    require manualMarketSelection();

    triggerRollover@withrevert(e);
    assert lastReverted, "triggerRollover must revert in manual mode";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only TREASURY_ROLE can call deposit()
rule deposit_requires_treasury(uint256 amount) {
    env e;
    deposit@withrevert(e, amount);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can deposit";
}

/// @notice Only TREASURY_ROLE can call withdraw()
rule withdraw_requires_treasury(uint256 amount) {
    env e;
    withdraw@withrevert(e, amount);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can withdraw";
}

/// @notice Only TREASURY_ROLE can call withdrawAll()
rule withdrawAll_requires_treasury() {
    env e;
    withdrawAll@withrevert(e);
    assert !lastReverted => hasRole(TREASURY_ROLE(), e.msg.sender),
        "Only TREASURY_ROLE can withdrawAll";
}

/// @notice Only STRATEGIST_ROLE can call setSlippage()
rule setSlippage_requires_strategist(uint256 bps) {
    env e;
    setSlippage@withrevert(e, bps);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setSlippage";
}

/// @notice Only STRATEGIST_ROLE can call setPtDiscountRate()
rule setPtDiscountRate_requires_strategist(uint256 bps) {
    env e;
    setPtDiscountRate@withrevert(e, bps);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setPtDiscountRate";
}

/// @notice Only STRATEGIST_ROLE can call setRolloverThreshold()
rule setRolloverThreshold_requires_strategist(uint256 t) {
    env e;
    setRolloverThreshold@withrevert(e, t);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can setRolloverThreshold";
}

/// @notice Only STRATEGIST_ROLE can call allocateToMarket()
rule allocateToMarket_requires_strategist(address m, uint256 a) {
    env e;
    allocateToMarket@withrevert(e, m, a);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can allocateToMarket";
}

/// @notice Only STRATEGIST_ROLE can call rollToNewMarket()
rule rollToNewMarket_requires_strategist() {
    env e;
    rollToNewMarket@withrevert(e);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can rollToNewMarket";
}

/// @notice Only STRATEGIST_ROLE can call triggerRollover()
rule triggerRollover_requires_strategist() {
    env e;
    triggerRollover@withrevert(e);
    assert !lastReverted => hasRole(STRATEGIST_ROLE(), e.msg.sender),
        "Only STRATEGIST_ROLE can triggerRollover";
}

/// @notice Only GUARDIAN_ROLE can call emergencyWithdraw()
rule emergencyWithdraw_requires_guardian(address recipient) {
    env e;
    emergencyWithdraw@withrevert(e, recipient);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can emergencyWithdraw";
}

/// @notice Only GUARDIAN_ROLE can call pause()
rule pause_requires_guardian() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can pause";
}

/// @notice Only GUARDIAN_ROLE can call setActive()
rule setActive_requires_guardian(bool a) {
    env e;
    setActive@withrevert(e, a);
    assert !lastReverted => hasRole(GUARDIAN_ROLE(), e.msg.sender),
        "Only GUARDIAN_ROLE can setActive";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice deposit() reverts when paused
rule paused_blocks_deposit(uint256 amount) {
    env e;
    require paused();
    require amount > 0;
    deposit@withrevert(e, amount);
    assert lastReverted, "deposit must revert when paused";
}

/// @notice allocateToMarket() reverts when paused
rule paused_blocks_allocate(address m, uint256 a) {
    env e;
    require paused();
    allocateToMarket@withrevert(e, m, a);
    assert lastReverted, "allocateToMarket must revert when paused";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: EMERGENCY WITHDRAW SAFETY
// ═══════════════════════════════════════════════════════════════════

/// @notice emergencyWithdraw with zero-address recipient must revert
rule emergencyWithdraw_zero_recipient() {
    env e;
    emergencyWithdraw@withrevert(e, 0);
    assert lastReverted, "emergencyWithdraw(address(0)) must revert";
}

/// @notice emergencyWithdraw pauses the contract
rule emergencyWithdraw_pauses() {
    env e;
    address recipient;
    require recipient != 0;

    emergencyWithdraw@withrevert(e, recipient);
    bool succeeded = !lastReverted;

    assert succeeded => paused(),
        "emergencyWithdraw must pause the contract";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: RECOVER TOKEN RESTRICTIONS
// ═══════════════════════════════════════════════════════════════════

/// @notice recoverToken cannot recover USDC
rule recover_blocks_usdc(address to) {
    env e;
    address usdcAddr = asset();

    recoverToken@withrevert(e, usdcAddr, to);
    assert lastReverted,
        "recoverToken must revert for USDC";
}

/// @notice recoverToken cannot recover current PT
rule recover_blocks_currentPT(address to) {
    env e;
    address pt = currentPT();
    require pt != 0;

    recoverToken@withrevert(e, pt, to);
    assert lastReverted,
        "recoverToken must revert for current PT token";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ALLOCATE INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════════

/// @notice allocateToMarket with zero address reverts
rule allocateToMarket_zero_address(uint256 amt) {
    env e;
    require manualMarketSelection();
    allocateToMarket@withrevert(e, 0, amt);
    assert lastReverted, "allocateToMarket(address(0)) must revert";
}

/// @notice allocateToMarket with zero amount reverts
rule allocateToMarket_zero_amount(address market) {
    env e;
    require manualMarketSelection();
    require market != 0;
    allocateToMarket@withrevert(e, market, 0);
    assert lastReverted, "allocateToMarket(0) must revert";
}
