# DAML / Canton Specialist Security Audit

**Protocol:** Minted mUSD — Canton Network Layer  
**Date:** 2026-02-14  
**Auditor:** DAML/Canton Specialist  
**Scope:** All `.daml` files in `/daml/` (13 production modules, ~7,800 LOC)  
**Methodology:** Manual line-by-line review of every template, choice, signatory/observer rule, and ensure clause  

---

## Files Reviewed

| # | Module | Lines | Templates | Role |
|---|--------|-------|-----------|------|
| 1 | `Minted/Protocol/V3.daml` | 1,719 | 18 | Unified bridge-integrated protocol |
| 2 | `CantonDirectMint.daml` | 845 | 11 | Canton-native minting, USDCx, redemption |
| 3 | `CantonLending.daml` | 1,565 | 9 | Multi-collateral lending, liquidation |
| 4 | `CantonLoopStrategy.daml` | 611 | 6 | Leveraged loop positions |
| 5 | `CantonBoostPool.daml` | 503 | 4 | Validator reward pool |
| 6 | `CantonSMUSD.daml` | 319 | 3 | Staked mUSD, yield vault |
| 7 | `CantonCoinToken.daml` | 73 | 2 | Canton coin token |
| 8 | `Compliance.daml` | 152 | 1 | Blacklist / freeze registry |
| 9 | `Governance.daml` | 458 | 5 | Multi-sig, timelock, minter registry |
| 10 | `InterestRateService.daml` | 213 | 2 | Utilization-based rate model |
| 11 | `AuditReceipts.daml` | 119 | 3 | Immutable mint/burn/transfer receipts |
| 12 | `Upgrade.daml` | 250 | 4 | Contract migration framework |
| 13 | `UserPrivacySettings.daml` | 160 | 1 | Privacy-by-default settings |

---

## Findings

### DAML-CRIT-01 — CRITICAL: V3 Protocol Module Lacks Compliance Registry Integration

**Severity:** CRITICAL  
**File:** `daml/Minted/Protocol/V3.daml`  
**Code Reference:** Module header (lines 1–28) — no `import Compliance` present  

**Description:**  
The entire `Minted.Protocol.V3` module (1,719 lines, 18 templates) does **not** import the `Compliance` module. This means:

- `MUSD_Transfer` (line ~215) relies only on the per-token `blacklisted` boolean — not the centralized `ComplianceRegistry`
- `CantonMint_Mint` (line ~770) performs **no** compliance check at all
- `CantonMint_Redeem` (line ~825) performs **no** compliance check
- `MUSD_BridgeToEthereum` (line ~254) has no compliance gate
- `Bridge_ReceiveFromEthereum` (line ~1160) mints mUSD with zero KYC/AML validation

Compare with the standalone `CantonDirectMintService` (in `CantonDirectMint.daml`) which calls `ValidateMint`, `ValidateRedemption`, and `ValidateTransfer` on every operation.

**Impact:**  
Any party — including OFAC-sanctioned, blacklisted, or frozen entities — can mint, transfer, redeem, and bridge mUSD through V3 templates. If V3 is the production bridge pipeline, this completely bypasses the compliance framework, exposing the protocol to regulatory enforcement action.

**Recommendation:**  
1. Import `Compliance (ComplianceRegistry, ValidateMint, ValidateRedemption, ValidateTransfer)` into V3
2. Add a `complianceRegistryCid : ContractId ComplianceRegistry` field to `CantonDirectMint` (V3), `BridgeService`, and `CantonSMUSD` (V3)
3. Gate `CantonMint_Mint` with `ValidateMint`, `CantonMint_Redeem` with `ValidateRedemption`, `MUSD_Transfer` with `ValidateTransfer`, and `Bridge_ReceiveFromEthereum` with `ValidateMint`

---

### DAML-CRIT-02 — CRITICAL: V3 VaultManager Opens Vaults Without Compliance Check

**Severity:** CRITICAL  
**File:** `daml/Minted/Protocol/V3.daml`, `OpenVault` choice (line ~707)  
**Code Reference:**  
```
choice OpenVault : ContractId Vault
  with
    owner : Party
    collateralSymbol : Text
  controller owner
```

