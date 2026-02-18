/// @title MorphoBlueAdapter Formal Verification Spec
/// @notice Certora spec for the Morpho Blue yield adapter
/// @dev Verifies protocol identity and return value constraints

methods {
    function protocolName() external returns (string memory) envfree;
    function protocolId() external returns (uint256) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// PROTOCOL IDENTITY
// ═══════════════════════════════════════════════════════════════════

/// @notice protocolId is always 2 (MorphoBlue)
rule protocol_id_is_2() {
    assert protocolId() == 2,
        "protocolId() is not 2";
}

/// @notice protocolName returns "Morpho Blue"
rule protocol_name_is_morpho_blue() {
    string memory name = protocolName();
    assert keccak256(bytes(name)) == keccak256(bytes("Morpho Blue")),
        "protocolName() did not return 'Morpho Blue'";
}
