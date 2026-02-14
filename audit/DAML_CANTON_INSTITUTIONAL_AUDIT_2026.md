# Minted mUSD — DAML/Canton Layer Institutional Security Audit

**Date:** February 14, 2026  
**Auditor:** Elite DAML/Canton Security Audit — Automated Deep Analysis  
**Scope:** All DAML modules under `/daml/` (standalone Canton-native + V3 bridge-integrated)  
**SDK Version:** 2.10.3  
**Commit:** HEAD at time of audit  

---

## Executive Summary

The Minted mUSD Canton layer comprises **~7,500 lines of DAML** across 28 files covering direct minting, staked mUSD (smUSD), multi-collateral lending, loop leverage strategies, a boost pool, compliance, governance, interest rate services, upgrade migration, user privacy, and a V3 bridge-integrated module. The codebase shows evidence of significant prior remediation (tagged `FIX D-M-xx`, `DAML-H-xx`, `DAML-C-xx`, etc.), indicating previous audit cycles.

This audit identified **2 High**, **7 Medium**, **6 Low**, and **6 Informational** findings. No **Critical** severity issues were found — prior remediation has addressed the most dangerous vectors. The remaining findings center on **compliance bypass on transfer proposals**, **missing governance gates on sensitive operator actions**, and **significant test coverage gaps**.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 7 |
| LOW | 6 |
| INFORMATIONAL | 6 |

---

## Findings

---

### HIGH-01: smUSD and BoostPool LP Transfers Bypass Compliance Entirely

