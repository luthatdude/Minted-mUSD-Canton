# DAML/Canton Security Audit — Minted mUSD Protocol (BLE Protocol)

**Audit Date:** 2026-02-06  
**Auditor:** Senior DAML/Canton Security Auditor  
**SDK Version:** daml-sdk 2.10.3  
**Project:** ble-protocol v1.0.0  
**Scope:** All 19 active DAML modules in `daml/`  
**Archive Status:** 14 deprecated files in `archive/daml/` — verified NO imports from active code  

---

## Overall Score: 7.8 / 10

The Minted mUSD Canton layer demonstrates mature security architecture with consistent dual-signatory patterns, comprehensive compliance integration, governance-gated admin operations, and robust test coverage (~100+ test scenarios across 6 test files). Several medium-severity gaps remain around inconsistent compliance enforcement across token types, operator-only controls on price-sensitive operations, and governance proof inconsistencies between modules.

---

## Executive Summary

| Severity | Count |
|---|---|
| **CRITICAL** | 0 |
| **HIGH** | 2 |
| **MEDIUM** | 9 |
| **LOW** | 8 |
| **INFORMATIONAL** | 7 |
| **TOTAL** | 26 |

---

## Findings

---

### HIGH Severity

---

#### H-01: `USDCx_Transfer` Missing Compliance Check

**File:** `daml/CantonDirectMint.daml` ~line 113  
**Category:** Access Control / Compliance Enforcement  

**Description:**  
`CantonUSDC_Transfer` correctly validates the recipient against the `ComplianceRegistry` before transferring. However, `USDCx_Transfer` (xReserve USDC) performs NO compliance check at all — a blacklisted/sanctioned party can freely receive USDCx tokens.

**Impact:**  
USDCx represents xReserve USDC which has real monetary value backing. A sanctioned entity could receive USDCx, then redeem for mUSD or bridge out, circumventing OFAC compliance.

**Recommendation:**  
Add the same `ValidateTransfer` compliance check to `USDCx_Transfer` that exists on `CantonUSDC_Transfer`:
```daml
USDCx_Transfer : ContractId USDCx
  with newOwner : Party; complianceRegistryCid : ContractId ComplianceRegistry
  controller owner
  do
    exercise complianceRegistryCid ValidateTransfer with fromParty = owner; toParty = newOwner
    create this with owner = newOwner
```

---

#### H-02: `GovernanceActionLog` Signatory Is Operator-Only — `ConsumeProof` Lacks Executor Authorization

**File:** `daml/Governance.daml` ~lines 280-320  
**Category:** Access Control / Governance Integrity  

**Description:**  
`GovernanceActionLog` has `signatory operator` with `executedBy` as observer. The `ConsumeProof` choice is controlled by `operator`. This means:
1. The operator can exercise `ConsumeProof` without the executor's consent or visibility.
2. Any module calling `exercise govProofCid ConsumeProof` only requires operator authority — the multi-sig approval chain is consumed by a single party.
3. The executor (who earned the approval) has no on-ledger guarantee the proof was consumed for the intended purpose.

**Impact:**  
The entire governance multi-sig system's enforcement reduces to single-operator control at the consumption point. While the creation of the proof requires multi-sig, its consumption does not, weakening the security model.

**Recommendation:**  
Make `executedBy` a signatory (or at minimum a controller on `ConsumeProof`):
```daml
template GovernanceActionLog
  with ...
  where
    signatory operator, executedBy
    choice ConsumeProof : ()
      controller operator, executedBy
      do pure ()
```

---

### MEDIUM Severity

---

#### M-01: `PriceFeed_EmergencyUpdate` Requires No Governance Approval

**File:** `daml/CantonLending.daml` ~lines 165-180  
**Category:** Oracle Manipulation / Access Control  

**Description:**  
`PriceFeed_EmergencyUpdate` can be executed by the operator alone with only a 5-minute cooldown. There is no governance co-signer, attestation, or multi-sig requirement. The only constraint is the cooldown timer.

**Impact:**  
A compromised operator key can crash any asset's price feed and trigger mass liquidations. The 5-minute cooldown is insufficient protection — an attacker needs only wait 5 minutes after the last update.

**Recommendation:**  
Require a governance proof or at minimum a guardian co-signer for emergency price updates:
```daml
PriceFeed_EmergencyUpdate : ContractId CantonPriceFeed
  with newPriceUsd : Decimal; reason : Text; governanceProofCid : ContractId GovernanceActionLog
  controller operator
  do
    exercise governanceProofCid ConsumeProof
    ...
```