**Description:**  
Any party can open a vault (`controller owner`) without any compliance validation. Vaults enable borrowing mUSD, so a blacklisted party can open a vault → borrow → obtain mUSD — entirely circumventing the compliance layer. The standalone `CantonLendingService` properly gates `Lending_Borrow` with `ValidateMint`, but V3's `Vault` has no equivalent.

**Impact:**  
Sanctioned entities can create leveraged debt positions and mint unbacked mUSD through the vault system.

**Recommendation:**  
Add a `complianceRegistryCid` parameter to `VaultManager` and call `ValidateMint` in `OpenVault` before creating the vault. Also gate `AdjustLeverage` with compliance check.

---

### DAML-H-01 — HIGH: Frozen Users Can Transfer sMUSD, BoostPoolLP, and CantonUSDC (Wrong Compliance Choice)

**Severity:** HIGH  
**Files:**
- `daml/CantonSMUSD.daml` — `SMUSD_Transfer` (line ~68)
- `daml/CantonBoostPool.daml` — `BPLP_Transfer` (line ~53)
- `daml/CantonDirectMint.daml` — `CantonUSDC_Transfer` (line ~75)

**Code Reference (CantonSMUSD.daml):**
```
choice SMUSD_Transfer : ContractId CantonSMUSDTransferProposal
  ...
  controller owner
  do
    exercise complianceRegistryCid ValidateMint with minter = owner
```

**Description:**  
These transfer choices call `ValidateMint` instead of `ValidateTransfer`. Per the Compliance module:
- `ValidateMint` checks **only** blacklist status (line ~105 of Compliance.daml)
- `ValidateTransfer` checks blacklist **and** freeze status of sender (line ~116)

A frozen user — whose assets are supposed to be immovable during investigation — can still initiate transfers of sMUSD, BoostPoolLP, and CantonUSDC because the freeze check is skipped.

Additionally, `CantonUSDC_Transfer` validates the **recipient** (`minter = newOwner`) but **not the sender**, so a blacklisted sender can initiate USDC transfers freely.

**Impact:**  
Asset freeze orders are ineffective for sMUSD, CantonCoin, BoostPoolLP, and CantonUSDC transfers. A frozen user under investigation can move assets to accomplice addresses.

**Recommendation:**  
Replace `ValidateMint` with `ValidateTransfer` in all transfer choices:
```daml
exercise complianceRegistryCid ValidateTransfer with
  sender = owner
  receiver = newOwner
```

---

### DAML-H-02 — HIGH: CantonBoostPool Pause/Unpause Is Operator-Only (No Governance)

**Severity:** HIGH  
**File:** `daml/CantonBoostPool.daml` — `BoostPool_SetPaused` (line ~449)  
**Code Reference:**
```
choice BoostPool_SetPaused : ContractId CantonBoostPoolService
  with newPaused : Bool
  controller operator
```

**Description:**  
The operator can unilaterally pause **and** unpause the BoostPool with no governance co-signature. Compare with:
- `Bridge_Pause` / `Bridge_Unpause` → `controller operator, governance` ✓
- `SMUSD_UpdateConfig` → `controller operator, governance` ✓
- `Staking_SetPaused` → `controller operator` (same issue, but staking is lower TVL risk)

An operator key compromise allows silently pausing the pool (DoS) or unpausing a pool that governance paused for security reasons.

**Impact:**  
Unilateral pause/unpause capability creates a single point of failure for the BoostPool, which holds user-deposited Canton coins.

**Recommendation:**  
Change to `controller operator, governance` for unpause. Pause can remain operator-only for emergency response speed, but unpause should require governance approval.

---

### DAML-H-03 — HIGH: CantonLoopStrategy Admin Choices Lack Governance Proof

**Severity:** HIGH  
**File:** `daml/CantonLoopStrategy.daml`  
**Code References:**
- `Loop_UpdateParams` (line ~308) — `controller operator`
- `Loop_WithdrawFees` (line ~325) — `controller operator`
- `Loop_SetPaused` (line ~320) — `controller operator`

