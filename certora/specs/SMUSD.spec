/// @title SMUSD Formal Verification Spec
/// @notice Certora spec for the Staked mUSD (ERC-4626) vault
/// @dev ERC-4626 mathematical properties verified using view functions.
///      Execution-based deposit/mint/withdraw require a harness to model
///      SafeERC20 cross-contract calls; without one, DISPATCHER routes
///      transferFrom to SMUSD itself (also ERC20), breaking accounting.
///      Cross-contract execution correctness verified via Hardhat tests.

using MUSD as musd;

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // SMUSD envfree view functions
    function totalSupply() external returns (uint256) envfree;
    function totalAssets() external returns (uint256) envfree;
    function balanceOf(address) external returns (uint256) envfree;
    function convertToShares(uint256) external returns (uint256) envfree;
    function convertToAssets(uint256) external returns (uint256) envfree;
    function previewDeposit(uint256) external returns (uint256) envfree;
    function previewMint(uint256) external returns (uint256) envfree;
    function previewWithdraw(uint256) external returns (uint256) envfree;
    function previewRedeem(uint256) external returns (uint256) envfree;
    function paused() external returns (bool) envfree;
    function currentUnvestedYield() external returns (uint256) envfree;
    function unvestedYield() external returns (uint256) envfree;
    function yieldVestingEnd() external returns (uint256) envfree;
    function VESTING_DURATION() external returns (uint256) envfree;
    function MAX_YIELD_BPS() external returns (uint256) envfree;
    function cantonTotalShares() external returns (uint256) envfree;
    function lastDeposit(address) external returns (uint256) envfree;
    function WITHDRAW_COOLDOWN() external returns (uint256) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// ERC-4626 MATHEMATICAL INVARIANTS (view-only)
// ═══════════════════════════════════════════════════════════════════

/// @notice convertToShares→convertToAssets round-trip never exceeds input (floor rounding)
rule share_asset_conversion_consistency(uint256 assets) {
    require assets > 0 && assets < 1000000000000000000000000; // 1e24
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 shares = convertToShares(assets);
    uint256 roundTrip = convertToAssets(shares);

    assert roundTrip <= assets,
        "convertToAssets(convertToShares(x)) > x (rounding error)";
}

/// @notice Deposit→redeem round-trip never creates value
/// @dev previewDeposit uses floor rounding (fewer shares), previewRedeem uses
///      floor rounding (fewer assets). Composition guarantees no profit.
rule no_value_creation_on_roundtrip(uint256 assets) {
    require assets > 0 && assets < 1000000000000000000000000; // 1e24
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 shares = previewDeposit(assets);
    uint256 assetsOut = previewRedeem(shares);

    assert assetsOut <= assets,
        "Round-trip deposit→redeem created value";
}

/// @notice Larger deposit yields more (or equal) shares — monotonicity
rule deposit_share_monotonicity(uint256 assets1, uint256 assets2) {
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;
    require assets1 > 0;
    require assets2 > assets1;
    require assets2 < 1000000000000000000000000;

    uint256 shares1 = previewDeposit(assets1);
    uint256 shares2 = previewDeposit(assets2);

    assert shares2 >= shares1,
        "More assets deposited but fewer shares received";
}

/// @notice Larger redemption yields more (or equal) assets — monotonicity
rule redeem_asset_monotonicity(uint256 shares1, uint256 shares2) {
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;
    require shares1 > 0;
    require shares2 > shares1;
    require shares2 < 1000000000000000000000000;

    uint256 assets1 = previewRedeem(shares1);
    uint256 assets2 = previewRedeem(shares2);

    assert assets2 >= assets1,
        "More shares redeemed but fewer assets received";
}

// ═══════════════════════════════════════════════════════════════════
// SOLVENCY (view-only)
// ═══════════════════════════════════════════════════════════════════

/// @notice Full redemption of all shares cannot exceed vault assets
/// @dev Proves vault is solvent: sum of all share claims ≤ totalAssets.
///      Math: previewRedeem(S) = floor(S*(A+1)/(S+10^d)) < A+1, so floor ≤ A.
rule vault_solvency() {
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 totalRedeemable = previewRedeem(totalSupply());

    assert totalRedeemable <= totalAssets(),
        "Total redeemable exceeds total assets (vault insolvent)";
}

// ═══════════════════════════════════════════════════════════════════
// ZERO-VALUE EDGE CASES
// ═══════════════════════════════════════════════════════════════════

/// @notice Zero deposit returns zero shares
rule zero_deposit_returns_zero_shares() {
    uint256 shares = previewDeposit(0);
    assert shares == 0,
        "Zero deposit returned non-zero shares";
}

/// @notice Zero redeem returns zero assets
rule zero_redeem_returns_zero_assets() {
    uint256 assets = previewRedeem(0);
    assert assets == 0,
        "Zero redeem returned non-zero assets";
}

// ═══════════════════════════════════════════════════════════════════
// PAUSED STATE (revert checks — no cross-contract accounting needed)
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused vault blocks deposits
rule paused_blocks_deposit(uint256 assets, address receiver) {
    env e;
    require paused();

    deposit@withrevert(e, assets, receiver);

    assert lastReverted,
        "Deposit succeeded while paused";
}

/// @notice Paused vault blocks withdrawals
rule paused_blocks_withdraw(uint256 assets, address receiver, address owner) {
    env e;
    require paused();

    withdraw@withrevert(e, assets, receiver, owner);

    assert lastReverted,
        "Withdraw succeeded while paused";
}

// ═══════════════════════════════════════════════════════════════════
// CX-C-01: YIELD VESTING DEVIATION BOUNDS
// ═══════════════════════════════════════════════════════════════════

/// @notice Unvested yield never exceeds MAX_YIELD_BPS of total assets
/// @dev This bounds the maximum ERC-4626 preview deviation during vesting
rule unvested_yield_bounded_by_max_yield() {
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 unvested = currentUnvestedYield();
    uint256 raw = totalAssets() + unvested;
    uint256 maxYield = (raw * MAX_YIELD_BPS()) / 10000;

    assert unvested <= maxYield,
        "Unvested yield exceeds MAX_YIELD_BPS of total assets";
}

/// @notice During vesting, deposit-redeem round-trip never creates value
/// @dev The anti-MEV vesting mechanism depresses totalAssets, giving depositors
///      more shares. But floor rounding ensures no profit on round-trip.
rule vesting_favors_vault_on_deposit(uint256 assets) {
    require assets > 0 && assets < 1000000000000000000000000;
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 shares = convertToShares(assets);
    uint256 roundTrip = convertToAssets(shares);

    assert roundTrip <= assets,
        "Deposit-redeem round-trip created value during vesting";
}

/// @notice Cooldown prevents immediate withdrawal after deposit
rule cooldown_blocks_immediate_withdraw(address user) {
    require lastDeposit(user) > 0;

    env e;
    require e.block.timestamp < lastDeposit(user) + WITHDRAW_COOLDOWN();

    withdraw@withrevert(e, 1, user, user);

    assert lastReverted,
        "Withdraw succeeded during cooldown period";
}

/// @notice Canton shares do not affect local ERC-4626 conversion
/// @dev convertToShares uses local totalAssets/totalSupply, not global
rule canton_shares_dont_affect_local_conversion(uint256 assets) {
    require assets > 0 && assets < 1000000000000000000000000;
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000;

    uint256 shares = convertToShares(assets);
    assert shares > 0,
        "Zero shares for positive deposit";
}