---

#### M-02: `SyncYield` (Legacy) Missing Attestation Requirements

**File:** `daml/CantonSMUSD.daml` ~lines 195-210  
**Category:** Oracle Manipulation / Data Integrity  

**Description:**  
`SyncGlobalSharePrice` correctly requires `attestationHash` (64-char hex) and `validatorCount ≥ 3` for BFT verification. However, the legacy `SyncYield` choice on `CantonStakingService` has no such requirements — it accepts yield updates without any attestation proof.

**Impact:**  
If `SyncYield` is still callable (it exists in the template), an operator can manipulate the yield rate without any validator attestation, potentially inflating sMUSD value.

**Recommendation:**  
Either remove `SyncYield` entirely (in favor of `SyncGlobalSharePrice`) or add the same attestation requirements. If kept for backward compatibility, deprecate with `assertMsg "SyncYield deprecated" False`.

---

#### M-03: `CantonSMUSD` Transfer Missing Compliance Check

**File:** `daml/CantonSMUSD.daml` ~lines 50-70  
**Category:** Compliance Enforcement  

**Description:**  
`CantonMUSD_Transfer` validates against `ComplianceRegistry`. `SMUSD_Transfer` (via `CantonSMUSDTransferProposal`) does NOT perform any compliance check. sMUSD is a yield-bearing derivative of mUSD with equivalent monetary value.

**Impact:**  
A sanctioned party could receive sMUSD (staked mUSD), earn yield, and later unstake to receive mUSD — bypassing compliance controls that exist on the base token.

**Recommendation:**  
Add compliance validation to `SMUSD_AcceptTransfer`:
```daml
SMUSD_AcceptTransfer : ContractId CantonSMUSD
  with complianceRegistryCid : ContractId ComplianceRegistry
  controller recipient
  do
    exercise complianceRegistryCid ValidateTransfer with fromParty = sender; toParty = recipient
    create CantonSMUSD with owner = recipient; ...
```

---

#### M-04: `Loop_UpdateParams` Lacks Governance Proof

**File:** `daml/CantonLoopStrategy.daml` ~lines 240-260  
**Category:** Access Control / Privilege Escalation  

**Description:**  
`Loop_UpdateParams` is controlled by operator alone with no governance proof requirement. This allows unilateral changes to critical loop parameters (max leverage, health factor thresholds, fee rates) without multi-sig approval.

In contrast, `LoopConfig_Update` on `CantonLoopStrategyConfig` correctly requires a governance proof.

**Impact:**  
Operator can change max leverage ratios, disable health factor checks, or modify fee structures without governance oversight.

**Recommendation:**  
Add `governanceProofCid` parameter and consume it:
```daml
Loop_UpdateParams : ContractId CantonLoopStrategyService
  with ...; governanceProofCid : ContractId GovernanceActionLog
  controller operator
  do
    exercise governanceProofCid ConsumeProof
    ...
```

---

#### M-05: `CantonLoopRequest` Compliance Check Is Optional

**File:** `daml/CantonLoopStrategy.daml` ~lines 415-435  
**Category:** Compliance Enforcement  

**Description:**  
The compliance check on `CantonLoopRequest` depends on `config.complianceRegistryCid` being `Some`. If this field is `None`, the loop position opens without any compliance validation:
```daml
case config.complianceRegistryCid of
  Some cid -> do exercise cid ValidateTransfer with ...
  None -> pure ()
```

**Impact:**  
If `CantonLoopStrategyConfig` is created or updated with `complianceRegistryCid = None`, sanctioned parties can open leveraged positions.

**Recommendation:**  
Make `complianceRegistryCid` non-optional (`ContractId ComplianceRegistry` instead of `Optional (ContractId ComplianceRegistry)`), or add an `ensure` clause requiring it.

---

#### M-06: `CantonLoopStrategyConfig` Governance Proof Manual Archive

**File:** `daml/CantonLoopStrategy.daml` ~lines 310-380  
**Category:** Governance Integrity  

**Description:**  
`LoopConfig_Update` fetches the governance proof and manually archives it via `archive governanceProofCid` instead of using the established `ConsumeProof` choice pattern used by other modules (Governance.daml, CantonLending.daml).

**Impact:**  
1. Bypasses any future validation logic added to `ConsumeProof`.
2. Inconsistency makes audit harder — reviewers must check two consumption patterns.
3. The `archive` approach works but doesn't trigger `ConsumeProof`'s controller check.