**Description:**  
Three admin choices on `CantonLoopStrategyService` are operator-only with no governance proof. The operator can unilaterally:
1. Change `maxLoops` (up to 20), `maxLeverageX10` (up to 4x), `minBorrowPerLoop`
2. Drain all accumulated protocol fees
3. Pause/unpause the service

Compare with `CantonLendingService` where equivalent admin choices (`Lending_UpdateRate`, `Lending_WithdrawReserves`, etc.) all require `GovernanceActionLog` proof.

**Impact:**  
A compromised operator key can set maxLoops to 20 and maxLeverage to 4x to enable excessive risk, drain fees, or grief users by pausing.

**Recommendation:**  
Add `governanceProofCid : ContractId GovernanceActionLog` parameter and consume proof in each admin choice, matching the pattern used in CantonLending.

---

### DAML-H-04 — HIGH: CantonBoostPool Price Syncs Lack Multi-Validator Attestation

**Severity:** HIGH  
**File:** `daml/CantonBoostPool.daml`  
**Code References:**
- `SyncCantonPrice` (line ~395) — `controller operator`
- `SyncSharePrice` (line ~412) — `controller operator`

**Description:**  
Both price sync choices are operator-only with no attestation hash or validator count requirements. Compare with:
- `CantonPriceFeed.PriceFeed_Update` — requires `attestationHash` + `validatorCount >= 2` ✓
- `CantonStakingService.SyncGlobalSharePrice` — requires `attestationHash` + `validatorCount >= 3` ✓

The Canton price is used to calculate deposit caps (`maxCantonValueMusd = smusdValueMusd * cantonCapRatio`). A manipulated price directly controls how much Canton users can deposit.

**Impact:**  
Operator can manipulate `cantonPriceMusd` to artificially inflate deposit caps, allowing over-depositing into the pool beyond what sMUSD positions justify.

**Recommendation:**  
Add `attestationHash : Text` and `validatorCount : Int` parameters, with `validatorCount >= 2` assertion, matching `CantonPriceFeed.PriceFeed_Update`.

---

### DAML-H-05 — HIGH: V3 LiquidationOrder Has No Expiry or Release Mechanism

**Severity:** HIGH  
**File:** `daml/Minted/Protocol/V3.daml` — `LiquidationOrder` template (line ~743)  

**Description:**  
When a keeper calls `ClaimOrder`, the order transitions to `Claimed` status. If the keeper then fails to call `CompleteOrder` (crashed, went offline, griefing), the order remains stuck in `Claimed` state **indefinitely**. There is no:
- Expiry timeout to auto-release back to `Pending`
- Operator override to unclaim
- Competing keeper mechanism

The only escape is `CancelOrder` by the operator, but this permanently cancels rather than making it claimable again.

**Impact:**  
A malicious keeper (or one experiencing an outage) can DoS liquidations by claiming orders and never executing them, allowing bad debt to accumulate.

**Recommendation:**  
1. Add `claimedAt : Time` and `maxClaimDuration : RelTime` fields
2. Add `ReleaseExpiredClaim` choice that allows any party to release back to `Pending` after timeout
3. Or: allow `ClaimOrder` to override an expired claim

---

### DAML-M-01 — MEDIUM: Compliance IsCompliant Choice Leaks Privacy

**Severity:** MEDIUM  
**File:** `daml/Compliance.daml` — `IsCompliant` choice (line ~126)  
**Code Reference:**
```
nonconsuming choice IsCompliant : Bool
  with
    party : Party
    caller : Party
  controller caller
```

**Description:**  
Any party can query the compliance status of any other party by exercising `IsCompliant` with themselves as `caller`. This leaks whether a target party is blacklisted or frozen — information that may be confidential during an ongoing investigation.

**Impact:**  
Privacy leak: surveillance actors or front-runners can detect blacklist/freeze actions before they take effect on active contracts.

**Recommendation:**  
Restrict `controller` to `operator` or `regulator`, or require `caller` to be in a specific observer set.

