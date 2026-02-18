/// @title SMUSDE Formal Verification Spec
/// @notice Certora spec for the smUSD-E token (ETH Pool staked mUSD)
/// @dev Verifies mint/burn totalSupply tracking, blacklist enforcement, and pause behavior

methods {
    function totalSupply() external returns (uint256) envfree;
    function balanceOf(address) external returns (uint256) envfree;
    function isBlacklisted(address) external returns (bool) envfree;
    function paused() external returns (bool) envfree;
    function hasRole(bytes32, address) external returns (bool) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// SUPPLY TRACKING
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint increases totalSupply exactly by amount
rule mint_increases_total_supply(address to, uint256 amount) {
    env e;
    require to != address(0);
    require amount > 0 && amount < 1000000000000000000000000;

    uint256 supplyBefore = totalSupply();
    require supplyBefore + amount < 1000000000000000000000000; // no overflow

    mint@withrevert(e, to, amount);

    assert !lastReverted => totalSupply() == supplyBefore + amount,
        "Mint did not increase totalSupply by exact amount";
}

/// @notice Burn decreases totalSupply exactly by amount
rule burn_decreases_total_supply(address from, uint256 amount) {
    env e;
    require amount > 0 && amount < 1000000000000000000000000;
    require balanceOf(from) >= amount;

    uint256 supplyBefore = totalSupply();

    burn@withrevert(e, from, amount);

    assert !lastReverted => totalSupply() == supplyBefore - amount,
        "Burn did not decrease totalSupply by exact amount";
}

// ═══════════════════════════════════════════════════════════════════
// BLACKLIST ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice Transfer from blacklisted sender reverts
rule blacklisted_sender_cannot_transfer(address from, address to, uint256 amount) {
    env e;
    require isBlacklisted(from);
    require from != address(0) && to != address(0);

    transferFrom@withrevert(e, from, to, amount);

    assert lastReverted,
        "Transfer from blacklisted sender succeeded";
}

/// @notice Transfer to blacklisted recipient reverts
rule blacklisted_recipient_cannot_receive(address from, address to, uint256 amount) {
    env e;
    require isBlacklisted(to);
    require from != address(0) && to != address(0);

    transferFrom@withrevert(e, from, to, amount);

    assert lastReverted,
        "Transfer to blacklisted recipient succeeded";
}

// ═══════════════════════════════════════════════════════════════════
// PAUSE ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════

/// @notice Paused state blocks transfers
rule paused_blocks_transfer(address to, uint256 amount) {
    env e;
    require paused();

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "Transfer succeeded while paused";
}

/// @notice Mint to zero address reverts
rule mint_to_zero_reverts(uint256 amount) {
    env e;

    mint@withrevert(e, 0, amount);

    assert lastReverted,
        "Mint to zero address succeeded";
}

/// @notice Burn with zero amount reverts
rule burn_zero_amount_reverts(address from) {
    env e;

    burn@withrevert(e, from, 0);

    assert lastReverted,
        "Burn of zero amount succeeded";
}
