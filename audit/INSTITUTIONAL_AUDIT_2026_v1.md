# INSTITUTIONAL-GRADE SECURITY AUDIT REPORT
## Minted mUSD Canton Protocol — Full Re-Audit
### February 13, 2026

**Auditors**: Minted Security Team (Coordinated Review)  
**Methodology**: Trail of Bits / Spearbit / Consensys Diligence hybrid framework  
**Scope**: Every source file across all layers (~160+ files)  
**Languages**: Solidity 0.8.26, DAML, TypeScript, YAML/K8s  

---

## EXECUTIVE SUMMARY

| Metric | Value |
|--------|-------|
| **Files Audited** | 160+ across 7 layers |
| **Total Findings** | 78 |
| **Critical** | 3 (2 Resolved, 1 Retracted, 0 Open) |
| **High** | 13 |
| **Medium** | 27 |
| **Low** | 25 |
| **Informational** | 10 |
| **Gas Optimizations** | 17 |
| **Composite Score** | **8.0 / 10.0** |
| **Verdict** | **INSTITUTIONAL GRADE — Upper Tier** |

---

## SCORING BREAKDOWN

| # | Category (Weight) | Score | Reviewer | Key Observations |
|---|---|---|---|---|
| 1 | **Smart Contract Security** (25%) | 8.2 / 10 | solidity-auditor | Strong RBAC, CEI compliance, ReentrancyGuard throughout. PendleStrategyV2 upgrade auth and unlimited approval are the only HIGH findings. No criticals in Solidity. |
| 2 | **Cross-Chain Bridge Security** (15%) | 8.5 / 10 | solidity-auditor | Multi-layered replay protection exceeds industry standard. Attestation entropy + state hash + nonce + timestamp bounds + rate limiting. |
| 3 | **DAML/Canton Layer** (10%) | 8.7 / 10 | daml-auditor | Dual-signatory token model, proposal-based transfers, BFT 67% bridge attestation. ~~Deprecated templates~~ archived (CRIT-01 RESOLVED). Optional compliance in LoopStrategy (HIGH). |
| 4 | **TypeScript Services** (10%) | 7.5 / 10 | typescript-reviewer | TLS enforcement, secret sanitization, KMS key management. dotenv in yield-api breaks secret model (HIGH). parseFloat precision loss in financial calcs (HIGH). |
| 5 | **Infrastructure & DevOps** (10%) | 8.5 / 10 | infra-reviewer | Pod Security Standards `restricted`, default-deny NetworkPolicies, ESO integration, SHA-pinned Actions, 9 security scanners in CI. ~~Placeholder Canton image digests~~ pinned to verified Docker Hub SHA-256 (CRIT-03 RESOLVED). |
| 6 | **Operational Security** (10%) | 7.8 / 10 | infra-reviewer | Health endpoints, Prometheus alerting, graceful shutdown. ServiceMonitor label mismatch means metrics not scraped. |
| 7 | **Test Coverage** (10%) | 7.5 / 10 | Testing | 1,769 Hardhat tests, 91 Certora rules, 35 Foundry fuzz tests, 245 DAML scenarios. 10/21 contracts lack formal verification. Zero frontend tests. |
| 8 | **Gas Efficiency** (10%) | 6.5 / 10 | gas-optimizer | Immutables correct, calldata used, short-circuit in loops. But string requires everywhere (~139 total), uncached storage reads, missing unchecked on bounded loops. ~80-120k gas saveable per borrow/repay cycle. |

### Weighted Composite Score

$$\text{Score} = (8.2 \times 0.25) + (8.5 \times 0.15) + (8.7 \times 0.10) + (7.5 \times 0.10) + (8.5 \times 0.10) + (7.8 \times 0.10) + (7.5 \times 0.10) + (6.5 \times 0.10)$$
$$= 2.05 + 1.275 + 0.87 + 0.75 + 0.85 + 0.78 + 0.75 + 0.65 = \mathbf{7.98 \approx 8.0/10}$$

---

## CRITICAL FINDINGS (3)

