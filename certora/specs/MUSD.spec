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
    function hasRole(bytes32, address) external returns (bool) envfree;
    function BRIDGE_ROLE() external returns (bytes32) envfree;
    function LIQUIDATOR_ROLE() external returns (bytes32) envfree;
}

// ═══════════════════════════════════════════════════════════════════
// GHOST VARIABLE: SUM OF ALL BALANCES
// ═══════════════════════════════════════════════════════════════════

/// @dev Ghost tracks the mathematical sum of all ERC20 balances.
///      Updated on every write to OZ ERC20's private `_balances` mapping.
ghost mathint sumOfBalances {
    init_state axiom sumOfBalances == 0;
}

hook Sstore currentContract._balances[KEY address a] uint256 newVal (uint256 oldVal) {
    sumOfBalances = sumOfBalances + to_mathint(newVal) - to_mathint(oldVal);
}

// ═══════════════════════════════════════════════════════════════════
// INVARIANTS
// ═══════════════════════════════════════════════════════════════════

/// @notice Minting never pushes totalSupply above the effective cap
/// @dev setSupplyCap can intentionally set cap below supply (undercollateralization response)
///      so `totalSupply <= supplyCap` is NOT an invariant of this contract by design.
///      Instead we verify the mint path: if mint succeeds, supply stays within effective cap.
rule supply_never_exceeds_cap(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 cap = supplyCap();
    uint256 bps = localCapBps();

    // Contract enforces localCapBps in [1000, 10000]
    require bps >= 1000 && bps <= 10000;
    // Inductive assumption: supply was within cap before this mint
    require supplyBefore <= cap;

    mint(e, to, amount);

    // After a successful mint, totalSupply must not exceed supplyCap
    // (effectiveCap <= supplyCap since localCapBps <= 10000)
    assert totalSupply() <= cap,
        "Mint pushed totalSupply above supplyCap";
}

/// @notice Sum of all balances equals totalSupply (ERC20 conservation)
/// @dev Ghost variable `sumOfBalances` is updated via Sstore hook on
///      OZ ERC20._balances. The invariant proves that mint/burn/transfer
///      preserve the fundamental ERC20 accounting identity.
invariant total_supply_is_sum_of_balances()
    to_mathint(totalSupply()) == sumOfBalances;

// ═══════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════

/// @notice Mint increases totalSupply by exactly the minted amount
rule mint_increases_supply(address to, uint256 amount) {
    env e;

    // Preconditions to avoid vacuity (rule_sanity: basic)
    require hasRole(BRIDGE_ROLE(), e.msg.sender);
    require !paused();
    require !isBlacklisted(to);
    require !isBlacklisted(e.msg.sender);
    require !isBlacklisted(0);   // address(0) is 'from' in _update for mint
    require to != 0;             // contract rejects mint to address(0)
    require amount > 0;

    // ERC20 conservation: no individual balance can exceed totalSupply
    // (OZ ERC20._update uses unchecked { _balances[to] += value } assuming this)
    require totalSupply() >= balanceOf(to);

    // Effective cap must allow this mint
    uint256 bps = localCapBps();
    require bps >= 1000 && bps <= 10000;
    mathint effectiveCap = (to_mathint(supplyCap()) * to_mathint(bps)) / 10000;
    require to_mathint(totalSupply()) + to_mathint(amount) <= effectiveCap;

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

    // Preconditions to avoid vacuity (rule_sanity: basic)
    require hasRole(BRIDGE_ROLE(), e.msg.sender) || hasRole(LIQUIDATOR_ROLE(), e.msg.sender);
    require !paused();
    require !isBlacklisted(from);
    require !isBlacklisted(e.msg.sender);
    require !isBlacklisted(0);   // address(0) is 'to' in _update for burn
    require from != 0;
    require amount > 0;

    uint256 supplyBefore = totalSupply();
    uint256 balBefore = balanceOf(from);
    require balBefore >= amount;

    // ERC20 conservation: totalSupply >= any individual balance
    // (OZ ERC20._update uses unchecked { _totalSupply -= value } assuming this)
    require supplyBefore >= balBefore;

    // If from != msg.sender, need sufficient allowance
    require from == e.msg.sender || allowance(from, e.msg.sender) >= amount;

    burn(e, from, amount);

    uint256 supplyAfter = totalSupply();
    assert supplyAfter == supplyBefore - amount,
        "Burn did not decrease supply by exact amount";
}

/// @notice Mint cannot exceed effective supply cap (supplyCap * localCapBps / 10000)
/// @dev The contract checks against effectiveCap, not raw supplyCap
rule mint_respects_cap(address to, uint256 amount) {
    env e;
    uint256 supplyBefore = totalSupply();
    uint256 cap = supplyCap();
    uint256 bps = localCapBps();

    // Constrain localCapBps to contract-enforced bounds
    require bps >= 1000 && bps <= 10000;
    mathint effectiveCap = (to_mathint(cap) * to_mathint(bps)) / 10000;

    // If minting would exceed effective cap, it must revert
    require to_mathint(supplyBefore) + to_mathint(amount) > effectiveCap;

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
