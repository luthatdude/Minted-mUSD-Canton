# CIP-56 Phase 4 Migration Matrix

## Overview

Phase 4 adds native CIP-56 paths for the two highest-impact user-facing flows that still require
hybrid conversion: **Lending Repay** and **Staking (smUSD)**. Legacy paths remain fully intact as
fallback.

## Flow Migration Status

| Flow | DAML Choice (Legacy) | Input Type | Native Choice (Phase 4) | Fallback Behavior | Status |
|------|---------------------|------------|------------------------|-------------------|--------|
| Bridge/Redeem | `DirectMint_Redeem` | `ContractId CantonMUSD` | `DirectMint_RedeemFromInventory` | Infra errors only (5xx/409) | **Phase 3** (shipped) |
| Lending Repay | `Lending_Repay` | `ContractId CantonMUSD` | `Lending_RepayFromInventory` | Infra errors only (5xx/409) | **Phase 4** (this PR) |
| Stake (smUSD) | `Stake` | `ContractId CantonMUSD` | `StakeFromInventory` | Infra errors only (5xx/409) | **Phase 4** (this PR) |
| Lending Borrow | `Lending_Borrow` | N/A (mints new mUSD) | N/A | N/A | N/A (no CIP-56 input) |
| Unstake (smUSD) | `Unstake` | `ContractId CantonSMUSD` | N/A | N/A | N/A (no CIP-56 input) |
| Lending Liquidate | `Lending_Liquidate` | `ContractId CantonMUSD` | Deferred | Convert-then-exercise | **Deferred** (bot-driven) |
| ETH Pool Stake | `ETHPool_Stake` | `ContractId CantonMUSD` | Deferred | Convert-then-exercise | **Deferred** (lower volume) |
| ETH Pool Unstake | `ETHPool_Unstake` | `ContractId CantonSMUSD_E` | N/A | N/A | N/A (no CIP-56 input) |
| Admin Ops | Various | Various | N/A | N/A | Operator-only |

## Native Choice Design Pattern

All native CIP-56 choices follow the same pattern established by `DirectMint_RedeemFromInventory`:

1. **API layer** builds an atomic batch command:
   - Archive user's CIP-56 tokens (CIP-56 package)
   - Create CIP-56 escrow under operator (CIP-56 package)
   - Exercise native DAML choice with operator inventory tokens (main package)
2. **DAML choice** accepts `inventoryMusdCids : [ContractId CantonMUSD]` (operator-owned):
   - Validates all tokens are `owner == operator && issuer == operator`
   - Archives inventory tokens
   - Returns change to operator if overpayment
   - Performs the same business logic as the legacy choice
3. **Frontend** tries native endpoint first, falls back to hybrid on infra errors only.

Cross-package constraint: CIP-56 and main DAML packages cannot import each other.
The atomic batch bridges both packages in a single ledger transaction.

## Fallback Policy (Strict)

| Error Class | HTTP Status | Action | Rationale |
|-------------|------------|--------|-----------|
| Business error (paused, blacklisted, min-amount, compliance, auth) | 400/404 | Surface to user | Policy violations must not be bypassed |
| Infra error (Canton unavailable, timeout, inventory mismatch) | 502/5xx/409 | Fall back to hybrid convert-then-exercise | Transient failures should not block users |

## Supply/Accounting Invariants

### Lending_RepayFromInventory
- `cantonCurrentSupply` **decremented** (same as `Lending_Repay`) — repaying debt removes mUSD from circulation
- `totalBorrows` **decremented** by repay amount
- `protocolReserves` **incremented** by reserve portion of interest
- Operator inventory not tracked in lending supply (created via DirectMint, not Lending_Borrow)

### StakeFromInventory
- `pooledMusd` **incremented** by stake amount (TVL grows)
- `totalShares` **incremented** by computed shares
- `poolMusdCid` updated (pool vault holds the deposited mUSD)
- Operator inventory consumed and re-deposited as pool-held mUSD

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Inventory exhaustion during native flow | API checks inventory before batch; 409 triggers hybrid fallback |
| Double-spend via replay | sha256-based idempotency store per endpoint |
| Supply accounting drift | Native choices use identical accounting logic as legacy choices |
| Pool CID consumed by conversion | `canton-convert.ts` already excludes `poolMusdCid` from inventory selection |
| Partial batch failure | Canton atomic batch = all-or-nothing; no partial state |

## Rollback Plan

If native paths cause issues post-deploy:
1. Set `DISABLE_NATIVE_CIP56=true` in environment (checked by frontend before attempting native path)
2. All flows revert to hybrid convert-then-exercise (legacy paths remain intact)
3. No DAML changes needed for rollback — native choices simply stop being called

## Files Changed

### DAML (additive only)
- `daml/CantonLending.daml` — `Lending_RepayFromInventory` choice
- `daml/CantonSMUSD.daml` — `StakeFromInventory` choice
- `daml/CantonLendingTest.daml` — Tests for `Lending_RepayFromInventory`
- `daml/CantonDirectMintTest.daml` — Tests for `StakeFromInventory`

### API
- `frontend/src/pages/api/canton-cip56-repay.ts` — Native repay endpoint
- `frontend/src/pages/api/canton-cip56-stake.ts` — Native stake endpoint

### Frontend
- `frontend/src/hooks/useCantonLedger.ts` — `nativeCip56Repay`, `nativeCip56Stake` functions
- `frontend/src/components/canton/CantonBorrow.tsx` — Native-first repay path
- `frontend/src/components/canton/CantonStake.tsx` — Native-first stake path

### Docs
- `frontend/docs/cip56-phase4-migration-matrix.md` — This document
