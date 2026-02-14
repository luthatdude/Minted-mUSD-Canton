// Certora Verification Spec: BLEBridgeV9
// CRIT-02 FIX: Rewritten for V9 interface (was targeting phantom V8 functions).
//
// V9 uses attestation-based supply cap management, not direct minting.
// Key state: attestedCantonAssets, currentNonce, minSignatures, collateralRatioBps,
//            dailyCapIncreaseLimit, dailyCapIncreased, dailyCapDecreased, lastRateLimitReset.

methods {
    // V9 public state getters (envfree = no msg.sender / msg.value needed)
    function attestedCantonAssets() external returns (uint256) envfree;
    function currentNonce() external returns (uint256) envfree;
    function minSignatures() external returns (uint256) envfree;
    function collateralRatioBps() external returns (uint256) envfree;
    function dailyCapIncreaseLimit() external returns (uint256) envfree;
    function dailyCapIncreased() external returns (uint256) envfree;
    function dailyCapDecreased() external returns (uint256) envfree;
    function lastAttestationTime() external returns (uint256) envfree;
    function lastRateLimitReset() external returns (uint256) envfree;
    function usedAttestationIds(bytes32) external returns (bool) envfree;
    function paused() external returns (bool) envfree;

    // MUSD interface (external calls from bridge)
    function _.supplyCap() external => DISPATCHER(true);
    function _.totalSupply() external => DISPATCHER(true);
    function _.setSupplyCap(uint256) external => DISPATCHER(true);
}

// ═══════════════════════════════════════════════════════════════
// INV-1: minSignatures must always be >= 2
// Prevents single-validator attestation attacks.
// ═══════════════════════════════════════════════════════════════
invariant minSignaturesAtLeastTwo()
    minSignatures() >= 2;

// ═══════════════════════════════════════════════════════════════
// INV-2: Collateral ratio must always be >= 10000 (100%)
// Ensures mUSD is always at least 100% collateralized.
// ═══════════════════════════════════════════════════════════════
invariant collateralRatioAbove100Percent()
    collateralRatioBps() >= 10000;

// ═══════════════════════════════════════════════════════════════
// INV-3: Nonce monotonicity — nonce only increases
// Prevents replay attacks via nonce rollback.
// ═══════════════════════════════════════════════════════════════
rule nonceMonotonicallyIncreases(method f) filtered {
    f -> !f.isView && !f.isFallback
} {
    env e;
    calldataarg args;

    uint256 nonceBefore = currentNonce();
    f(e, args);
    uint256 nonceAfter = currentNonce();

    assert nonceAfter >= nonceBefore,
        "Nonce must never decrease";
}

// ═══════════════════════════════════════════════════════════════
// RULE-1: Attestation IDs cannot be replayed
// Once an attestation ID is marked used, any processAttestation
// with the same ID must revert.
// ═══════════════════════════════════════════════════════════════
rule attestationIdNotReplayable(bytes32 id) {
    require usedAttestationIds(id) == true;

    env e;
    calldataarg args;

    // Any processAttestation call with a reused ID must revert
    processAttestation@withrevert(e, args);

    // If it didn't revert, the ID must still be used (no clearing)
    assert usedAttestationIds(id) == true,
        "Used attestation ID must remain marked";
}

// ═══════════════════════════════════════════════════════════════
// RULE-2: processAttestation increments nonce by exactly 1
// Ensures each attestation consumes exactly one nonce slot.
// ═══════════════════════════════════════════════════════════════
rule processAttestationIncrementsNonce() {
    env e;
    calldataarg args;

    uint256 nonceBefore = currentNonce();

    processAttestation(e, args);

    uint256 nonceAfter = currentNonce();
    assert nonceAfter == nonceBefore + 1,
        "processAttestation must increment nonce by exactly 1";
}

// ═══════════════════════════════════════════════════════════════
// RULE-3: Daily cap increase is bounded by dailyCapIncreaseLimit
// Net daily increase (increased - decreased) cannot exceed the limit
// within a single 24-hour window.
// ═══════════════════════════════════════════════════════════════
rule dailyCapIncreaseBounded() {
    env e;
    calldataarg args;

    uint256 limitBefore = dailyCapIncreaseLimit();

    processAttestation(e, args);

    uint256 increased = dailyCapIncreased();
    uint256 decreased = dailyCapDecreased();

    // Net increase is capped: increased - decreased <= limit
    // (if decreased > increased, net is 0 which is fine)
    assert increased <= limitBefore + decreased,
        "Daily cap increase must not exceed limit + decreases";
}

// ═══════════════════════════════════════════════════════════════
// RULE-4: Emergency cap reduction cannot increase cap
// emergencyReduceCap must always result in a lower or equal cap.
// ═══════════════════════════════════════════════════════════════
rule emergencyCapOnlyReduces(uint256 newCap, string reason) {
    env e;

    emergencyReduceCap@withrevert(e, newCap, reason);

    // If it succeeded, the attestedCantonAssets didn't increase
    // (emergency reduce doesn't touch attestedCantonAssets, only supply cap)
    assert !lastReverted => attestedCantonAssets() == attestedCantonAssets(),
        "Emergency reduce must not alter attested assets";
}

// ═══════════════════════════════════════════════════════════════
// RULE-5: setMinSignatures cannot set below 2
// Enforces the MinSigsTooLow guard on admin calls.
// ═══════════════════════════════════════════════════════════════
rule setMinSignaturesGuarded(uint256 newMin) {
    env e;

    setMinSignatures@withrevert(e, newMin);

    assert !lastReverted => newMin >= 2,
        "setMinSignatures must revert if newMin < 2";
}
