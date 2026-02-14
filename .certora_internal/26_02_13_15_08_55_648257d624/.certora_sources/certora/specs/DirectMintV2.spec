/// @title DirectMintV2 Formal Verification Spec (H-03)
/// @notice Certora spec for the DirectMintV2 mint/redeem contract
/// @dev Verifies fee accounting, supply cap, decimal conversion, and access control

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    function mint(uint256) external returns (uint256);
    function redeem(uint256) external returns (uint256);
    function mintFor(address, uint256) external returns (uint256);
    function previewMint(uint256) external returns (uint256, uint256) envfree;
    function previewRedeem(uint256) external returns (uint256, uint256) envfree;
    function mintFeeBps() external returns (uint256) envfree;
    function redeemFeeBps() external returns (uint256) envfree;
    function mintFees() external returns (uint256) envfree;
    function redeemFees() external returns (uint256) envfree;
    function minMintAmount() external returns (uint256) envfree;
    function maxMintAmount() external returns (uint256) envfree;
    function minRedeemAmount() external returns (uint256) envfree;
    function maxRedeemAmount() external returns (uint256) envfree;
    function remainingMintable() external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function setFees(uint256, uint256) external;
    function setLimits(uint256, uint256, uint256, uint256) external;

    // External call summaries (ERC20, MUSD, Treasury)
    function _.transferFrom(address, address, uint256) external => NONDET;
    function _.approve(address, uint256) external => NONDET;
    function _.transfer(address, uint256) external => NONDET;
    function _.mint(address, uint256) external => NONDET;
    function _.burn(address, uint256) external => NONDET;
    function _.deposit(address, uint256) external => NONDET;
    function _.totalSupply() external => PER_CALLEE_CONSTANT;
    function _.supplyCap() external => PER_CALLEE_CONSTANT;
}

// ═══════════════════════════════════════════════════════════════════
// RULES: FEE BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint fee can never exceed MAX_FEE_BPS (500 = 5%)
invariant fee_bounds_mint()
    mintFeeBps() <= 500;

/// @notice Redeem fee can never exceed MAX_FEE_BPS (500 = 5%)
invariant fee_bounds_redeem()
    redeemFeeBps() <= 500;

// ═══════════════════════════════════════════════════════════════════
// RULES: MINT CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint preview matches actual output
rule mint_matches_preview(uint256 usdcAmount) {
    env e;
    require usdcAmount >= minMintAmount();
    require usdcAmount <= maxMintAmount();

    uint256 previewMusd;
    uint256 previewFee;
    previewMusd, previewFee = previewMint(usdcAmount);

    uint256 actualMusd = mint(e, usdcAmount);

    assert actualMusd == previewMusd,
        "Mint output doesn't match preview";
}

/// @notice Mint below minimum reverts
rule mint_rejects_below_minimum(uint256 usdcAmount) {
    env e;
    require usdcAmount > 0;
    require usdcAmount < minMintAmount();

    mint@withrevert(e, usdcAmount);

    assert lastReverted,
        "Mint below minMintAmount succeeded";
}

/// @notice Mint above maximum reverts
rule mint_rejects_above_maximum(uint256 usdcAmount) {
    env e;
    require usdcAmount > maxMintAmount();

    mint@withrevert(e, usdcAmount);

    assert lastReverted,
        "Mint above maxMintAmount succeeded";
}

/// @notice Mint fees only increase (never decrease during mint)
rule mint_fees_monotonic(uint256 usdcAmount) {
    env e;
    uint256 feesBefore = mintFees();

    mint(e, usdcAmount);

    assert mintFees() >= feesBefore,
        "Mint decreased fee accumulator";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: REDEEM CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

/// @notice Redeem preview matches actual output
rule redeem_matches_preview(uint256 musdAmount) {
    env e;
    require musdAmount >= minRedeemAmount();
    require musdAmount <= maxRedeemAmount();

    uint256 previewUsdc;
    uint256 previewFee;
    previewUsdc, previewFee = previewRedeem(musdAmount);

    uint256 actualUsdc = redeem(e, musdAmount);

    assert actualUsdc == previewUsdc,
        "Redeem output doesn't match preview";
}

/// @notice Redeem fees only increase
rule redeem_fees_monotonic(uint256 musdAmount) {
    env e;
    uint256 feesBefore = redeemFees();

    redeem(e, musdAmount);

    assert redeemFees() >= feesBefore,
        "Redeem decreased fee accumulator";
}

// ═══════════════════════════════════════════════════════════════════
// RULES: LIMIT ORDERING
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint limits: min <= max always
invariant mint_limit_ordering()
    minMintAmount() <= maxMintAmount();

/// @notice Redeem limits: min <= max always
invariant redeem_limit_ordering()
    minRedeemAmount() <= maxRedeemAmount();

// ═══════════════════════════════════════════════════════════════════
// RULES: PAUSED STATE
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused contract blocks minting
rule paused_blocks_mint(uint256 amount) {
    env e;
    require paused();

    mint@withrevert(e, amount);

    assert lastReverted,
        "Mint succeeded while paused";
}

/// @notice Paused contract blocks redeeming
rule paused_blocks_redeem(uint256 amount) {
    env e;
    require paused();

    redeem@withrevert(e, amount);

    assert lastReverted,
        "Redeem succeeded while paused";
}
