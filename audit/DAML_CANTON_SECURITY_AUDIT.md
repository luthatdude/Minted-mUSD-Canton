# DAML/Canton Layer Security Audit

**Protocol**: Minted mUSD — Canton DAML Templates  
**Audit Date**: 2026-02-13  
**Scope**: All `.daml` files in `/daml/` (22 files, ~7,500 LOC)  
**Auditor**: Minted Security Team — DAML/Canton  
**SDK Version**: 2.10.3  

---

## Overall Score: **8.1 / 10** — DAML/Canton Layer Security

The Canton DAML layer demonstrates a mature, defense-in-depth design with consistent dual-signatory patterns, mandatory compliance hooks, and comprehensive supply tracking. The codebase shows evidence of multiple audit rounds with well-documented fixes. Key residual risks center on operator centralization, precision edge cases in interest calculations, and two deprecated modules that remain in the source tree.

---

## Executive Summary

| Category | Rating | Notes |
|---|---|---|
| Authorization Model | ★★★★☆ | Strong dual-signatory, proposal patterns; operator centralization risk |
| Privacy & Divulgence | ★★★★★ | Private-by-default, opt-in `UserPrivacySettings`, clean observer lists |
| Compliance Enforcement | ★★★★☆ | Consistent across 5 core modules; one config bypass path |
| Supply Tracking | ★★★★☆ | Tracked in DirectMint, Lending, Liquidation; V3 Vault gap |
| Price Feed Security | ★★★★☆ | Movement caps, staleness, attestation; emergency bypass risk |
| Escrow Model | ★★★★★ | Actual token consumption, no double-spend vectors found |
| Upgrade Safety | ★★★★★ | Opt-in migration, rollback windows, batch limits, audit logs |
| Interest Accrual | ★★★☆☆ | Correct formula; precision loss on short durations |
| Deprecated Templates | ★★☆☆☆ | Two deprecated modules (`BLEProtocol`, `MUSD_Protocol`) still compiled |
| Key Management | ★★★★☆ | Governance multi-sig, but single-operator price feeds |

---

## Findings

### CRITICAL

