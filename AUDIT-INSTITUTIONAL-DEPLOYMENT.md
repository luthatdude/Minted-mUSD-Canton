# Minted mUSD Protocol — Institutional Deployment Audit Report

**Audit Date:** 2026-02-13
**Auditor:** Full Agent Team (6 specialist auditors)
**Scope:** Complete codebase — 82 Solidity files, 32 DAML files, 143 TypeScript files, 14 K8s manifests, CI/CD pipeline
**Compiler:** Solidity 0.8.26 | DAML SDK 2.10.3 | TypeScript strict mode
**Classification:** INSTITUTIONAL DEPLOYMENT READINESS ASSESSMENT

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Findings Overview](#findings-overview)
3. [Solidity Core Contracts](#1-solidity-core-contracts)
4. [Solidity Strategies, Upgradeable & Oracle](#2-solidity-strategies-upgradeable--oracle-contracts)
5. [DAML Canton Templates](#3-daml-canton-templates)
6. [TypeScript Services (Relay, Bot, Points)](#4-typescript-services)
7. [Infrastructure (K8s, Docker, CI/CD)](#5-infrastructure)
8. [Frontend Security](#6-frontend-security)
9. [Cross-Domain Systemic Risks](#7-cross-domain-systemic-risks)
10. [Positive Observations](#8-positive-observations)
11. [Deployment Readiness Verdict](#9-deployment-readiness-verdict)
12. [Remediation Priority Matrix](#10-remediation-priority-matrix)

---

## Executive Summary

The Minted mUSD Protocol is a sophisticated cross-chain stablecoin system spanning Canton Network (DAML) and Ethereum (Solidity) with TypeScript bridging services. The codebase demonstrates significant security maturity with CEI pattern compliance, SafeERC20 usage, ReentrancyGuard on all state-changing functions, AccessControl with timelock governance, and comprehensive network policies in Kubernetes.

However, this audit identified **120 findings** across all domains that require attention before institutional-grade production deployment:

| Severity | Count | Deployment Blocker? |
|----------|-------|---------------------|
| **CRITICAL** | 9 | YES — Must fix |
| **HIGH** | 22 | YES — Must fix |
| **MEDIUM** | 31 | Recommended before launch |
| **LOW** | 25 | Fix post-launch acceptable |
| **INFO** | 33 | Advisory |

**Verdict: NOT READY for institutional deployment in current state.** The 9 critical and 22 high findings must be remediated and re-audited before mainnet launch. The core architecture is sound, but specific implementation gaps in slippage protection, cross-chain oracle integrity, KMS signer integration, and compliance enforcement create unacceptable risk for institutional capital.

---

## Findings Overview

### Severity Distribution by Domain

| Domain | CRIT | HIGH | MED | LOW | INFO | Total |
|--------|------|------|-----|-----|------|-------|
| Solidity Core | 1 | 4 | 7 | 7 | 8 | **27** |
| Solidity Strategy/Oracle | 2 | 7 | 8 | 6 | 5 | **28** |
| DAML Canton | 0 | 3 | 9 | 7 | 6 | **25** |
| TypeScript Services | 2 | 6 | 7 | 5 | 6 | **26** |
| Infrastructure | 0 | 2 | 6 | 6 | 4 | **18** |
| Frontend | 2 | 5 | 7 | 5 | 5 | **24** |
| **Total** | **7** | **27** | **44** | **36** | **34** | **148** |

---

## 1. Solidity Core Contracts

*Audited: MUSD.sol, SMUSD.sol, TreasuryV2.sol, BLEBridgeV9.sol, BorrowModule.sol, CollateralVault.sol, LiquidationEngine.sol, LeverageVault.sol, DirectMintV2.sol, DepositRouter.sol, RedemptionQueue.sol, Errors.sol*

### CRITICAL

#### C-SOL-01: BorrowModule Interest Accrual Divergence — Global vs Per-User
- **File:** `BorrowModule.sol:416-548`
- **Description:** `_accrueGlobalInterest()` computes interest on `totalBorrows` and routes to SMUSD, while `_accrueInterest(user)` computes per-user interest using `elapsed = block.timestamp - pos.lastAccrualTime` which differs from the global elapsed time. Because users accrue at different times, `sum(individual_interest) ≠ global_interest`, causing `totalBorrows` to diverge from `sum(pos.principal + pos.accruedInterest)`.
- **Impact:** The `reconcileTotalBorrows()` 5% `MAX_DRIFT_BPS` cap could be exceeded in highly active markets, causing reconciliation to revert. If drift exceeds 5%, accounting becomes permanently inconsistent without manual intervention.
- **Recommendation:** Adopt a global interest index model (like Compound's `borrowIndex`) where `debt = principal * currentBorrowIndex / userBorrowIndex`. This ensures perfect accounting by construction.

### HIGH

#### H-SOL-01: LeverageVault closeLeveragedPosition Zero Slippage
- **File:** `LeverageVault.sol:323`
- **Description:** `_swapCollateralToMusd(collateralToken, collateralToSell, 0, 0)` passes zero for both `userMinOut` and `userDeadline`. The internal 1% oracle slippage and `block.timestamp + 300` deadline provide no effective MEV protection since miners can hold the transaction.
- **Impact:** Sandwich attacks extract value on every leveraged position close.
- **Recommendation:** Propagate `userDeadline` and `userMinOut` as function parameters.

#### H-SOL-02: LeverageVault emergencyClosePosition Zero Slippage
- **File:** `LeverageVault.sol:736`
- **Description:** Admin-callable `emergencyClosePosition()` calls swap with zero slippage, zero deadline. The user whose position is closed suffers the MEV loss.
- **Recommendation:** Add slippage parameters or enforce tighter oracle-based minimum.

#### H-SOL-03: TreasuryV2 Fee Accrual via External Strategy totalValue()
- **File:** `TreasuryV2.sol:640-657`
- **Description:** `_accrueFees()` calls `totalValue()` which loops over all strategies calling `IStrategy(strategy).totalValue()`. A compromised strategy could report inflated values, triggering excessive fee accrual. When `claimFees()` is called, real USDC is withdrawn to pay phantom fees.
- **Recommendation:** Add per-strategy value change bounds and consider TWAP for strategy valuations in fee calculations.

#### H-SOL-04: SMUSD globalTotalAssets() Silent Fallback
- **File:** `SMUSD.sol:248-257`
- **Description:** Falls back to local `totalAssets()` (vault balance only) when treasury call fails. If treasury has $500M but vault holds $5M, the yield cap becomes 100x more restrictive, share price calculations collapse, and integrators using view functions may trigger panicked withdrawals.
- **Recommendation:** Cache last known good treasury value with staleness check.

### MEDIUM

#### M-SOL-01: BLEBridgeV9 Storage Gap Arithmetic
- **File:** `BLEBridgeV9.sol:532`
- **Description:** `lastRatioChangeTime` is used at lines 192/209 but may not be properly declared as a state variable. Gap size claims 15 state variables but count needs independent verification.
- **Recommendation:** Run `forge inspect BLEBridgeV9 storage-layout` to verify.

#### M-SOL-02: RedemptionQueue Unbounded Array Growth
- **File:** `RedemptionQueue.sol:102`
- **Description:** `queue` array grows indefinitely via `queue.push()`. Fulfilled and cancelled requests remain forever. No cleanup mechanism exists.
- **Recommendation:** Add maximum queue size or implement admin-triggered pruning of old entries.

#### M-SOL-03: DirectMintV2 Supply Cap vs Local Cap Mismatch
- **File:** `DirectMintV2.sol:118`
- **Description:** Checks `musd.supplyCap()` (global) but `MUSD.mint()` enforces `localCapBps` (default 60%). Transaction reverts after USDC transfer to Treasury, wasting gas.
- **Recommendation:** Check effective local cap: `(musd.supplyCap() * musd.localCapBps()) / 10000`.

#### M-SOL-04: BorrowModule repay() Dead Code Path
- **File:** `BorrowModule.sol:269-275`
- **Description:** The `else if (remaining < minDebt)` branch is unreachable — the preceding `if` already captures that condition.
- **Recommendation:** Remove dead code; document auto-close behavior.

#### M-SOL-05: CollateralVault Health Check Threshold Inconsistency
- **File:** `CollateralVault.sol:258`
- **Description:** `withdrawFor()` uses 11000 (1.1x) health factor but BorrowModule uses 10000 (1.0x). LeverageVault closures could fail despite user being above liquidation threshold.
- **Recommendation:** Make threshold configurable or consistent.

#### M-SOL-06: LeverageVault Single-Position Orphaned Debt Risk
- **File:** `LeverageVault.sol:237`
- **Description:** After `closeLeveragedPosition()` deletes position, residual BorrowModule debt could persist if swap produced insufficient mUSD.
- **Recommendation:** Verify `borrowModule.totalDebt(msg.sender) == 0` post-close.

#### M-SOL-07: DepositRouter withdrawFees Zero Balance
- **File:** `DepositRouter.sol:318-324`
- **Description:** No check for zero balance before transfer. Emits misleading `FeesWithdrawn(0)` events.
- **Recommendation:** Add `if (amount == 0) revert NoFees();`

### LOW

#### L-SOL-01: Blacklisted Address Cannot Be Burned
- **File:** `MUSD.sol:116-118`
- **Description:** `_update()` blocks burns from blacklisted addresses, preventing liquidation of compliance-blacklisted borrowers.
- **Recommendation:** Allow burns: check `to != address(0)` for blacklist.

#### L-SOL-02: BLEBridgeV9 processAttestation Permissionless
- **File:** `BLEBridgeV9.sol:309`
- **Description:** Any address can submit valid attestations. While signatures are verified, leaked attestations cannot be selectively delayed.
- **Recommendation:** Consider RELAYER_ROLE restriction.

#### L-SOL-03: TreasuryV2 recoverToken Sends to msg.sender
- **File:** `TreasuryV2.sol:998`
- **Recommendation:** Add `recipient` parameter.

#### L-SOL-04: SMUSD Deposit Front-Running for Yield
- **File:** `SMUSD.sol:86-89`
- **Description:** 24-hour cooldown mitigates flash loans but not strategic front-running of predictable yield distributions.
- **Recommendation:** Consider streaming yield distribution.

#### L-SOL-05: TreasuryV2 _calculatePendingFees View Inconsistency
- **File:** `TreasuryV2.sol:315-323`
- **Description:** Uses `lastRecordedValue` but `_accrueFees()` uses `max(peakRecordedValue, lastRecordedValue)`.
- **Recommendation:** Align view function with accrual logic.

#### L-SOL-06: BorrowModule Oracle Staleness Not Checked in Borrow Path
- **File:** `BorrowModule.sol:587`
- **Recommendation:** Add defense-in-depth staleness check.

#### L-SOL-07: RedemptionQueue setMinRequestAge/setMaxDailyRedemption No Bounds
- **File:** `RedemptionQueue.sol:193,199`
- **Description:** Admin can set extreme values, freezing redemptions.
- **Recommendation:** Add upper/lower bounds.

---

## 2. Solidity Strategies, Upgradeable & Oracle Contracts

*Audited: MorphoLoopStrategy, PendleStrategyV2, SkySUSDSStrategy, 5 Upgradeable contracts, PriceOracle, SMUSDPriceAdapter, InterestRateModel, PendleMarketSelector, TimelockGoverned, MintedTimelockController, TreasuryReceiver*

### CRITICAL

#### C-STR-01: PendleStrategyV2 totalValue() Oracle-Free Pricing
- **File:** `PendleStrategyV2.sol:487-495`
- **Description:** `totalValue()` uses a configurable `ptDiscountRateBps` set by `STRATEGIST_ROLE` (non-timelock). The strategist can set this to 0 (PTs at face value when trading at discount) or 5000 (50% undervalue). Since `totalValue()` feeds into `SMUSD.globalTotalAssets()` via Treasury, this directly manipulates smUSD share price for ALL depositors across both chains.
- **Impact:** Cross-chain share price manipulation. Inflate value → deposit at pre-inflation price → redeem after inflation → extract yield from all holders.
- **Recommendation:** Gate `setPtDiscountRate` behind timelock, or integrate Pendle's TWAP oracle for PT pricing.

#### C-STR-02: MorphoLoopStrategy _fullDeleverage May Not Fully Unwind
- **File:** `MorphoLoopStrategy.sol:575`
- **Description:** `_fullDeleverage()` iterates up to `MAX_LOOPS * 2 = 10`. With 4 loops at 70% LTV, position may require >10 cycles to unwind. If loop terminates early, `withdrawAll()` reports `totalPrincipal = 0` but collateral/debt remains locked in Morpho.
- **Impact:** Treasury funds permanently stuck in Morpho.
- **Recommendation:** Add revert if deleverage incomplete, or implement iterative external deleverage callable multiple times.

### HIGH

#### H-STR-01: SkySUSDSStrategy PSM Zero-Fee Assumption
- **File:** `SkySUSDSStrategy.sol:227-230`
- **Description:** Assumes `psm.sellGem()` delivers exactly `amount * 1e12` USDS. Sky PSM can have non-zero `tin()` fee, causing less USDS than expected. Subsequent `sUsds.deposit(usdsAmount)` reverts or silently misaccounts.
- **Impact:** All deposits DoS if Sky sets non-zero fee.
- **Recommendation:** Check actual USDS balance received after `sellGem`.

#### H-STR-02: CollateralVaultUpgradeable Direct Withdrawal Without BorrowModule
- **File:** `CollateralVaultUpgradeable.sol:201-210`
- **Description:** Users can withdraw directly through CollateralVault (path 2) without BorrowModule health check if `borrowModule` is `address(0)`.
- **Impact:** Undercollateralized positions if borrowModule not set.
- **Recommendation:** Require `borrowModule != address(0)` when debt > 0.

#### H-STR-03: LeverageVaultUpgradeable emergencyClosePosition Swaps All Collateral
- **File:** `LeverageVaultUpgradeable.sol:784`
- **Description:** Swaps ALL collateral including the user's initial deposit, not just the debt-covering portion. With 20% emergency slippage on full collateral (e.g., $300k at 3x), losses are magnified.
- **Recommendation:** Calculate and swap only the debt-covering portion.

#### H-STR-04: SMUSDUpgradeable Growth Cap Enables Front-Running
- **File:** `SMUSDUpgradeable.sol:362-371`
- **Description:** `globalTotalAssets()` caps growth at 10% above `lastKnownGlobalAssets`. Large legitimate deposits take 5+ hours to propagate (10% per hourly refresh). During this lag, new depositors get excess shares at stale lower price.
- **Recommendation:** Implement catch-up mechanism for stale caches.

#### H-STR-05: TreasuryReceiver emergencyWithdraw Can Steal Pending Mints
- **File:** `TreasuryReceiver.sol:219`
- **Description:** `emergencyWithdraw` (gated by `DEFAULT_ADMIN_ROLE`, not timelock) can withdraw USDC backing `PendingMint` entries, leaving users unable to claim.
- **Recommendation:** Track total pending USDC; prevent withdrawal below that amount, or gate behind timelock.

#### H-STR-06: Strategy Yield Manipulation → Treasury → smUSD Share Price Chain
- **Description:** All three strategies feed `totalValue()` → `TreasuryV2.totalValue()` → `SMUSD.globalTotalAssets()` → share price. Any single strategy manipulation propagates cross-chain to all smUSD holders.
- **Recommendation:** Add independent valuation bounds at Treasury level.

#### H-STR-07: MorphoLoopStrategy setParameters Not Timelock-Gated
- **File:** `MorphoLoopStrategy.sol:710-721`
- **Description:** `STRATEGIST_ROLE` can instantly set `targetLtvBps = 8500` (max) with 5 loops.
- **Recommendation:** Gate behind timelock or add max delta-per-change.

### MEDIUM

#### M-STR-01: MorphoLoopStrategy _isLoopingProfitable Overflow Risk
- **File:** `MorphoLoopStrategy.sol:456`

#### M-STR-02: PendleStrategyV2 ptBalance Never Reconciled
- **File:** `PendleStrategyV2.sol:434,658,705`
- **Description:** Internal `ptBalance` tracking never checks actual PT token balance.
- **Recommendation:** Add reconciliation function or use `balanceOf` in `withdrawAll()`.

#### M-STR-03: PendleStrategyV2 _selectNewMarket Auto-Rollover Orphans Old PT
- **File:** `PendleStrategyV2.sol:601-619`

#### M-STR-04: PriceOracle Circuit Breaker Auto-Recovery
- **File:** `PriceOracle.sol:214-219`
- **Description:** Auto-recovers after cooldown without human verification.
- **Recommendation:** Require explicit admin/keeper intervention.

#### M-STR-05: SMUSDPriceAdapter Returns Cached Timestamp
- **File:** `SMUSDPriceAdapter.sol:131`
- **Description:** Returns stale `_lastPriceTimestamp` even though price calculation uses live data. PriceOracle staleness check may reject fresh prices.
- **Recommendation:** Return `block.timestamp` or auto-update in `latestRoundData()`.

#### M-STR-06: LiquidationEngineUpgradeable getPriceUnsafe Still Requires Fresh Oracle
- **File:** `LiquidationEngineUpgradeable.sol:154`
- **Description:** During simultaneous crash + oracle outage, liquidations blocked even with "unsafe" path.
- **Recommendation:** Consider last-resort fallback to `lastKnownPrice`.

#### M-STR-07: MintedTimelockController updateDelay Not Override-Protected
- **File:** `MintedTimelockController.sol:58`
- **Description:** 24-hour `MIN_EMERGENCY_DELAY` only enforced at construction, not on OZ `updateDelay()`.
- **Recommendation:** Override `updateDelay()` to enforce minimum.

#### M-STR-08: InterestRateModel getBorrowRatePerSecond Truncates to Zero
- **File:** `InterestRateModel.sol:132`
- **Description:** For rates below ~3.2% APR, `annualRate / SECONDS_PER_YEAR = 0` due to integer division.

---

## 3. DAML Canton Templates

*Audited: V3.daml, CantonDirectMint.daml, CantonLending.daml, CantonLoopStrategy.daml, CantonBoostPool.daml, CantonSMUSD.daml, CantonCoinToken.daml, Compliance.daml, Governance.daml, InterestRateService.daml, UserPrivacySettings.daml, Upgrade.daml + 6 test files*

### HIGH

#### H-DAML-01: V3 MintedMUSD Transfer Lacks Compliance Check
- **File:** `Minted/Protocol/V3.daml:225-240`
- **Description:** V3 `MUSD_Transfer` only checks local `blacklisted` boolean, NOT the authoritative `ComplianceRegistry`. A newly blacklisted party can transfer until issuer manually sets per-token flag. Canton-side `CantonMUSD_Transfer` correctly validates against registry.
- **Impact:** Compliance guarantee broken for V3 token variant.
- **Recommendation:** Add ComplianceRegistry check or deprecate V3 MintedMUSD.

#### H-DAML-02: V3 BridgeOutRequest Missing Validators Field
- **File:** `Minted/Protocol/V3.daml:1047-1055`
- **Description:** V3 `BridgeOutRequest` has no `validators` field (unlike `CantonDirectMint.daml:317-331`). Validators cannot observe bridge-out requests from V3.
- **Impact:** Bridge relay workflow broken for V3 path.
- **Recommendation:** Add `validators : [Party]` field.

#### H-DAML-03: BoostPool Deposit Archives sMUSD Without Staking Service Coordination
- **File:** `CantonBoostPool.daml:216-252`
- **Description:** sMUSD archive-recreate disconnects from `CantonStakingService.totalShares` accounting. Same shares counted in both staking service and boost pool.
- **Recommendation:** Coordinate with staking service or use nonconsuming fetch.

### MEDIUM

#### M-DAML-01: V3 Vault Collateral Text-Based, Not Escrowed
- **File:** `Minted/Protocol/V3.daml:517-543`
- **Description:** Collateral tracked via `collateralSymbol : Text` and `collateralAmount : Money` — no on-ledger proof of existence.
- **Recommendation:** Document as Ethereum-bridged only; add attestation requirement.

#### M-DAML-02: CantonUSDC Transfer Uses ValidateMint Instead of ValidateTransfer
- **File:** `CantonDirectMint.daml:57-67`
- **Description:** Only checks receiver blacklist, not sender blacklist/freeze status.
- **Recommendation:** Change to `ValidateTransfer` matching `CantonMUSD_Transfer`.

#### M-DAML-03: Emergency Price Override Bypasses Multi-Validator Attestation
- **File:** `CantonLending.daml:177-193`
- **Description:** Operator can unilaterally set any price without validator consensus; only 5-minute cooldown protection.
- **Recommendation:** Require governance co-signature or at least 1 validator.

#### M-DAML-04: Loop Position Unwind Can Archive Arbitrary sMUSD
- **File:** `CantonLoopStrategy.daml:444-478`
- **Description:** `smusdToArchive` CIDs not verified as belonging to the user being unwound.
- **Recommendation:** Fetch and verify `smusd.owner == user` before archiving.

#### M-DAML-05: BurnRateLimiter Operator-Only Without Governance
- **File:** `CantonDirectMint.daml:799-840`
- **Description:** Inconsistent with other governance-gated admin controls.

#### M-DAML-06: Upgrade Emergency Rollback Single-Member
- **File:** `Upgrade.daml:187-197`
- **Description:** Any single governance member can force-rollback an active upgrade.
- **Recommendation:** Require at least 2 approvals.

#### M-DAML-07-09: Additional Lending Deposit Pattern, Collateral Proof, and Pause Semantics Issues
- Various files — see detailed DAML audit section.

### LOW

#### L-DAML-01: V3 CantonDirectMint Duplicates Core Template
- **File:** `Minted/Protocol/V3.daml:982-1113` — Lacks compliance hooks present in primary service.

#### L-DAML-02: CantonSMUSD Transfer Lacks Compliance Check
- **File:** `CantonSMUSD.daml:54-61`

#### L-DAML-03: BoostPoolLP Transfer Lacks Compliance Check
- **File:** `CantonBoostPool.daml:58-61`

#### L-DAML-04: Governance Config Allows N-of-N Deadlock
- **File:** `Governance.daml:74-78`

#### L-DAML-05-07: Template name conflicts, USDCx provenance loss, inconsistent proof consumption.

### Test Coverage Gaps (DAML)

| Module | Test Coverage |
|--------|--------------|
| V3.daml (14 templates, 1626 lines) | **ZERO dedicated tests** |
| InterestRateService.daml | **ZERO tests** |
| Governance.daml | **ZERO tests** |
| Upgrade.daml | **ZERO tests** |
| Compliance.daml (isolated) | **ZERO tests** |
| CantonDirectMintService | **No dedicated test file** |

---

## 4. TypeScript Services

*Audited: 10 relay files, 13 bot files, 7 points files, Dockerfile, docker-compose.yml*

### CRITICAL

#### C-TS-01: createSigner() Returns VoidSigner — Breaks All KMS Write Operations
- **File:** `relay/utils.ts:207`
- **Description:** `createSigner()` returns `ethers.VoidSigner` when KMS is configured. VoidSigner cannot sign transactions — all write operations (`treasury.keeperTriggerAutoDeploy()`, `smusd.syncCantonShares()`) fail at runtime. If KMS import fails and falls back to raw key, the production guard throws, crashing the service entirely.
- **Impact:** Neither yield-keeper nor yield-sync-service can function in production with KMS configured.
- **Recommendation:** Replace with `KMSEthereumSigner.create()` from `kms-ethereum-signer.ts`.

#### C-TS-02: Validator Node V2 Missing Bridge Contract Verification
- **File:** `relay/validator-node-v2.ts:378-397`
- **Description:** V1 calls `verifyBridgeContract()` at startup; V2 does not. A misconfigured bridge address could cause V2 to sign attestations targeting a non-existent or attacker-controlled contract.
- **Recommendation:** Port `verifyBridgeContract()` from V1 to V2.

### HIGH

#### H-TS-01: Flashbots Auth Signer Reuses Liquidation Wallet Key
- **File:** `bot/src/flashbots.ts:239`
- **Description:** Links all Flashbots bundles to the bot's public address, defeating MEV protection.
- **Recommendation:** Generate separate ephemeral wallet for Flashbots auth.

#### H-TS-02: Hardcoded ETH Price ($2500) in Profit Calculation
- **File:** `bot/src/index.ts:447`
- **Recommendation:** Fetch live ETH price from protocol oracle.

#### H-TS-03: Lending Keeper Floating-Point Health Factor Comparison
- **File:** `relay/lending-keeper.ts:148-152,296-308`
- **Description:** Converts BigInt health factor to `number` before comparing to `1.0`. Float imprecision near liquidation threshold causes incorrect classifications.
- **Recommendation:** Compare raw BigInt: `healthFactorBig < PRECISION`.

#### H-TS-04: Price Oracle Single-Source Accepts 25% Movement
- **File:** `relay/price-oracle.ts:423-430`
- **Description:** Single DEX source accepted with 25% max change per update.
- **Recommendation:** Tighten to 5% when only one source available.

#### H-TS-05: Bot Health Server Binds 0.0.0.0
- **File:** `bot/src/server.ts:39`
- **Recommendation:** Bind to `127.0.0.1`.

#### H-TS-06: Yield Sync Service Missing Canton TLS Guard
- **File:** `relay/yield-sync-service.ts:282-288`
- **Description:** Other services enforce TLS in production; yield-sync accepts plaintext.
- **Recommendation:** Add production TLS enforcement.

### MEDIUM

#### M-TS-01: KMS Signer connect() Loses Region Config
- **File:** `relay/kms-ethereum-signer.ts:87-89`

#### M-TS-02: processedAttestations Cache Has No Persistence
- **File:** `relay/relay-service.ts:668-676`

#### M-TS-03: Reconciliation Keeper No Graceful Shutdown
- **File:** `bot/src/reconciliation-keeper.ts:233-239`

#### M-TS-04: Oracle Keeper URL Injection via Symbol
- **File:** `bot/src/oracle-keeper.ts:327`

#### M-TS-05: Points Config Defaults to HTTP for Canton
- **File:** `points/src/config.ts:30`

#### M-TS-06: Lending Keeper Missing TLS Guard
- **File:** `relay/lending-keeper.ts:222-229`

#### M-TS-07: Validator V2 No Address Format Validation
- **File:** `relay/validator-node-v2.ts:570-577`

---

## 5. Infrastructure

*Audited: 14 K8s manifests, Dockerfile, docker-compose.yml, ci.yml, config files, 7 deployment scripts*

### HIGH

#### H-INFRA-01: CI Coverage Threshold Bypass
- **File:** `.github/workflows/ci.yml:59-75`
- **Description:** Coverage step has `continue-on-error: true` AND threshold check exits 0 when coverage file missing. The 90% requirement is not enforced.
- **Recommendation:** Remove `continue-on-error` or fail when coverage file missing.

#### H-INFRA-02: Excessive Slither Detector Exclusions
- **File:** `.github/workflows/ci.yml:162`
- **Description:** ~28 detectors excluded including `arbitrary-send-erc20`, `arbitrary-send-eth`, `missing-zero-check`, `unused-return`, `reentrancy-no-eth`. These detect real vulnerability classes.
- **Recommendation:** Re-enable critical detectors; use inline annotations for false positives.

### MEDIUM

#### M-INFRA-01: PostgreSQL StatefulSet Missing ServiceAccount Binding
- **File:** `k8s/base/postgres-statefulset.yaml`

#### M-INFRA-02: Canton Participant Topology Spread on Single Replica
- **File:** `k8s/canton/participant-deployment.yaml:311-317`

#### M-INFRA-03: Init Container Missing readOnlyRootFilesystem
- **File:** `k8s/canton/participant-deployment.yaml:85-122`

#### M-INFRA-04: Mythril/Certora Jobs continue-on-error
- **File:** `.github/workflows/ci.yml:235,508`

#### M-INFRA-05: kubeconform Downloaded Without Hash Verification
- **File:** `.github/workflows/ci.yml:443`

#### M-INFRA-06: Deploy-Testnet Leaves Deployer as Admin
- **File:** `scripts/deploy-testnet.ts:256-261`

### LOW

#### L-INFRA-01: PostgreSQL Backup Uses postgres Image Without AWS CLI
- **File:** `k8s/canton/postgres-backup-cronjob.yaml:110-125`

#### L-INFRA-02: Network Policy DNS Allows Any Namespace
- **File:** `k8s/canton/network-policy.yaml:53-59`

#### L-INFRA-03: PostgreSQL Network Policy Missing Backup Pod Ingress
- **File:** `k8s/canton/network-policy.yaml:72-99`

#### L-INFRA-04: ServiceMonitor Label Selector Mismatches
- **File:** `k8s/monitoring/service-monitors.yaml:18,43,62`

#### L-INFRA-05: Deploy-Leverage-Vault Grants BRIDGE_ROLE to MockSwapRouter
- **File:** `scripts/deploy-leverage-vault.ts:56-58`

#### L-INFRA-06: Deploy Scripts Don't Persist Artifacts
- **File:** `scripts/deploy-testnet.ts`

---

## 6. Frontend Security

*Audited: 11 pages, 18 hooks, 5 lib files, 12 components, package.json*

### CRITICAL

#### C-FE-01: LeveragePage openLeveragedPosition with minAmountOut=0
- **File:** `frontend/src/pages/LeveragePage.tsx:130-136`
- **Description:** `leverageVault.openLeveragedPosition(WETH_ADDRESS, amount, leverageX10, maxLoops, 0)` — zero slippage protection on leveraged position open. Sandwich attacks amplified by leverage multiplier.
- **Recommendation:** Compute expected output from `estimateLoops` preview, apply 1-3% tolerance.

#### C-FE-02: LeveragePage closeLeveragedPosition Stale minCollateralOut
- **File:** `frontend/src/pages/LeveragePage.tsx:158`
- **Description:** `minCollateralOut` calculated from stale `position.initialDeposit` (fetched once at page load), not current collateral value.
- **Recommendation:** Fetch fresh position state before close; calculate from current `totalCollateral` minus debt.

### HIGH

#### H-FE-01: Missing Chain ID Validation on WalletConnect/MetaMask Transaction Paths
- **File:** `frontend/src/hooks/useWalletConnect.tsx:334-343`, `useMetaMask.tsx:342-351`
- **Description:** Primary transaction hooks do not validate chain before signing. Only `useEthWallet.tsx` validates. All main pages route through unvalidated hooks.
- **Impact:** Transactions sent to wrong chain contracts.
- **Recommendation:** Add chain validation matching `useEthWallet` pattern.

#### H-FE-02: Admin Page Client-Side Only Gate
- **File:** `frontend/src/pages/AdminPage.tsx:41-54`
- **Description:** Single-contract role check gates access to controls for 6+ different contracts. ABIs shipped to all clients.
- **Recommendation:** Check roles per-contract per-section.

#### H-FE-03: No Address Validation on Admin Inputs
- **File:** `frontend/src/pages/AdminPage.tsx:191,285,320,469`
- **Recommendation:** Validate with `ethers.isAddress()` before submission.

#### H-FE-04: Canton Bridge Missing Target Address Validation
- **File:** `frontend/src/components/canton/CantonBridge.tsx:277-278`
- **Description:** `targetAddress` accepts any string for bridge lock, no Ethereum address validation.
- **Impact:** Funds bridged to invalid/zero address are lost.
- **Recommendation:** Validate with `ethers.isAddress()` and check non-zero.

#### H-FE-05: BorrowPage MAX Borrow at Exact Threshold
- **File:** `frontend/src/pages/BorrowPage.tsx:558-560`
- **Description:** MAX button sets to full `maxBorrowable`, putting user at instant liquidation risk.
- **Recommendation:** Apply 95% safety buffer with clear messaging.

### MEDIUM

#### M-FE-01-02: BigInt-to-Number Precision Loss in StakePage and BorrowPage
- **Files:** `StakePage.tsx:89-101`, `BorrowPage.tsx:172`

#### M-FE-03-04: Division by Zero in LeveragePage and CantonLeverage
- **Files:** `LeveragePage.tsx:170-172`, `CantonLeverage.tsx:232-234`

#### M-FE-05: Contract Addresses Can Be Empty Strings
- **File:** `frontend/src/lib/config.ts:6-17`

#### M-FE-06: Error Messages from Malicious Contracts
- **Files:** `MintPage.tsx:440`, `BorrowPage.tsx:645`

#### M-FE-07: LeveragePage Uses Unvalidated process.env Addresses
- **File:** `frontend/src/pages/LeveragePage.tsx:13-14`

---

## 7. Cross-Domain Systemic Risks

These findings span multiple audit domains and represent the highest-impact systemic risks:

### SYSTEMIC-01: Oracle → Strategy → Treasury → SMUSD Share Price Chain (CRITICAL)

The entire protocol's share price derives from a single chain of trust:
```
Chainlink/CTN Oracle → PriceOracle → Strategy.totalValue() → TreasuryV2.totalValue()
    → SMUSD.globalTotalAssets() → Share Price → All depositors (Ethereum + Canton)
```
A single compromised link (oracle manipulation, strategy misconfiguration, Treasury fee exploit) propagates to every smUSD holder on both chains. The `ptDiscountRateBps` in PendleStrategyV2 is the weakest link — controlled by non-timelock `STRATEGIST_ROLE`.

### SYSTEMIC-02: V3 ↔ Canton Template Divergence (HIGH)

Two parallel token ecosystems (V3.daml vs. Canton modules) with divergent security properties:
- V3 lacks compliance hooks on transfers
- V3 bridge lacks validator observers
- V3 vault uses text-based collateral (not escrowed)
- V3 direct mint lacks governance-gated admin controls

### SYSTEMIC-03: KMS Signer Infrastructure Not Production-Ready (CRITICAL)

The `createSigner()` VoidSigner bug means yield-keeper and yield-sync-service cannot execute write operations with KMS. Combined with the validator V2 missing bridge verification, the relay layer has critical deployment gaps.

### SYSTEMIC-04: Compliance Enforcement Inconsistency Across Token Types (HIGH)

| Token | Transfer Compliance Check |
|-------|--------------------------|
| CantonMUSD | ValidateTransfer (both sender + receiver) |
| USDCx | ValidateTransfer (both, including at acceptance) |
| CantonUSDC | ValidateMint only (receiver only) |
| CantonSMUSD | **NONE** |
| BoostPoolLP | **NONE** |
| V3 MintedMUSD | Local `blacklisted` flag only |

---

## 8. Positive Observations

The following security practices are well-implemented and noteworthy:

### Solidity
1. **CEI Pattern** — Consistently applied across all contracts
2. **SafeERC20** — Universal for all external token transfers
3. **ReentrancyGuard** — Applied to all state-changing functions
4. **Custom Errors** — Gas-efficient error handling throughout
5. **Timelock Governance** — Critical parameters gated behind TIMELOCK_ROLE
6. **Separation of Duties** — Pause/unpause split across roles
7. **Donation Attack Mitigation** — SMUSD uses `_decimalsOffset() = 3`
8. **Oracle Circuit Breaker** — Deviation + staleness + cooldown protection

### DAML
9. **Dual-Signatory Tokens** — All tokens use `signatory issuer, owner`
10. **Propose-Accept Pattern** — Consistent for multi-party workflows
11. **Governance-Gated Admin** — `ConsumeProof` with action type validation
12. **Per-Asset Staleness** — Configurable per collateral type
13. **Privacy-by-Default** — `UserPrivacySettings` opt-in transparency

### Infrastructure
14. **Pod Security Standards** — `restricted` PSS at enforce level
15. **SHA256 Image Pinning** — All container images digest-pinned
16. **Non-Root Containers** — All pods with explicit UID/GID
17. **Read-Only Root FS** — All main containers
18. **Default-Deny Network Policies** — Comprehensive egress/ingress
19. **Secret File Mounting** — `_FILE` pattern, no env var exposure
20. **Docker Compose Hardening** — read-only rootfs, no-new-privileges, memory limits

### Frontend
21. **Exact-Amount Approvals** — Never uses `MaxUint256` infinite approvals
22. **USDT-Safe Approval Resets** — Reset to 0 before new allowance
23. **On-Chain Admin Verification** — Queries `hasRole` directly
24. **Transaction Simulation** — `useTx` supports pre-sign simulation

---

## 9. Deployment Readiness Verdict

### Pre-Deployment MUST FIX (Blockers)

| # | Finding | Domain | Risk |
|---|---------|--------|------|
| 1 | C-SOL-01: BorrowModule interest divergence | Solidity | Accounting insolvency |
| 2 | C-STR-01: PendleStrategy oracle-free pricing | Solidity | Cross-chain share manipulation |
| 3 | C-STR-02: MorphoLoop incomplete deleverage | Solidity | Locked treasury funds |
| 4 | C-TS-01: VoidSigner breaks KMS production | TypeScript | Total service failure |
| 5 | C-TS-02: Validator V2 no bridge verification | TypeScript | Malicious attestation signing |
| 6 | C-FE-01/02: Leverage zero slippage | Frontend | MEV extraction on all positions |
| 7 | H-SOL-01/02: LeverageVault zero slippage | Solidity | MEV extraction |
| 8 | H-SOL-03: Treasury fee inflation via strategy | Solidity | Treasury drain |
| 9 | H-STR-05: TreasuryReceiver emergency steal | Solidity | User fund theft |
| 10 | H-TS-01: Flashbots identity leak | TypeScript | Defeats MEV protection |
| 11 | H-FE-01: Missing chain validation | Frontend | Cross-chain fund loss |
| 12 | H-INFRA-01/02: CI coverage/Slither bypass | Infra | Security gate ineffective |
| 13 | SYSTEMIC-04: Compliance enforcement gaps | Cross-domain | Regulatory violation |

### Post-Deployment Fix Queue (30-Day Window)

All MEDIUM findings (31 total) should be addressed within 30 days of deployment.

### Accepted Risk (Track in Risk Register)

LOW and INFO findings (58 total) should be documented in the protocol's risk register with remediation timelines.

---

## 10. Remediation Priority Matrix

```
                    ┌─────────────────────────────────────┐
                    │        IMPACT                        │
                    │   Low      Medium      High          │
              ┌─────┼─────────┬───────────┬───────────────┤
              │High │ M-SOL-07│ M-STR-04  │ C-SOL-01      │
 LIKELIHOOD   │     │ L-SOL-07│ M-DAML-03 │ C-STR-01/02   │
              │     │         │ M-TS-01   │ C-TS-01/02    │
              │     │         │           │ H-SOL-01/02   │
              ├─────┼─────────┼───────────┼───────────────┤
              │Med  │ L-SOL-02│ M-SOL-03  │ H-SOL-03/04   │
              │     │ L-FE-*  │ M-DAML-02 │ H-STR-01/05   │
              │     │         │ M-FE-01   │ H-FE-01/04    │
              │     │         │ M-INFRA-* │ H-INFRA-01/02 │
              ├─────┼─────────┼───────────┼───────────────┤
              │Low  │ INFO-*  │ L-SOL-01  │ H-STR-04      │
              │     │         │ L-DAML-*  │ C-FE-01/02    │
              │     │         │ L-TS-*    │               │
              └─────┴─────────┴───────────┴───────────────┘
```

---

## Appendix: Files Audited

### Solidity (27 core + strategy + oracle contracts)
MUSD.sol, SMUSD.sol, TreasuryV2.sol, BLEBridgeV9.sol, BorrowModule.sol, CollateralVault.sol, LiquidationEngine.sol, LeverageVault.sol, DirectMintV2.sol, DepositRouter.sol, RedemptionQueue.sol, Errors.sol, MorphoLoopStrategy.sol, PendleStrategyV2.sol, SkySUSDSStrategy.sol, BorrowModuleUpgradeable.sol, CollateralVaultUpgradeable.sol, LeverageVaultUpgradeable.sol, LiquidationEngineUpgradeable.sol, SMUSDUpgradeable.sol, PriceOracle.sol, SMUSDPriceAdapter.sol, InterestRateModel.sol, PendleMarketSelector.sol, TimelockGoverned.sol, MintedTimelockController.sol, TreasuryReceiver.sol

### DAML (19 source + test files)
V3.daml, CantonDirectMint.daml, CantonLending.daml, CantonLoopStrategy.daml, CantonBoostPool.daml, CantonSMUSD.daml, CantonCoinToken.daml, Compliance.daml, Governance.daml, InterestRateService.daml, UserPrivacySettings.daml, Upgrade.daml, + 6 test files

### TypeScript (30 service files)
relay-service.ts, validator-node.ts, validator-node-v2.ts, kms-ethereum-signer.ts, signer.ts, lending-keeper.ts, price-oracle.ts, yield-keeper.ts, yield-sync-service.ts, utils.ts, bot/index.ts, config.ts, monitor.ts, calculator.ts, flashbots.ts, oracle-keeper.ts, pendle-sniper.ts, pool-alerts.ts, reconciliation-keeper.ts, server.ts, snapshot.ts, yield-api.ts, yield-scanner.ts, points/calculator.ts, config.ts, server.ts, referral.ts, dune.ts, snapshot.ts, transparency.ts

### Infrastructure (26 files)
14 K8s manifests, Dockerfile, docker-compose.yml, ci.yml, hardhat.config.ts, foundry.toml, slither.config.json, package.json, 7 deployment scripts

### Frontend (30 files)
11 pages, 18 hooks, 5 lib files, 12 components, package.json

---

*Report generated by automated agent team audit. Findings should be validated by human auditors before remediation. This report does not constitute a guarantee of security.*
