# TimelockGoverned Migration Design

## Status: Pre-Mainnet Planning
## Date: 2026-02-17
## Author: Audit Team

---

## 1. Background

### Current State: Two Governance Patterns

The protocol uses **two different governance patterns** for timelocked admin operations:

| Pattern | Contracts | Mechanism |
|---------|-----------|-----------|
| **TIMELOCK_ROLE** (legacy) | CollateralVault, SMUSD, MUSD, PriceOracle | `AccessControl` with `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` — self-governing role |
| **TimelockGoverned** (new) | TreasuryV2, LeverageVault | `onlyTimelock` modifier checking `msg.sender == timelock()` via ERC-7201 namespaced storage |

### Why Migrate?

The legacy `TIMELOCK_ROLE` pattern has several issues identified during audit:

1. **Self-governance loop**: `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` means any TIMELOCK_ROLE holder can grant/revoke the role to/from anyone. This is a flat access model masquerading as governance.
2. **No enforced delay**: The `TIMELOCK_ROLE` name implies a timelock, but the role itself has NO delay mechanism — any holder can call protected functions immediately.
3. **Role holder sprawl**: Multiple addresses can hold `TIMELOCK_ROLE` simultaneously with no coordination. There's no single source of truth for pending operations.
4. **No scheduling/cancellation**: No way to preview pending changes, cancel queued operations, or emit events for upcoming changes.
5. **Inconsistency**: Two patterns in one protocol creates cognitive overhead and audit surface.

### TimelockGoverned Advantages

- **Enforced delay**: Operations go through `MintedTimelockController.schedule()` → wait minimum delay → `execute()`.
- **Single authority**: Only the `MintedTimelockController` contract can call `onlyTimelock` functions.
- **Transparency**: All pending operations are visible on-chain via `TimelockController` events.
- **Cancellation**: Proposers can cancel queued operations before execution.
- **Standard**: Uses OpenZeppelin's battle-tested `TimelockController`.
- **ERC-7201 safe**: Namespaced storage prevents slot collisions in upgradeable contexts.

---

## 2. Affected Contracts

### CollateralVault (0x155d6618...)

**TIMELOCK_ROLE-protected functions:**
- `setBorrowModule(address)` — Critical dependency
- `addCollateral(address, uint16, uint16, uint16)` — Collateral params  
- `updateCollateralParams(address, uint16, uint16, uint16)` — LTV changes
- `disableCollateral(address)` — Disable collateral
- `enableCollateral(address)` — Re-enable collateral
- `unpause()` — Emergency unpause

**Migration complexity: HIGH** — Most functions, core protocol contract

### MUSD (0xEAf4EFECA...)

**TIMELOCK_ROLE-protected functions:**
- `setSupplyCap(uint256)` — Supply cap changes

**Migration complexity: LOW** — Single function

### SMUSD (0x8036D2bB...)

**TIMELOCK_ROLE-protected functions:**
- `setTreasury(address)` — Treasury address
- `setCooldownPeriod(uint256)` — Unstaking cooldown
- `setMinStakeAmount(uint256)` — Minimum stake

**Migration complexity: MEDIUM** — Multiple config functions

### PriceOracle (0x8eF615b3...)

**TIMELOCK_ROLE-protected functions:**
- `setFeed(address, address, uint256)` — Price feed changes
- `removeFeed(address)` — Remove price feed

**Migration complexity: MEDIUM** — Oracle manipulation is critical

---

## 3. Migration Strategy

### Option A: Redeploy with TimelockGoverned (Recommended for New Deployments)

Since CollateralVault, MUSD, SMUSD, and PriceOracle are **not upgradeable** (plain contracts without UUPS/Transparent proxy), migration requires redeployment.

**Steps:**
1. Deploy new versions inheriting `TimelockGoverned`
2. Set `_setTimelock(MintedTimelockController)` in constructor
3. Replace `onlyRole(TIMELOCK_ROLE)` with `onlyTimelock`
4. Remove `TIMELOCK_ROLE` constant and `_setRoleAdmin` calls
5. Migrate all state (collateral configs, balances, etc.)
6. Update all dependent contracts to point to new addresses
7. Verify and deprecate old contracts

**Pros:** Clean architecture, no legacy code
**Cons:** State migration complexity, address changes everywhere, potential for migration bugs

### Option B: Upgrade to UUPS + TimelockGoverned (Future-Proof)

Deploy UUPS proxy versions of these contracts, then upgrade the implementation.

**Steps:**
1. Create `CollateralVaultV2`, `MUSDV2`, `SMUSDV2`, `PriceOracleV2` as UUPS upgradeable
2. Inherit both `UUPSUpgradeable` and `TimelockGoverned`
3. Deploy behind proxies with `initialize()` matching current constructor logic
4. Migrate state from old contracts to new proxies
5. Gate `_authorizeUpgrade()` with `onlyTimelock`

