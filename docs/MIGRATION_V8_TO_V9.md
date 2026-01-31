# BLEBridgeV8 → BLEBridgeV9 Migration Guide

## ⚠️ CRITICAL WARNING

**BLEBridgeV9 is NOT storage-compatible with BLEBridgeV8.**

A direct UUPS upgrade (`upgradeTo()`) will **corrupt contract state** because the storage layout has changed. This document describes the safe migration procedure.

---

## Storage Layout Comparison

```
┌─────────┬──────────────────────────┬──────────────────────────┐
│  Slot   │        V8 Variable       │        V9 Variable       │
├─────────┼──────────────────────────┼──────────────────────────┤
│    0    │ musdToken                │ musdToken          ✅    │
│    1    │ totalCantonAssets        │ attestedCantonAssets ✅  │
│    2    │ currentNonce             │ collateralRatioBps ❌    │
│    3    │ minSignatures            │ currentNonce       ❌    │
│    4    │ dailyMintLimit           │ minSignatures      ❌    │
│    5    │ dailyMinted              │ lastAttestationTime ❌   │
│    6    │ dailyBurned              │ lastRatioChangeTime ❌   │
│    7    │ lastReset                │ dailyCapIncreaseLimit ❌ │
│    8    │ navOracle                │ dailyCapIncreased  ❌    │
│    9    │ maxNavDeviationBps       │ dailyCapDecreased  ❌    │
│   10    │ navOracleEnabled         │ lastRateLimitReset ❌    │
│   11+   │ usedAttestationIds       │ usedAttestationIds ❌    │
└─────────┴──────────────────────────┴──────────────────────────┘

❌ = Incompatible - direct upgrade would read wrong data
```

**Root Cause:** V9 removes NAV oracle fields and adds collateral ratio, shifting all subsequent slots.

---

## Migration Strategy

### Option A: Fresh Deployment (Recommended) ✅

Deploy a new V9 proxy alongside V8, migrate state, then switch over.

**Pros:**
- Zero-downtime migration possible
- Rollback by re-enabling V8
- No state corruption risk

**Cons:**
- New contract address (need to update integrations)
- Must migrate used attestation IDs

### Option B: Storage-Compatible Wrapper (Not Recommended) ❌

Create a V9 that maintains V8 storage layout with deprecated fields.

**Pros:**
- Same contract address

**Cons:**
- Wasted storage slots
- Complex maintenance
- Technical debt

---

## Pre-Migration Checklist

### 1. Gather Required Information

```bash
# Record current V8 state
V8_PROXY_ADDRESS=0x...
MUSD_ADDRESS=0x...
DEPLOYMENT_BLOCK=...  # Block when V8 was deployed

# List of validators (VALIDATOR_ROLE holders)
VALIDATOR_1=0x...
VALIDATOR_2=0x...
VALIDATOR_3=0x...
VALIDATOR_4=0x...
VALIDATOR_5=0x...

# Emergency multisig (EMERGENCY_ROLE holder)
EMERGENCY_MULTISIG=0x...

# Admin multisig (DEFAULT_ADMIN_ROLE holder)
ADMIN_MULTISIG=0x...
```

### 2. Extract Current State

```typescript
// Connect to V8
const v8 = await ethers.getContractAt("BLEBridgeV8", V8_PROXY_ADDRESS);

// Critical state to preserve
const totalCantonAssets = await v8.totalCantonAssets();
const currentNonce = await v8.currentNonce();
const minSignatures = await v8.minSignatures();

// Get all used attestation IDs (from events)
const filter = v8.filters.AttestationExecuted();
const events = await v8.queryFilter(filter, DEPLOYMENT_BLOCK, "latest");
const usedAttestationIds = events.map(e => e.args.id);

console.log("State to migrate:");
console.log(`  totalCantonAssets: ${ethers.formatEther(totalCantonAssets)}`);
console.log(`  currentNonce: ${currentNonce}`);
console.log(`  minSignatures: ${minSignatures}`);
console.log(`  usedAttestationIds: ${usedAttestationIds.length} IDs`);
```

### 3. Prepare V9 Parameters