### CRIT-01: Deprecated DAML Templates Still Compilable — Signature Forgery Vector
- **Reviewer**: DAML/Canton
- **File**: `daml/BLEBridgeProtocol.daml` (deprecated V1/V2)
- **Status**: ✅ **RESOLVED** (commit `64ed868`)
- **Description**: Deprecated bridge templates were still compiled and deployable. The V1 `ValidatorSignature` template uses `signatory aggregator` instead of the validator party, meaning a compromised aggregator could forge validator signatures. V2 templates bypass compliance checks entirely and lack rate limits or cross-module supply coordination.
- **Impact**: If a deprecated template was accidentally instantiated (or deliberately by a compromised operator), it bypassed all V3 security controls — compliance, rate limits, and proper signature authorization.
- **Remediation Applied**: Archived 6 deprecated DAML files to `archive/daml/` (outside the `daml/` source directory). Files archived: `BLEProtocol.daml`, `BLEBridgeProtocol.daml`, `MintedMUSD.daml`, `MUSD_Protocol.daml`, `TokenInterface.daml`, `InstitutionalAssetV4.daml`. Verified zero active modules import any archived file. `daml.yaml` (`source: .`) only compiles files within `daml/`, so archived files are excluded from compilation. Added `archive/daml/DEPRECATED.md` documenting why each file was archived.

### ~~CRIT-02: Deprecated CantonDirectMint Bypasses All Compliance~~ — RETRACTED (False Positive)
- **Reviewer**: DAML/Canton
- **File**: `daml/CantonDirectMint.daml`
- **Status**: ❌ **RETRACTED** — False positive identified during remediation
- **Verification**: `CantonDirectMint.daml` is the **active production module**, imported by 9 other modules (CantonLending, CantonSMUSD, CantonLoopStrategy, CantonBoostPool, CantonCoinToken, and 4 test files). It contains **12 compliance references** (`ComplianceRegistry`, `ValidateMint`, `ValidateRedemption`, `ValidateTransfer`), mandatory compliance enforcement, rate limiting via `BurnRateLimiter`, and cross-module supply coordination via `CantonDirectMintService`.
- **Root Cause of False Positive**: The review confused the standalone `CantonDirectMint.daml` (active, with full compliance) with the V3-embedded `CantonDirectMint` template inside `Minted/Protocol/V3.daml`. Both are production code; neither is deprecated.
- **Finding Count Adjustment**: Total criticals reduced from 3 to 2 (1 resolved, 1 retracted, 1 open).

### CRIT-03: Placeholder Container Image Digests in Canton K8s Deployments
- **Reviewer**: Infrastructure
- **File**: `k8s/canton/participant-deployment.yaml`
- **Status**: ✅ **RESOLVED**
- **Description**: Canton/DAML deployment manifests used placeholder image digests (`sha256:MUST_REPLACE_WITH_REAL_DIGEST`) instead of real SHA-256 hashes. In a cluster that enforces image digest verification (standard for institutional deployments), these pods would fail to start.
- **Impact**: Canton layer completely non-functional in production K8s clusters with image verification policies. Could also mask supply-chain attacks if digests are not verified.
- **Remediation Applied**:
  1. **Canton participant**: `digitalasset/canton-open-source` tag `2.9.3` does not exist on Docker Hub (latest available is `2.7.9`). Replaced with `digitalasset/daml-sdk:2.9.3` which includes the Canton runtime (bundled since SDK 2.8+). Pinned to verified digest `sha256:8c2a681e348025d69d76932b1f6e7ddac4830355a7d3f8fa8774bb87e8150cc3` (linux/amd64, pushed 2024-07-22).
  2. **JSON API sidecar**: Pinned `digitalasset/daml-sdk:2.9.3` to the same verified digest.
  3. **CI guardrail**: Added `Reject placeholder image digests (CRIT-03)` step to `k8s-validate` CI job. Scans all K8s YAML for `MUST_REPLACE`, `sha256:placeholder`, and sequential hex patterns. Blocks merge on violation.
  4. **Config checksum**: Replaced static `PLACEHOLDER_REPLACE_AT_DEPLOY` annotation with deploy-time injection pattern.
  5. **Version note**: `daml.yaml` uses `sdk-version: 2.10.3` but Docker Hub latest `daml-sdk` is `2.10.2`. Image tags should be aligned when `2.10.3` is published.

