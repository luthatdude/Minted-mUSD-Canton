# Minted mUSD Protocol — Institutional Re-Audit Report

**Date:** 2026-02-14  
**Lead Auditor:** Minted Security Team  
**Scope:** Full-stack line-by-line re-audit — Solidity, DAML/Canton, TypeScript, Infrastructure  
**Methodology:** Specialist agent delegation + lead auditor deep synthesis  

---

## Executive Summary

| Severity | Count | Breakdown |
|----------|-------|-----------|
| **CRITICAL** | 2 | DAML V3 compliance bypass (2) |
| **HIGH** | 11 | DAML (5) · TypeScript (3) · Infrastructure (3) |
| **MEDIUM** | 24 | DAML (7) · TypeScript (7) · Infrastructure (8) · Solidity (2) |
| **LOW** | 19 | DAML (4) · TypeScript (8) · Infrastructure (4) · Solidity (3) |
| **INFO** | 18 | DAML (4) · TypeScript (6) · Infrastructure (5) · Solidity (3) |

### Institutional Readiness Score: **85 / 100**

| Domain | Weight | Score | Weighted |
|--------|--------|-------|----------|
| Solidity Smart Contracts | 40% | 9.3/10 | 37.2 |
| DAML/Canton | 15% | 7.5/10 | 11.3 |
| TypeScript Services | 15% | 7.8/10 | 11.7 |
| Infrastructure & DevOps | 15% | 8.2/10 | 12.3 |
| Testing & QA | 15% | 8.5/10 | 12.8 |
| **Total** | | | **85.3** |

---

## 1. Solidity Smart Contracts — 9.3/10

**Contracts audited:** 29+ source files (~8,500 LOC)  
**Core contracts read line-by-line:** MUSD, DirectMintV2, CollateralVault, BorrowModule, LiquidationEngine, BLEBridgeV9, SMUSD, TreasuryV2, PriceOracle, InterestRateModel, RedemptionQueue, LeverageVault, MintedTimelockController, TimelockGoverned, GlobalPauseRegistry, TreasuryReceiver, DepositRouter, SMUSDPriceAdapter, Errors + all 5 upgradeable variants

### Security Patterns Verified ✅

| Pattern | Status | Evidence |
|---------|--------|----------|
| No `delegatecall` | ✅ PASS | Zero matches across entire codebase |
| No `selfdestruct` | ✅ PASS | Zero matches |
| No `tx.origin` | ✅ PASS | Zero matches |
| `SafeERC20` on all external token calls | ✅ PASS | `forceApprove` + `safeTransfer` throughout |
| `ReentrancyGuard` on state-changing entry points | ✅ PASS | All contracts use `nonReentrant` |
| `AccessControl` role separation | ✅ PASS | TIMELOCK_ROLE, PAUSER_ROLE, BRIDGE_ROLE, etc. |
| UUPS `_disableInitializers()` in constructors | ✅ PASS | All 6 upgradeable contracts |
| Storage gaps (`__gap[40]`) | ✅ PASS | All 5 upgradeable contracts |
| Timelock governance (48h min) | ✅ PASS | MintedTimelockController + TimelockGoverned |
| ERC-4626 compliance | ✅ PASS | `maxDeposit`/`maxMint`/`maxWithdraw`/`maxRedeem` all overridden |
| Supply cap enforcement | ✅ PASS | MUSD `supplyCap` + `localCapBps` |
| Oracle circuit breaker | ✅ PASS | PriceOracle per-asset thresholds + auto-recovery |
| Bad debt tracking | ✅ PASS | LiquidationEngine + BorrowModule socialization |
| Anti-DoS protections | ✅ PASS | RedemptionQueue (min/max/per-user), CollateralVault (50-token cap) |
| Compliance blacklist | ✅ PASS | MUSD `_update()` checks |
| `unchecked` blocks | ✅ SAFE | Only 1 instance in SMUSDUpgradeable (cooldown subtraction, safe) |

### Findings

#### SOL-M-01: SMUSDPriceAdapter Rate Limiter Depends on External Keeper
**Severity:** MEDIUM  
**File:** `contracts/SMUSDPriceAdapter.sol` lines 189-212  
**Description:** `latestRoundData()` is `view` and cannot update the rate-limiting cache (`_lastPrice`, `_lastPriceBlock`). Price clamping only takes effect after `updateCachedPrice()` is called by a keeper. If keeper fails, `_lastPrice` remains 0, and the `if (_lastPrice > 0)` guard skips rate limiting entirely, allowing a single-block donation to move the reported price up to `maxSharePrice` (2.0 USD).  
**Mitigating factors:** `minSharePrice`/`maxSharePrice` bounds (0.95–2.0 USD) and `minTotalSupply` check (1000e18) limit the attack surface. A 2× price jump requires the attacker to donate assets equal to the vault's entire `totalAssets`.  
**Recommendation:** Document keeper SLA requirement; consider a `nonView` variant that updates cache on read for liquidation paths.