| Parameter | Description | Recommended Value |
|-----------|-------------|-------------------|
| `_minSigs` | Minimum signatures required | Same as V8 (e.g., 3) |
| `_musdToken` | MUSD contract address | Same as V8 |
| `_collateralRatioBps` | Required collateralization | 11000 (110%) |
| `_dailyCapIncreaseLimit` | Max cap increase per day | 1,000,000e18 |

---

## Migration Procedure

### Phase 1: Preparation (No Downtime)

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1.1: Deploy V9 Implementation                             │
├─────────────────────────────────────────────────────────────────┤
│  • Deploy BLEBridgeV9 implementation contract                   │
│  • Do NOT initialize yet                                        │
│  • Record implementation address                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 1.2: Deploy V9 Proxy                                      │
├─────────────────────────────────────────────────────────────────┤
│  npx hardhat run scripts/migrate-v8-to-v9.ts --network mainnet  │
│                                                                 │
│  Environment:                                                   │
│    V8_BRIDGE_ADDRESS=0x...                                      │
│    MUSD_ADDRESS=0x...                                           │
│    DRY_RUN=true  # First do a dry run                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 1.3: Configure V9 Roles                                   │
├─────────────────────────────────────────────────────────────────┤
│  For each validator:                                            │
│    v9.grantRole(VALIDATOR_ROLE, validatorAddress)               │
│                                                                 │
│  For emergency multisig:                                        │
│    v9.grantRole(EMERGENCY_ROLE, emergencyMultisig)              │
│                                                                 │
│  Transfer admin to multisig:                                    │
│    v9.grantRole(DEFAULT_ADMIN_ROLE, adminMultisig)              │
│    v9.renounceRole(DEFAULT_ADMIN_ROLE, deployer)                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 1.4: Migrate Used Attestation IDs                         │
├─────────────────────────────────────────────────────────────────┤
│  For each used attestation ID from V8:                          │
│    v9.invalidateAttestationId(id, "Migrated from V8")           │
│                                                                 │
│  This prevents replay attacks with old attestations             │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: Switchover (Brief Pause Required)

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 2.1: Pause V8 Bridge                                      │
├─────────────────────────────────────────────────────────────────┤
│  From EMERGENCY_ROLE multisig:                                  │
│    v8.pause()                                                   │
│                                                                 │
│  ⏸️ Bridge operations now paused                                │
│  ⏱️ Target downtime: < 5 minutes                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 2.2: Final State Sync                                     │
├─────────────────────────────────────────────────────────────────┤
│  Check for any attestations processed since preparation:        │
│    const newEvents = await v8.queryFilter(filter, lastBlock);   │
│    for (id of newEvents) {                                      │
│      await v9.invalidateAttestationId(id, "Late migration");    │
│    }                                                            │
│                                                                 │
│  Sync nonce if needed:                                          │
│    const v8Nonce = await v8.currentNonce();                     │
│    await v9.forceUpdateNonce(v8Nonce, "Sync from V8");          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 2.3: Update MUSD Roles                                    │
├─────────────────────────────────────────────────────────────────┤
│  Grant V9 the CAP_MANAGER_ROLE:                                 │
│    musd.grantRole(CAP_MANAGER_ROLE, v9Address)                  │
│                                                                 │
│  Revoke V8's BRIDGE_ROLE (optional, for safety):                │
│    musd.revokeRole(BRIDGE_ROLE, v8Address)                      │
│                                                                 │
│  Note: V9 uses CAP_MANAGER_ROLE (not BRIDGE_ROLE) because it    │
│  only updates supply cap, not minting directly                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 2.4: Submit Initial Attestation to V9                     │
├─────────────────────────────────────────────────────────────────┤
│  Validators sign new attestation with:                          │
│    cantonAssets: current totalCantonAssets from V8              │
│    nonce: 0 (fresh start for V9)                                │
│    timestamp: block.timestamp                                   │
│                                                                 │
│  Submit to V9:                                                  │
│    v9.processAttestation(attestation, signatures)               │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 3: Verification & Completion

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 3.1: Verify V9 State                                      │
├─────────────────────────────────────────────────────────────────┤
│  const attestedAssets = await v9.attestedCantonAssets();        │
│  const supplyCap = await musd.supplyCap();                      │
│  const expectedCap = attestedAssets * 10000n / collateralRatio; │
│                                                                 │
│  assert(supplyCap === expectedCap, "Supply cap mismatch");      │
│  assert(await v9.paused() === false, "V9 should not be paused");│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 3.2: Update Infrastructure                                │
├─────────────────────────────────────────────────────────────────┤
│  • Update relay-service.ts with V9 address                      │
│  • Update validator-node-v2.ts with V9 address                  │
│  • Update frontend config with V9 address                       │
│  • Update monitoring/alerting for V9                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 3.3: Test End-to-End                                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Validators sign a small test attestation                    │
│  2. Submit to V9                                                │
│  3. Verify supply cap updated correctly                         │
│  4. Test emergency pause/unpause                                │
│  5. Monitor for 24 hours                                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Step 3.4: Deprecate V8 (After Confidence)                      │
├─────────────────────────────────────────────────────────────────┤
│  After 7-14 days of successful V9 operation:                    │
│                                                                 │
│  • Revoke all V8 admin roles                                    │
│  • Mark V8 as deprecated in documentation                       │
│  • Keep V8 paused indefinitely (do NOT unpause)                 │
│  • V8 proxy can remain for historical queries                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Rollback Procedure

