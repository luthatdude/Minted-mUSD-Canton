# Audit Readiness Review - Minted mUSD Canton Protocol

**Date:** 2026-01-31
**Reviewer:** Automated audit readiness analysis
**Verdict:** NOT audit ready - critical bugs and structural issues must be resolved first

---

## Summary

| Severity | Solidity | DAML | Infrastructure | Total |
|----------|----------|------|----------------|-------|
| CRITICAL | 1 | 5 | 0 | 6 |
| HIGH | 4 | 7 | 5 | 16 |
| MEDIUM | 7 | 7 | 14 | 28 |
| LOW | 5 | 0 | 10 | 15 |

---

## CRITICAL Findings

### SOL-CRIT-01: LeverageVault repay() called as wrong msg.sender
**File:** `contracts/LeverageVault.sol:306`

`closeLeveragedPosition()` calls `borrowModule.repay(debtToRepay)`. Since `msg.sender` is the LeverageVault contract (not the user), the repay targets the vault's own zero debt, not the user's. All position closures will revert with "NO_DEBT".

**Fix:** Add a `repayFor(address borrower, uint256 amount)` function to BorrowModule with LeverageVault authorization, or restructure the close flow.

### DAML-CRIT-01: BridgeOut_Sign creates stale CID references
**File:** `daml/BLEBridgeProtocol.daml:110-140`

`BridgeOut_Sign` is consuming and recreates the attestation with a new contract ID, but signatures store `requestCid = self` (the old ID). `BridgeOut_Finalize` checks `all (== self) reqIds` against the latest ID. Finalization fails when >1 validator signs.

**Fix:** Either make signing nonconsuming with `signedValidators` tracking (matching BridgeIn pattern), or reference attestations by payload key instead of CID.

### DAML-CRIT-02: Duplicate signatures possible on BridgeIn, SupplyCap, Yield attestations
**File:** `daml/BLEBridgeProtocol.daml:189, 270, 350`

The D-02 fix (`signedValidators` tracking) was applied to `BridgeOutAttestation` but NOT to `BridgeInAttestation`, `SupplyCapAttestation`, or `YieldAttestation`. Validators can sign these multiple times.

### DAML-CRIT-03: ValidatorSignature has aggregator as signatory, not validator
**File:** `daml/BLEProtocol.daml:176`

`ValidatorSignature` template has `signatory aggregator` and `observer validator`. The aggregator can forge signatures without validator consent.

### DAML-CRIT-04: MUSD_Protocol.Unstake race condition
**File:** `daml/MUSD_Protocol.daml:257-297`

`Unstake` is nonconsuming but archives shared contracts. Two concurrent Unstake calls create a race condition for supply cap accounting.

### DAML-CRIT-05: MUSD_Protocol.setup does not compile
**File:** `daml/MUSD_Protocol.daml:495`

The setup script calls `Unstake` with wrong number of arguments.

---

## HIGH Findings

### SOL-HIGH-01: Unsafe approve() in LeverageVault and DepositRouter
- `contracts/LeverageVault.sol:305, 431` -- uses `approve()` instead of `forceApprove()`
- `contracts/DepositRouter.sol:320` -- same issue
- Breaks with USDT-like tokens requiring zero-first approval

### SOL-HIGH-02: Unrestricted emergencyWithdraw
- `contracts/TreasuryReceiver.sol:244` -- owner can drain any token including user USDC
- `contracts/DepositRouter.sol:287` -- same issue

### SOL-HIGH-03: No timelock on UUPS upgrades
- `contracts/TreasuryV2.sol:874`
- `contracts/BLEBridgeV8.sol:388`
- `contracts/BLEBridgeV9.sol:391`
- `contracts/PendleMarketSelector.sol:499`

### SOL-HIGH-04: COMPLIANCE_ROLE can blacklist protocol contracts
**File:** `contracts/MUSD.sol:42-46`

No exemption for protocol addresses. Blacklisting Treasury or DirectMint bricks the protocol.

### DAML-HIGH-01: Asset_Transfer forces signatory without consent
**File:** `daml/MintedProtocol.daml:38`

Violates DAML best practices, will fail on Canton runtime.

### DAML-HIGH-02: V3 LiquidityPool swaps have no access control
**File:** `daml/Minted/Protocol/V3.daml:199-210`

Any party can drain the pool. The fix applied in MintedProtocol.daml (C-02) was not ported to V3.

### DAML-HIGH-03: ReserveTracker is dead code
**File:** `daml/CantonDirectMint.daml:286`

Never connected to CantonDirectMintService. Reserve accounting is not tracked.

### DAML-HIGH-04: Supply cap attestation flow disconnected
Finalized `SupplyCapPayload` from `BLEBridgeProtocol` is never consumed to update Canton-side `CantonDirectMintService.currentSupply`.

### DAML-HIGH-05: Yield attestation flow disconnected
Finalized `YieldPayload` is never consumed by `CantonStakingService.SyncYield`. Manual operator intervention required.

### DAML-HIGH-06: 5+ duplicate protocol implementations
`MintedProtocol`, `MintedProtocolV2Fixed`, `Minted.Protocol.V3`, `MUSD_Protocol`, `CantonDirectMint` all implement overlapping functionality with inconsistent security fixes.

### DAML-HIGH-07: Quorum threshold inconsistency
- `BLEProtocol` / `V2Fixed`: supermajority `(n+1)/2 + 1`
- `BLEBridgeProtocol` / `V3`: simple majority `n/2 + 1`

### INFRA-HIGH-01: Bot missing runtime env validation
**File:** `bot/src/index.ts:16-36`

All config values use TypeScript non-null assertion with no runtime check.

### INFRA-HIGH-02: 8 contracts have no dedicated test file
Missing: CollateralVault, MUSD, SMUSD, PriceOracle, Treasury V1, DepositRouter, TreasuryReceiver, PendleMarketSelector

### INFRA-HIGH-03: Zero tests for TypeScript services
Bot, relay, validator, yield keeper have no automated tests.

### INFRA-HIGH-04: Hardcoded ETH price in bot and yield keeper
- `bot/src/index.ts:343` -- hardcoded $2500
- `relay/yield-keeper.ts:215` -- hardcoded $2000

### INFRA-HIGH-05: Relay service aborts poll cycle on single failure
**File:** `relay/relay-service.ts:395`

Single attestation failure prevents processing of all remaining attestations.

---

## Pre-Audit Checklist

- [ ] Fix LeverageVault repay bug (SOL-CRIT-01)
- [ ] Fix DAML BridgeOut stale CID bug (DAML-CRIT-01)
- [ ] Apply duplicate-signature fix to all attestation types (DAML-CRIT-02)
- [ ] Consolidate DAML modules to single canonical version
- [ ] Add test coverage for 8 untested contracts (target 80%+)
- [ ] Add test coverage for TypeScript services
- [ ] Add runtime env validation to all services
- [ ] Replace hardcoded ETH prices with oracle queries
- [ ] Add timelocks to UUPS upgrade authorization
- [ ] Use forceApprove() consistently
- [ ] Pin pragma to 0.8.26 on all contracts
- [ ] Connect supply cap and yield attestation flows
- [ ] Add proposal pattern to all DAML transfers
- [ ] Remove deprecated Goerli configuration
- [ ] Pin Docker base image to SHA256 digest
- [ ] Set CI coverage threshold to 80% with hard failure