---

## HIGH FINDINGS (13)

### SOL-H-01: PendleStrategyV2 Grants Unlimited Router Approval
- **Reviewer**: Solidity
- **File**: `contracts/strategies/PendleStrategyV2.sol`
- **Description**: `type(uint256).max` approval granted to Pendle Router. SkySUSDSStrategy already uses per-operation approvals (remediated in prior audit), but PendleStrategyV2 was missed.
- **Impact**: If Pendle Router is compromised or upgraded maliciously, all strategy funds are drainable in a single transaction.
- **Recommendation**: Use per-operation `forceApprove(amount)` + `forceApprove(0)` pattern matching SkySUSDSStrategy.

### SOL-H-02: PendleStrategyV2 _authorizeUpgrade Bypasses Timelock
- **Reviewer**: Solidity
- **File**: `contracts/strategies/PendleStrategyV2.sol`
- **Description**: `_authorizeUpgrade` requires `DEFAULT_ADMIN_ROLE` instead of `TIMELOCK_ROLE`, allowing immediate upgrades without the 48h governance delay enforced on other upgradeable contracts.
- **Impact**: Compromised admin can upgrade strategy implementation instantly, bypassing governance safeguards.
- **Recommendation**: Change to `onlyRole(TIMELOCK_ROLE)` with `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)`.

### DAML-H-01: PriceFeed_EmergencyUpdate Bypasses Attestation Requirements
- **Reviewer**: DAML/Canton
- **File**: `daml/CantonLending.daml:174-188`
- **Description**: `PriceFeed_EmergencyUpdate` bypasses the ±50% price movement cap of `PriceFeed_Update`. Only a positive-price check and 5-minute cooldown exist. A compromised operator key can set arbitrary prices.
- **Impact**: Manipulated oracle prices affect all collateral valuations, potentially enabling unjust liquidations or undercollateralized borrowing.
- **Recommendation**: Add a wider cap (±90%) or require multi-party governance proof for emergency updates.

### DAML-H-02: CantonLoopStrategy Compliance Registry is Optional
- **Reviewer**: DAML/Canton
- **File**: `daml/CantonLoopStrategy.daml:74`
- **Description**: `complianceRegistryCid` is `Optional (ContractId ComplianceRegistry)`. When `None`, all compliance checks are skipped. Other modules (CantonLending, CantonDirectMint) use mandatory compliance.
- **Impact**: Blacklisted parties can use loop strategies to interact with the protocol, bypassing sanctions/AML controls.
- **Recommendation**: Change to mandatory `ContractId ComplianceRegistry`.

### DAML-H-03: Legacy SyncYield Choice Lacks Modern Attestation Caps
- **Reviewer**: DAML/Canton
- **File**: `daml/CantonSMUSD.daml`
- **Description**: The legacy `SyncYield` choice lacks the attestation requirements and movement caps present in the newer `SyncGlobalSharePrice` choice.
- **Impact**: If exercised, allows unattested yield updates without bounds checking.
- **Recommendation**: Remove or gate the legacy choice behind governance controls.

### DAML-H-04: V3 MUSDSupplyService Uncoordinated With CantonDirectMint
- **Reviewer**: DAML/Canton
- **Description**: Supply tracking in `MUSDSupplyService` operates independently from `CantonDirectMintService` supply tracking, allowing potential supply cap bypass through module interaction.
- **Recommendation**: Implement cross-module supply cap enforcement or a shared supply ledger.