If issues are discovered with V9 within the monitoring period:

```
┌─────────────────────────────────────────────────────────────────┐
│  Emergency Rollback Steps                                       │
├─────────────────────────────────────────────────────────────────┤
│  1. Pause V9:                                                   │
│     v9.pause()                                                  │
│                                                                 │
│  2. Revoke V9's CAP_MANAGER_ROLE:                               │
│     musd.revokeRole(CAP_MANAGER_ROLE, v9Address)                │
│                                                                 │
│  3. Re-grant V8's BRIDGE_ROLE (if revoked):                     │
│     musd.grantRole(BRIDGE_ROLE, v8Address)                      │
│                                                                 │
│  4. Unpause V8:                                                 │
│     v8.unpause()  // Requires DEFAULT_ADMIN_ROLE                │
│                                                                 │
│  5. Update relay/validators back to V8 address                  │
│                                                                 │
│  6. Sync V8 nonce if attestations were processed on V9:         │
│     v8.forceUpdateNonce(v9.currentNonce(), "Rollback sync")     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Considerations

### Replay Attack Prevention

Used attestation IDs MUST be migrated to V9 to prevent:
- Replaying old attestations on V9
- Double-counting Canton assets

### Nonce Management

V9 starts with nonce 0 (fresh proxy). Canton relay must:
- Reset its nonce tracking for V9
- NOT accept attestations with nonces > 0 until one is processed

### Key Ceremony

No new keys are generated. Existing validator keys work on V9 because:
- Same VALIDATOR_ROLE definition
- Same signature verification logic
- Same EIP-712 domain (uses contract address, so signatures are V9-specific)

**⚠️ IMPORTANT:** EIP-712 signatures include `address(this)`. V8 signatures will NOT work on V9 because the contract addresses differ. This is a security feature.

---

## Timeline Estimate

| Phase | Duration | Notes |
|-------|----------|-------|
| Preparation | 1-2 hours | Deploy, configure, dry run |
| Attestation ID Migration | 10-30 min | Depends on count |
| Switchover | 5-10 min | Pause → sync → switch → verify |
| Monitoring | 24-48 hours | Before deprecating V8 |
| V8 Deprecation | 7-14 days | After confidence |

**Total Downtime:** < 10 minutes (Phase 2 only)

---

## Appendix: Migration Script Usage

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
export V8_BRIDGE_ADDRESS=0x...
export MUSD_ADDRESS=0x...
export PRIVATE_KEY=0x...  # Deployer key

# 3. Dry run first
export DRY_RUN=true
npx hardhat run scripts/migrate-v8-to-v9.ts --network mainnet

# 4. Review output, then execute
export DRY_RUN=false
npx hardhat run scripts/migrate-v8-to-v9.ts --network mainnet
```

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-30 | Protocol Team | Initial migration guide |