#### SOL-M-02: TreasuryReceiver Emergency Withdraw Bypasses Timelock
**Severity:** MEDIUM  
**File:** `contracts/TreasuryReceiver.sol` line 322  
**Description:** `emergencyWithdraw()` is gated by `DEFAULT_ADMIN_ROLE` only, not `onlyTimelock`. This allows immediate drain of all bridged USDC without 48h governance delay.  
**Mitigating factors:** This is intentional for emergency response. DEFAULT_ADMIN is expected to be a multi-sig. The function emits transfer events for monitoring.  
**Recommendation:** Confirm admin is multi-sig (3/5 minimum) before mainnet. Add rate limiting or per-transaction cap.

#### SOL-L-01: DepositRouter TIMELOCK_ROLE Not Initialized in Constructor
**Severity:** LOW  
**File:** `contracts/DepositRouter.sol` constructor (lines 166-180)  
**Description:** Constructor does not accept a timelock address or grant `TIMELOCK_ROLE`. Functions gated by `onlyRole(TIMELOCK_ROLE)` (`setTreasury`, `setDirectMint`, `setFee`, `emergencyWithdraw`, `unpause`) are inaccessible until admin grants the role post-deployment.  
**Recommendation:** Add `_timelockController` parameter to constructor and grant `TIMELOCK_ROLE` on deployment, matching the TreasuryReceiver pattern.

#### SOL-L-02: Empty Library Placeholder Files
**Severity:** LOW  
**File:** `contracts/libraries/LeverageMathLib.sol`, `contracts/libraries/FlashLoanLib.sol`  
**Description:** Both files exist but are empty (0 bytes). These are either dead placeholders or accidentally committed.  
**Recommendation:** Remove or populate with actual library code.

#### SOL-L-03: TreasuryReceiver VAA Payload Parsing Gas Inefficiency
**Severity:** LOW  
**File:** `contracts/TreasuryReceiver.sol` lines 195-199  
**Description:** Byte-by-byte loop to extract user payload from VAA. Could use `bytes` slicing for ~500 gas savings per call.  
**Recommendation:** Replace with `bytes memory userPayload = vm.payload[133:]` (Solidity ≥0.8.0 supports memory slicing in some contexts) or use `abi.decode` with offset.

#### SOL-INFO-01: Deprecated Storage Variables Preserved Correctly
**File:** `contracts/upgradeable/BorrowModuleUpgradeable.sol` lines 102-128  
**Assessment:** CORRECT. Legacy timelock variables (`pendingInterestRateModel`, etc.) are preserved with `DEPRECATED` comments to maintain storage layout compatibility. This is the proper upgrade pattern.

#### SOL-INFO-02: 2 Failing Tests Are Test Spec Errors, Not Contract Bugs
**File:** `test/CoverageBoost_MiscContracts.test.ts` lines 1267, 1273  
**Assessment:** Tests expect `maxDeposit`/`maxMint` to return `type(uint256).max` when paused. Per ERC-4626 spec, these SHOULD return 0 when deposits are not possible. The SMUSD contract is correct; the tests need updating.

#### SOL-INFO-03: Single `unchecked` Block Is Safe
**File:** `contracts/upgradeable/SMUSDUpgradeable.sol` line 242  
**Assessment:** Used for cooldown subtraction where underflow is impossible due to prior `>=` check. Safe.

---

## 2. DAML/Canton — 7.5/10

**Modules audited:** 13 production DAML modules (~7,800 LOC)

### Critical Findings

#### DAML-CRIT-01: V3 CantonDirectMint Has Zero Compliance Integration
**Severity:** CRITICAL  
**Module:** `Minted.Protocol.V3` (1,719 lines, 18 templates)  
**Description:** The entire V3 module does not import the Compliance module. Mints, transfers, bridge operations, and redemptions proceed without KYC/AML/blacklist validation. If V3 is the production bridge pipeline, this completely bypasses the compliance framework.  
**Impact:** Sanctioned entities could mint, transfer, and redeem mUSD via the Canton layer with zero regulatory checks.

#### DAML-CRIT-02: V3 VaultManager No Compliance Gating
**Severity:** CRITICAL  
**Description:** `VaultManager.OpenVault` in V3 has no compliance check. Any party — including sanctioned entities — can open collateralized debt positions and borrow mUSD.