### DAML-H-05: Nonconsuming Deposit Choices Return Stale Contract IDs
- **Reviewer**: DAML/Canton
- **File**: `daml/CantonLending.daml:512-561`
- **Description**: Deposit choices are `nonconsuming` but modify ledger state (archive tokens, create escrows). The returned `self` CID may be stale if concurrent deposits race.
- **Impact**: Race condition could cause deposit failure or double-counting in rapid succession.
- **Recommendation**: Document concurrency expectations or switch to consuming pattern with explicit re-creation.

### TS-H-01: Yield API Uses dotenv Breaking Docker Secrets Model
- **Reviewer**: TypeScript
- **File**: `bot/src/yield-api.ts` (or similar)
- **Description**: `dotenv.config()` call loads `.env` file, bypassing the Docker secrets / environment variable pattern used by all other services.
- **Impact**: Secrets could be committed in `.env` files, and the inconsistent pattern creates operational confusion.
- **Recommendation**: Remove `dotenv` import. Use Docker secrets or environment variables directly.

### TS-H-02: Insecure Default RPC URL
- **Reviewer**: TypeScript
- **Description**: A service falls back to `http://localhost:8545` when no RPC URL is provided, using unencrypted HTTP.
- **Impact**: In production, connections to localhost would fail silently or connect to an unintended local process. The HTTP scheme bypasses TLS.
- **Recommendation**: Require explicit RPC URL. Remove default. Enforce HTTPS validation.

### TS-H-03: parseFloat Precision Loss in Financial Calculations
- **Reviewer**: TypeScript
- **File**: `bot/src/lending-keeper.ts:110-120`
- **Description**: `toFixed()` helper uses `parseFloat()` for string-to-number conversion, losing precision for values > 2^53. A $10M position with 18-decimal precision produces 10^25, far beyond float64's integer range.
- **Impact**: Health factor miscalculation for large positions ($10M+), potentially causing missed or premature liquidations.
- **Recommendation**: Parse strings directly as BigInt. Split on `.`, handle integer and fractional parts separately.

### TEST-H-01: No Certora Spec for CollateralVault
- **Reviewer**: Testing
- **File**: `certora/specs/` (missing)
- **Description**: CollateralVault holds ALL protocol collateral but has no formal verification spec. It is the highest-value target for invariant violations.
- **Recommendation**: Create CollateralVault.spec verifying: total deposits ≥ sum of user deposits, no withdrawal exceeds balance, enabled tokens only.

### TEST-H-02: No Certora Spec for RedemptionQueue
- **Reviewer**: Testing
- **File**: `certora/specs/` (missing)
- **Description**: RedemptionQueue manages FIFO ordering and daily withdrawal limits without formal verification.
- **Recommendation**: Create RedemptionQueue.spec verifying FIFO ordering invariant and daily cap enforcement.

### TEST-H-03: Zero Frontend Tests
- **Reviewer**: Testing
- **File**: `frontend/` (no test files)
- **Description**: The React frontend has no unit tests, integration tests, or E2E tests. Given it handles wallet connections, transaction signing, and displays financial data, this is a significant coverage gap.
- **Recommendation**: Add React Testing Library unit tests for critical components (wallet connection, transaction forms, balance displays). Add Cypress/Playwright E2E for key user flows.

---

## MEDIUM FINDINGS (27)

### Solidity (7)

| ID | File | Description |
|---|---|---|
| SOL-M-01 | BLEBridgeV9.sol | Storage gap arithmetic needs verification with hardhat-storage-layout (15 vars + 35 gap = 50 — verify mapping slots) |
| SOL-M-02 | TreasuryV2.sol | Storage gap needs same verification as SOL-M-01 |
| SOL-M-03 | LeverageVault.sol | `emergencyWithdraw()` can extract protocol tokens — restrict to non-protocol ERC20s |
| SOL-M-04 | SMUSD.sol | Fallback `totalAssets()` undervalues vault during strategy failures (uses balance instead of strategy value) |
| SOL-M-05 | BorrowModule.sol | Simple interest accrual drift over time — `reconcileTotalBorrows()` is manual-only |
| SOL-M-06 | RedemptionQueue.sol | Queue array grows unboundedly — no compaction or cleanup mechanism |
| SOL-M-07 | BorrowModule.sol | `_weightedCollateralValue` and `_weightedCollateralValueUnsafe` are near-identical — consolidate |

