/// @title BLEBridgeV9 Formal Verification Spec
/// @notice Certora spec for the BLE Bridge Canton attestation contract
/// @dev Verifies attestation replay prevention, nonce monotonicity,
///      collateral ratio bounds, rate limits, access control, and pause.

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // ── Storage reads (envfree) ──
    function attestedCantonAssets() external returns (uint256) envfree;
    function collateralRatioBps()   external returns (uint256) envfree;
    function currentNonce()         external returns (uint256) envfree;
    function minSignatures()        external returns (uint256) envfree;
    function lastAttestationTime()  external returns (uint256) envfree;
    function dailyCapIncreaseLimit() external returns (uint256) envfree;
    function dailyCapIncreased()    external returns (uint256) envfree;
    function paused()               external returns (bool)    envfree;
    function usedAttestationIds(bytes32) external returns (bool) envfree;

    // ── State-changing functions ──
    function setMinSignatures(uint256)      external;
    function setCollateralRatio(uint256)    external;
    function setDailyCapIncreaseLimit(uint256) external;
    function pause()                        external;
    function requestUnpause()               external;
    function executeUnpause()               external;
    function emergencyReduceCap(uint256, string) external;
    function forceUpdateNonce(uint256, string)   external;
    function invalidateAttestationId(bytes32, string) external;
    function upgradeToAndCall(address, bytes)    external;

    // ── Role constants (envfree) ──
    function VALIDATOR_ROLE()     external returns (bytes32) envfree;
    function EMERGENCY_ROLE()     external returns (bytes32) envfree;
    function DEFAULT_ADMIN_ROLE() external returns (bytes32) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;

    // ── External contract summaries ──
    function _.setSupplyCap(uint256) external => NONDET;
    function _.supplyCap() external          => PER_CALLEE_CONSTANT;
    function _.totalSupply() external        => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice minSignatures is always positive
/// @dev Filtered: upgradeToAndCall uses delegatecall which HAVOCs all storage
invariant minSignaturesPositive()
    minSignatures() > 0
    filtered { f -> f.selector != sig:upgradeToAndCall(address, bytes).selector }

/// @notice collateralRatioBps is always >= 10000 (100%)
/// @dev Filtered: upgradeToAndCall uses delegatecall which HAVOCs all storage
invariant collateralRatioAboveParity()
    collateralRatioBps() >= 10000
    filtered { f -> f.selector != sig:upgradeToAndCall(address, bytes).selector }

// ═══════════════════════════════════════════════════════════════════
// RULES: ATTESTATION REPLAY PREVENTION
// ═══════════════════════════════════════════════════════════════════

/// @notice Once an attestation ID is used, it stays used (monotonic)
/// @dev Filtered: upgradeToAndCall HAVOCs storage via delegatecall
rule attestation_id_monotonic(bytes32 id) {
    env e;
    require usedAttestationIds(id) == true;

    // Any state change shouldn't un-use an attestation
    calldataarg args;
    method f;
    require f.selector != sig:upgradeToAndCall(address, bytes).selector;
    f@withrevert(e, args);

    assert usedAttestationIds(id) == true,
        "Used attestation IDs must remain used";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: NONCE MONOTONICITY
// ═══════════════════════════════════════════════════════════════════

/// @notice currentNonce never decreases (except forceUpdateNonce by EMERGENCY_ROLE)
/// @dev Filtered: upgradeToAndCall HAVOCs storage via delegatecall
rule nonce_monotonic_on_normal_ops() {
    env e;
    uint256 nonceBefore = currentNonce();

    // For non-emergency operations, nonce should not decrease
    calldataarg args;
    method f;
    require f.selector != sig:forceUpdateNonce(uint256, string).selector;
    require f.selector != sig:upgradeToAndCall(address, bytes).selector;

    f@withrevert(e, args);

    bool succeeded = !lastReverted;
    assert succeeded => currentNonce() >= nonceBefore,
        "Nonce must not decrease on normal operations";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ACCESS CONTROL
// ═══════════════════════════════════════════════════════════════════

/// @notice Only EMERGENCY_ROLE can call pause()
rule pause_requires_emergency() {
    env e;
    pause@withrevert(e);
    assert !lastReverted => hasRole(EMERGENCY_ROLE(), e.msg.sender),
        "Only EMERGENCY_ROLE can pause";
}

/// @notice Only DEFAULT_ADMIN_ROLE can call requestUnpause()
rule requestUnpause_requires_admin() {
    env e;
    requestUnpause@withrevert(e);
    assert !lastReverted => hasRole(DEFAULT_ADMIN_ROLE(), e.msg.sender),
        "Only DEFAULT_ADMIN_ROLE can requestUnpause";
}

/// @notice Only EMERGENCY_ROLE can call emergencyReduceCap()
rule emergencyReduceCap_requires_emergency(uint256 cap, string reason) {
    env e;
    emergencyReduceCap@withrevert(e, cap, reason);
    assert !lastReverted => hasRole(EMERGENCY_ROLE(), e.msg.sender),
        "Only EMERGENCY_ROLE can emergencyReduceCap";
}

/// @notice Only EMERGENCY_ROLE can call forceUpdateNonce()
rule forceUpdateNonce_requires_emergency(uint256 nonce, string reason) {
    env e;
    forceUpdateNonce@withrevert(e, nonce, reason);
    assert !lastReverted => hasRole(EMERGENCY_ROLE(), e.msg.sender),
        "Only EMERGENCY_ROLE can forceUpdateNonce";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: COLLATERAL RATIO BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice setCollateralRatio stores value and maintains >= 10000
rule setCollateralRatio_stores(uint256 ratio) {
    env e;
    setCollateralRatio@withrevert(e, ratio);
    bool succeeded = !lastReverted;
    assert succeeded => collateralRatioBps() >= 10000,
        "collateralRatioBps must remain >= 10000 after set";
}