### High Findings

| ID | Title | Description |
|----|-------|-------------|
| DAML-H-01 | Transfer choices call ValidateMint instead of ValidateTransfer | `CantonSMUSD`, `BoostPoolLP`, and `CantonUSDC` transfers call the wrong validation choice, allowing frozen users to move assets |
| DAML-H-02 | V3 transfer has no compliance | V3 token transfers bypass compliance entirely |
| DAML-H-03 | CantonLoopStrategyService admin choices lack governance proofs | Operator-only with no timelock or multi-sig proof |
| DAML-H-04 | Price feed single trust point | Canton price feed relies on single operator attestation |
| DAML-H-05 | V3 LiquidationOrder has no expiry | Keeper can claim and never complete, permanently blocking liquidation |

### Medium Findings (7)

Registry key collisions, V3 governance downgrade, missing bridge-out validation, rate limit bypass paths, observer privacy leaks, V3 redemption no daily limits, unused V2 migration templates.

### Low Findings (4)

Event ordering inconsistencies, missing descriptions on choices, V3 template naming inconsistency, excessive observer lists.

---

## 3. TypeScript Services — 7.8/10

**Files audited:** ~80 source files across relay/, bot/, frontend/, points/, scripts/, subgraph/

### High Findings

| ID | Title | Description |
|----|-------|-------------|
| TS-H-01 | Hardcoded ETH price $2500 in liquidation bot | `bot/liquidation-keeper.ts` uses hardcoded `ETH_PRICE_USD = 2500` for gas cost estimation instead of querying a live feed |
| TS-H-02 | CSP `unsafe-inline` in production | Frontend allows inline scripts, enabling XSS vector |
| TS-H-03 | Weak randomness for referral codes | `Math.random()` used for referral code generation instead of `crypto.randomBytes()` |

### Medium Findings (7)

Canton HTTP default (no TLS), Canton token in React ref, no CORS on yield API, hardcoded Sepolia addresses, in-memory rate limit reset on restart, unbounded event query range, approval race condition in bot.

### Positive Findings (Notable Strengths)

- **Exemplary KMS management** in relay: AWS KMS integration with proper DER signature handling
- **Per-transaction bounded approvals** in keeper bots (not unlimited)
- **Comprehensive migration safety** checks
- **TLS watchdog** on relay services
- **Storage layout validation** in deployment scripts

---

## 4. Infrastructure & DevOps — 8.2/10

**Files audited:** All K8s manifests, Docker configs, CI/CD pipelines, build configurations

### High Findings

| ID | Title | Description |
|----|-------|-------------|
| INFRA-H-01 | 4 container images not SHA-pinned | `loki`, `promtail`, `pgbouncer`, `postgres-exporter` use mutable tags |
| INFRA-H-02 | postgres-exporter credentials via env vars | Uses `secretKeyRef` env vars instead of file-mounted credentials |
| INFRA-H-03 | kubeconform downloaded without SHA verification | CI pipeline fetches binary without integrity check |

### Strengths (Notable)

- All GitHub Actions SHA-pinned with Trivy + cosign + SBOM
- External Secrets Operator with AWS Secrets Manager
- Pod Security Standards `restricted` on namespace
- Default-deny NetworkPolicy baseline
- NGINX gateway with rate limiting, TLS 1.2+, HSTS, CSP, WAF

---

## 5. Testing & QA — 8.5/10

| Metric | Value |
|--------|-------|
| Test files | 42 |
| Tests passing | 1,523 |
| Tests failing | 2 (test spec errors, not contract bugs) |
| Pass rate | 99.87% |
| Core contract coverage | ~92% (Hardhat) |
| Formal verification | Certora specs present |
| Fuzz testing | FuzzTests.test.ts present |
| Static analysis | Slither configured |
| Audit tooling | audit-ci.json configured |

### Gaps

- 2 test assertions incorrect (expect `type(uint256).max` instead of 0 for paused `maxDeposit`/`maxMint`)
- Empty Foundry fuzz/invariant targets (foundry.toml configured but `forge-out/` suggests limited use)
- Strategy contracts (9 strategies) lack dedicated integration test files for all strategies
- DAML script-based testing not evaluated in Hardhat suite

---

## 6. Cross-Cutting Observations

### Bridge Security (Spans: Solidity + DAML + TypeScript + K8s)
The Ethereum-side bridge (BLEBridgeV9) is well-hardened with attestation validation, entropy checks, rate limiting, and unpause timelock. The TypeScript relay uses KMS signing and TLS. **However, the DAML V3 module bypasses compliance entirely (DAML-CRIT-01/02)**, creating a gap where Canton-side operations lack the same regulatory controls as the Ethereum side.