### DAML (7)

| ID | File | Description |
|---|---|---|
| DAML-M-01 | CantonLending.daml | Interest accrual microsecond→second truncation compounds over many small periods |
| DAML-M-02 | CantonLending.daml | Missing compliance check on liquidator party |
| DAML-M-03 | CantonSMUSD.daml | Asymmetric self-attestation on bridge-in vs bridge-out |
| DAML-M-04 | CantonLoopStrategy.daml | Position open lacks compliance check (separate from config issue) |
| DAML-M-05 | CantonLending.daml | Hardcoded `entrySharePrice = 1.0` on sMUSD withdrawal from lending escrow |
| DAML-M-06 | Upgrade.daml | Data migration lacks validation — no structural check on upgraded template fields |
| DAML-M-07 | CantonLending.daml | `PriceFeed_EmergencyUpdate` has only 5-minute cooldown vs 1-hour for normal updates |

### TypeScript (7)

| ID | File | Description |
|---|---|---|
| TS-M-01 | frontend | No CSRF protection on yield-api endpoints |
| TS-M-02 | bot | Health server binds to 0.0.0.0 — accessible from outside pod without NetworkPolicy |
| TS-M-03 | bot/lending-keeper.ts | `toFixed()` routes through parseFloat (partially overlaps TS-H-03) |
| TS-M-04 | relay/validator-node-v2.ts | Key rotation race condition — brief window where old key is invalid but new key not yet propagated |
| TS-M-05 | relay/validator-node-v2.ts | Missing TLS enforcement (present in relay-service.ts but not validator) |
| TS-M-06 | relay | KMS failover passes empty string for region |
| TS-M-07 | frontend/AdminPage.tsx | Admin page visible to all users (on-chain RBAC still protects operations) |

### Infrastructure (6)

| ID | File | Description |
|---|---|---|
| INFRA-M-01 | .github/workflows | Curl-pipe-bash for DAML SDK install — no checksum verification |
| INFRA-M-02 | Dockerfile(s) | Unpinned pip install commands in Python-based CI steps |
| INFRA-M-03 | k8s/monitoring | ServiceMonitor label selectors don't match pod labels — Prometheus not scraping |
| INFRA-M-04 | k8s | No off-cluster backup or disaster recovery for Canton state |
| INFRA-M-05 | CI | No SBOM (Software Bill of Materials) generation |
| INFRA-M-06 | k8s | Missing Dockerfiles for bot/points/frontend — unclear how images are built |

---

## LOW FINDINGS (25)

| ID | Reviewer | Summary |
|---|---|---|
| SOL-L-01 | solidity | PriceOracle auto-recovery clears circuit breaker silently |
| SOL-L-02 | solidity | DepositRouter refund absorption on ETH send failure |
| SOL-L-03 | solidity | InterestRateModel grants admin role in initializer — should be timelock |
| SOL-L-04 | solidity | `computeAttestationId()` view uses `block.chainid` — confusing for off-chain callers |
| SOL-L-05 | solidity | CollateralVault `getSupportedTokens()` returns unbounded array |
| SOL-L-06 | solidity | Variable shadowing in BorrowModule local `total` |
| SOL-L-07 | solidity | BorrowModule `minDebt` can be set to 0, disabling dust protection |
| SOL-L-08 | solidity | Deploy scripts use hardcoded defaults for dev environments |
| SOL-L-09 | solidity | MUSD `burn()` checks BRIDGE_ROLE before LIQUIDATOR_ROLE — liquidator path always pays for both checks |
| DAML-L-01 | daml | Linear search O(n) in `getConfig` — acceptable but doesn't scale |
| DAML-L-02 | daml | Observer list management not documented |
| DAML-L-03 | daml | No on-ledger key rotation mechanism |
| TS-L-01 | typescript | Temple API credentials in environment variables |
| TS-L-02 | typescript | Missing shutdown handlers in some services |
| TS-L-03 | typescript | Event listener leak — listeners not removed in `stop()` |
| TS-L-04 | typescript | Points service uses HTTP for Canton URL |
| TS-L-05 | typescript | Path traversal gap in static file serving |
| TS-L-06 | typescript | Flashbots retry has infinite loop risk |
| INFRA-L-01 | infra | Broad Slither exclusions may hide findings |
| INFRA-L-02 | infra | Demo API fallback for non-production |
| INFRA-L-03 | infra | Source maps included in production frontend build |
| INFRA-L-04 | infra | Branch protection gaps (force push, admin bypass) |
| TEST-L-01 | testing | Deploy scripts and migration scripts have zero tests |
| TEST-L-02 | testing | 3/5 upgradeable contracts lack storage-preservation tests |
| TEST-L-03 | testing | 13/19 DAML modules have no dedicated test files |

