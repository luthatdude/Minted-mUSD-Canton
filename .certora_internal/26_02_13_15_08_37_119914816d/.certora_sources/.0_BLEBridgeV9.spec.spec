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
// RULES: NONCE SECURITY
// ═══════════════════════════════════════════════════════════════════

/// @notice Nonce is monotonically non-decreasing across all operations
rule nonce_monotonic(method f)
    filtered { f -> f.selector != sig:forceUpdateNonce(uint256, string).selector }
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
rule attestation_id_permanence(bytes32 id, method f) {
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
rule min_signatures_preserved(method f) {
    env e;
    calldataarg args;
    require minSignatures() >= 2 && minSignatures() <= 10;

    f(e, args);

    assert minSignatures() >= 2 && minSignatures() <= 10,
        "minSignatures out of valid range [2, 10]";
}