**Pros:** Future upgradability, can fix issues without redeployment
**Cons:** Higher gas cost, proxy complexity, storage layout must be planned carefully

### Option C: Adapter Pattern (Minimal Change)

Keep existing contracts but route all `TIMELOCK_ROLE` calls through the `MintedTimelockController`.

**Steps:**
1. Revoke `TIMELOCK_ROLE` from all EOAs
2. Grant `TIMELOCK_ROLE` to `MintedTimelockController` only
3. All admin calls must go through `TimelockController.schedule()` → `execute()`

**Pros:** Zero contract changes, immediate implementation
**Cons:** Doesn't fix the self-governance loop (MintedTimelockController holds TIMELOCK_ROLE and could theoretically grant it to others through a scheduled operation)

---

## 4. Recommended Approach

### Testnet: Option C (Adapter Pattern) — Already Done ✅

On Sepolia testnet, we've already implemented Option C:
- `TIMELOCK_ROLE` granted to new deployer + `MintedTimelockController`
- `TIMELOCK_ROLE` renounced from old deployer
- This provides practical timelock governance without contract changes

### Mainnet: Option A (Redeploy with TimelockGoverned)

For mainnet deployment, use Option A with the following contract changes:

#### 4.1 CollateralVaultV2

```solidity
// Before (legacy):
contract CollateralVault is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");
    
    constructor(...) {
        _grantRole(TIMELOCK_ROLE, msg.sender);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);
    }
    
    function setBorrowModule(address _bm) external onlyRole(TIMELOCK_ROLE) { ... }
}

// After (TimelockGoverned):
contract CollateralVaultV2 is AccessControl, Pausable, ReentrancyGuard, TimelockGoverned {
    // Remove TIMELOCK_ROLE entirely
    
    constructor(..., address _timelock) {
        _setTimelock(_timelock);  // TimelockGoverned
        // Keep other roles (LEVERAGE_VAULT_ROLE, etc.)
    }
    
    function setBorrowModule(address _bm) external onlyTimelock { ... }
    function addCollateral(...) external onlyTimelock { ... }
    function unpause() external onlyTimelock { ... }
}
```

#### 4.2 State Migration Script

```
For each contract:
1. Deploy new version with TimelockGoverned
2. Read all state from old contract (collateral configs, user balances)
3. Write state to new contract via admin functions
4. Update all references (BorrowModule.collateralVault, etc.)
5. Pause old contract
6. Verify all state matches
```

---

## 5. Migration Checklist

### Pre-Migration
- [ ] Deploy new contracts with `TimelockGoverned`
- [ ] Verify all `onlyRole(TIMELOCK_ROLE)` → `onlyTimelock` changes
- [ ] Audit new contracts
- [ ] Test state migration on fork
- [ ] Test all admin operations through TimelockController

### State Migration (CollateralVault)
- [ ] Migrate collateral configurations (all tokens, params)
- [ ] Migrate user deposit balances
- [ ] Set BorrowModule reference
- [ ] Grant LEVERAGE_VAULT_ROLE to LeverageVault
- [ ] Verify health factors unchanged for all users

### State Migration (MUSD)
- [ ] Deploy new MUSD or grant BRIDGE_ROLE on existing
- [ ] Set supply cap
- [ ] Migrate bridge roles

### State Migration (SMUSD)
- [ ] Deploy new SMUSD with TimelockGoverned
- [ ] Set treasury
- [ ] Migrate staker balances and cooldowns
- [ ] Set cooldown period and min stake

### State Migration (PriceOracle)
- [ ] Deploy new PriceOracle with TimelockGoverned
- [ ] Migrate all price feeds
- [ ] Verify all price queries return same values

### Post-Migration
- [ ] Update all contract references across protocol
- [ ] Update frontend addresses
- [ ] Update subgraph addresses
- [ ] Update monitoring/bot configs
- [ ] Pause old contracts
- [ ] Run full integration test suite
- [ ] Verify governance flow end-to-end

---

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| State migration error | CRITICAL | Fork testing, checksum verification |
| User balance loss | CRITICAL | Snapshot + verify before/after |
| Missing cross-reference update | HIGH | Automated address update script |
| Timelock delay mismatch | MEDIUM | Verify MintedTimelockController minDelay |
| Front-running during migration | MEDIUM | Pause old contracts before migration |
| Gas cost of migration | LOW | Budget ~0.5 ETH for mainnet migration |

---

## 7. Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| 1. Contract Development | 1 week | Create V2 contracts with TimelockGoverned |
| 2. Unit Tests | 1 week | Full test coverage for new contracts |
| 3. Fork Testing | 3 days | Test migration on mainnet fork |
| 4. Audit | 1-2 weeks | Security review of V2 + migration |
| 5. Testnet Deploy | 2 days | Deploy and verify on Sepolia |
| 6. Mainnet Migration | 1 day | Execute migration with monitoring |

**Total: ~4-5 weeks**