**Recommendation:**  
Replace `archive governanceProofCid` with `exercise governanceProofCid ConsumeProof` for consistency.

---

#### M-07: `UpgradeRegistry_EmergencyRollback` Single-Member Threshold

**File:** `daml/Upgrade.daml` ~lines 185-200  
**Category:** Access Control / Governance  

**Description:**  
`UpgradeRegistry_EmergencyRollback` requires only a single governance member to exercise. For standard upgrades, the proposal requires `approvalThreshold` approvers, but emergency rollback bypasses this entirely — any single governance member can roll back an upgrade.

**Impact:**  
A single compromised governance key can roll back production upgrades, potentially reverting security fixes or causing service disruption.

**Recommendation:**  
Require at minimum 2-of-N or a reduced threshold (e.g., `ceiling(threshold/2)`) for emergency rollback.

---

#### M-08: BoostPool `Withdraw` Has No Pause Check

**File:** `daml/CantonBoostPool.daml` ~lines 290-320  
**Category:** Emergency Controls  

**Description:**  
`BoostPool_Deposit` correctly checks `assertMsg "Pool not paused" (not service.paused)`. However, `BoostPool_Withdraw` has NO pause check. During an emergency pause (exploit, price manipulation), users can still withdraw from the BoostPool.

**Impact:**  
During an active exploit scenario where the protocol is paused, attackers can still extract funds from the BoostPool.

**Recommendation:**  
Add pause check to `BoostPool_Withdraw`:
```daml
assertMsg "Pool not paused for withdrawals" (not service.paused)
```
Note: Consider whether legitimate users should be able to withdraw during pause — if so, add a separate `withdrawalsPaused` flag.

---

#### M-09: `SyncCantonPrice` and `SyncSharePrice` on BoostPool Lack Attestation

**File:** `daml/CantonBoostPool.daml` ~lines 350-390  
**Category:** Oracle Manipulation  

**Description:**  
`SyncCantonPrice` and `SyncSharePrice` on `CantonBoostPoolService` are operator-only with no attestation hash, validator count, or governance co-signer. These directly affect the sMUSD-qualified cap calculation and reward distribution.

**Impact:**  
A compromised operator can manipulate the Canton price or share price to inflate/deflate BoostPool caps and reward distributions.

**Recommendation:**  
Add attestation requirements consistent with `SyncGlobalSharePrice` on the staking service.

---

### LOW Severity

---

#### L-01: Interest Accrual Uses Simple (Not Compound) Interest

**File:** `daml/CantonLending.daml` ~line 340  
**Category:** Financial Logic  

**Description:**  
Interest calculation uses: `principalDebt * rate * time / (10000 * yearSeconds)`. This is simple interest that doesn't compound. Over long periods, the protocol collects less interest than a compound model would generate.

**Impact:**  
Protocol revenue leakage — borrowers pay less interest than in equivalent DeFi compound interest models. For a $10M lending book at 5% APR, the difference is ~$12,500/year.

**Recommendation:**  
Document the simple interest model as intentional, or implement compound accrual per-block/per-day.

---

#### L-02: `InterestRateService` Integer Division Truncation

**File:** `daml/InterestRateService.daml` ~lines 90-100  
**Category:** Precision / Financial  

**Description:**  
Rate calculations use: `(util * multiplierBps) / 10000`. Integer division truncates, and intermediate calculations use `Decimal` type while monetary values use `Numeric 18` — potential precision mismatch.

**Impact:**  
Minor rate calculation inaccuracies. At high utilization with low multipliers, the truncation could result in rates being slightly lower than intended.

**Recommendation:**  
Use `Numeric 18` consistently throughout rate calculations, or multiply before dividing to minimize truncation.

---

#### L-03: BoostPool Deposit Archives and Recreates sMUSD

**File:** `daml/CantonBoostPool.daml` ~lines 230-250  
**Category:** State Management  

**Description:**  
`BoostPool_Deposit` archives the user's `CantonSMUSD` contract and recreates it with a new contract ID. Any external references to the old sMUSD contract ID (e.g., in escrow records, UI caches, or cross-module lookups) become stale.

**Impact:**  
Low — DAML's consumption model makes this standard practice, but any off-ledger system caching contract IDs must handle CID changes.

**Recommendation:**  
Document the CID change behavior for frontend/integration teams. Consider using contract keys for sMUSD lookup where possible.