---

### DAML-M-02 — MEDIUM: BurnRateLimiter.BurnLimit_UpdateLimit Lacks Governance

**Severity:** MEDIUM  
**File:** `daml/CantonDirectMint.daml` — `BurnLimit_UpdateLimit` (line ~840)  
**Code Reference:**
```
choice BurnLimit_UpdateLimit : ContractId BurnRateLimiter
  with newLimit : Money
  controller operator
```

**Description:**  
The burn rate limit can be changed by the operator alone without governance approval. The limit controls how much mUSD can be burned per 24h window — a critical parameter that prevents flash-unwind attacks on loop positions.

**Impact:**  
Operator can set `dailyBurnLimit` to an extremely high value, disabling the rate limiter, or to zero, preventing all redemptions.

**Recommendation:**  
Require `GovernanceActionLog` proof, matching the pattern used in `DirectMint_SetDailyMintLimit`.

---

### DAML-M-03 — MEDIUM: V3 PriceOracle Single-Provider Model (No Multi-Validator)

**Severity:** MEDIUM  
**File:** `daml/Minted/Protocol/V3.daml` — `PriceOracle` template (line ~430)  

**Description:**  
V3's `PriceOracle` has a single `provider` party who controls all price updates via `Oracle_UpdatePrice`. There is no multi-validator attestation requirement. Compare with `CantonPriceFeed` (in CantonLending.daml) which requires `attestationHash` and `validatorCount >= 2`.

The ±50% movement cap helps, but a compromised provider can still move prices by 50% per update.

**Impact:**  
Single point of failure for price feeds affecting vault health calculations, liquidation triggers, and leverage operations.

**Recommendation:**  
Add multi-validator attestation (attestationHash + validatorCount ≥ 2) to `Oracle_UpdatePrice`, or deprecate V3 PriceOracle in favor of the more secure `CantonPriceFeed`.

---

### DAML-M-04 — MEDIUM: V3 Bridge Status Fields Are Freeform Text

**Severity:** MEDIUM  
**File:** `daml/Minted/Protocol/V3.daml`  
**Code References:**
- `BridgeOutRequest.status : Text` (line ~1630)
- `BridgeInRequest.status : Text` (line ~1668)

Also in `daml/CantonDirectMint.daml`:
- `BridgeOutRequest.status : Text` (line ~330)

**Description:**  
Status fields use `Text` type with string comparisons (`status == "pending"`, `status == "bridged"`). A typo in any status string (e.g., `"Pending"` vs `"pending"`) would silently bypass assertions.

**Impact:**  
Latent bug risk from string typos. No compile-time safety for state transitions.

**Recommendation:**  
Define a proper enum type:
```daml
data BridgeRequestStatus = BridgePending | BridgeCompleted | BridgeFailed | BridgeCancelled
  deriving (Eq, Show)
```

---

### DAML-M-05 — MEDIUM: DirectMint_SetPaused and Lending_SetPaused Lack Governance for Unpause

**Severity:** MEDIUM  
**Files:**
- `daml/CantonDirectMint.daml` — `DirectMint_SetPaused` (line ~726)
- `daml/CantonLending.daml` — `Lending_SetPaused` (line ~1375)

**Description:**  
Both pause choices are operator-only. While operator-only pause is acceptable for emergency speed, unpause should require governance co-signature to prevent a compromised operator from unpausing a service that was paused for security reasons.

**Impact:**  
A compromised operator can reverse emergency pauses, re-enabling operations during an active security incident.

**Recommendation:**  
Split into separate `Pause` (operator-only for emergency) and `Unpause` (operator + governance) choices, matching `BridgeService.Bridge_Pause` / `Bridge_Unpause`.

---

### DAML-M-06 — MEDIUM: GovernanceConfig Has No Choice to Modify Governor List

**Severity:** MEDIUM  
**File:** `daml/Governance.daml` — `GovernanceConfig` template (line ~62)  