---

## INFORMATIONAL FINDINGS (10)

| ID | Reviewer | Summary |
|---|---|---|
| SOL-I-01 | solidity | CEI pattern compliance confirmed across all contracts ✅ |
| SOL-I-02 | solidity | Event coverage complete — all state changes emit events ✅ |
| SOL-I-03 | solidity | ERC-4626 conformance verified in SMUSD ✅ |
| SOL-I-04 | solidity | Flash loan resistance confirmed in LeverageVault ✅ |
| SOL-I-05 | solidity | Bridge security architecture exceeds industry standard ✅ |
| DAML-I-01 | daml | Dual-signatory token model provides strong authorization ✅ |
| DAML-I-02 | daml | BFT 67% supermajority for bridge attestations ✅ |
| DAML-I-03 | daml | ConsumeProof pattern prevents governance replay ✅ |
| INFRA-I-01 | infra | Pod Security Standards `restricted` enforced ✅ |
| INFRA-I-02 | infra | All GitHub Actions SHA-pinned with version comments ✅ |

---

## GAS OPTIMIZATION SUMMARY

| Priority | ID | Contract | Savings Estimate | Description |
|---|---|---|---|---|
| 🔴 HIGH | GAS-01 | All (8 contracts) | ~200k deploy + 200/revert | Convert ~139 string requires to custom errors |
| 🔴 HIGH | GAS-02 | BorrowModule | ~5,000-15,000/call | Cache `getSupportedTokens()` result, batch external calls |
| 🟡 MED | GAS-03 | BorrowModule | ~3,000-5,000/borrow | Cache `totalDebt()` — called twice in `borrow()` |
| 🟡 MED | GAS-04 | Multiple | ~60-120/iteration | `unchecked { ++i; }` on 8 bounded loops |
| 🟡 MED | GAS-05 | DirectMintV2 | ~15,000/mint | One-time max approval instead of per-tx `forceApprove` |
| 🟡 MED | GAS-06 | MUSD | ~2,100/mint | Pack `supplyCap` + `localCapBps` into single slot |
| 🟡 MED | GAS-07 | BorrowModule | ~10,000 deploy | Merge duplicate `_weightedCollateralValue` functions |
| 🟡 MED | GAS-08 | LiquidationEngine | ~2,600/liquidation | Cache `decimals()` in CollateralConfig |
| 🟡 MED | GAS-09 | SMUSD | ~2,100/transfer | Short-circuit `lastDeposit` read when `fromCooldown == 0` |

**Total estimated user-facing savings**: ~80,000-120,000 gas per typical borrow/repay cycle

---

## CROSS-CUTTING OBSERVATIONS

### 1. Bridge Security (Solidity ↔ DAML ↔ TypeScript ↔ K8s)
The bridge security model is the strongest component of the protocol. BLEBridgeV9 implements 8 layers of replay protection (multi-sig + entropy + state hash + nonce + timestamp + rate limit + attestation age + unpause timelock). The DAML-side deprecated templates (CRIT-01) have been archived, eliminating the bypass vector that previously undermined the on-chain protections. The TypeScript relay correctly sanitizes URLs and enforces TLS, but the validator node lacks the same TLS guard.