---

#### L-04: V3 `MUSD_SetBlacklist` Has No Reason or Audit Trail

**File:** `daml/Minted/Protocol/V3.daml` ~line 307  
**Category:** Compliance / Auditability  

**Description:**  
`MUSD_SetBlacklist` in V3 toggles the per-token `blacklisted` flag with only `issuer` controller. No reason text, no compliance registry validation, and no audit log. In contrast, `ComplianceRegistry.Compliance_Blacklist` requires a `reason` field.

**Impact:**  
Regulatory audit trail gap — blacklisting actions on V3 tokens cannot be explained or traced.

**Recommendation:**  
Add `reason : Text` parameter and emit an audit event or log contract.

---

#### L-05: V3 `LiquidityPool` Has No Slippage Protection

**File:** `daml/Minted/Protocol/V3.daml` ~lines 460-490  
**Category:** Financial Safety  

**Description:**  
`LP_AddLiquidity` and `LP_RemoveLiquidity` calculate share amounts based on current pool ratios but have no `minSharesOut` or `maxPriceImpact` parameter.

**Impact:**  
Users could experience unexpected slippage if a large trade front-runs their liquidity operation. In DAML's serialized execution model this is less likely than in public blockchains, but still possible with operator ordering.

**Recommendation:**  
Add `minSharesOut : Numeric 18` for deposits and `minAmountOut : Numeric 18` for withdrawals.

---

#### L-06: `ComplianceRegistry.ValidateMint` Doesn't Check Frozen Status

**File:** `daml/Compliance.daml` ~lines 120-130  
**Category:** Compliance Logic  

**Description:**  
`ValidateMint` checks: `assertMsg "Minter not blacklisted" (not (S.member minter blacklisted))` but does NOT check the `frozen` set. A frozen party (whose assets should be immobilized) can still mint new tokens.

**Impact:**  
Frozen parties can mint new mUSD, partially circumventing the freeze action's intent.

**Recommendation:**  
Add frozen check: `assertMsg "Minter not frozen" (not (S.member minter frozen))`.

---

#### L-07: `DistributeRewards` Epoch Gap Check But No Attestation

**File:** `daml/CantonBoostPool.daml` ~lines 330-340  
**Category:** Data Integrity  

**Description:**  
`DistributeRewards` enforces `epochNumber - lastRewardEpoch ≤ 100` but has no attestation hash or validator count requirement. Reward amounts are operator-provided with no external verification.

**Impact:**  
Operator can provide arbitrary reward amounts. The epoch gap check prevents large gaps but not fabricated reward data.

**Recommendation:**  
Add attestation requirement or governance co-signer for reward distribution.

---

#### L-08: `Loop_EmergencyClose` Has No Compliance Check and No Fee

**File:** `daml/CantonLoopStrategy.daml` ~lines 175-195  
**Category:** Compliance / Financial  

**Description:**  
`Loop_EmergencyClose` skips compliance validation and charges no exit fee. While emergency exits should be fast, the complete bypass of compliance means a party that was blacklisted AFTER opening a position can close it without any check.

**Impact:**  
Low — the party already has the position. But compliance should at minimum be logged for regulatory purposes.

**Recommendation:**  
Log the emergency close in an audit trail even if compliance isn't enforced as a gate.

---

### INFORMATIONAL

---

#### I-01: `CantonDirectMintTest.daml` Moved to Archive — Test Gap

**File:** `archive/daml/CantonDirectMintTest.daml`  
**Category:** Test Coverage  

**Description:**  
The dedicated test file for `CantonDirectMint.daml` (the standalone module, not V3) has been moved to archive. While `CrossModuleIntegrationTest.daml` covers some DirectMint scenarios, the unit-level tests for rate limiting, supply cap changes, bridge-out flows, and USDCx operations in the standalone module are no longer in the active test suite.

**Recommendation:**  
Create a new `CantonDirectMintTest.daml` or verify that all standalone DirectMint behaviors are covered by integration tests.

---

#### I-02: V3 and Standalone Module Divergence

**Files:** `daml/Minted/Protocol/V3.daml` vs `daml/CantonDirectMint.daml`, `daml/CantonSMUSD.daml`  
**Category:** Architecture  

