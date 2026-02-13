// Certora Verification Spec: BLEBridgeV9
// FIX: Previously no formal verification for bridge security

methods {
    function mintCap() external returns (uint256) envfree;
    function totalMinted() external returns (uint256) envfree;
    function requiredSignatures() external returns (uint256) envfree;
    function processedNonces(bytes32) external returns (bool) envfree;
}

// INV-1: Total minted never exceeds mint cap
invariant mintCapEnforced()
    totalMinted() <= mintCap();

// INV-2: Required signatures must be positive
invariant signaturesRequired()
    requiredSignatures() > 0;

// RULE: Nonces cannot be replayed
rule nonceNotReplayable(bytes32 nonce) {
    env e;

    require processedNonces(nonce) == true;

    // Any mint attempt with a used nonce must revert
    bridgeMint@withrevert(e, nonce);

    assert lastReverted, "Used nonce must cause revert";
}

// RULE: Minting increases totalMinted
rule mintIncreasesTotal() {
    env e;
    uint256 mintedBefore = totalMinted();

    // Any successful mint
    bridgeMint(e);

    uint256 mintedAfter = totalMinted();
    assert mintedAfter > mintedBefore, "Successful mint must increase totalMinted";
}

// RULE: Mint cap cannot be reduced below current supply
rule mintCapBoundedBySupply(uint256 newCap) {
    env e;

    uint256 currentMinted = totalMinted();

    setMintCap@withrevert(e, newCap);

    assert !lastReverted => newCap >= currentMinted,
        "Mint cap cannot be set below current minted amount";
}