**Description:**  
The `GovernanceConfig` template stores `governors : [(Party, GovernorRole)]` but provides no choice to add, remove, or update governors. Any change requires archiving the entire config and creating a new one — which requires the operator signatory and would break any `lookupByKey @GovernanceConfig operator` references during the transition.

**Impact:**  
Governor rotation (e.g., replacing a compromised key) requires manual contract lifecycle management with potential for race conditions on the key.

**Recommendation:**  
Add `GovConfig_AddGovernor`, `GovConfig_RemoveGovernor`, and `GovConfig_UpdateRole` choices, each requiring elevated-threshold approval through a `GovernanceActionLog` proof.

---

### DAML-M-07 — MEDIUM: CantonLoopStrategyConfig Allows Setting ComplianceRegistry to None

**Severity:** MEDIUM  
**File:** `daml/CantonLoopStrategy.daml` — `LoopConfig_SetComplianceRegistry` (line ~435)  

**Description:**  
The choice accepts `Optional (ContractId ComplianceRegistry)` and allows setting it to `None`. When `None`, the `LoopRequest_Execute` choice skips compliance entirely:
```daml
case cfg.complianceRegistryCid of
  Some regCid -> exercise regCid ValidateMint with minter = user
  None -> pure ()
```

**Impact:**  
Governance can disable compliance checks on loop strategy positions, allowing blacklisted users to open leveraged positions.

**Recommendation:**  
Remove the `Optional` wrapper — make compliance mandatory:
```daml
complianceRegistryCid : ContractId ComplianceRegistry
```

---

### DAML-L-01 — LOW: AuditReceipts Not Integrated Into Operational Choices

**Severity:** LOW  
**File:** `daml/AuditReceipts.daml`  

**Description:**  
`MintAuditReceipt`, `BurnAuditReceipt`, and `TransferAuditReceipt` templates are defined but are not created by any operational choice in `CantonDirectMint.daml`, `CantonSMUSD.daml`, or `CantonLending.daml`. The module header says "created on every mUSD mint" but the integration is missing.

**Impact:**  
No immutable on-ledger audit trail for mints/burns/transfers. The regulatory compliance value of these receipts is unrealized.

**Recommendation:**  
Integrate `create MintAuditReceipt` into `DirectMint_Mint`, `Lending_Borrow`, `Unstake`; `create BurnAuditReceipt` into `DirectMint_Redeem`, `Lending_Repay`, `Stake`; and `create TransferAuditReceipt` into all `_Transfer` choices.

---

### DAML-L-02 — LOW: Lending_WithdrawReserves Mints mUSD Without Supply Cap Check

**Severity:** LOW  
**File:** `daml/CantonLending.daml` — `Lending_WithdrawReserves` (line ~1437)  

**Description:**  
The choice creates new `CantonMUSD` for the operator (protocol reserves) but does not increment `cantonCurrentSupply` or check against `cantonSupplyCap`. While reserves are technically already-minted mUSD that was rerouted, the minting of a new `CantonMUSD` contract introduces supply that isn't tracked.

**Impact:**  
Protocol reserve withdrawals create mUSD outside the supply tracking system, causing `cantonCurrentSupply` to undercount actual outstanding mUSD.

**Recommendation:**  
Track reserve minting in `cantonCurrentSupply` or use a separate reserve-tracking mechanism.

---

### DAML-L-03 — LOW: V3 CantonSMUSD Mints mUSD on Withdraw Without Supply Cap

**Severity:** LOW  
**File:** `daml/Minted/Protocol/V3.daml` — `SMUSD_Withdraw` (line ~980)  

**Description:**  
When a user withdraws from the V3 smUSD vault, new `MintedMUSD` is created:
```daml
musdCid <- create MintedMUSD with
  issuer = operator
  owner = user
  amount = musdAmount
```
This bypasses the `MUSDSupplyService` supply cap. Yield accrual means `musdAmount > originalDeposit`, creating net new mUSD.

The standalone `CantonStakingService` addresses this with `musdMintCap` tracking, but V3's version does not.

**Impact:**  
Unbounded mUSD minting through repeated deposit-yield-withdraw cycles if V3's smUSD is used in production.