### 2. Secret Management (K8s ↔ TypeScript ↔ CI)
Largely excellent — Docker secrets, ESO integration, KMS for signing, SHA-pinned Actions. The `dotenv` usage in yield-api (TS-H-01) is the single inconsistency. ~~Canton image placeholder digests (CRIT-03)~~ resolved — pinned to verified Docker Hub SHA-256.

### 3. Upgrade Safety (Solidity ↔ Governance)
Storage gaps are present on all upgradeable contracts. UUPS `_authorizeUpgrade` is role-protected. However, PendleStrategyV2 uses `DEFAULT_ADMIN_ROLE` instead of `TIMELOCK_ROLE` (SOL-H-02), and 3/5 upgradeable contracts lack storage-preservation tests (TEST-L-02).

### 4. Compliance Consistency (DAML)
Compliance enforcement is mandatory in CantonLending and CantonDirectMint but optional in CantonLoopStrategy (DAML-H-02). This creates a regulatory gap where sanctioned parties can interact through the loop strategy module.

### 5. Financial Precision (Solidity ↔ TypeScript)
Solidity contracts handle precision well (BPS arithmetic, proper rounding). The TypeScript layer has precision risks from `parseFloat()` in the lending keeper (TS-H-03), which could miscalculate health factors for positions > $10M.

---

## ARCHITECTURE STRENGTHS

1. **Defense-in-Depth Bridge** — 8 layers of replay protection exceeding most production bridges
2. **Role Separation** — PAUSER cannot unpause, EMERGENCY cannot upgrade, LEVERAGE_VAULT has scoped borrowFor/repayFor
3. **Circuit Breaker with Liquidation Bypass** — Blocks normal ops on >20% deviation, but allows liquidations via `getPriceUnsafe()`
4. **Timelock Governance** — 48h delay on critical parameters via MintedTimelockController
5. **KMS Signing with Key Rotation** — Zero-downtime rotation flow, private keys never in Node.js memory
6. **Canton-Native Escrow** — Actual token consumption/recreation, not just reference tracking
7. **Dual-Level Supply Caps** — Module-level + global-level caps prevent unbounded minting
8. **9-Scanner CI Pipeline** — Slither, Mythril, Certora, gitleaks, npm audit, SAST, license check, kubeconform, Semgrep
9. **Pod Security Standards** — `restricted` profile at namespace level with default-deny NetworkPolicies
10. **1,769 Hardhat Tests** — Comprehensive unit testing with edge cases, boundary conditions, and attack simulations

---

## COMPARISON TO INSTITUTIONAL STANDARDS

| Standard | Status | Score | Notes |
|---|---|---|---|
| OpenZeppelin Defender Compatible | ✅ PASS | — | Uses OZ contracts-upgradeable v5 |
| Formal Verification | ⚠️ PARTIAL | 7.5/10 | 11/21 contracts verified (91 Certora rules) |
| Multi-sig Governance | ✅ PASS | — | Validator multi-sig + admin timelock |
| Circuit Breakers | ✅ PASS | — | PriceOracle with configurable thresholds |
| Rate Limiting | ✅ PASS | — | BLEBridgeV9 24h supply cap rate limit |
| Emergency Pause | ✅ PASS | — | With 24h unpause timelock |
| Event Coverage | ✅ PASS | — | All state changes emit events |
| Reentrancy Protection | ✅ PASS | — | OZ ReentrancyGuard + CEI on all entry points |
| Supply Cap Enforcement | ✅ PASS | — | Dual caps (module + global) |
| Upgrade Safety | ⚠️ PARTIAL | 8.0/10 | UUPS + gaps, but PendleV2 bypasses timelock |
| Cross-Chain Security | ✅ PASS | — | 8-layer replay protection |
| TLS Enforcement | ⚠️ PARTIAL | 8.0/10 | Present in relay, missing in validator node |
| Non-Root Containers | ✅ PASS | — | `USER appuser` + read-only rootfs |
| Secret Management | ⚠️ PARTIAL | 8.5/10 | ESO + Docker secrets, but dotenv in yield-api |
| Monitoring & Alerting | ⚠️ PARTIAL | 7.0/10 | Prometheus rules exist but ServiceMonitor labels mismatched |
| Test Coverage | ⚠️ PARTIAL | 7.5/10 | 1,769 unit + 91 formal + 35 fuzz, but no frontend/E2E |
| SBOM / Supply Chain | ❌ MISSING | — | No SBOM generation in CI |
| Disaster Recovery | ❌ MISSING | — | No off-cluster backup for Canton state |

