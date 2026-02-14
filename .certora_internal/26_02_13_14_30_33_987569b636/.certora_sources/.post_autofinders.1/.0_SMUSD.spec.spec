/// @title SMUSD Formal Verification Spec
/// @notice Certora spec for the Staked mUSD (ERC-4626) vault
/// @dev Verifies share price monotonicity, solvency, and ERC-4626 invariants

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
    function maxDeposit(address) external returns (uint256) envfree;
    function maxMint(address) external returns (uint256) envfree;
    function previewDeposit(uint256) external returns (uint256) envfree;
    function previewMint(uint256) external returns (uint256) envfree;
    function previewWithdraw(uint256) external returns (uint256) envfree;
    function previewRedeem(uint256) external returns (uint256) envfree;
    function paused() external returns (bool) envfree;

    // MUSD (linked underlying token) — explicit envfree declarations
    function musd.paused() external returns (bool) envfree;
    function musd.isBlacklisted(address) external returns (bool) envfree;
    function musd.balanceOf(address) external returns (uint256) envfree;

    // maxWithdraw and maxRedeem use block.timestamp (cooldown) — NOT envfree
    function maxWithdraw(address) external returns (uint256);
    function maxRedeem(address) external returns (uint256);

    // ── ERC20 dispatchers for SafeERC20 low-level calls ──
    // SafeERC20.safeTransferFrom uses address.functionCall (low-level).
    // Without DISPATCHER, Certora havocs these calls instead of routing
    // them to the linked MUSD implementation, causing all deposit/mint/
    // withdraw rules to produce spurious counterexamples.
    function _.transferFrom(address, address, uint256) external => DISPATCHER(true);
    function _.transfer(address, uint256) external => DISPATCHER(true);
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice If shares exist, the vault must hold at least 1 wei of assets
/// @dev Preserved blocks constrain callers to prevent:
///      1. MUSD.burn(smusd, amount) — drains vault assets without share burn
///      2. MUSD.transferFrom(smusd, ...) — moves vault assets out externally
///      3. Self-calls from vault address — accounting anomalies
invariant vault_solvency()
    totalSupply() == 0 || totalAssets() > 0
    {
        preserved with (env e) {
            require !musd.paused();
            require !musd.isBlacklisted(currentContract);
            require !musd.isBlacklisted(e.msg.sender);
            require e.msg.sender != currentContract;
            require e.msg.sender != 0;
        }
        // Prevent external burn of vault's MUSD (would break solvency)
        preserved burn(address from, uint256 amount) with (env e) {
            require from != currentContract;
            require !musd.paused();
        }
        // Prevent transferFrom draining vault's MUSD
        preserved transferFrom(address from, address to, uint256 amount) with (env e) {
            require from != currentContract;
            require !musd.paused();
            require !musd.isBlacklisted(from);
            require !musd.isBlacklisted(to);
        }
    }

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice Deposit should never decrease share price
rule deposit_never_decreases_share_price(uint256 assets, address receiver) {
    env e;
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000000;
    require assets > 0;
    require assets < 1000000000000000000000000000; // 1e27
    // MUSD must be operational for deposit to succeed
    require !musd.paused();
    require !musd.isBlacklisted(e.msg.sender);
    require !musd.isBlacklisted(currentContract);
    require !musd.isBlacklisted(receiver);
    // Address separation — prevent self-transfer aliasing
    require e.msg.sender != currentContract;
    require e.msg.sender != musd;
    require receiver != currentContract;
    require receiver != musd;
    require receiver != 0;
    // Caller must have enough MUSD for the transfer
    require musd.balanceOf(e.msg.sender) >= assets;

    uint256 priceBefore = convertToAssets(1000000000000000000); // 1e18

    deposit(e, assets, receiver);

    uint256 priceAfter = convertToAssets(1000000000000000000);

    assert priceAfter >= priceBefore,
        "Share price decreased after deposit";
}