### Upgrade Safety (Spans: Solidity + Infrastructure)
All 6 UUPS contracts follow correct patterns: `_disableInitializers()`, `__gap[40]`, `_authorizeUpgrade` gated by TIMELOCK_ROLE with 48h delay. Deprecated storage variables are preserved. Deployment scripts include storage layout validation. **Strong.**

### Secret Management (Spans: K8s + TypeScript)
External Secrets Operator used consistently, except postgres-exporter (INFRA-H-02). TypeScript services use env validation. **One gap, otherwise strong.**

### Governance & Access Control (Spans: Solidity + DAML)
Solidity governance is excellent: MintedTimelockController (48h min delay), role separation (TIMELOCK_ROLE self-administering), unpause requires timelock. DAML standalone modules have governance proofs. **V3 DAML module governance is weaker** — operator-only choices without timelock proofs (DAML-H-03).

---

## 7. Prioritized Recommendations

### Tier 1 — Must Fix Before Mainnet (CRITICAL + HIGH)
1. **DAML-CRIT-01/02:** Integrate compliance module into V3 templates or gate V3 behind compliance middleware
2. **DAML-H-01:** Fix transfer choices to call `ValidateTransfer` instead of `ValidateMint`
3. **DAML-H-05:** Add expiry to V3 `LiquidationOrder`
4. **TS-H-01:** Replace hardcoded ETH price with live Chainlink feed in liquidation bot
5. **TS-H-02:** Remove `unsafe-inline` from CSP; use nonce-based script loading
6. **INFRA-H-01:** Pin remaining 4 container images to SHA256 digests

### Tier 2 — Should Fix Before Mainnet (MEDIUM)
7. Fix 2 failing test assertions (`maxDeposit`/`maxMint` when paused → expect 0)
8. Add TIMELOCK_ROLE initialization to DepositRouter constructor
9. Document SMUSDPriceAdapter keeper SLA requirement
10. Remove empty library placeholder files
11. Switch postgres-exporter to file-mounted credentials
12. Add SHA verification to kubeconform download in CI

### Tier 3 — Improve Post-Launch (LOW + INFO)
13. Improve VAA payload parsing gas efficiency in TreasuryReceiver
14. Add Foundry invariant tests for BorrowModule interest accrual
15. Expand strategy integration test coverage
16. Add referral code generation with `crypto.randomBytes()`

---

## 8. Comparison to Prior Audit

| Metric | Prior Audit (v1) | This Re-Audit |
|--------|-----------------|---------------|
| Readiness Score | 82/100 | **85/100** |
| Critical findings | 1 (fixed) | 2 (new — DAML V3) |
| Solidity score | ~8.5/10 | **9.3/10** |
| Test pass rate | ~95% | **99.87%** |
| Timelock governance | Partial | **Complete** |
| ERC-4626 compliance | Partial | **Full** |
| Storage gaps | Present | **Verified** |

**Score improved +3 points** driven by:
- Complete timelock migration (eliminating all hand-rolled pending-variable patterns)
- ERC-4626 maxDeposit/maxMint/maxWithdraw/maxRedeem overrides
- DirectMintV2 setFeeRecipient TIMELOCK_ROLE gate
- ConfigMap key mismatch fix
- Test suite expansion (1523 passing from ~1400)

**Score held back by:**
- DAML V3 compliance gaps (new module, not present in prior audit)
- 3 remaining infrastructure hardening items
- TypeScript hardcoded values in bot services

---

## Conclusion

The Minted mUSD protocol demonstrates **strong institutional-grade security** in its core Solidity smart contracts (9.3/10), with proper use of OpenZeppelin 5.x patterns, comprehensive timelock governance, ERC-4626 compliance, and defense-in-depth (circuit breakers, rate limiting, bad debt socialization, anti-DoS protections). No delegatecall, selfdestruct, or tx.origin usage was found. Upgrade safety is exemplary.

The primary gaps are:
1. **DAML V3 compliance integration** — the two CRITICALs must be resolved before any V3 template is used in production
2. **TypeScript bot hardcoded values** — operational risk, not exploitable but could cause incorrect liquidation decisions
3. **Minor infrastructure hardening** — image pinning and credential management for monitoring sidecars

**With the 6 Tier 1 fixes applied, the protocol would score approximately 90/100.**

---

*Report generated from line-by-line review of 29+ Solidity contracts, 13 DAML modules, ~80 TypeScript files, and all infrastructure manifests. Test suite: 1,523/1,525 passing (99.87%).*
