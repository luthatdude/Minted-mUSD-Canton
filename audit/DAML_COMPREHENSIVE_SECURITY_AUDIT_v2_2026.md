# Minted mUSD Canton — Comprehensive DAML Security Audit v2

**Date:** 2026-02-15  
**Auditor:** Automated DAML Security Analysis  
**Scope:** All 18 DAML source modules + 14 test modules (`/daml/`)  
**Framework:** Canton 3.x / Daml LF 2.x  
**Source LOC:** ~8,500 (18 modules)  
**Test LOC:** ~11,080 (14 modules)  
**Test:Source Ratio:** 1.30:1  

---

## Executive Summary

The Minted mUSD Canton DAML layer implements a full-stack stablecoin protocol with lending, staking, bridging, loop strategies, and validator rewards. The codebase shows evidence of **multiple prior audit rounds** with 20+ resolved findings documented inline (DAML-CRIT-01, DAML-H-xx, DAML-M-xx, AUDIT-xx, BRIDGE-xx, D-Mxx labels). The architecture is mature and well-structured.

**No critical vulnerabilities were found.** Three HIGH-severity issues remain, two related to the LF 2.x migration and one architectural trust-boundary concern. The positive engineering patterns — dual-signatory transfers, module-scoped governance proofs, cross-module supply cap coordination, oracle price caps, and an extensive adversarial test suite — place this codebase well above average for DAML protocol implementations.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 3 |
| LOW | 4 |
| RESOLVED | 21+ |

**Overall DAML Security Score: 83 / 100**

---

## Table of Contents