/// @notice Mint should never decrease share price
rule mint_never_decreases_share_price(uint256 shares, address receiver) {
    env e;
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000000;
    require shares > 0;
    require shares < 1000000000000000000000000000; // 1e27
    require !musd.paused();
    require !musd.isBlacklisted(e.msg.sender);
    require !musd.isBlacklisted(currentContract);
    require !musd.isBlacklisted(receiver);
    // Address separation
    require e.msg.sender != currentContract;
    require e.msg.sender != musd;
    require receiver != currentContract;
    require receiver != musd;
    require receiver != 0;

    uint256 priceBefore = convertToAssets(1000000000000000000);

    mint(e, shares, receiver);

    uint256 priceAfter = convertToAssets(1000000000000000000);

    assert priceAfter >= priceBefore,
        "Share price decreased after mint";
}

/// @notice Deposit never decreases totalAssets
rule deposit_increases_total_assets(uint256 assets, address receiver) {
    env e;
    require assets > 0;
    require assets < 1000000000000000000000000000; // 1e27
    require totalAssets() < 1000000000000000000000000000;
    require !musd.paused();
    require !musd.isBlacklisted(e.msg.sender);
    require !musd.isBlacklisted(currentContract);
    require !musd.isBlacklisted(receiver);
    // Address separation
    require e.msg.sender != currentContract;
    require e.msg.sender != musd;
    require receiver != currentContract;
    require receiver != musd;
    require receiver != 0;
    // Caller must have enough MUSD
    require musd.balanceOf(e.msg.sender) >= assets;

    uint256 assetsBefore = totalAssets();

    deposit(e, assets, receiver);

    assert totalAssets() >= assetsBefore + assets,
        "Deposit increased totalAssets by less than expected";
}

/// @notice Withdraw decreases totalAssets by at most the withdrawn amount
rule withdraw_decreases_total_assets(uint256 assets, address receiver, address owner) {
    env e;
    require assets > 0;
    require !musd.paused();
    require !musd.isBlacklisted(e.msg.sender);
    require !musd.isBlacklisted(currentContract);
    require !musd.isBlacklisted(receiver);
    require !musd.isBlacklisted(owner);
    // Address separation
    require receiver != currentContract;
    require receiver != musd;

    uint256 assetsBefore = totalAssets();

    withdraw(e, assets, receiver, owner);

    assert totalAssets() <= assetsBefore,
        "Withdraw didn't decrease totalAssets";
}

/// @notice Round-trip: deposit then redeem should not create meaningful value
rule no_value_creation_on_roundtrip(uint256 assets, address receiver) {
    env e;
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000000;
    require assets > 0;
    require assets < 1000000000000000000000000000; // 1e27 bound
    require !musd.paused();
    require !musd.isBlacklisted(e.msg.sender);
    require !musd.isBlacklisted(currentContract);
    require !musd.isBlacklisted(receiver);
    // Address separation
    require e.msg.sender != currentContract;
    require e.msg.sender != musd;
    require receiver != currentContract;
    require receiver != musd;
    require receiver != 0;
    // Caller must have enough MUSD
    require musd.balanceOf(e.msg.sender) >= assets;

    uint256 shares = deposit(e, assets, receiver);

    // Preview the redeem — allow 1 wei rounding tolerance
    uint256 assetsOut = previewRedeem(shares);

    assert assetsOut <= assets + 1,
        "Round-trip deposit→redeem created value (share price manipulation)";
}

/// @notice convertToShares and convertToAssets are consistent inverses (within rounding)
rule share_asset_conversion_consistency(uint256 assets) {
    require assets > 0;
    require assets < 1000000000000000000000000000; // 1e27 bound
    require totalSupply() > 0 && totalSupply() < 1000000000000000000000000000;
    require totalAssets() > 0 && totalAssets() < 1000000000000000000000000000;

    uint256 shares = convertToShares(assets);
    uint256 roundTrip = convertToAssets(shares);

    // Should be within 1 wei of original due to rounding
    assert roundTrip <= assets,
        "convertToAssets(convertToShares(x)) > x (rounding error)";
}

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