**Recommendation:**  
Route SMUSD_Withdraw minting through `MUSDSupplyService.SupplyService_VaultMint` or add a `musdMintCap` field to the V3 CantonSMUSD template.

---

### DAML-L-04 — LOW: USDCx Withdrawal From Lending Sets Dummy CCTP Fields

**Severity:** LOW  
**File:** `daml/CantonLending.daml` — `Lending_WithdrawUSDCx` (line ~1098)  
**Code Reference:**
```daml
usdcxCid <- create USDCx with
  issuer = operator
  owner = user
  amount = withdrawAmount
  sourceChain = "canton-lending-withdrawal"
  cctpNonce = 0
```

**Description:**  
When USDCx is withdrawn from lending escrow, a new `USDCx` is created with `sourceChain = "canton-lending-withdrawal"` and `cctpNonce = 0`. These dummy values break the USDCx provenance chain — the original sourceChain and cctpNonce (linking back to the Circle CCTP attestation) are lost.

**Impact:**  
Audit trail for USDCx provenance is broken after a lending deposit-withdraw cycle. The CCTP nonce trail that connects USDCx to its original Circle attestation is permanently lost.

**Recommendation:**  
Store `sourceChain` and `cctpNonce` in `EscrowedCollateral` (or a separate metadata contract) so they can be restored on withdrawal.

---

### DAML-I-01 — INFO: Dual-Signatory Token Model Is Well-Designed

**Severity:** INFO  
**Files:** All token templates  

**Description:**  
All token templates (`CantonMUSD`, `CantonUSDC`, `USDCx`, `CantonCoin`, `CantonSMUSD`, `BoostPoolLP`) use `signatory issuer, owner` which prevents unilateral operations. Combined with the transfer-proposal pattern (sender creates proposal → receiver accepts), this is the canonical DAML pattern for safe value transfers.

---

### DAML-I-02 — INFO: Privacy-by-Default Model Is Excellent

**Severity:** INFO  
**File:** `daml/UserPrivacySettings.daml`  

**Description:**  
The `UserPrivacySettings` module provides a clean, opt-in transparency framework. Contracts are private by default (only issuer + owner see them). Users can selectively add observers (auditor, compliance officer) via a keyed lookup. All product templates call `lookupUserObservers` at creation time. This is a mature Canton privacy model.

---

### DAML-I-03 — INFO: Upgrade Framework Follows Canton Best Practices

**Severity:** INFO  
**File:** `daml/Upgrade.daml`  

**Description:**  
The upgrade module implements governance-approved proposals, user opt-in migration tickets, batch limits (100 per tx), rollback windows, and immutable migration logs. This is a production-grade contract migration framework.

---

### DAML-I-04 — INFO: Cross-Module Supply Cap Coordination Is Well-Implemented

**Severity:** INFO  
**File:** `daml/CantonLending.daml` — `Lending_Borrow` (line ~833)  

**Description:**  
The lending service performs cross-module supply coordination by looking up `CantonDirectMintService` via key and verifying `combinedSupply <= globalMintCap`. The fallback when DirectMint is not deployed now correctly enforces the global cap (previously was `pure ()`). This is a robust supply cap design.

---

## Summary Table