**Severity:** HIGH  
**Files:** [CantonSMUSD.daml](../daml/CantonSMUSD.daml#L63-L68), [CantonBoostPool.daml](../daml/CantonBoostPool.daml#L58-L60)  
**Templates/Choices:** `CantonSMUSD.SMUSD_Transfer`, `CantonSMUSDTransferProposal_Accept`, `BoostPoolLP.BPLP_Transfer`, `BPLPTransferProposal_Accept`

**Description:**  
The `SMUSD_Transfer` choice creates a transfer proposal without any compliance check — no `ValidateTransfer`, no `ComplianceRegistry` parameter. The corresponding `CantonSMUSDTransferProposal_Accept` also performs no check. Contrast this with `CantonMUSD_Transfer` (which calls `ValidateTransfer` with sender/receiver) and `CantonCoin_Transfer` / `USDCx_Transfer` (both compliance-gated). The same gap exists for `BoostPoolLP.BPLP_Transfer`.

**Attack Scenario:**  
1. Regulator blacklists party `Mallory` via `ComplianceRegistry.BlacklistUser`.
2. Mallory holds 10,000 smUSD shares (worth $10,500 at current share price).
3. Mallory calls `SMUSD_Transfer` to a fresh address — no compliance check fires.
4. The fresh address unstakes via `CantonStakingService.Unstake`, receiving mUSD.
5. Mallory has exfiltrated value despite being blacklisted.

The same attack applies to BoostPool LP tokens — blacklisted users can transfer LP shares and have a confederate withdraw the underlying Canton.

**Impact:** Blacklisted/sanctioned entities can freely move yield-bearing smUSD positions and BoostPool LP tokens, completely bypassing OFAC/sanctions controls. This is a regulatory compliance failure.

**Recommended Fix:**  
Add `complianceRegistryCid` parameter and `ValidateTransfer` call to both `SMUSD_Transfer` and `BPLP_Transfer`, mirroring the pattern established in `CantonMUSD_Transfer` and `CantonCoin_Transfer`:

```haskell
choice SMUSD_Transfer : ContractId CantonSMUSDTransferProposal
  with
    newOwner : Party
    complianceRegistryCid : ContractId ComplianceRegistry  -- ADD
  controller owner
  do
    exercise complianceRegistryCid ValidateTransfer with    -- ADD
      sender = owner                                        -- ADD
      receiver = newOwner                                   -- ADD
    create CantonSMUSDTransferProposal with
      smusd = this
      newOwner
```

Apply the same pattern to `BPLP_Transfer`.

---

### HIGH-02: CantonUSDC Transfer Checks Receiver Only — Frozen/Blacklisted Sender Can Transfer

**Severity:** HIGH  
**File:** [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L62-L68)  
**Template/Choice:** `CantonUSDC.CantonUSDC_Transfer`

**Description:**  
The `CantonUSDC_Transfer` choice calls `ValidateMint with minter = newOwner`, which only checks whether the **receiver** is blacklisted. It does **not** check whether the **sender** (owner) is blacklisted or frozen. Compare with the correctly implemented patterns:

- `CantonMUSD_Transfer` → calls `ValidateTransfer` (checks both sender and receiver, plus frozen)
- `CantonCoin_Transfer` → calls `ValidateTransfer` (checks both)
- `USDCx_Transfer` → calls `ValidateTransfer` (checks both)
- `CantonUSDC_Transfer` → calls `ValidateMint` (checks **receiver only**)

**Attack Scenario:**  
1. Regulator freezes user `Mallory` via `ComplianceRegistry.FreezeUser`.
2. Mallory holds 50,000 CantonUSDC.
3. Mallory calls `CantonUSDC_Transfer` with a confederate as `newOwner` — only the confederate is checked against the blacklist.
4. Mallory's frozen status is never checked. The USDC transfer proposal is created and accepted.
5. Mallory has exfiltrated frozen assets.

**Impact:** Frozen users can transfer CantonUSDC freely. Blacklisted senders can also transfer, since only the receiver is validated. This breaks the compliance invariant that frozen assets are immobilized.

**Recommended Fix:**  
Change `ValidateMint` to `ValidateTransfer` to match the pattern used by all other token types:

```haskell
choice CantonUSDC_Transfer : ContractId CantonUSDCTransferProposal
  with
    newOwner : Party
    complianceRegistryCid : ContractId ComplianceRegistry
  controller owner
  do
    exercise complianceRegistryCid ValidateTransfer with  -- CHANGE
      sender = owner                                       -- ADD
      receiver = newOwner                                  -- CHANGE
    create CantonUSDCTransferProposal with
      usdc = this
      newOwner
```

---

### MED-01: CantonMUSD and CantonCoin Transfer Proposals Lack Compliance Re-validation at Acceptance

**Severity:** MEDIUM  
**Files:** [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L300-L303), [CantonCoinToken.daml](../daml/CantonCoinToken.daml#L56-L58)  
**Templates:** `CantonMUSDTransferProposal.CantonMUSDTransferProposal_Accept`, `CantonCoinTransferProposal.CantonCoinTransferProposal_Accept`

**Description:**  
Both `CantonMUSD_Transfer` and `CantonCoin_Transfer` perform compliance validation at **initiation** (when the proposal is created). However, the corresponding `_Accept` choices do **not** re-validate. Compare with the correctly implemented `USDCxTransferProposal_Accept`, which takes a `complianceRegistryCid` parameter and calls `ValidateTransfer` at acceptance time.

This creates a time-of-check-time-of-use (TOCTOU) window: a party that passes compliance at proposal creation could be blacklisted before the proposal is accepted, and the transfer would still succeed.

**Attack Scenario:**  
1. Alice creates a transfer proposal for 100,000 mUSD to Bob (passes compliance).
2. Before Bob accepts, the regulator blacklists Bob.
3. Bob accepts the proposal — no compliance re-check — and receives the mUSD.

**Impact:** Compliance enforcement has a race window proportional to how long transfer proposals remain open. In practice this window is likely short, but for institutional compliance it should be zero.

**Recommended Fix:**  
Add `complianceRegistryCid` parameter and re-validation to `CantonMUSDTransferProposal_Accept` and `CantonCoinTransferProposal_Accept`, matching the `USDCxTransferProposal_Accept` pattern.

---

### MED-02: BurnRateLimiter Limit Update Lacks Governance Gate

**Severity:** MEDIUM  
**File:** [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L826-L831)  
**Template/Choice:** `BurnRateLimiter.BurnLimit_UpdateLimit`

**Description:**  
The `BurnLimit_UpdateLimit` choice is controlled by `operator` alone with no governance proof requirement. Compare with `DirectMint_SetDailyMintLimit` which requires a `GovernanceActionLog` proof. The burn rate limiter is a security-critical control that prevents flash-unwind attacks on loop positions.

**Attack Scenario:**  
A compromised operator key sets `dailyBurnLimit` to an arbitrarily high value, then executes a flash-unwind attack on loop positions within a single 24-hour window.

**Impact:** Operator can unilaterally bypass the burn rate limit, which was specifically designed as a security control against flash-unwind attacks (per the FIX C-DAML-02 comment).

**Recommended Fix:**  
Add `governanceProofCid` parameter and validate against `ParameterUpdate` action type, matching the pattern used by `DirectMint_SetDailyMintLimit`.

---

### MED-03: Operator-Only Pause/Unpause on Critical Services Lacks Governance Co-Signature

**Severity:** MEDIUM  
**Files:** [CantonSMUSD.daml](../daml/CantonSMUSD.daml#L302-L306), [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L603-L607), [CantonLending.daml](../daml/CantonLending.daml#L1389-L1393), [CantonLoopStrategy.daml](../daml/CantonLoopStrategy.daml#L335-L338)  
**Choices:** `Staking_SetPaused`, `DirectMint_SetPaused`, `Lending_SetPaused`, `Loop_SetPaused`

**Description:**  
All four critical service pause/unpause operations are controlled by `operator` alone without governance co-signature. While pause operations should be fast (emergency response), the **unpause** operation should require governance approval to prevent a compromised operator from silently resuming a paused service during an active security incident.

This is asymmetric with `EmergencyPauseState` in Governance.daml which correctly requires multi-guardian approval for pause and governance proof for resume.

**Impact:** Compromised operator can resume paused services during active incident response without governance oversight.

**Recommended Fix:**  
Keep pause as operator-only (for emergency speed). Add governance proof requirement to unpause:

```haskell
choice DirectMint_SetPaused : ContractId CantonDirectMintService
  with
    newPaused : Bool
    governanceProofCid : Optional (ContractId GovernanceActionLog) -- Required for unpause
  controller operator
  do
    when (not newPaused) do -- Unpause requires governance
      case governanceProofCid of
        None -> abort "GOVERNANCE_REQUIRED_FOR_UNPAUSE"
        Some proofCid -> do
          proof <- exercise proofCid ConsumeProof with consumedBy = operator
          assertMsg "WRONG_ACTION_TYPE" (proof.actionType == EmergencyPause)
    create this with paused = newPaused
```

---

### MED-04: Loop Strategy Fee Withdrawal Lacks Governance Gate

**Severity:** MEDIUM  
**File:** [CantonLoopStrategy.daml](../daml/CantonLoopStrategy.daml#L340-L344)  
**Template/Choice:** `CantonLoopStrategyService.Loop_WithdrawFees`

**Description:**  
The `Loop_WithdrawFees` choice is controlled by `operator` alone without governance proof. Compare with `DirectMint_WithdrawFees` and `Lending_WithdrawReserves` which both require `GovernanceActionLog` proofs with `TreasuryWithdrawal` action type. This inconsistency means the loop strategy's protocol fees (from entry/exit fees) can be extracted without governance oversight.

**Impact:** Operator can unilaterally extract all accrued protocol fees from the loop strategy without governance approval, unlike equivalent choices in DirectMint and Lending.

**Recommended Fix:**  
Add `governanceProofCid` parameter matching the pattern in `DirectMint_WithdrawFees`.

---

### MED-05: BoostPool Price Sync Operations Lack Governance Co-Signature

**Severity:** MEDIUM  
**File:** [CantonBoostPool.daml](../daml/CantonBoostPool.daml#L370-L395)  
**Choices:** `CantonBoostPoolService.SyncCantonPrice`, `CantonBoostPoolService.SyncSharePrice`

**Description:**  
Both price sync choices are controlled by `operator` alone. While they have per-update movement caps (±20% for Canton price, ±10% min for share price), the operator can chain multiple updates across consecutive transactions to achieve arbitrary price changes. Compare with `CantonStakingService.SyncGlobalSharePrice` which correctly requires `controller operator, governance`.

**Attack Scenario:**  
1. Operator calls `SyncCantonPrice` with +20% (0.172 → 0.206).
2. Operator immediately calls again with +20% (0.206 → 0.247).
3. After 5 chained calls: price moves from 0.172 to 0.428 (+149%).
4. This inflated price increases the deposit cap, allowing excess deposits.

**Impact:** Operator can manipulate deposit caps via chained price updates, potentially enabling over-collateralization attacks or extraction of excess yield.

**Recommended Fix:**  
Add governance co-signature (`controller operator, governance`) or add a minimum cooldown between price updates matching `PriceFeed_Update`'s 10-second floor.

---

### MED-06: BoostPool Reward Distribution Lacks Governance Co-Signature

**Severity:** MEDIUM  
**File:** [CantonBoostPool.daml](../daml/CantonBoostPool.daml#L349-L365)  
**Choice:** `CantonBoostPoolService.DistributeRewards`

**Description:**  
The `DistributeRewards` choice allows the operator to inject arbitrary reward amounts into the pool with only an epoch sequential check and a cap of 100 epoch gaps. Unlike `SyncGlobalSharePrice` (which requires `controller operator, governance` plus attestation), reward distribution has no governance co-signature or attestation requirement.

**Attack Scenario:**  
Operator injects inflated rewards (e.g., 1,000,000 Canton instead of the actual 1,000 earned) → 60% goes to LPs (artificially inflating LP share value) → operator withdraws the 40% protocol share as pure profit.

**Impact:** Operator can inflate LP share values and extract protocol fees from fabricated rewards.

**Recommended Fix:**  
Require governance co-signature and/or attestation hash from validators, matching `SyncGlobalSharePrice` pattern.

---

### MED-07: V3 MintedMUSD Transfer Uses Local Blacklist Flag Instead of ComplianceRegistry

**Severity:** MEDIUM  
**File:** [Minted/Protocol/V3.daml](../daml/Minted/Protocol/V3.daml#L244-L255)  
**Template/Choice:** `MintedMUSD.MUSD_Transfer`

**Description:**  
The V3 `MUSD_Transfer` checks only the token-local `blacklisted` boolean field rather than consulting a `ComplianceRegistry`. This means if a party is added to the compliance blacklist **after** their mUSD tokens were created, transfers still succeed because the token-level `blacklisted` flag was set at creation time and never updated.

The standalone `CantonMUSD_Transfer` (in CantonDirectMint.daml) correctly consults the live `ComplianceRegistry` via `ValidateTransfer`, making this a V3-specific regression.

**Impact:** Post-creation blacklisting is ineffective for V3 mUSD tokens unless the issuer proactively calls `MUSD_SetBlacklist` on every token held by the blacklisted party — an operationally burdensome and error-prone process.

**Recommended Fix:**  
Add `ComplianceRegistry` parameter to `MUSD_Transfer` and validate against the live registry, or implement an event-driven mechanism to propagate blacklist changes to all tokens.

---

### LOW-01: AuditReceipt Templates Not Integrated Into Operational Flows

**Severity:** LOW  
**File:** [AuditReceipts.daml](../daml/AuditReceipts.daml)  
**Templates:** `MintAuditReceipt`, `BurnAuditReceipt`, `TransferAuditReceipt`

**Description:**  
The `AuditReceipts` module defines three immutable receipt templates for regulatory compliance. However, none of the operational choices (`DirectMint_Mint`, `DirectMint_Redeem`, `Stake`, `Unstake`, `Lending_Borrow`, `Lending_Repay`, etc.) actually create these receipts inline. The templates exist as definitions but are never instantiated in the core protocol flow.

**Impact:** No on-ledger audit trail is produced for mints, burns, or transfers. Regulatory evidence (MiCA, SEC) and reconciliation data between Canton and Ethereum is not being generated.

**Recommended Fix:**  
Integrate `MintAuditReceipt` creation into `DirectMint_Mint`, `DirectMint_MintWithUSDCx`, `Unstake`, and `Lending_Borrow`. Integrate `BurnAuditReceipt` into `DirectMint_Redeem`, `Stake`, and `Lending_Repay`. Integrate `TransferAuditReceipt` into transfer acceptance choices.

---

### LOW-02: Six Test Files Are Empty — Significant Coverage Gap

**Severity:** LOW  
**Files:** `CantonDirectMintTest.daml`, `ComplianceExtendedTest.daml`, `GovernanceExtendedTest.daml`, `InterestRateServiceTest.daml`, `UpgradeTest.daml`, `V3ProtocolExtendedTest.daml`

**Description:**  
Six test files exist as placeholders but contain no test logic. This leaves the following modules without dedicated test coverage:

- **CantonDirectMintTest.daml** — No tests for the core minting/redemption service (rate limiting, USDCx path, supply cap coordination).
- **ComplianceExtendedTest.daml** — No extended compliance edge-case tests (bulk blacklist, concurrent freeze/unfreeze, cross-module compliance integration).
- **GovernanceExtendedTest.daml** — No extended governance tests (timelock manipulation, proposal expiry, quorum edge cases).
- **InterestRateServiceTest.daml** — No tests for the kinked-curve interest rate model.
- **UpgradeTest.daml** — No tests for the migration framework (rollback, batch limits, closed windows).
- **V3ProtocolExtendedTest.daml** — No extended tests for V3 bridge-integrated flow.

**Impact:** Critical protocol paths lack automated regression coverage. Changes to these modules risk silent regressions.

**Recommended Fix:**  
Populate all empty test files with positive and negative test cases covering the documented edge cases in each module.

---

### LOW-03: InterestRateService Utilization Truncation Bias

**Severity:** LOW  
**File:** [InterestRateService.daml](../daml/InterestRateService.daml#L87-L90)  
**Choice:** `InterestRateService.RateService_GetUtilization`

**Description:**  
The utilization calculation uses `truncate util` which always rounds **down**. For a protocol earning interest, this systematically underestimates utilization and therefore undercharges borrowers. At 79.9% utilization, the model reports 79% (below the 80% kink), using the lower pre-kink slope. The borrower pays the lower rate despite being just below the regime boundary.

**Impact:** Minor systematic undercharging of borrowers near the kink point. Economically negligible for most positions but technically incorrect.

**Recommended Fix:**  
Use `round` instead of `truncate` for unbiased rounding, or compute rates using `Decimal` precision throughout to avoid integer truncation entirely.

---

### LOW-04: CantonStakingService musdMintCap Has No Governance Update Choice

**Severity:** LOW  
**File:** [CantonSMUSD.daml](../daml/CantonSMUSD.daml#L126-L127)  
**Template:** `CantonStakingService`

**Description:**  
The `musdMintCap` and `currentUnstakeMinted` fields on `CantonStakingService` track the maximum mUSD that can be minted through unstake operations. There is no choice to update `musdMintCap` after deployment. If the cap is reached, all unstake operations are permanently blocked unless a new `CantonStakingService` is deployed with a higher cap.

Additionally, there is no choice to reset `currentUnstakeMinted` when the minted mUSD is subsequently burned (e.g., when users re-stake). This means the cap is monotonically consumed and never freed.

**Impact:** The unstake cap is a one-way ratchet that will eventually brick all unstake operations. The service must be redeployed to restore functionality.

**Recommended Fix:**  
Add governance-gated choices to update `musdMintCap` and to decrement `currentUnstakeMinted` when mUSD is burned through staking.

---

### LOW-05: CantonLoopPosition LoopPosition_RecordLoop Operator-Only Control

**Severity:** LOW  
**File:** [CantonLoopStrategy.daml](../daml/CantonLoopStrategy.daml#L112-L137)  
**Choice:** `CantonLoopPosition.LoopPosition_RecordLoop`

**Description:**  
`LoopPosition_RecordLoop` is controlled by `operator` only and records arbitrary `musdMinted`, `musdStaked`, `musdBorrowed`, and `newLeverage` values into the user's position. While the operator needs the user's authority from the contract signatory for the create, the operator fully controls what values are recorded. A health factor check is performed, but it uses the operator-supplied values.

**Impact:** A compromised operator could record inflated staking values or deflated debt values, manipulating a user's apparent position. The user has no on-chain way to verify the recorded values match actual operations.

**Recommended Fix:**  
Consider adding on-chain verification of the recorded values against actual contract IDs, or require dual-controller (`operator, user`) for `RecordLoop` to give users explicit consent to each loop iteration's accounting.

---

### LOW-06: V3 BridgeOutRequest Missing Validators and Attestation Fields

**Severity:** LOW  
**File:** [Minted/Protocol/V3.daml](../daml/Minted/Protocol/V3.daml#L1597-L1641)  
**Template:** `BridgeOutRequest` (V3 variant)

**Description:**  
The V3 `BridgeOutRequest` lacks the `validators : [Party]` field present in the standalone `CantonDirectMint.BridgeOutRequest`. This means V3 bridge-out requests have no multi-party attestation model — only the operator can complete them. The standalone version adds validators as observers for multi-party visibility.

**Impact:** V3 bridge-out operations lack the same level of multi-party oversight as the standalone module.

**Recommended Fix:**  
Add `validators : [Party]` field and observer clause to V3's `BridgeOutRequest` template, matching the standalone variant.

---

### INFO-01: Multiple Module Versions Create Maintenance Burden

**Severity:** INFORMATIONAL  
**Files:** Standalone modules (`CantonDirectMint.daml`, `CantonSMUSD.daml`) vs V3 (`Minted/Protocol/V3.daml`)

**Description:**  
The codebase maintains two parallel implementations: standalone Canton-native modules (authoritative) and V3 bridge-integrated modules. Template names overlap (e.g., `CantonUSDC`, `BridgeOutRequest`, `CantonSMUSD`) with different field sets and security properties. Changes to one version may not be propagated to the other. For example, V3's `MintedMUSD` uses token-local blacklist (MED-07), while standalone `CantonMUSD` uses live registry lookup.

**Recommendation:** Document which version is authoritative for each feature. Consider deprecating the non-authoritative version or auto-generating one from the other.

---

### INFO-02: Numeric 18 Precision May Cause Rounding in Extreme Cases

**Severity:** INFORMATIONAL  
**File:** All modules using `type Money = Numeric 18`

**Description:**  
18-decimal fixed-point arithmetic can accumulate rounding errors in multi-step calculations (e.g., loop leverage with 5+ iterations, share price computation across millions of shares). The `Numeric 18` type has 38 total digits, but intermediate products of two `Numeric 18` values can exceed this range.

**Recommendation:** Add property-based tests with extreme values (near max `Numeric 18`) to verify no overflow or precision loss in critical paths like `calculateLeverage`, `computeWeightedCollateralValue`, and share price calculations.

---

### INFO-03: ComplianceRegistry Nonconsuming Validation Choices Use Operator-Only Controller

**Severity:** INFORMATIONAL  
**File:** [Compliance.daml](../daml/Compliance.daml#L94-L122)  
**Choices:** `ValidateMint`, `ValidateTransfer`, `ValidateRedemption`

**Description:**  
All three validation choices use `controller operator` — meaning only the protocol operator can exercise them. This is correct for cross-template composition (service templates exercise these on behalf of users), but it means that if a module incorrectly passes a non-operator party as the exercising party, the validation silently fails at the authorization level rather than at the compliance level.

The comment "FIX CRITICAL: Changed controller to operator only" confirms this was a deliberate change for cross-template compatibility. The tradeoff is that direct user-initiated compliance checks are impossible.

**Recommendation:** No change needed, but document this design constraint for future module authors.

---

### INFO-04: No Formal Verification or Property-Based Testing

**Severity:** INFORMATIONAL

**Description:**  
The test suite uses example-based Daml Script tests. There are no property-based tests (e.g., using `daml-quickcheck` or similar) and no formal verification (e.g., Certora for the DAML layer). Critical invariants like "total mUSD supply ≤ supply cap across all modules" and "total collateral value ≥ total debt at all times" are tested by example but not proven.

**Recommendation:** Consider adding property-based tests for economic invariants and cross-module supply cap coordination.

---

### INFO-05: SDK Version 2.10.3 — Verify Against Known Vulnerabilities

**Severity:** INFORMATIONAL  
**File:** [daml.yaml](../daml/daml.yaml)

**Description:**  
The project uses Daml SDK 2.10.3. Verify this version does not have known security vulnerabilities. Pin the exact SDK version in CI/CD to prevent silent upgrades.

---

### INFO-06: GovernanceActionLog signatory change (D-H-01) has downstream implications

**Severity:** INFORMATIONAL  
**File:** [Governance.daml](../daml/Governance.daml#L340-L361)  
**Template:** `GovernanceActionLog`

**Description:**  
Fix D-H-01 changed `GovernanceActionLog` signatory from `(operator, executedBy)` to `operator` only, with `executedBy` as observer. This was necessary to allow operator-controlled archive in `ConsumeProof`. However, it means any party who knows a `GovernanceActionLog` contract ID can no longer be certain the `executedBy` field hasn't been fabricated, since the executor is now only an observer, not a signatory.

The `ConsumeProof` choice does validate `consumedBy == operator || consumedBy == executedBy`, providing some guardrail.

**Recommendation:** Document this trust assumption. Consider whether `executedBy` should be verified via an external attestation if non-repudiation of governance execution is required for regulatory purposes.

---

## Summary of Compliance Validation Coverage

| Token Type | Transfer Initiation | Transfer Acceptance | Notes |
|---|---|---|---|
| `CantonMUSD` | ✅ `ValidateTransfer` | ❌ No re-check | **MED-01** |
| `CantonUSDC` | ⚠️ `ValidateMint` (receiver only) | ❌ No re-check | **HIGH-02** |
| `USDCx` | ✅ `ValidateTransfer` | ✅ `ValidateTransfer` | ✅ Fully compliant |
| `CantonCoin` | ✅ `ValidateTransfer` | ❌ No re-check | **MED-01** |
| `CantonSMUSD` | ❌ No check | ❌ No check | **HIGH-01** |
| `BoostPoolLP` | ❌ No check | ❌ No check | **HIGH-01** |
| V3 `MintedMUSD` | ⚠️ Local `blacklisted` flag only | N/A (no registry) | **MED-07** |

---

## Governance Gate Coverage

| Operation | Governance Required? | Notes |
|---|---|---|
| `DirectMint_UpdateSupplyCap` | ✅ Yes | |
| `DirectMint_SetDailyMintLimit` | ✅ Yes | |
| `DirectMint_WithdrawFees` | ✅ Yes | |
| `DirectMint_SetPaused` | ❌ Operator only | **MED-03** |
| `BurnLimit_UpdateLimit` | ❌ Operator only | **MED-02** |
| `Staking_SetPaused` | ❌ Operator only | **MED-03** |
| `SyncGlobalSharePrice` | ✅ Yes (dual controller) | |
| `Lending_UpdateConfig` | ✅ Yes | |
| `Lending_SetPaused` | ❌ Operator only | **MED-03** |
| `Lending_WithdrawReserves` | ✅ Yes | |
| `Loop_WithdrawFees` | ❌ Operator only | **MED-04** |
| `Loop_SetPaused` | ❌ Operator only | **MED-03** |
| `BoostPool_UpdateFees` | ✅ Yes | |
| `SyncCantonPrice` | ❌ Operator only | **MED-05** |
| `SyncSharePrice` | ❌ Operator only | **MED-05** |
| `DistributeRewards` | ❌ Operator only | **MED-06** |

---

## Positive Security Observations

The following security properties were verified as correctly implemented:

1. **Supply cap coordination** — `Lending_Borrow` correctly queries `CantonDirectMintService` via `lookupByKey` and enforces `globalMintCap` across both modules (FIX DAML-H-02, DAML-H-05).
2. **Share price bounding** — `SyncGlobalSharePrice` caps increases/decreases at ±10% per epoch with 3+ validator attestations (FIX D-M-02, D-M-05, D-M09).
3. **Cooldown enforcement** — `Unstake` correctly enforces cooldown via `stakedAt` + `cooldownSeconds` (FIX D-M01).
4. **Dual-signatory transfer proposals** — All token types use the accept/reject proposal pattern, preventing forced signatory obligations.
5. **Escrow collateral isolation** — BoostPool correctly checks `lookupByKey @EscrowedCollateral` to prevent sMUSD double-use across lending and boost (FIX D-M04).
6. **Governance proof replay prevention** — `ConsumeProof` archives `GovernanceActionLog` after use (FIX C-DAML-01).
7. **Multi-module supply cap** — DAML-H-05 correctly enforces `globalMintCap` even when `CantonDirectMintService` is not deployed.
8. **Liquidation uses unsafe price** — `Lending_Liquidate` correctly uses `PriceFeed_GetPriceUnsafe` to prevent stale prices from blocking liquidations.
9. **Debt canonical CID verification** — `Lending_Liquidate` verifies the provided `debtCid` matches `lookupByKey` to prevent stale debt CID attacks (FIX DAML-M-06).
10. **Oracle price movement caps** — `PriceFeed_Update` caps at ±50%, `PriceFeed_EmergencyUpdate` requires governance proof with 30-minute cooldown (FIX X-M-02, DAML-M-06).

---

*End of audit report.*