---

## REMEDIATION PRIORITY

### 🔴 Immediate (Before Mainnet)
1. ~~**CRIT-01/02**: Archive or delete deprecated DAML templates~~ — ✅ **DONE** (CRIT-01 resolved via archival, CRIT-02 retracted as false positive)
2. ~~**CRIT-03**: Replace placeholder Canton image digests with real SHA-256 hashes~~ — ✅ **DONE** (pinned to verified Docker Hub digests + CI guardrail added)
3. **SOL-H-01**: PendleStrategyV2 — per-operation approvals instead of `type(uint256).max`
4. **SOL-H-02**: PendleStrategyV2 — `_authorizeUpgrade` requires `TIMELOCK_ROLE`
5. **DAML-H-02**: CantonLoopStrategy — make compliance registry mandatory

### 🟡 Short-Term (Within 2 Weeks Post-Launch)
6. **DAML-H-01**: Add price movement cap to `PriceFeed_EmergencyUpdate`
7. **TS-H-01**: Remove dotenv from yield-api, use Docker secrets
8. **TS-H-03**: Replace parseFloat with BigInt parsing in lending keeper
9. **INFRA-M-03**: Correct ServiceMonitor label selectors
10. **GAS-01**: Convert string requires to custom errors (all contracts)
11. **DAML-H-05**: Document or remediate nonconsuming deposit race condition

### 🟢 Medium-Term (Within 1 Month)
12. **TEST-H-01/02**: Create Certora specs for CollateralVault and RedemptionQueue
13. **TEST-H-03**: Add frontend testing framework (React Testing Library + Playwright)
14. **GAS-02/03/04/05**: Gas optimization pass on hot-path contracts
15. **INFRA-M-05**: Add SBOM generation to CI pipeline
16. **INFRA-M-04**: Implement off-cluster Canton state backup
17. **DAML-H-03/04**: Remove legacy SyncYield choice, coordinate supply tracking

---

## FINAL VERDICT

### Composite Score: 8.0 / 10.0 — INSTITUTIONAL GRADE (Upper Tier)

The Minted mUSD Canton protocol demonstrates **production-grade security architecture** with defense-in-depth patterns that exceed most DeFi protocols. The bridge security model (8 protection layers), role separation, and Canton escrow model are particular standouts.

**What prevents a higher score:**

| Factor | Impact on Score |
|---|---|
| ~~Deprecated DAML templates still compilable~~ | ~~−0.6~~ → **RESOLVED** |
| 10/21 contracts without formal verification | −0.4 |
| Gas inefficiency (string requires, uncached reads) | −0.35 |
| Zero frontend tests | −0.3 |
| PendleStrategyV2 authorization gaps | −0.2 |
| TypeScript precision issues in financial calcs | −0.15 |

**Path to 9.0+:**
1. ~~Archive deprecated DAML templates (+0.6)~~ — ✅ **DONE**
2. Add Certora specs for remaining 10 contracts (+0.4)
3. Gas optimization pass with custom errors (+0.35)
4. Add frontend test suite (+0.3)
5. Remediate PendleStrategyV2 auth + approval (+0.2)

**The protocol is production-deployable** with the 5 immediate remediations above. The remaining findings are hardening measures that strengthen an already solid foundation.

---

*Report generated by Minted Security Team*
*Methodology: Trail of Bits / Spearbit / Consensys Diligence hybrid framework*
*Date: February 13, 2026*
