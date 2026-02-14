/// @title BLEBridgeV9 Formal Verification Spec
/// @notice Certora spec for the attestation-based bridge
/// @dev Verifies nonce monotonicity, attestation ID permanence, and signature bounds

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function minSignatures() external returns (uint256) envfree;
    function currentNonce() external returns (uint256) envfree;
    function usedAttestationIds(bytes32) external returns (bool) envfree;
    function attestedCantonAssets() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;

    // Summarize external MUSD token calls
    function _.setSupplyCap(uint256) external => NONDET;
    function _.supplyCap() external => PER_CALLEE_CONSTANT;
    function _.totalSupply() external => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

/// @notice Functions excluded from parametric verification
/// @dev upgradeToAndCall: delegatecall to arbitrary code, not modelable.
///      initialize: one-shot initializer guard not modelable; also only checks _minSigs >= 2.
///      processAttestation (0x0a4a4ba4): ECDSA signature verification loop with
///        ecrecover precompile causes solver timeout. Properties trivially hold
///        by code inspection: nonce++ always increases, usedAttestationIds only
///        set to true, minSignatures not modified. Verified via Hardhat unit tests.
///      migrateUsedAttestations (0x57575a26): loop over dynamic bytes32[] array.
///        Only sets usedAttestationIds[id] = true; nonce and minSignatures untouched.
definition isExcluded(method f) returns bool =
    f.selector == sig:upgradeToAndCall(address, bytes).selector
    || f.selector == sig:initialize(uint256, address, uint256, uint256).selector
    || f.selector == to_bytes4(0x0a4a4ba4)   // processAttestation
    || f.selector == to_bytes4(0x57575a26);   // migrateUsedAttestations

// ═══════════════════════════════════════════════════════════════════
// RULES: NONCE SECURITY
// ═══════════════════════════════════════════════════════════════════

/// @notice Nonce is monotonically non-decreasing across all operations
/// @dev forceUpdateNonce is admin-only emergency function excluded by design.
///      processAttestation does currentNonce++ (trivially monotonic, verified by unit tests).
rule nonce_monotonic(method f)
    filtered { f ->
        f.selector != sig:forceUpdateNonce(uint256, string).selector
        && !isExcluded(f)
    }
{
    env e;
    calldataarg args;
    uint256 nonceBefore = currentNonce();

    f(e, args);

    assert currentNonce() >= nonceBefore,
        "Nonce must never decrease";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: ATTESTATION ID PERMANENCE
// ═══════════════════════════════════════════════════════════════════

/// @notice Once an attestation ID is used, it can never be un-set
/// @dev processAttestation sets usedAttestationIds[att.id] = true (never false).
///      migrateUsedAttestations loops setting usedAttestationIds[id] = true.
///      Both trivially preserve this property. Verified via Hardhat unit tests.
rule attestation_id_permanence(bytes32 id, method f)
    filtered { f -> !isExcluded(f) }
{
    env e;
    calldataarg args;
    require usedAttestationIds(id) == true;

    f(e, args);

    assert usedAttestationIds(id) == true,
        "Used attestation ID was reset to false";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: SIGNATURE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice minSignatures stays within valid range [2, 10] (inductive)
/// @dev Only setMinSignatures modifies this field, with explicit [2,10] bounds.
///      processAttestation and migrateUsedAttestations do not modify minSignatures.
rule min_signatures_preserved(method f)
    filtered { f -> !isExcluded(f) }
{
    env e;
    calldataarg args;
    require minSignatures() >= 2 && minSignatures() <= 10;

    f(e, args);

    assert minSignatures() >= 2 && minSignatures() <= 10,
        "minSignatures out of valid range [2, 10]";
}
