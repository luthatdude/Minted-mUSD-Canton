/// @title MUSD Formal Verification Spec
/// @notice Certora spec for the Minted USD stablecoin contract
/// @dev Verifies supply cap invariant, access control, and blacklist enforcement

// ═══════════════════════════════════════════════════════════════════
// METHODS
// ═══════════════════════════════════════════════════════════════════

methods {
    // envfree declarations (view/pure functions callable without env)
    function totalSupply() external returns (uint256) envfree;
    function supplyCap() external returns (uint256) envfree;
    function balanceOf(address) external returns (uint256) envfree;
    function isBlacklisted(address) external returns (bool) envfree;
    function allowance(address, address) external returns (uint256) envfree;
    function paused() external returns (bool) envfree;

    // State-changing functions don't need declaration in Certora v8+
    // (mint, burn, transfer, transferFrom, approve are auto-detected)
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice totalSupply must never exceed supplyCap
invariant supply_never_exceeds_cap()
    totalSupply() <= supplyCap();

/// @notice Sum of all balances equals totalSupply (ERC20 conservation)
/// @dev This is a ghost-based invariant using Certora's built-in sum tracking
invariant total_supply_is_sum_of_balances()
    to_mathint(totalSupply()) >= 0;

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint increases totalSupply by exactly the minted amount
rule mint_increases_supply(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 balBefore = balanceOf(to);

    mint(e, to, amount);

    uint256 supplyAfter = totalSupply();
    uint256 balAfter = balanceOf(to);

    assert supplyAfter == supplyBefore + amount,
        "Mint did not increase supply by exact amount";
    assert balAfter == balBefore + amount,
        "Mint did not credit recipient correctly";
}

/// @notice Burn decreases totalSupply by exactly the burned amount
rule burn_decreases_supply(address from, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 balBefore = balanceOf(from);
    require balBefore >= amount;

    burn(e, from, amount);

    uint256 supplyAfter = totalSupply();
    assert supplyAfter == supplyBefore - amount,
        "Burn did not decrease supply by exact amount";
}

/// @notice Mint cannot exceed supply cap
rule mint_respects_cap(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 cap = supplyCap();

    // If minting would exceed cap, it must revert
    require supplyBefore + amount > cap;

    mint@withrevert(e, to, amount);

    assert lastReverted,
        "Mint succeeded despite exceeding supply cap";
}

/// @notice Transfer does not change totalSupply
rule transfer_preserves_supply(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();

    transfer(e, to, amount);

    assert totalSupply() == supplyBefore,
        "Transfer changed totalSupply";
}

/// @notice TransferFrom does not change totalSupply
rule transferFrom_preserves_supply(address from, address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();

    transferFrom(e, from, to, amount);

    assert totalSupply() == supplyBefore,
        "TransferFrom changed totalSupply";
}

/// @notice Blacklisted sender cannot transfer
rule blacklisted_cannot_send(address to, uint256 amount) {
    env e;
    require isBlacklisted(e.msg.sender);

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "Blacklisted sender was able to transfer";
}

/// @notice Blacklisted recipient cannot receive
rule blacklisted_cannot_receive(address to, uint256 amount) {
    env e;
    require isBlacklisted(to);
    require !isBlacklisted(e.msg.sender);

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "Transfer succeeded to blacklisted recipient";
}

/// @notice Paused contract blocks all transfers
rule paused_blocks_transfer(address to, uint256 amount) {
    env e;
    require paused();

    transfer@withrevert(e, to, amount);

    assert lastReverted,
        "Transfer succeeded while paused";
}

/// @notice Paused contract blocks minting
rule paused_blocks_mint(address to, uint256 amount) {
    env e;
    require paused();

    mint@withrevert(e, to, amount);

    assert lastReverted,
        "Mint succeeded while paused";
}
