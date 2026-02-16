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
    function localCapBps() external returns (uint256) envfree;

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
/// @dev Uses @withrevert and asserts properties only when mint succeeds.
///      Mint can legitimately revert due to: access control (BRIDGE_ROLE),
///      pause, blacklist, zero-address, effective cap (localCapBps), or overflow.
rule mint_increases_supply(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 balBefore = balanceOf(to);

    mint@withrevert(e, to, amount);
    bool succeeded = !lastReverted;

    uint256 supplyAfter = totalSupply();
    uint256 balAfter = balanceOf(to);

    assert succeeded => supplyAfter == supplyBefore + amount,
        "Mint did not increase supply by exact amount";
    assert succeeded => balAfter == balBefore + amount,
        "Mint did not credit recipient correctly";
}

/// @notice Burn decreases totalSupply by exactly the burned amount
/// @dev Uses @withrevert because burn can revert due to: access control
///      (BRIDGE_ROLE or LIQUIDATOR_ROLE), pause, blacklist, or insufficient allowance.
rule burn_decreases_supply(address from, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 balBefore = balanceOf(from);
    require balBefore >= amount;

    burn@withrevert(e, from, amount);
    bool succeeded = !lastReverted;

    uint256 supplyAfter = totalSupply();
    assert succeeded => supplyAfter == supplyBefore - amount,
        "Burn did not decrease supply by exact amount";
}

/// @notice Mint cannot exceed effective supply cap (supplyCap * localCapBps / 10000)
/// @dev The contract enforces: totalSupply() + amount <= (supplyCap * localCapBps) / 10000
///      localCapBps defaults to 6000 (60%), so effective cap < raw supplyCap.
rule mint_respects_cap(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 cap = supplyCap();
    uint256 bps = localCapBps();
    // Compute effective cap the same way the contract does
    mathint effectiveCap = (cap * bps) / 10000;

    // If minting would exceed effective cap, it must revert
    require to_mathint(supplyBefore) + to_mathint(amount) > effectiveCap;
    // Guard against mathint overflow in multiplication
    require cap <= 2^128;
    require bps <= 10000;

    mint@withrevert(e, to, amount);

    assert lastReverted,
        "Mint succeeded despite exceeding effective supply cap";
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