1. [Authorization Model](#1-authorization-model)
2. [Privacy Architecture](#2-privacy-architecture)
3. [Choice Architecture](#3-choice-architecture)
4. [Key Management (LF 2.x)](#4-key-management-lf-2x)
5. [Cross-Module Safety](#5-cross-module-safety)
6. [Compliance Integration](#6-compliance-integration)
7. [Governance & Multi-Sig](#7-governance--multi-sig)
8. [Test Coverage](#8-test-coverage)
9. [Canton 3.x / LF 2.x Compatibility](#9-canton-3x--lf-2x-compatibility)
10. [Positive Patterns](#10-positive-patterns)
11. [Findings Detail](#11-findings-detail)
12. [Resolved Findings](#12-resolved-findings)

---

## 1. Authorization Model

### Assessment: STRONG

The protocol consistently uses the **dual-signatory model** across all token templates. Every value-bearing contract (`MintedMUSD`, `CantonMUSD`, `CantonUSDC`, `USDCx`, `CantonCoin`, `CantonSMUSD`, `CantonSMUSD_E`, `BoostPoolLP`, `EscrowedCollateral`, `CantonDebtPosition`) requires both `issuer` (operator) and `owner` as signatories.

**Transfer pattern:** All transfers use the proposal-accept pattern (e.g., `MUSD_Transfer` creates a `TransferProposal` that the `newOwner` must accept). This prevents forced signatory obligations — a party cannot be made a signatory of a contract without their explicit consent.

**Controller assignments:**
- Token choices (transfer, split, merge, burn): `controller owner` or `controller issuer, owner` — correct
- Service admin choices: `controller operator` — appropriate for single-operator protocol
- Governance-gated choices: `controller operator` with governance proof consumption — adds multi-sig layer
- Bridge attestation: `controller validator` for signing, `controller aggregator` for completion — correct separation

**Finding:** See [H-03](#h-03-operator-can-bypass-multi-sig-governance-via-direct-governanceactionlog-creation) for a trust-boundary concern where the operator can create governance proofs without going through the MultiSigProposal process.

---

## 2. Privacy Architecture

### Assessment: DEGRADED (LF 2.x Impact)

Canton provides privacy-by-default: only signatories see a contract. The protocol implements an opt-in transparency system via `UserPrivacySettings` that allows users to designate observers (auditors, compliance officers, fund admins).

The architecture is well-designed:
- `UserPrivacySettings.daml` — per-user toggle with `FullyPrivate` / `SelectiveTransparency` modes
- Observer lists propagated to product contracts at creation time
- Self-observation and operator-observation prevented (`CANNOT_OBSERVE_SELF`, `CANNOT_OBSERVE_OPERATOR`)

**However**, the privacy propagation mechanism is **non-functional** after the LF 2.x migration. See [H-02](#h-02-lookupuserobservers-permanently-disabled-after-lf-2x-migration).

---

## 3. Choice Architecture

### Assessment: STRONG (with one exception)

Choice consumption semantics are correctly applied across the vast majority of the codebase:

| Pattern | Usage | Correctness |
|---------|-------|-------------|
| **Consuming choices** for state transitions | Lending_Borrow, Lending_Repay, DirectMint_Mint, BoostPool_Deposit | ✅ |
| **Nonconsuming choices** for reads | ValidateMint, ValidateTransfer, GetSharePrice, Oracle_GetPrice | ✅ |
| **Consuming choices** for admin updates | Lending_SetPaused, BoostPool_SetPaused, Staking_SetPaused | ✅ |
| **Nonconsuming choices** for admin updates | DirectMint_SetPaused, DirectMint_SetDailyMintLimit | ❌ See [H-01](#h-01-nonconsuming-admin-choices-in-cantondirectmintservice-create-duplicate-contracts) |

The `ensure` clause pattern is used correctly for invariant enforcement:
- `MintedMUSD`: `amount > 0.0` (V3.daml line 43)
- `UserPrivacySettings`: `FullyPrivate` ↔ `null observers` (UserPrivacySettings.daml line 64)
- `CantonLoopPosition`: `currentDeposit >= 0.0`, `totalBorrowed >= 0.0` (CantonLoopStrategy.daml line 101)

---

## 4. Key Management (LF 2.x)

### Assessment: FULLY MIGRATED (with side effects)

All contract keys have been removed for LF 2.x compliance. Every former `key` declaration is annotated with `-- LF 2.x: keys removed`. The migration is thorough and consistent across all 18 modules.

**Migration pattern:** All `lookupByKey` / `fetchByKey` calls replaced with explicit CID passing. Callers must provide contract IDs as choice parameters rather than discovering contracts by key.

**Side effects:**
1. `lookupUserObservers` now always returns `[]` — see [H-02](#h-02-lookupuserobservers-permanently-disabled-after-lf-2x-migration)
2. Cross-module lookup (e.g., CantonLending checking DirectMint supply via key) replaced with `directMintServiceName` field and explicit CID coordination
3. Duplicate-position prevention (formerly via key uniqueness) now enforced via explicit `assertMsg` checks (e.g., `DAML-M-01: DUPLICATE_ESCROW` in CantonLending.daml line 474)

---

## 5. Cross-Module Safety

### Assessment: STRONG

The protocol implements multiple cross-module safety mechanisms:

**Supply Cap Coordination (D-M02):**  
CantonLending tracks both `cantonSupplyCap` and `cantonCurrentSupply` independently from DirectMint's `supplyCap` and `currentSupply`. The `globalMintCap` field in CantonLendingService enforces a protocol-wide ceiling. Tested in CrossModuleIntegrationTest.daml (Integration 10, line 640).

**Module-Scoped Governance Proofs:**  
All governance-gated choices validate `proof.targetModule` matches the current module name:
- `assertMsg "WRONG_TARGET_MODULE" (proof.targetModule == "CantonLending")` — CantonLending.daml line 1233
- `assertMsg "WRONG_TARGET_MODULE" (proof.targetModule == "CantonDirectMint")` — CantonDirectMint.daml line 817
- Prevents a governance proof approved for one module from being used in another.

**sMUSD Double-Use Prevention (D-M04):**  
sMUSD escrowed as lending collateral cannot simultaneously qualify for BoostPool deposits. The BoostPool reads sMUSD data without consuming it (DAML-H-06 fix).

**Compliance Propagation:**  
All user-facing modules hold a `complianceRegistryCid` and validate compliance before minting, transferring, and redeeming. Compliance checks are nonconsuming, so multiple modules can validate against the same registry without contention.

---

## 6. Compliance Integration

### Assessment: STRONG

The `ComplianceRegistry` template provides a unified enforcement point:

| Check | Controller | Type | Location |
|-------|-----------|------|----------|
| `ValidateMint` | `operator` | nonconsuming | Compliance.daml line 99 |
| `ValidateTransfer` | `operator` | nonconsuming | Compliance.daml line 112 |
| `ValidateRedemption` | `operator` | nonconsuming | Compliance.daml line 124 |
| `IsCompliant` | `caller` | nonconsuming | Compliance.daml line 133 |

**Strengths:**
- `Set`-based lookups provide O(log n) blacklist/freeze checks
- Frozen parties can receive assets but cannot send — correct regulatory semantics
- Bulk blacklist capped at 1,000 parties (D-L-04 expansion for mass incident response)
- All modules validate compliance at entry: DirectMint, Lending, BoostPool, ETHPool, LoopStrategy, Bridge

**Finding:** See [M-01](#m-01-iscompliant-choice-has-unrestricted-controller-caller) regarding `IsCompliant` controller.

---

## 7. Governance & Multi-Sig

### Assessment: GOOD (with trust caveat)

The governance system implements:

1. **MultiSigProposal** — N-of-M approval with configurable threshold, timelock, and expiration
2. **GovernanceActionLog** — Proof of approved action, consumed on use via `ConsumeProof`
3. **EmergencyPauseState** — Multi-guardian pause with 48h max duration (DAML-M-02)
4. **MinterRegistry** — Centralized minter authorization

**ConsumeProof (C-DAML-01):** The `ConsumeProof` choice is consuming, ensuring each governance proof can only be used once. This prevents replay attacks where a single approved action could be executed multiple times.

**Module scoping:** Each `GovernanceActionLog` is scoped to a `targetModule` and `actionType`. A proof approved for "CantonLending / ParameterUpdate" cannot be used for "CantonDirectMint / TreasuryWithdrawal".

**Finding:** See [H-03](#h-03-operator-can-bypass-multi-sig-governance-via-direct-governanceactionlog-creation) for the trust-boundary issue.

---

## 8. Test Coverage

### Assessment: STRONG

**14 test modules** totaling **~11,080 lines** cover the protocol comprehensively:

| Test Module | Lines | Coverage Area |
|-------------|-------|---------------|
| CantonBoostPoolTest.daml | 1,590 | Deposit, cap enforcement, withdrawal, fee updates, pause |
| V3ProtocolExtendedTest.daml | 1,365 | MUSD lifecycle, oracle, vault, bridge, attestation |
| CantonLendingTest.daml | 1,172 | Price feeds, deposits, borrows, liquidation, admin |
| CantonLoopStrategyTest.daml | 1,026 | Loop execution, health factor, unwind |
| CantonDirectMintTest.daml | 832 | Minting, redemption, rate limits, fee withdrawal |
| CrossModuleIntegrationTest.daml | 713 | 10 cross-module scenarios (mint→stake, liquidation, compliance, supply cap) |
| GovernanceExtendedTest.daml | 653 | Proposal lifecycle, timelock, multi-sig, emergency pause |
| UserPrivacySettingsTest.daml | 642 | Observer management, privacy toggles |
| CantonEdgeCasesTest.daml | 619 | Bridge quorum boundary, rate limit window reset, concurrent attestations |
| CantonETHPoolTest.daml | 615 | Deposits, share price sync, yield distribution, pause |
| UpgradeTest.daml | 577 | Upgrade proposal, activation, batch migration, rollback |
| NegativeTests.daml | 554 | 14 adversarial scenarios: unauthorized ops, double-spend, invalid state |
| ComplianceExtendedTest.daml | 377 | Blacklist, freeze, bulk ops, validate mint/transfer/redemption |
| InterestRateServiceTest.daml | 345 | Rate calculations, market state sync, APR caps |

**Strengths:**
- Dedicated adversarial test suite (NegativeTests) with `submitMustFail` / `submitMultiMustFail` assertions
- Cross-module integration tests covering 10 end-to-end workflows
- Edge case testing (quorum boundaries, rate limit window resets, concurrent operations)
- Every major module has its own dedicated test file

**Gap:** No dedicated test file for `AuditReceipts.daml`, `CantonCoinToken.daml`, `CantonCoinMint.daml`, or `InitProtocol.daml`. These are smaller utility modules but would benefit from unit tests.

---

## 9. Canton 3.x / LF 2.x Compatibility

### Assessment: GOOD

The codebase has been fully migrated to LF 2.x:

- **All contract keys removed** — annotated with `-- LF 2.x: keys removed` throughout
- **CID-based addressing** — all lookups use explicit contract IDs passed as choice parameters
- **`lookupByKey` / `fetchByKey` eliminated** — no remaining calls in source modules
- **`DA.Set` used** (not `DA.Map`) for blacklist/freeze — compatible with LF 2.x serialization
- **Numeric 18 precision** — correct for financial calculations and Ethereum Wei mapping

**Residual concern:** The `lookupUserObservers` stub (UserPrivacySettings.daml line 147) needs a proper replacement mechanism for the key-based lookup it replaced. See [H-02](#h-02-lookupuserobservers-permanently-disabled-after-lf-2x-migration).

---

## 10. Positive Patterns

These engineering patterns demonstrate security-conscious design:

1. **Proposal-Accept Transfers** — All token transfers require recipient opt-in. Prevents forced signatory obligations. Used across `MintedMUSD`, `CantonMUSD`, `CantonUSDC`, `CantonCoin`.

2. **Oracle Price Caps** — Price updates capped at ±50% movement per update (CantonLending.daml, PriceFeed_Update). Share price sync capped at ±10% per epoch (CantonSMUSD.daml, SyncGlobalSharePrice). Canton coin price changes capped at ±25%.

3. **ConsumeProof One-Time Use** — Governance proofs are consuming, preventing replay. Each approved action can execute exactly once.

4. **Module-Scoped Governance** — `targetModule` field prevents cross-module proof reuse.

5. **Rate Limiting with Proportional Decay** — 24h rolling window with proportional decay for mint/burn rate limits (CantonDirectMint.daml, AUDIT-C-02).

6. **Validator Ratchet** — `minValidators` is a one-way ratchet (can only increase), preventing security regression (V3.daml, AUDIT-H-03).

7. **Interest Accrual Before Reads** — Debt positions accrue interest before any state reads, preventing stale-interest exploits (DAML-M-04).

8. **Liquidation Receipts** — Immutable audit trail per liquidation event with collateral type, amounts, prices, penalties, and keeper bonuses.

9. **Emergency Override Architecture** — `PriceFeed_EmergencyUpdate` bypasses movement caps but requires governance proof. `Oracle_GetPriceUnsafe` allows liquidation to proceed during stale data, preventing blocked liquidations.

10. **CantonMUSD Burn Proposal** — Burn requires explicit proposal (`CantonMUSDBurnProposal`) preventing unilateral token destruction. Owner and operator must coordinate.

11. **Attestation Quorum** — Bridge operations require ECDSA signatures from validators. Minimum 130-char signature length validated. `requiredSignatures` threshold enforced before completion.

12. **Comprehensive `assertMsg` Coverage** — Descriptive error codes throughout (`MINTER_BLACKLISTED`, `SUPPLY_CAP_EXCEEDED`, `PRICE_STALE`, `HEALTH_FACTOR_OK`).

---

## 11. Findings Detail

---

### H-01: Nonconsuming Admin Choices in CantonDirectMintService Create Duplicate Contracts

**Severity:** HIGH  
**Status:** OPEN  
**Location:** CantonDirectMint.daml lines 801–835

**Description:**  
Three admin choices on `CantonDirectMintService` are declared `nonconsuming` but create new service contracts:

| Choice | Line | Issue |
|--------|------|-------|
| `DirectMint_SetPaused` | 801 | `nonconsuming` + `create this with paused = newPaused` |
| `DirectMint_SetDailyMintLimit` | 808 | `nonconsuming` + `create this with dailyMintLimit = newLimit` |
| `DirectMint_SetComplianceRegistry` | 820 | `nonconsuming` + `create this with complianceRegistryCid = newRegistryCid` |

A `nonconsuming` choice does NOT archive the contract it is exercised on. Each execution creates a NEW `CantonDirectMintService` contract while the original remains active. After exercising `DirectMint_SetPaused`, there are **two** active service contracts: the original (unpaused) and the new one (paused).

**Impact:**
- Operator could inadvertently use the stale service CID, bypassing the pause
- Rate limit state (`dailyMinted`, `dailyBurned`) is duplicated — the old contract retains the pre-limit-update state, potentially allowing a higher effective daily limit
- Accumulated fees could be double-withdrawn from old and new contracts

**Comparison:** All other modules use **consuming** choices for the same pattern:
- `Lending_SetPaused` — consuming (CantonLending.daml line 1239) ✅
- `BoostPool_SetPaused` — consuming (CantonBoostPool.daml line 450) ✅
- `ETHPool_SetPaused` — consuming (CantonETHPool.daml line 483) ✅
- `Staking_SetPaused` — consuming (CantonSMUSD.daml line 382) ✅
- `Loop_SetPaused` — consuming (CantonLoopStrategy.daml line 318) ✅

**Recommendation:** Change all three choices from `nonconsuming choice` to `choice` (consuming). This is a one-word change per choice that aligns with the pattern used in every other module.

---

### H-02: `lookupUserObservers` Permanently Disabled After LF 2.x Migration

**Severity:** HIGH  
**Status:** OPEN  
**Location:** UserPrivacySettings.daml lines 144–147

**Description:**  
The `lookupUserObservers` function, which propagates user privacy preferences to all product contracts, was stubbed to always return `[]` after LF 2.x contract key removal:

```haskell
lookupUserObservers : Party -> Party -> Update [Party]
lookupUserObservers _operator _user = do
  return []  -- LF 2.x: contract keys removed, default to fully private
```

This function is called from **10+ locations** across 6 modules:
- CantonCoinToken.daml line 31
- CantonETHPool.daml lines 98, 416, 548
- CantonSMUSD.daml lines 58, 202, 267
- CantonBoostPool.daml lines 59, 266, 319
- CantonLending.daml lines 222, 310, 556, 613

**Impact:**
- The entire `UserPrivacySettings` system is non-functional. Users can create settings and add observers, but the observers are **never applied** to any product contract.
- Institutional users who need compliance officers or auditors as observers cannot achieve selective transparency.
- The `UserPrivacySettings` template itself is well-tested (642-line test file) but its integration with the rest of the protocol is broken.

**Recommendation:** Replace the stub with an explicit CID-passing pattern. Add an optional `privacySettingsCid : Optional (ContractId UserPrivacySettings)` parameter to service choices that create user-facing contracts, and fetch/apply observers from the settings contract when provided.

---

### H-03: Operator Can Bypass Multi-Sig Governance via Direct GovernanceActionLog Creation

**Severity:** HIGH  
**Status:** OPEN (architectural trade-off)  
**Location:** Governance.daml — `GovernanceActionLog` template

**Description:**  
The `GovernanceActionLog` template has `signatory operator` only (per D-H-01 fix, changed from `signatory operator, approvers` to prevent archive failures when approvers go offline). This means the operator can create a `GovernanceActionLog` directly via `createCmd`, completely bypassing the `MultiSigProposal` approval process.

All governance-gated admin choices consume a `GovernanceActionLog` as proof:
- `DirectMint_SetDailyMintLimit` — CantonDirectMint.daml line 808
- `DirectMint_SetComplianceRegistry` — CantonDirectMint.daml line 820
- `DirectMint_WithdrawFees` — CantonDirectMint.daml line 836
- `Lending_UpdateMinBorrow` — CantonLending.daml line 1248
- `Lending_UpdateReserveFactor` — CantonLending.daml line 1259
- `Lending_UpdateCloseFactor` — CantonLending.daml line 1270
- `Lending_WithdrawReserves` — CantonLending.daml line 1286
- `Lending_SetComplianceRegistry` — CantonLending.daml line 1304
- `BoostPool_UpdateFees` — CantonBoostPool.daml line 457
- `BoostPool_UpdateCapRatio` — CantonBoostPool.daml line 475

**Impact:**
- The multi-sig governance safeguard is **advisory, not enforceable** at the ledger level
- The operator can unilaterally change daily mint limits, compliance registries, fee structures, reserve factors, and withdraw protocol reserves
- The `ConsumeProof` mechanism prevents replay but not forgery

**Mitigating Factors:**
1. The operator is already a trusted party (signatory on all service templates) — a malicious operator has many other attack vectors
2. The D-H-01 fix was necessary for operational reliability (approvers going offline would block all governance actions)
3. Off-chain monitoring can detect `GovernanceActionLog` creation events not preceded by `MultiSigProposal` execution
4. The `proposalId` field on `GovernanceActionLog` can be cross-referenced against actual proposals

**Recommendation:** Consider adding a `proposalCid : Optional (ContractId MultiSigProposal)` field to `GovernanceActionLog` and having the consuming choices validate this reference when the protocol is not in emergency mode. Alternatively, implement an off-chain monitoring alert for direct `GovernanceActionLog` creation.

---

### M-01: `IsCompliant` Choice Has Unrestricted `controller caller`

**Severity:** MEDIUM  
**Status:** OPEN  
**Location:** Compliance.daml lines 133–140

**Description:**  
The `IsCompliant` choice uses `controller caller` where `caller` is a choice parameter, meaning **any party** who has visibility of the `ComplianceRegistry` can query the compliance status of any other party. The other validation choices (`ValidateMint`, `ValidateTransfer`, `ValidateRedemption`) correctly restrict the controller to `operator`.

**Impact:**
- Parties with registry visibility can enumerate blacklist/freeze status of other parties
- In Canton's privacy model, this is limited to parties who can see the contract (signatories + observers), but the pattern is unnecessarily broad

**Recommendation:** Change `controller caller` to `controller operator` (consistent with other validation choices), or add an `assertMsg "NOT_AUTHORIZED" (caller == operator || caller == regulator)` check.

---

### M-02: ComplianceRegistry Operator Visibility Not Guaranteed in Production Canton

**Severity:** MEDIUM  
**Status:** OPEN  
**Location:** Compliance.daml line 25

**Description:**  
The `ComplianceRegistry` template declares `signatory regulator` only. The `operator` party is a field but is not declared as a signatory or observer. Multiple choices use `controller operator` (`ValidateMint`, `ValidateTransfer`, `ValidateRedemption`), which requires the operator to have visibility of the contract.

In DAML Script testing this works (sandbox shares ACS). In production Canton, the operator would need to be disclosed the contract through Canton's disclosure mechanism or added as an explicit observer.

**Impact:** Protocol operations that depend on compliance validation (minting, transferring, redeeming across all modules) could fail in production if operator visibility is not properly configured.

**Recommendation:** Add `observer operator` to the `ComplianceRegistry` template, or document the required Canton disclosure configuration for deployment.

---

### M-03: CantonYBStaking Is an Empty Module

**Severity:** MEDIUM  
**Status:** OPEN  
**Location:** CantonYBStaking.daml (1 line)

**Description:**  
The file contains only `module CantonYBStaking where`. If this represents planned functionality, it should be removed from the main codebase or explicitly marked as a placeholder. An empty module imported by other code could cause confusion during development and deployment.

**Recommendation:** Remove the file or add a comment explaining the planned purpose and timeline.

---

### L-01: CantonLoopStrategy `UnwindRequest_Cancel` Doesn't Validate Position Status

**Severity:** LOW  
**Location:** CantonLoopStrategy.daml line 559

**Description:**  
The `UnwindRequest_Cancel` choice fetches the position and sets its status to `"active"` without verifying that the current status is `"unwinding"`. While the `UnwindRequest` template's existence implies the position should be in an unwinding state, an explicit `assertMsg "MUST_BE_UNWINDING" (pos.status == "unwinding")` check would be defensive.

---

### L-02: Hardcoded Time Constants

**Severity:** LOW  
**Location:** Multiple modules

**Description:**  
Several modules hardcode time constants rather than using configurable parameters:
- Cooldown: `86400` seconds (24h) in CantonSMUSD.daml (though also a config field `cooldownSeconds`)
- Rate limit window: `hours 24` in CantonDirectMint.daml
- Emergency pause max: `hours 48` in Governance.daml
- Supply cap cooldown: `hours 24` in CantonDirectMint.daml line 795

**Impact:** Cannot adjust timing parameters without contract upgrade.

---

### L-03: No Dedicated Tests for Utility Modules

**Severity:** LOW  
**Location:** N/A

**Description:**  
The following modules lack dedicated test files:
- `AuditReceipts.daml` (90 lines) — audit trail templates
- `CantonCoinToken.daml` (81 lines) — Canton coin token
- `CantonCoinMint.daml` (127 lines) — Canton coin minting wrapper
- `InitProtocol.daml` (177 lines) — protocol initialization

These modules are exercised indirectly through other tests but would benefit from dedicated coverage, especially `InitProtocol.daml` which bootstraps the entire protocol state.

---

### L-04: String-Based Status Fields Instead of Sum Types

**Severity:** LOW  
**Location:** CantonLoopStrategy.daml — `CantonLoopPosition.status : Text`

**Description:**  
The `CantonLoopPosition` template uses `status : Text` with string values (`"active"`, `"unwinding"`, etc.) rather than a sum type (`data PositionStatus = Active | Unwinding | Closed`). This allows invalid status values to be set without compiler enforcement. Other modules (e.g., Governance.daml with `ProposalStatus`) correctly use sum types.

---

## 12. Resolved Findings

The codebase contains extensive evidence of prior audit remediation. The following findings have been verified as resolved:

| ID | Description | Module | Resolution |
|----|-------------|--------|------------|
| DAML-CRIT-01 | Supply cap bypass | Multiple | Multi-layer cap tracking with cross-module coordination |
| DAML-H-01 | GovernanceActionLog archive failure | Governance | Changed to operator-only signatory (trade-off: see H-03) |
| DAML-H-03 | Lending deposit consuming service | CantonLending | Changed to nonconsuming choice for deposits |
| DAML-H-04 | Lending compliance registry update | CantonLending | Added governance proof requirement |
| DAML-H-06 | BoostPool sMUSD consumption | CantonBoostPool | Changed to read-only (fetch without archive) |
| DAML-M-01 | Duplicate escrow CID | CantonLending | Explicit assertMsg check added |
| DAML-M-02 | Emergency pause single-operator | Governance | Multi-guardian approval required |
| DAML-M-03 | Hardcoded staleness threshold | CantonLending | Per-asset staleness configuration |
| DAML-M-04 | Stale interest exploit | CantonLending | Interest accrual before debt reads |
| DAML-M-05 | Fee/cap ratio change ungated | CantonBoostPool | Governance proof requirement added |
| DAML-M-06 | Emergency price update ungated | CantonLending | Governance proof requirement added |
| DAML-M-09 | Share price manipulation | CantonSMUSD | ±10% per epoch cap + 3 validator attestation |
| AUDIT-H-03 | minValidators regression | V3 | One-way ratchet (can only increase) |
| AUDIT-H-04 | BridgeOut without attestation | V3 | Attestation required for completion |
| AUDIT-C-02 | Rate limit bypass | CantonDirectMint | 24h rolling window with proportional decay |
| BRIDGE-H-02 | Client-side nonce manipulation | V3 | Server-side assignment (accepted risk) |
| DAML-C-03 | Archive unvalidated issuer | CantonLoopStrategy | Issuer validation before archive |
| D-M01 | Unstake without cooldown | CantonSMUSD | Cooldown enforcement added |
| D-M02 | Supply cap module isolation | Cross-module | Cross-module supply tracking |
| D-M08 | Blacklisted transfer allowed | CantonDirectMint | Compliance check at transfer point |
| C-DAML-01 | Governance proof replay | Governance | ConsumeProof consuming choice |

---

## Scoring Breakdown

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Authorization Model | 15% | 90 | 13.50 |
| Privacy Architecture | 10% | 55 | 5.50 |
| Choice Architecture | 15% | 85 | 12.75 |
| Key Management (LF 2.x) | 10% | 80 | 8.00 |
| Cross-Module Safety | 15% | 92 | 13.80 |
| Compliance Integration | 10% | 88 | 8.80 |
| Governance & Multi-Sig | 10% | 70 | 7.00 |
| Test Coverage | 10% | 88 | 8.80 |
| Canton 3.x Compatibility | 5% | 90 | 4.50 |
| **Total** | **100%** | | **82.65 ≈ 83** |

---

## Overall DAML Security Score: **83 / 100**

The Minted mUSD Canton DAML layer is a **well-engineered protocol** that has undergone extensive security review and remediation. The three remaining HIGH findings are actionable: H-01 is a straightforward fix (change `nonconsuming` to consuming), H-02 requires a design decision on CID-passing for privacy settings, and H-03 is an architectural trade-off with documented rationale and off-chain mitigations.

The strong positive patterns — particularly the dual-signatory model, module-scoped governance proofs, oracle price caps, and 1.3:1 test-to-source ratio — demonstrate security-first engineering throughout the protocol.

---

*End of audit report.*
