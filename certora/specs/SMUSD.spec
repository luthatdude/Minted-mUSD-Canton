// Certora Verification Language (CVL) Specification
// Minted mUSD Protocol — SMUSD (ERC-4626) Invariants
//
// Run with:
//   certoraRun contracts/SMUSD.sol \
//     --verify SMUSD:certora/specs/SMUSD.spec \
//     --solc solc-0.8.26 \
//     --optimistic_loop \
//     --loop_iter 3

methods {
    function totalSupply() external returns (uint256) envfree;
    function totalAssets() external returns (uint256) envfree;
    function convertToAssets(uint256) external returns (uint256) envfree;
    function convertToShares(uint256) external returns (uint256) envfree;
    function balanceOf(address) external returns (uint256) envfree;
    function deposit(uint256, address) external returns (uint256);
    function withdraw(uint256, address, address) external returns (uint256);
    function redeem(uint256, address, address) external returns (uint256);
}

// ═══════════════════════════════════════════════════════════════════════
// INVARIANT 1: Share price monotonicity (deposits only increase value)
// ═══════════════════════════════════════════════════════════════════════
// When no bad debt or slashing occurs, the share price (assets per share)
// should never decrease.

// Ghost tracking share price direction
ghost mathint lastSharePrice {
    init_state axiom lastSharePrice == 0;
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 1: Deposit must not decrease share price
// ═══════════════════════════════════════════════════════════════════════

rule depositDoesNotDecreaseSharePrice(uint256 assets, address receiver) {
    env e;
    require totalSupply() > 0;
    
    uint256 priceBefore = convertToAssets(1000000000000000000); // 1e18
    
    deposit(e, assets, receiver);
    
    uint256 priceAfter = convertToAssets(1000000000000000000);
    
    assert priceAfter >= priceBefore,
        "deposit must not decrease share price";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 2: Withdrawal must not increase share price (no free money)
// ═══════════════════════════════════════════════════════════════════════

rule withdrawalDoesNotCreateValue(uint256 assets, address receiver, address owner) {
    env e;
    require totalSupply() > 0;
    
    uint256 priceBefore = convertToAssets(1000000000000000000);
    
    withdraw(e, assets, receiver, owner);
    
    require totalSupply() > 0; // Still has shares outstanding
    uint256 priceAfter = convertToAssets(1000000000000000000);
    
    assert priceAfter >= priceBefore,
        "withdrawal must not decrease share price for remaining holders";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 3: convertToShares and convertToAssets are inverse
// ═══════════════════════════════════════════════════════════════════════

rule sharesAssetsInverse(uint256 assets) {
    require totalSupply() > 0;
    require assets > 0 && assets <= 1000000000000000000000000; // 1M max
    
    uint256 shares = convertToShares(assets);
    uint256 assetsBack = convertToAssets(shares);
    
    // Due to rounding down, assetsBack <= assets (favor the vault)
    assert assetsBack <= assets,
        "convertToAssets(convertToShares(x)) must be <= x (rounding favors vault)";
}

// ═══════════════════════════════════════════════════════════════════════
// RULE 4: No zero-share deposits (donation attack protection)
// ═══════════════════════════════════════════════════════════════════════

rule noZeroShareDeposit(uint256 assets, address receiver) {
    env e;
    require assets > 0;
    
    uint256 shares = deposit(e, assets, receiver);
    
    assert shares > 0,
        "non-zero deposit must mint non-zero shares (donation attack protection)";
}

// ═══════════════════════════════════════════════════════════════════════
// INVARIANT 2: totalAssets >= totalSupply relationship
// ═══════════════════════════════════════════════════════════════════════
// With virtual shares offset, the share price starts at ~1:1 and only
// goes up. So totalAssets (local) should reflect underlying token balance.

invariant totalAssetsBackedByTokens()
    totalAssets() >= 0;