#### DAML-C-01: Deprecated BLEProtocol.daml Still Compiled — Forgeable Validator Signatures
- **Severity**: CRITICAL
- **File**: [BLEProtocol.daml](../daml/BLEProtocol.daml#L1)
- **Lines**: 1–5 (header), 142–150 (`ValidatorSignature` template)
- **Description**: `BLEProtocol.daml` is explicitly marked `DEPRECATED — DO NOT USE IN PRODUCTION` with a C-3 CRITICAL warning in its header noting that `ValidatorSignature` has `signatory aggregator` instead of `signatory validator`. This means a compromised aggregator can forge validator signatures and bypass BFT validation. Despite the deprecation notice, this module is still compiled as part of the `daml.yaml` build (no `exclude` directive). Any party with ledger access could instantiate these vulnerable templates.
- **Impact**: An attacker exploiting a compromised aggregator could forge bridge attestation signatures, bypassing validator consensus and authorizing unauthorized cross-chain transfers.
- **Recommendation**: 
  1. Move `BLEProtocol.daml` to `archive/` or add a `daml.yaml` exclude directive.
  2. If it must remain for reference, gate template creation behind a permanently-false `ensure` clause (e.g., `ensure False`).

#### DAML-C-02: Deprecated MUSD_Protocol.daml Still Compiled — No Compliance, No Supply Cap Coordination
- **Severity**: CRITICAL
- **File**: [MUSD_Protocol.daml](../daml/MUSD_Protocol.daml#L1)
- **Lines**: 1–3 (deprecation header), 119–158 (`MintingService`)
- **Description**: `MUSD_Protocol.daml` is marked deprecated but still compiled. Its `MintingService.Mint_Musd` and `StakingService.Unstake` have no `ComplianceRegistry` check, no daily rate limits, no cross-module supply cap coordination, and use `Decimal` precision instead of `Numeric 18`. A blacklisted user could mint through this path if the templates are deployed.
- **Impact**: Complete bypass of compliance (blacklist/freeze), potential supply inflation via uncoordinated minting, and precision mismatch with the canonical `CantonDirectMint` pipeline.
- **Recommendation**: Remove from compilation or add `ensure False` to all templates. The module header already says "should NOT be deployed."

---

### HIGH

#### DAML-H-01: PriceFeed_EmergencyUpdate Bypasses Attestation Requirement
- **Severity**: HIGH
- **File**: [CantonLending.daml](../daml/CantonLending.daml#L145-L158)
- **Lines**: 145–158
- **Description**: `PriceFeed_EmergencyUpdate` bypasses the `attestationHash` and `validatorCount >= 2` requirements enforced by `PriceFeed_Update`. It only requires the operator's signature and a text `reason`. While the 5-minute cooldown and positive-price checks are present, a compromised operator could set arbitrary prices during emergencies without any validator consensus.
- **Impact**: A compromised operator could manipulate prices to trigger mass liquidations or enable under-collateralized borrowing.
- **Recommendation**: Require at least 1 validator attestation for emergency updates, or add a governance co-signature requirement (matching the `SyncGlobalSharePrice` pattern which requires `operator, governance`).

#### DAML-H-02: CantonLoopStrategyConfig Has Optional Compliance Registry
- **Severity**: HIGH
- **File**: [CantonLoopStrategy.daml](../daml/CantonLoopStrategy.daml#L298-L305)
- **Lines**: 298–305 (`complianceRegistryCid : Optional (ContractId ComplianceRegistry)`)
- **Description**: `CantonLoopStrategyConfig.complianceRegistryCid` is `Optional`. When `None`, the `LoopRequest_Execute` and `UnwindRequest_Execute` choices skip compliance checks entirely (`case None -> pure ()`). While the `CantonLoopStrategyService` has a mandatory registry, the `CantonLoopRequest` path uses the config's optional registry.
- **Impact**: If a `CantonLoopStrategyConfig` is deployed with `complianceRegistryCid = None`, blacklisted users could open and unwind loop positions through the `CantonLoopRequest` / `UnwindRequest` path.
- **Recommendation**: Make `complianceRegistryCid` non-optional in `CantonLoopStrategyConfig`, or add an `ensure isSome complianceRegistryCid` clause. The `LoopConfig_SetComplianceRegistry` choice already allows setting it to `None` — this should be guarded.

#### DAML-H-03: Lending Deposit Choices Are Nonconsuming But Archive User Tokens
- **Severity**: HIGH (Informational — by design, but with contention risk)
- **File**: [CantonLending.daml](../daml/CantonLending.daml#L558-L570)
- **Lines**: 558 (`nonconsuming choice Lending_DepositCTN`), 610, 660, 720
- **Description**: `Lending_DepositCTN`, `Lending_DepositUSDC`, `Lending_DepositUSDCx`, and `Lending_DepositSMUSD` are marked `nonconsuming` but call `archive coinCid` / `archive usdcCid` etc. within the choice body. This is functionally correct — the service contract is not consumed, but the token contracts are. However, a malicious user could attempt to exercise the same deposit choice with the same token CID from two concurrent transactions. The first will succeed and archive the token; the second will fail because the archived token CID no longer exists. This is safe by DAML's ledger model, but the `return (self, escrowCid)` returns a potentially stale `self` if another deposit has since modified the service.
- **Impact**: No double-spend risk (DAML prevents it), but the stale `self` return value could confuse application-layer code that uses it for subsequent operations.
- **Recommendation**: Document that callers should re-query the service CID after exercising deposit choices. Consider returning `None` or a fresh lookup instead of `self`.

#### DAML-H-04: SyncYield (Legacy) Lacks Attestation and Epoch-Increase Cap
- **Severity**: HIGH
- **File**: [CantonSMUSD.daml](../daml/CantonSMUSD.daml#L192-L206)
- **Lines**: 192–206
- **Description**: `CantonStakingService.SyncYield` is a legacy choice that requires `controller operator, governance` but does NOT enforce `attestationHash`, `validatorCount >= 3`, or the ±10% share price movement cap that `SyncGlobalSharePrice` enforces. It recalculates `newSharePrice` and directly updates `globalSharePrice`. A colluding operator + governance party could use this path to bypass validator attestation and inject arbitrary yield.
- **Impact**: Share price manipulation via the legacy `SyncYield` path, affecting all sMUSD holders.
- **Recommendation**: Either remove `SyncYield` entirely (it's marked "deprecated" in comment), or add the same guards as `SyncGlobalSharePrice` (attestation hash, validator count, ±10% cap).

#### DAML-H-05: V3 Vault Supply Tracking Not Coordinated with CantonDirectMint
- **Severity**: HIGH
- **File**: [Minted/Protocol/V3.daml](../daml/Minted/Protocol/V3.daml#L213-L230)
- **Lines**: 213–230 (`MUSDSupplyService.SupplyService_VaultMint`)
- **Description**: `MUSDSupplyService` in V3.daml tracks its own `currentSupply` independently. It does not coordinate with `CantonDirectMintService.currentSupply` or `CantonLendingService.cantonCurrentSupply`. The CantonLending module does cross-check via `lookupByKey @CantonDirectMintService`, but V3's `MUSDSupplyService` has no such coordination.
- **Impact**: If both V3 `MUSDSupplyService` and `CantonDirectMintService` are deployed simultaneously, combined minting could exceed the intended global cap.
- **Recommendation**: Either retire V3's `MUSDSupplyService` (since `CantonDirectMintService` and `CantonLendingService` now handle supply), or add cross-module supply checks matching the `CantonLendingService.Lending_Borrow` pattern.

---

### MEDIUM

#### DAML-M-01: Interest Calculation Precision Loss on Short Durations
- **Severity**: MEDIUM
- **File**: [CantonLending.daml](../daml/CantonLending.daml#L257-L262)
- **Lines**: 257–262 (`Debt_GetTotalDebt`), 271–280 (`Debt_AccrueInterest`)
- **Description**: Interest is calculated as:
  ```
  elapsed = convertRelTimeToMicroseconds(now - lastAccrualTime)
  secondsElapsed = intToNumeric (elapsed / 1000000)  -- Integer division!
  newInterest = principal * rateBps * secondsElapsed / (10000 * 31536000)
  ```
  The `elapsed / 1000000` is integer division, truncating sub-second precision. For very short durations (< 1 second), `secondsElapsed = 0` and no interest accrues. On Canton where transactions can execute within the same microsecond batch, repeated borrow-repay within the same second could avoid all interest accrual.
- **Impact**: Users could exploit sub-second accrual to avoid interest on flash-borrow-repay patterns. The monetary impact depends on transaction timing precision.
- **Recommendation**: Use microsecond-precision arithmetic throughout:
  ```
  let microYearSeconds = 31536000000000.0
  let newInterest = principal * rateBps * intToNumeric elapsed / (10000 * microYearSeconds)
  ```

#### DAML-M-02: ReserveTracker Requires Dual Signatory (operator, governance) for All Operations
- **Severity**: MEDIUM
- **File**: [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L337-L340)
- **Lines**: 337–340 (`signatory operator, governance`), 345–380 (all choices use `controller operator, governance`)
- **Description**: `ReserveTracker` is a dual-signatory contract where ALL choices (`Reserve_RecordDeposit`, `Reserve_RecordRedemption`, `Reserve_RecordBridgeOut`, `Reserve_RecordBridgeIn`) require both `operator` and `governance`. However, `CantonDirectMintService.DirectMint_Mint` and `DirectMint_Redeem` don't exercise the `ReserveTracker` — they only update `currentSupply` locally. The ReserveTracker appears to be an audit artifact that is never exercised from the main flow.
- **Impact**: Reserve tracking (for audit reconciliation between Canton deposits and Ethereum backing) is not automatically maintained. A manual reconciliation process would be needed.
- **Recommendation**: Either integrate `ReserveTracker` into the DirectMint flow (exercise `Reserve_RecordDeposit` during `DirectMint_Mint`), or document it as an off-chain audit reconciliation tool.

#### DAML-M-03: CantonBoostPool sMUSD Fetch + Archive + Recreate Pattern
- **Severity**: MEDIUM
- **File**: [CantonBoostPool.daml](../daml/CantonBoostPool.daml#L188-L205)
- **Lines**: 188–205 (Deposit choice: `archive smusdCid` then `create CantonSMUSD`)
- **Description**: During `CantonBoostPoolService.Deposit`, the user's sMUSD is archived and immediately recreated with a new contract ID (`_newSmusdCid`). This changes the sMUSD's contract ID, which could break any other pending operations that reference the old CID (e.g., a pending `SMUSD_Transfer` proposal or a `Lending_DepositSMUSD` operation).
- **Impact**: Race condition where a user's sMUSD CID changes unexpectedly, causing pending transfers or lending deposits to fail. No fund loss, but poor UX.
- **Recommendation**: Document this behavior. Consider using a nonconsuming verification pattern that only reads the sMUSD (via `fetch`) without archiving/recreating it.

#### DAML-M-04: BridgeIn_Sign Lacks Self-Attestation (Unlike BridgeOut_Sign)
- **Severity**: MEDIUM
- **File**: [BLEBridgeProtocol.daml](../daml/BLEBridgeProtocol.daml#L271-L297)
- **Lines**: 271–297
- **Description**: `BridgeOut_Sign` requires a `ValidatorSelfAttestation` CID (C-01 fix) to prove independent validator participation, preventing operator impersonation. However, `BridgeIn_Sign` does NOT require self-attestation. A compromised aggregator cannot forge `BridgeOut_Sign` (because `ValidatorSelfAttestation.signatory = validator`), but could potentially manipulate `BridgeIn_Sign` if validator keys are compromised at the participant level.
- **Impact**: Asymmetric security between bridge-out (strong: self-attestation) and bridge-in (weaker: no self-attestation). Bridge-in is lower risk (minting USDC on Canton, not sending to Ethereum), but the inconsistency weakens defense-in-depth.
- **Recommendation**: Add `ValidatorSelfAttestation` requirement to `BridgeIn_Sign` for consistency.

#### DAML-M-05: Lending_Liquidate Does Not Check Compliance on Liquidator
- **Severity**: MEDIUM
- **File**: [CantonLending.daml](../daml/CantonLending.daml#L1099-L1100)
- **Lines**: 1099 (beginning of `Lending_Liquidate`)
- **Description**: `Lending_Borrow` checks `ValidateMint` on the borrower, `Lending_Repay` is intentionally unblocked, but `Lending_Liquidate` performs no compliance check on the `liquidator` party. A blacklisted entity could act as a liquidator, receiving seized collateral.
- **Impact**: Blacklisted entities could acquire assets through the liquidation path.
- **Recommendation**: Add `exercise complianceRegistryCid ValidateMint with minter = liquidator` at the start of `Lending_Liquidate`.

#### DAML-M-06: USDCx_Transfer Has No Compliance Check (Unlike CantonUSDC_Transfer)
- **Severity**: MEDIUM
- **File**: [CantonDirectMint.daml](../daml/CantonDirectMint.daml#L119-L125)
- **Lines**: 119–125 (`USDCx_Transfer`)
- **Description**: `CantonUSDC_Transfer` includes a `ComplianceRegistry` parameter and calls `ValidateMint` on the recipient (`DAML-M-05` fix). However, `USDCx_Transfer` has no compliance check — any party can receive USDCx via transfer.
- **Impact**: Blacklisted parties could receive USDCx through transfers. USDCx is directly usable as lending collateral and for minting mUSD.
- **Recommendation**: Add a `complianceRegistryCid` parameter to `USDCx_Transfer` and check the recipient, mirroring `CantonUSDC_Transfer`.

#### DAML-M-07: Lending_WithdrawSMUSD Sets entrySharePrice = 1.0 (Placeholder)
- **Severity**: MEDIUM
- **File**: [CantonLending.daml](../daml/CantonLending.daml#L1039-L1043)
- **Lines**: 1039–1043
- **Description**: When `Lending_WithdrawSMUSD` recreates a `CantonSMUSD` token after withdrawal, it sets `entrySharePrice = 1.0` with a comment "Placeholder; real share price is tracked by CantonStakingService." This means the sMUSD returned from lending has an incorrect `entrySharePrice`, which could affect yield tracking or display logic.
- **Impact**: Cosmetic/informational — the actual yield calculation uses `globalSharePrice` from `CantonStakingService`, not `entrySharePrice`. But audit trail and user-facing displays would show incorrect entry price.
- **Recommendation**: Fetch the current `globalSharePrice` from `CantonStakingService` (via `lookupByKey`) and use it as `entrySharePrice`.

---

### LOW

#### DAML-L-01: Compliance IsCompliant Choice Allows Any Caller
- **Severity**: LOW
- **File**: [Compliance.daml](../daml/Compliance.daml#L93-L99)
- **Lines**: 93–99
- **Description**: `ComplianceRegistry.IsCompliant` uses `controller caller` where `caller` is an arbitrary party. Any party on the ledger can check compliance status of any other party. While this is read-only and doesn't leak the actual blacklist set (only returns a boolean), it could be used for reconnaissance.
- **Impact**: Information disclosure — any party can probe whether a specific party is blacklisted/frozen.
- **Recommendation**: Restrict `caller` to `operator` or observers. Low priority since the boolean response doesn't reveal the full list.

#### DAML-L-02: TokenInterface.daml Is Empty/Stub
- **Severity**: LOW
- **File**: [TokenInterface.daml](../daml/TokenInterface.daml)
- **Lines**: 1–10
- **Description**: `TokenInterface.daml` contains only a module declaration, a `Daml.Script` import, and comments. It's marked deprecated but still compiled. It poses no security risk but adds confusion.
- **Impact**: None (no templates defined).
- **Recommendation**: Remove or move to `archive/`.

#### DAML-L-03: InstitutionalAssetV4.daml Asset_EmergencyTransfer Is Issuer-Only
- **Severity**: LOW
- **File**: [InstitutionalAssetV4.daml](../daml/InstitutionalAssetV4.daml#L112-L128)
- **Lines**: 112–128
- **Description**: `Asset_EmergencyTransfer` allows the issuer to unilaterally transfer the asset to a new owner without the current owner's consent. While this is by design (regulatory/court-order seizure), the `Asset` template has dual signatory (`issuer, owner`), meaning the issuer can exercise this consuming choice because they are a signatory. No governance or multi-sig is required.
- **Impact**: Issuer has unilateral power to seize assets. Appropriate for regulated instruments but should be clearly documented.
- **Recommendation**: Already mitigated by compliance check (`EnsureAuthorized`) and reason requirement. Consider adding a governance proof requirement for additional safeguarding.

#### DAML-L-04: CantonCoin_Burn Requires Dual Signatory (issuer, owner) But BoostPool Burns Via archive
- **Severity**: LOW
- **File**: [CantonBoostPool.daml](../daml/CantonBoostPool.daml#L196)
- **Lines**: 196 (`exercise cantonCid CantonCoin_Burn`)
- **Description**: `CantonCoin_Burn` has `controller issuer, owner`. In the BoostPool deposit flow, the user is the controller of the `Deposit` choice, and the CantonCoin's `issuer == operator`. Since `Deposit` is `controller user`, the authorization context includes `user` (as controller) and `operator` (as signatory of the service). This satisfies `controller issuer, owner` because `operator == issuer` and `user == owner`. This is correct but non-obvious.
- **Impact**: None — authorization is satisfied. But the implicit authorization chain is worth documenting.
- **Recommendation**: Add a comment explaining the authorization flow for auditability.

#### DAML-L-05: BulkBlacklist Cap Increased to 1000 Without Rate Limiting
- **Severity**: LOW
- **File**: [Compliance.daml](../daml/Compliance.daml#L106-L115)
- **Lines**: 106–115
- **Description**: `BulkBlacklist` was increased from 100 to 1000 entries per call (per fix D-L-04). The `Set.insert` fold over 1000 entries is O(n log n) which is acceptable, but there's no rate limiting on how frequently `BulkBlacklist` can be called. A regulator could call it repeatedly to flood the blacklist.
- **Impact**: Low — the regulator is a trusted party. But in a compromised-regulator scenario, mass blacklisting could freeze the entire protocol.
- **Recommendation**: Consider adding a cooldown or maximum blacklist size.

---

### INFORMATIONAL

#### DAML-I-01: Consistent Use of Proposal Pattern Across All Token Templates
- **Severity**: INFORMATIONAL (POSITIVE)
- **Files**: `CantonDirectMint.daml`, `CantonSMUSD.daml`, `CantonCoinToken.daml`, `CantonBoostPool.daml`, `MintedMUSD.daml`, `InstitutionalAssetV4.daml`
- **Description**: All token templates consistently use the proposal pattern for transfers (`_Transfer` → `_TransferProposal` → `_Accept` / `_Reject` / `_Cancel`). This prevents forced signatory obligations on unwitting recipients, which is a common DAML anti-pattern.

#### DAML-I-02: Governance Action Logs Are One-Time Use via ConsumeProof
- **Severity**: INFORMATIONAL (POSITIVE)
- **File**: [Governance.daml](../daml/Governance.daml#L252-L257)
- **Description**: `GovernanceActionLog.ConsumeProof` archives the log entry after use, preventing replay of governance proofs across modules. The `targetModule` field scopes each proof to a specific module (e.g., "CantonLending", "CantonDirectMint"), preventing cross-module replay.

#### DAML-I-03: Upgrade Framework Is Well-Designed
- **Severity**: INFORMATIONAL (POSITIVE)
- **File**: [Upgrade.daml](../daml/Upgrade.daml)
- **Description**: The upgrade framework features: (1) opt-in migration (users must consent), (2) batch size limits (max 100 per tx), (3) rollback windows, (4) immutable `UpgradeMigrationLog`, (5) governance threshold for activation. This is a model implementation for Canton contract upgrades.

---

## Audit Area Deep Dives

### 1. Authorization Model

**Strengths:**
- All token templates use dual-signatory (`issuer, owner`), preventing unilateral actions
- Transfer proposal pattern universally applied — no forced obligations
- Governance uses M-of-N multi-sig with timelocks
- `ConsumeProof` prevents governance proof replay
- `GovernanceActionLog.signatory = operator` only (fix D-H-01) enables archive from operator-controlled choices
- `DAML-CRIT-01` fixes add `caller == owner` assertions to escrow choices

**Weaknesses:**
- `CantonPriceFeed`, `LendingCollateralAggregate`, `BoostPoolDepositRecord` are single-signatory (`operator` only) — operator has unilateral control
- `PriceFeed_EmergencyUpdate` bypasses multi-validator attestation
- `EscrowedCollateral.Escrow_Seize` is `controller operator` with no borrower notification or consent

### 2. Privacy & Divulgence

**Assessment: Excellent**
- Private-by-default design via `UserPrivacySettings`
- `lookupUserObservers` returns `[]` if no settings exist (fully private)
- `CantonLiquidationReceipt` correctly makes both borrower and liquidator observers
- No unintended observer lists found
- `BridgeOutPayload.sender` as a field (not observer) avoids divulgence to validators

### 3. Compliance Enforcement

| Module | Compliance Enforced | Notes |
|---|---|---|
| `CantonDirectMint` | ✅ `ValidateMint` on mint, `ValidateRedemption` on redeem, `ValidateTransfer` on mUSD transfer | Complete |
| `CantonLending` | ✅ `ValidateMint` on borrow | Missing on liquidator (DAML-M-05) |
| `CantonBoostPool` | ✅ `ValidateMint` on deposit, `ValidateRedemption` on withdraw | Complete |
| `CantonSMUSD` | ✅ `ValidateMint` on stake, `ValidateRedemption` on unstake | Complete |
| `CantonLoopStrategy` | ⚠️ Mandatory via `CantonLoopStrategyService`, Optional via `CantonLoopRequest` | See DAML-H-02 |
| `BLEBridgeProtocol` | ✅ `BridgeOut_Sign` checks sender blacklist/freeze | Complete |

### 4. Supply Tracking

| Path | `cantonCurrentSupply` Updated | Notes |
|---|---|---|
| DirectMint_Mint | ✅ `+netAmount` | Correct |
| DirectMint_Redeem | ✅ `-musd.amount` | Correct |
| Lending_Borrow | ✅ `+borrowAmount` | Correct |
| Lending_Repay | ✅ `-repayFromSupply` | Correct (capped at `cantonCurrentSupply`) |
| Lending_Liquidate | ✅ `-repayFromSupply` (fix C-01) | Fixed — previously missing |
| V3 SupplyService_VaultMint | ⚠️ Own `currentSupply` — no cross-module | See DAML-H-05 |
| CantonStakingService.Unstake | ❌ Not tracked | Unstake creates CantonMUSD but no supply service is updated |

**Note on Unstake**: `CantonStakingService.Unstake` creates a new `CantonMUSD` without incrementing any supply tracker. This is arguably correct because the mUSD was "burned" on stake (supply decremented) and "re-minted" on unstake (should be incremented). However, there's no explicit supply increment on unstake — this relies on the original minting having been tracked. If the staked mUSD was originally minted via `Lending_Borrow`, the supply decrement on stake and missing increment on unstake creates an asymmetry.

### 5. Price Feed Security

- ✅ `PriceFeed_Update`: Positive price, ±50% movement cap, 10s cooldown, attestation + 2 validators
- ✅ `PriceFeed_GetPrice`: Per-asset staleness from `CollateralConfig.maxStalenessSecs`
- ✅ `PriceFeed_GetPriceUnsafe`: Staleness bypass for liquidations (correct — liquidations must proceed)
- ⚠️ `PriceFeed_EmergencyUpdate`: 5-min cooldown, positive price, but NO attestation, NO movement cap (see DAML-H-01)
- ✅ V3 `Oracle_UpdatePrice`: ±50% movement cap
- ✅ `CantonBoostPoolService.SyncCantonPrice`: ±20% cap per update

### 6. Escrow Model

**Assessment: Robust — No double-spend vectors found.**
- Deposit: Token is `archive`d (consumed), then `EscrowedCollateral` created with the amount
- Withdrawal: `Escrow_WithdrawPartial` / `Escrow_WithdrawAll` are consuming choices, then a new token is created
- Liquidation: `Escrow_Seize` is consuming (returns `None` for full seizure, `Some newEscrow` for partial)
- Cross-module check: BoostPool checks `lookupByKey @EscrowedCollateral (operator, user, CTN_SMUSD)` to prevent sMUSD double-use (fix D-M04)
- Dedup check: All collateral computation functions assert `length (dedup escrowCids) == length escrowCids` (fix DAML-M-01)

### 7. Upgrade Safety

**Assessment: Excellent.**
- `UpgradeProposal` → `UpgradeRegistry` → `MigrationTicket` → `UpgradeMigrationLog` lifecycle
- User must create `MigrationTicket` (opt-in, `signatory operator, holder`)
- Batch limit: 100 contracts per migration tx (DoS prevention)
- Rollback window with `UpgradeRegistry_EmergencyRollback`
- `UpgradeMigrationLog` has no choices — immutable permanent audit record
- Governance threshold for activation, activation delay for review period

### 8. Interest Accrual

- Formula: `interest = principal * rateBps * secondsElapsed / (10000 * 31536000)`
- Correct annual rate conversion with basis points
- ⚠️ Integer division on microsecond→second conversion truncates sub-second precision (DAML-M-01)
- ✅ Accrual happens before borrow (prevents stale debt reads)
- ✅ Repay applies to interest first, then principal (waterfall model)
- ✅ `Debt_UpdateRate` bounds: 0 ≤ rateBps ≤ 10000

### 9. Deprecated Templates

| File | Status | Risk |
|---|---|---|
| `BLEProtocol.daml` | DEPRECATED (header) | **CRITICAL** — still compiled, forgeable signatures |
| `MUSD_Protocol.daml` | DEPRECATED (header) | **CRITICAL** — still compiled, no compliance |
| `TokenInterface.daml` | DEPRECATED (header) | LOW — empty module, no templates |
| `MintedMUSD.daml` | ACTIVE (V1 module) | OK — used for legacy support, has dual-signatory |
| `CantonSMUSD.SyncYield` | DEPRECATED (comment) | HIGH — still callable, weaker guards |

### 10. Key Management

- **Operator Key**: Single party controlling price feeds, escrow operations, service administration. This is the highest-risk key — compromise gives control over prices and collateral.
- **Governance Key**: Co-signer for supply cap changes, yield sync, rate params. Multi-sig via `GovernanceConfig` + `MultiSigProposal`.
- **Regulator Key**: Controls `ComplianceRegistry` (blacklist/freeze). Fully separate from operator.
- **Validator Keys**: Used for bridge attestations. BFT 67% threshold (fix D-H01). Self-attestation (fix C-01) prevents operator impersonation for bridge-out.
- **Guardian Keys**: Emergency pause with multi-guardian threshold (fix DAML-M-02).

**Gap**: No key rotation mechanism exists in DAML templates. If an operator key is compromised, there is no on-ledger way to rotate it without migrating all contracts. This is inherent to DAML's signatory model — parties are fixed at contract creation.

---

## Summary of Findings

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 2 | DAML-C-01, DAML-C-02 |
| HIGH | 5 | DAML-H-01 through DAML-H-05 |
| MEDIUM | 7 | DAML-M-01 through DAML-M-07 |
| LOW | 5 | DAML-L-01 through DAML-L-05 |
| INFORMATIONAL | 3 | DAML-I-01 through DAML-I-03 (positive findings) |

---

## Recommendations Priority

1. **Immediate**: Remove `BLEProtocol.daml` and `MUSD_Protocol.daml` from compilation (DAML-C-01, DAML-C-02)
2. **High Priority**: Add attestation requirement to `PriceFeed_EmergencyUpdate` (DAML-H-01)
3. **High Priority**: Make compliance non-optional in `CantonLoopStrategyConfig` (DAML-H-02)
4. **High Priority**: Remove or harden `SyncYield` legacy choice (DAML-H-04)
5. **Medium Priority**: Fix interest precision to microsecond-level (DAML-M-01)
6. **Medium Priority**: Add compliance check on liquidator (DAML-M-05)
7. **Medium Priority**: Add compliance to `USDCx_Transfer` (DAML-M-06)