| ID | Severity | Title | Module |
|----|----------|-------|--------|
| DAML-CRIT-01 | **CRITICAL** | V3 Protocol lacks compliance registry integration | V3.daml |
| DAML-CRIT-02 | **CRITICAL** | V3 VaultManager opens vaults without compliance | V3.daml |
| DAML-H-01 | **HIGH** | Frozen users can transfer (wrong compliance choice) | CantonSMUSD, BoostPool, DirectMint |
| DAML-H-02 | **HIGH** | BoostPool pause/unpause is operator-only | CantonBoostPool.daml |
| DAML-H-03 | **HIGH** | LoopStrategy admin choices lack governance proof | CantonLoopStrategy.daml |
| DAML-H-04 | **HIGH** | BoostPool price syncs lack multi-validator attestation | CantonBoostPool.daml |
| DAML-H-05 | **HIGH** | V3 LiquidationOrder has no expiry/release mechanism | V3.daml |
| DAML-M-01 | **MEDIUM** | Compliance IsCompliant leaks privacy to any caller | Compliance.daml |
| DAML-M-02 | **MEDIUM** | BurnRateLimiter update lacks governance | CantonDirectMint.daml |
| DAML-M-03 | **MEDIUM** | V3 PriceOracle single-provider model | V3.daml |
| DAML-M-04 | **MEDIUM** | Bridge status fields are freeform Text | V3.daml, CantonDirectMint.daml |
| DAML-M-05 | **MEDIUM** | Pause/unpause asymmetry (no governance on unpause) | CantonDirectMint, CantonLending |
| DAML-M-06 | **MEDIUM** | GovernanceConfig has no governor modification choice | Governance.daml |
| DAML-M-07 | **MEDIUM** | LoopStrategyConfig allows Optional None compliance | CantonLoopStrategy.daml |
| DAML-L-01 | **LOW** | AuditReceipts not integrated into operational choices | AuditReceipts.daml |
| DAML-L-02 | **LOW** | Reserve withdrawal mints outside supply tracking | CantonLending.daml |
| DAML-L-03 | **LOW** | V3 smUSD withdraw mints without supply cap | V3.daml |
| DAML-L-04 | **LOW** | USDCx provenance lost on lending withdrawal | CantonLending.daml |
| DAML-I-01 | **INFO** | Dual-signatory token model is well-designed | All tokens |
| DAML-I-02 | **INFO** | Privacy-by-default model is excellent | UserPrivacySettings.daml |
| DAML-I-03 | **INFO** | Upgrade framework follows best practices | Upgrade.daml |
| DAML-I-04 | **INFO** | Cross-module supply cap coordination is robust | CantonLending.daml |

---

## Overall DAML/Canton Maturity Score: 7.5 / 10

### Strengths (Driving Score Up)
- **Signatory hygiene:** All token templates use proper `signatory issuer, owner` with transfer-proposal patterns. No forced signatory obligations anywhere.
- **Compliance module design:** The `ComplianceRegistry` with `Set`-based O(log n) lookups and nonconsuming validate choices is well-architected.
- **Standalone modules are hardened:** `CantonDirectMint`, `CantonLending`, and `CantonSMUSD` have comprehensive compliance gating, governance proofs, supply caps, rate limits, and oracle bounds.
- **Governance framework:** Multi-sig proposals with configurable thresholds, time-locked execution, scoped governance proofs (targetModule), and proof consumption preventing replay.
- **Canton-specific patterns:** Virtual shares (ERC-4626 defense), per-asset staleness, privacy-by-default, and collateral aggregate tracking demonstrate deep Canton expertise.
- **Upgrade framework:** User opt-in, batch limits, rollback windows — production-grade.

### Weaknesses (Driving Score Down)
- **V3 module is a compliance gap:** The bridge-integrated protocol module has zero compliance integration — this is the most significant single finding.
- **Inconsistent governance requirements:** Some admin choices require governance proofs while equivalent choices in other modules don't.
- **Frozen-user asset movement:** Using `ValidateMint` instead of `ValidateTransfer` in transfer choices creates a freeze bypass.
- **AuditReceipts unused:** Templates exist but are never created, negating their compliance value.
- **V3 vs standalone divergence:** Having two parallel implementations (V3 bridge-integrated + standalone Canton-native) creates surface area for inconsistency.

### Remediation Priority
1. **Immediate (pre-launch):** DAML-CRIT-01, DAML-CRIT-02 — V3 compliance integration
2. **P1 (within 1 week):** DAML-H-01, DAML-H-03 — freeze bypass and governance gaps
3. **P2 (within 2 weeks):** DAML-H-02, DAML-H-04, DAML-H-05 — operational security
4. **P3 (before mainnet):** All MEDIUM findings
5. **Backlog:** LOW and INFO findings

---

*Audit performed by DAML/Canton Specialist — 2026-02-14*