**Description:**  
V3.daml contains its own versions of `CantonUSDC`, `CantonSMUSD`, `CantonDirectMint` etc. alongside the standalone modules. The V3 versions have different security properties:
- V3.CantonUSDC has no compliance observers field
- V3.MintedMUSD has per-token `blacklisted` flag (standalone doesn't)
- V3.BridgeOutRequest has no `validators` field

This creates potential confusion about which version is canonical.

**Recommendation:**  
Document clearly which module set is production (V3 or standalone) and deprecate the other.

---

#### I-03: `daml.yaml` Suppresses Unused Import Warnings

**File:** `daml.yaml`  
**Category:** Build Hygiene  

**Description:**  
`build-option: --ghc-option=-Wno-unused-imports` suppresses unused import warnings. This can hide dead code references and make dependency tracking harder.

**Recommendation:**  
Remove the suppression and clean up unused imports.

---

#### I-04: Nonconsuming Deposit Choices Return Service CID

**File:** `daml/CantonLending.daml`  
**Category:** API Design  

**Description:**  
`Lending_DepositCTN`, `Lending_DepositUSDC`, etc. are marked `nonconsuming` but still return `ContractId CantonLendingService` (which is `self`). This is semantically misleading — callers may expect the returned CID to be a new contract, but it's the same one.

**Recommendation:**  
Either make the choices consuming (returning a new service CID) or change the return type to not include the service CID.

---

#### I-05: `MigrationTicket_Execute` Doesn't Actually Migrate Contracts

**File:** `daml/Upgrade.daml` ~lines 200-230  
**Category:** Architecture  

**Description:**  
`MigrationTicket_Execute` creates an `UpgradeMigrationLog` but doesn't perform any actual contract migration. Real migration would require external tooling (DAML Script, automation) to archive old contracts and create new versions.

**Recommendation:**  
Document the expected migration tooling and consider providing migration script templates.

---

#### I-06: `lookupUserObservers` Fetch May Fail on Archived Contract

**File:** `daml/UserPrivacySettings.daml`  
**Category:** Robustness  

**Description:**  
`lookupUserObservers` does `lookupByKey @UserPrivacySettings (operator, user)` then fetches. If the contract is archived between the lookup and fetch (race condition in high-concurrency scenarios), the choice fails.

**Recommendation:**  
Use `fetchByKey` directly which handles the lookup+fetch atomically, or handle the `None` case from `lookupByKey`.

---

#### I-07: Hardcoded Constants in Multiple Modules

**Files:** Various  
**Category:** Maintainability  

**Description:**  
Several security-critical values are hardcoded across modules:
- 5-minute emergency update cooldown (CantonLending.daml)
- 10% share price movement cap (CantonSMUSD.daml)
- 64-character hash length (multiple files)
- 80/20 sMUSD-qualified ratio (CantonBoostPool.daml)
- 10 mUSD minimum borrow (CantonLending.daml)

**Recommendation:**  
Extract to a shared configuration module or make them governance-configurable parameters.

---

## Positive Security Patterns

The following security practices are well-implemented and noteworthy:

### ✅ P-01: Dual-Signatory Token Model
All token templates (`CantonMUSD`, `CantonUSDC`, `USDCx`, `CantonCoin`, `CantonSMUSD`, `BoostPoolLP`) consistently use `signatory issuer, owner` with proposal-based transfers. This prevents unilateral token creation or manipulation.

### ✅ P-02: BFT 67% Supermajority (V3 Attestation)
The attestation module in V3.daml correctly implements BFT consensus with `(n * 2 + 2) / 3` threshold calculation, signature validation, nonce monotonicity, and attestation expiry. This is a robust bridge security pattern.

### ✅ P-03: ConsumeProof Governance Pattern
The one-time-use governance proof pattern (`ConsumeProof`) prevents replay of approved governance actions. Most modules correctly consume proofs after use.

### ✅ P-04: Per-Asset Price Staleness (DAML-M-03)
Each `CollateralConfig` has its own `maxStalenessSeconds`, allowing volatile assets (CTN: 300s) to have stricter freshness requirements than stablecoins (USDC: 3600s).

### ✅ P-05: Privacy-by-Default
`UserPrivacySettings` defaults to `FullyPrivate` mode, requiring explicit opt-in for transparency. Cannot add self or operator as observers. Labels required for audit trail.

### ✅ P-06: Comprehensive Test Coverage
Six dedicated test files with ~100+ test scenarios covering:
- Unit tests for lending, loop strategy, boost pool, privacy settings
- Cross-module integration tests (10 scenarios)
- Negative/adversarial tests (13 scenarios)
- Specific regression tests for prior audit findings (D-M01 through D-M09)

### ✅ P-07: Supply Cap Coordination (FIX D-M02)
Cross-module supply cap enforcement between `CantonDirectMint` and `CantonLending` via `serviceName` key lookup prevents total mUSD supply from exceeding the global cap.

### ✅ P-08: Compliance Registry with Set-Based Lookups
O(log n) `DA.Set` for blacklisted/frozen party lookups. Nonconsuming validation choices prevent contention. Bulk operations bounded to 1000 entries.

### ✅ P-09: Archive Separation
All 14 deprecated files are cleanly isolated in `archive/daml/`. Verified zero imports from active modules to archived code.

### ✅ P-10: Virtual Shares Anti-Manipulation (V3)
V3 staking uses virtual shares (`VIRTUAL_SHARES = 1e18`) to prevent first-depositor share price manipulation — a known DeFi attack vector correctly mitigated.

---

## Test Coverage Analysis

| Module | Dedicated Tests | Integration Tests | Negative Tests | Coverage |
|---|---|---|---|---|
| CantonLending | ✅ 30 tests | ✅ 4 scenarios | ✅ 3 scenarios | **Excellent** |
| CantonLoopStrategy | ✅ ~15 tests | ✅ 1 scenario | ⚠️ Limited | **Good** |
| CantonBoostPool | ✅ ~20 tests | ✅ 1 scenario (D-M04) | ⚠️ Limited | **Good** |
| UserPrivacySettings | ✅ 24 tests | ✅ Observer propagation | ✅ Edge cases | **Excellent** |
| CantonDirectMint (standalone) | ❌ Archived | ✅ 2 scenarios | ⚠️ Limited | **Needs Attention** |
| CantonSMUSD | ⚠️ Via integration | ✅ 2 scenarios | ⚠️ Limited | **Adequate** |
| Compliance | ⚠️ Via integration | ✅ 1 scenario (D-M08) | ⚠️ Limited | **Adequate** |
| Governance | ⚠️ Via usage in other tests | ⚠️ Indirect | ❌ None | **Needs Attention** |
| InterestRateService | ❌ None | ❌ None | ❌ None | **Gap** |
| Upgrade | ⚠️ Via NegativeTests | ⚠️ Limited | ✅ 2 scenarios | **Adequate** |
| V3 | ❌ None (NegativeTests covers some) | ⚠️ Limited | ✅ 13 scenarios | **Needs Attention** |

---

## Recommendations Summary (Priority Order)

1. **[H-01]** Add compliance check to `USDCx_Transfer` — immediate fix
2. **[H-02]** Make `ConsumeProof` require executor authorization — architecture change
3. **[M-01]** Add governance requirement to `PriceFeed_EmergencyUpdate`
4. **[M-03]** Add compliance check to `SMUSD_Transfer`
5. **[M-04]** Add governance proof to `Loop_UpdateParams`
6. **[M-05]** Make compliance registry non-optional on `CantonLoopRequest`
7. **[M-08]** Add pause check to BoostPool withdrawals
8. **[M-09]** Add attestation to BoostPool price syncs
9. **[L-06]** Check frozen status in `ValidateMint`
10. **[I-01]** Restore `CantonDirectMintTest.daml` or ensure equivalent coverage

---

## Methodology

This audit reviewed all 19 active DAML files comprising ~7,500+ lines of DAML source code and ~5,500+ lines of test code. Each file was read in full. The review covered:

1. **Access Control** — Controller specifications, signatory/observer patterns, authorization chains
2. **Compliance Integration** — Blacklist/freeze enforcement consistency across all token operations
3. **Governance Enforcement** — Multi-sig requirements, ConsumeProof usage, timelock compliance
4. **Oracle/Price Feed Security** — Staleness checks, movement caps, attestation requirements
5. **Financial Logic** — Interest calculations, fee structures, liquidation mechanics, precision
6. **State Management** — Contract lifecycle, CID handling, key uniqueness, ensure clauses
7. **Cross-Module Invariants** — Supply cap coordination, escrow references, compliance propagation
8. **Emergency Controls** — Pause mechanisms, emergency updates, rollback procedures
9. **Privacy** — Observer management, privacy-by-default, data minimization
10. **Upgrade Safety** — Migration lifecycle, rollback windows, batch limits
11. **Test Coverage** — Positive/negative test scenarios, regression tests, integration coverage
12. **Archive Hygiene** — Deprecated file isolation, import verification

---

*End of Audit Report*
