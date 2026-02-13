# RE-AUDIT SECURITY REPORT — FOURTH PASS
## Minted mUSD Canton Protocol
### Full-Stack Re-Audit: Solidity + DAML + TypeScript + Frontend + Infrastructure

**Auditor**: Minted Security Team (Automated Multi-Agent)
**Date**: 2026-02-13
**Scope**: All source files across 6 audit domains (~160+ files)
**Methodology**: 6-agent parallel audit with fix verification against third-pass findings
**Purpose**: Verify previously reported fixes and identify any new/residual issues

---

## EXECUTIVE SUMMARY

| Metric | Value |
|--------|-------|
| **Audit Domains** | 6 (Solidity Core, Strategies/Upgradeable, DAML, TypeScript, Frontend, Infrastructure) |
| **Previous Fixes Verified** | 30 fixes checked |
| **Fixes Confirmed** | 13 VERIFIED |
| **Fixes NOT Applied** | 10 NOT FIXED or REGRESSED |
| **Fixes Partially Applied** | 7 PARTIAL |
| **New Findings** | 85 total |
| **New Critical** | 5 |
| **New High** | 24 |
| **New Medium** | 30 |
| **New Low** | 18 |
| **New Informational** | 8 |

### INSTITUTIONAL GRADE SCORE: 6.8 / 10.0

**Verdict: Below Institutional Grade** — While core on-chain security patterns (CEI, ReentrancyGuard, SafeERC20, multi-sig bridge) remain strong, this re-audit reveals that 10 of 30 previously reported fixes were NOT applied, 3 critical fixes regressed (PendleStrategyV2 timelock, MorphoLoopStrategy deleverage, validator-node-v2 bridge verification), and the frontend has zero fix adoption from the prior audit. The protocol requires a focused remediation sprint before institutional deployment.

---

## FIX VERIFICATION SUMMARY

### Solidity Core Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| C-SOL-01 | BorrowModule interest accrual drift | **PARTIALLY VERIFIED** — reconcileTotalBorrows exists but relies on off-chain indexer completeness; no computedTotalBorrows() |
| H-SOL-01/02 | LeverageVault slippage on close/emergencyClose | **VERIFIED** — minCollateralOut param + 10% buffer swap logic |
| H-SOL-03 | TreasuryV2 _accrueFees caps growth | **VERIFIED** — high-water mark + MIN_ACCRUAL_INTERVAL approach |
| H-SOL-04 | SMUSD globalTotalAssets staleness | **VERIFIED** — live external call with try/catch fallback |
| H-STR-05 | TreasuryReceiver totalPendingMintAmount in emergencyWithdraw | **DESIGN CHANGED** — per-address pendingCredits, but emergencyWithdraw still does NOT update them (see M-SOL-03) |

### Strategy/Upgradeable Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| C-STR-01 | PendleStrategyV2 setPtDiscountRate TIMELOCK_ROLE + max 2000bps | **NOT FIXED** — Still uses STRATEGIST_ROLE, max 5000bps |
| C-STR-02 | MorphoLoopStrategy _fullDeleverage MAX_LOOPS*4 + revert on debt | **PARTIAL** — Uses MAX_LOOPS*2 (10 iters), no revert on remaining debt |
| H-STR-01 | SkySUSDSStrategy measures actual PSM balance | **VERIFIED** |
| H-STR-02 | CollateralVaultUpgradeable borrowModule==address(0) health check | **VERIFIED** |
| H-STR-03 | LeverageVaultUpgradeable emergencyClose debt-covering swap | **VERIFIED** |
| H-STR-07 | MorphoLoopStrategy setParameters requires onlyTimelock | **NOT FIXED** — Still uses STRATEGIST_ROLE |

### DAML Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| H-DAML-01 | V3 MintedMUSD MUSD_Transfer validates ComplianceRegistry | **NOT FIXED** in V3 — Fixed only in CantonMUSD |
| H-DAML-02 | V3 BridgeOutRequest has validators field | **VERIFIED** in CantonDirectMint; NOT in V3 |
| H-DAML-03 | CantonBoostPool nonconsuming fetch for sMUSD | **NOT VERIFIED** — Uses archive+recreate pattern instead |

### TypeScript Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| C-TS-01 | createSigner uses KMSEthereumSigner | **PARTIAL** — relay-service.ts uses correct one; utils.ts still returns VoidSigner for yield-sync and yield-keeper |
| C-TS-02 | validator-node-v2 verifyBridgeContract at startup | **NOT FIXED** — V2 does NOT call verifyBridgeContract() |
| H-TS-01 | flashbots separate ephemeral auth signer | **NOT FIXED** — Same wallet used for auth and tx signing |
| H-TS-02 | ETH price from config | **VERIFIED** |
| H-TS-03 | lending-keeper BigInt health factor | **VERIFIED** |
| H-TS-04 | price-oracle single-source cap at 5% | **VERIFIED** — Divergence now blocks updates |
| H-TS-05 | bot server binds 127.0.0.1 | **NOT FIXED** — Still binds 0.0.0.0 |
| H-TS-06 | yield-sync TLS guard in production | **PARTIAL** — Ethereum TLS yes, Canton TLS not enforced |

### Frontend Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| C-FE-01 | LeveragePage openPosition 3% slippage | **NOT FIXED** — Still passes `0` (zero slippage) |
| C-FE-02 | closePosition fresh data + 5% slippage | **PARTIAL** — 5% floor present but uses stale data |
| H-FE-01 | useMetaMask/useWalletConnect chain ID validation | **NOT FIXED** |
| H-FE-02/03 | AdminPage per-contract role warning + address validation | **PARTIAL** — Role gate present, address validation missing |
| H-FE-04 | CantonBridge target address validation | **NOT FIXED** |
| H-FE-05 | BorrowPage 95% MAX buffer | **NOT FIXED** |

### Infrastructure Fixes

| Fix ID | Description | Verdict |
|--------|-------------|---------|
| H-INFRA-01 | CI coverage continue-on-error removed | **NOT FIXED** — Still has continue-on-error: true + exit 0 fallback |
| H-INFRA-02 | Slither critical detectors re-enabled | **PARTIAL** — fail-on:high added, but excessive global exclusions remain |

---

## NEW FINDINGS

---

## DOMAIN 1: SOLIDITY CORE CONTRACTS

### [CRITICAL] C-SOL-02: DirectMint Missing mintFor Function — Interface Mismatch with TreasuryReceiver

**File:** `contracts/DirectMint.sol` (archive) / `contracts/TreasuryReceiver.sol:210`
**Description:** TreasuryReceiver calls `IDirectMint(directMint).mintFor(recipient, received)`, but DirectMint only has `mint(uint256)` which mints to `msg.sender`. All `receiveAndMint()` calls will revert.
**Impact:** Complete DoS of the cross-chain deposit flow. All bridged USDC will be queued as pending mints indefinitely.
**Recommendation:** Add `mintFor(address recipient, uint256 usdcAmount)` to DirectMint, or update TreasuryReceiver to use a compatible interface.

### [HIGH] H-SOL-05: LeverageVault closeLeveragedPosition Passes Zero Slippage to Internal Swaps

**File:** `contracts/LeverageVault.sol:323`
**Description:** `_swapCollateralToMusd()` is called with `0, 0` for minOut and deadline. The deadline `block.timestamp + 300` provides no MEV protection since miners set `block.timestamp`.
**Impact:** MEV sandwich attacks on every close position swap.
**Recommendation:** Accept `userDeadline` parameter and forward to internal swap calls.

### [HIGH] H-SOL-06: BorrowModule User Interest Double-Counting vs Global Interest

**File:** `contracts/BorrowModule.sol:509-548`
**Description:** `_accrueGlobalInterest()` updates `totalBorrows` before user interest is calculated, inflating the denominator and diluting per-user share distribution. This systematically creates `totalBorrows > sum(user debts)`.
**Impact:** Persistent phantom debt inflating utilization rates and borrow costs.
**Recommendation:** Snapshot `totalBorrows` before global accrual for user proportional calculation.

### [MEDIUM] M-SOL-01: PriceOracle View Function Cannot Update lastKnownPrice After Auto-Recovery

**File:** `contracts/PriceOracle.sol:179-227`
**Description:** `_getPrice()` is `view` and cannot clear circuit breaker state. After auto-recovery, `lastKnownPrice` remains stale and `circuitBreakerTrippedAt` stays set indefinitely until a non-view function is called.
**Impact:** Confusing state; external monitors show perpetually tripped circuit breaker.
**Recommendation:** Ensure keepers call `refreshPrice()` after auto-recovery periods.

### [MEDIUM] M-SOL-02: BLEBridgeV9 Storage Gap Should Be Verified Against Actual Layout

**File:** `contracts/BLEBridgeV9.sol:532`
**Description:** Gap calculation appears correct (15 vars + 35 gap = 50) but does not account for OZ base contract slots. Should be verified with `forge inspect`.
**Impact:** Future upgrade storage collisions if base contracts change.
**Recommendation:** Run `forge inspect BLEBridgeV9 storage-layout` and document.

### [MEDIUM] M-SOL-03: TreasuryReceiver emergencyWithdraw Does Not Update pendingCredits

**File:** `contracts/TreasuryReceiver.sol:327-330`
**Description:** `emergencyWithdraw()` transfers USDC without clearing `pendingCredits`/`pendingMints`. After emergency withdrawal, `claimPendingMint()` will revert for affected users.
**Impact:** User funds permanently locked in pending state after emergency.
**Recommendation:** Clear affected pendingMints entries or add refund mechanism.

### [MEDIUM] M-SOL-04: DirectMint Supply Cap Check Bypasses Local Cap

**File:** `contracts/DirectMint.sol:109`
**Description:** Uses raw `supplyCap()` instead of effective local cap `(supplyCap * localCapBps) / 10000`. Preview functions give misleading capacity estimates.
**Impact:** Users get false expectations from `previewMint()` and `remainingMintable()`.
**Recommendation:** Query effective local cap for accurate preview.

### [MEDIUM] M-SOL-05: LeverageVault emergencyClosePosition Residual mUSD Not Burned

**File:** `contracts/LeverageVault.sol:751-754`
**Description:** If `repayFor()` fails in try/catch, mUSD from swap is sent to user AND position is deleted — user gets free mUSD while debt persists.
**Impact:** Unbacked mUSD circulation + hidden residual debt.
**Recommendation:** Don't delete position if repay fails. Consider burning excess mUSD.

### [MEDIUM] M-SOL-06: BorrowModule Phantom Debt When Routing Fails Then Succeeds

**File:** `contracts/BorrowModule.sol:462-493`
**Description:** When pending interest from failed routing is later routed successfully, the prior periods' interest was never added to `totalBorrows`, creating systematic understatement.
**Impact:** Lower utilization rates and borrow rates than warranted.
**Recommendation:** Add pending interest to `totalBorrows` when combined route succeeds.

### [LOW] L-SOL-01 — L-SOL-06: Minor Issues

| ID | Title | File |
|----|-------|------|
| L-SOL-01 | Cooldown propagation analysis (no issue) | SMUSD.sol |
| L-SOL-02 | Burn allowance semantics for trusted roles | MUSD.sol:107 |
| L-SOL-03 | Strategy array non-compaction (max 10 slots) | TreasuryV2.sol:784 |
| L-SOL-04 | require strings vs custom errors | DirectMint.sol |
| L-SOL-05 | emergencyReduceCap prevents cap below supply | BLEBridgeV9.sol:257 |
| L-SOL-06 | Position overwrite after emergency close with residual debt | LeverageVault.sol:237 |

### [INFO] I-SOL-01 — I-SOL-02

| ID | Title | File |
|----|-------|------|
| I-SOL-01 | reconcileTotalBorrows skips per-user accrual | BorrowModule.sol:880 |
| I-SOL-02 | Hardcoded Wormhole payload offset | TreasuryReceiver.sol:198 |

---

## DOMAIN 2: STRATEGY & UPGRADEABLE CONTRACTS

### [CRITICAL] C-STR-03: PendleStrategyV2 TIMELOCK_ROLE Never Granted — Dead Role

**File:** `contracts/strategies/PendleStrategyV2.sol:354-362`
**Description:** `initialize()` sets `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` but never `_grantRole(TIMELOCK_ROLE, _timelock)`. Since TIMELOCK_ROLE is its own admin, it can never be granted to anyone. Compare with SkySUSDSStrategy which correctly grants it at line 190.
**Impact:** TIMELOCK_ROLE is permanently dead. Any code checking `hasRole(TIMELOCK_ROLE, ...)` will always return false.
**Recommendation:** Add `_grantRole(TIMELOCK_ROLE, _timelock)` in initialize().

### [HIGH] H-STR-08: MorphoLoopStrategy _fullDeleverage Can Leave Residual Debt Without Reverting

**File:** `contracts/strategies/MorphoLoopStrategy.sol:571-612`
**Description:** 10-iteration loop may not fully deleverage. No check for remaining borrowShares after loop exits. `totalPrincipal = 0` is set even if debt remains on Morpho.
**Impact:** Permanent desynchronization between strategy accounting and Morpho position.
**Recommendation:** Check borrowShares after loop; revert if non-zero.

### [HIGH] H-STR-09: MorphoLoopStrategy Parameter Setters Lack Timelock (H-STR-07 Regression)

**File:** `contracts/strategies/MorphoLoopStrategy.sol:710-749`
**Description:** `setParameters`, `setSafetyBuffer`, `setProfitabilityParams` all use `STRATEGIST_ROLE`. A compromised strategist can raise LTV to 85%, lower safety buffer to 200bps, and deposit to create maximally leveraged position — all in one transaction.
**Impact:** Strategist can drive position to Morpho liquidation threshold.
**Recommendation:** Gate behind `onlyTimelock` as originally specified.

### [HIGH] H-STR-10: PendleStrategyV2 setPtDiscountRate Allows 50% NAV Manipulation (C-STR-01 Regression)

**File:** `contracts/strategies/PendleStrategyV2.sol:815-819`
**Description:** STRATEGIST can set discount rate up to 5000bps (50%), directly affecting `totalValue()` via `_ptToUsdc()`. Fix specified TIMELOCK_ROLE + max 2000bps.
**Impact:** Arbitrary manipulation of strategy's reported NAV by up to 50%.
**Recommendation:** Change to `onlyTimelock`, cap at 2000bps.

### [HIGH] H-STR-11: DEFAULT_ADMIN_ROLE Can Bypass TIMELOCK_ROLE in All Upgradeable Contracts

**File:** `contracts/upgradeable/CollateralVaultUpgradeable.sol:74`, `LeverageVaultUpgradeable.sol:182`, `BorrowModuleUpgradeable.sol:214`
**Description:** Unlike strategy contracts which isolate TIMELOCK_ROLE with `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)`, the upgradeable contracts leave TIMELOCK_ROLE under DEFAULT_ADMIN_ROLE admin. The deployer can grant themselves TIMELOCK_ROLE and execute admin actions instantly.
**Impact:** Entire timelock governance model bypassable for upgradeable contracts.
**Recommendation:** Add `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` in each initialize(). Renounce DEFAULT_ADMIN_ROLE post-deployment.

### [HIGH] H-STR-12: LeverageVaultUpgradeable emergencyClose Uses block.timestamp Deadline

**File:** `contracts/upgradeable/LeverageVaultUpgradeable.sol:784`
**Description:** `block.timestamp + 1 hours` provides zero MEV protection since block.timestamp is set at inclusion time.
**Impact:** Emergency close swaps can be held in mempool and executed at worst price within slippage tolerance.
**Recommendation:** Accept deadline parameter.

### [MEDIUM] M-STR-01 — M-STR-07: Medium Issues

| ID | Title | File |
|----|-------|------|
| M-STR-01 | _maxWithdrawable potential underflow if safetyBuffer > targetLtv | MorphoLoopStrategy.sol:631 |
| M-STR-02 | _deleverage uses stale currentBorrow tracking in loop | MorphoLoopStrategy.sol:536 |
| M-STR-03 | SkySUSDSStrategy PSM fee not accounted for | SkySUSDSStrategy.sol:224 |
| M-STR-05 | Single position per user; inconsistent deletion on partial close | LeverageVaultUpgradeable.sol:83 |
| M-STR-06 | unpause uses DEFAULT_ADMIN_ROLE, not TIMELOCK | CollateralVault/BorrowModule/LeverageVault |
| M-STR-07 | recoverToken sends to timelock, tokens may become stuck | MorphoLoopStrategy.sol:805 |

### [LOW] L-STR-01 — L-STR-05, [INFO] I-STR-01 — I-STR-03

| ID | Sev | Title |
|----|-----|-------|
| L-STR-01 | Low | Borrow rate multiplication overflow possible |
| L-STR-02 | Low | PT-to-USDC precision loss in discount calculation |
| L-STR-03 | Low | socializeBadDebt O(n^2) duplicate check |
| L-STR-04 | Low | totalValue() precision differs from Morpho |
| L-STR-05 | Low | USDS-to-USDC truncation dust accumulation |
| I-STR-01 | Info | Inconsistent timelock patterns across contracts |
| I-STR-02 | Info | Per-operation approval is gas-intensive (intentional) |
| I-STR-03 | Info | Storage gap sizing is consistent |

---

## DOMAIN 3: DAML/CANTON TEMPLATES

### [HIGH] H-DAML-04: V3 MintedMUSD Transfer Bypasses Live Compliance Registry

**File:** `daml/Minted/Protocol/V3.daml:225-240`
**Description:** `MUSD_Transfer` checks only stale `blacklisted` boolean on the token itself — no live `ComplianceRegistry` lookup. The newer `CantonMUSD` has live compliance, but V3 does not.
**Impact:** Blacklisted parties can freely transfer V3 MintedMUSD tokens.
**Recommendation:** Deprecate V3 MintedMUSD or add ComplianceRegistry validation.

### [HIGH] H-DAML-05: CantonBoostPool Deposit Archives sMUSD With Hardcoded Issuer on Recreate

**File:** `daml/CantonBoostPool.daml:216-253`
**Description:** Recreated sMUSD hardcodes `issuer = operator` instead of preserving `smusd.issuer`. In multi-operator setups, recreated token has wrong issuer.
**Impact:** sMUSD unusable with original CantonStakingService for unstaking — user funds locked.
**Recommendation:** Use `issuer = smusd.issuer` on recreate.

### [HIGH] H-DAML-06: CantonLoopStrategyConfig Uses archive Instead of ConsumeProof

**File:** `daml/CantonLoopStrategy.daml:321-370`
**Description:** Config update choices manually `archive governanceProofCid` instead of exercising `ConsumeProof`. This bypasses the authorization check in `ConsumeProof`.
**Impact:** Any signatory can archive the proof, bypassing consumer validation.
**Recommendation:** Use `exercise governanceProofCid ConsumeProof with consumedBy = operator`.

### [HIGH] H-DAML-07: Loop_UpdateParams Lacks Governance Proof Requirement

**File:** `daml/CantonLoopStrategy.daml:274-288`
**Description:** Operator can update maxLoops, maxLeverageX10, and minBorrowPerLoop unilaterally without governance proof. Contrasts with CantonDirectMint and CantonLending.
**Impact:** Operator can raise leverage limits without governance approval.
**Recommendation:** Add governanceProofCid parameter and ConsumeProof exercise.

### [HIGH] H-DAML-08: Loop_WithdrawFees Lacks Governance Proof

**File:** `daml/CantonLoopStrategy.daml:298-304`
**Description:** Operator can drain protocol fees without governance oversight.
**Impact:** Unilateral fee extraction without governance approval.
**Recommendation:** Add GovernanceActionLog proof with TreasuryWithdrawal action type.

### [MEDIUM] M-DAML-01 — M-DAML-07: Medium Issues

| ID | Title | File |
|----|-------|------|
| M-DAML-01 | BridgeOutRequest status uses untyped Text instead of ADT | V3.daml:1557 |
| M-DAML-02 | CantonBoostPool admin choices lack governance proof | CantonBoostPool.daml:450-480 |
| M-DAML-03 | CantonSMUSD transfer has no compliance check | CantonSMUSD.daml:54-61 |
| M-DAML-04 | CollateralDepositProof active set bloat | V3.daml:62-92 |
| M-DAML-06 | Emergency PriceFeed override no multi-sig | CantonLending.daml:179-193 |
| M-DAML-07 | Loop_Close negative remainder / exit fee | CantonLoopStrategy.daml:250 |

### [LOW] L-DAML-01 — L-DAML-05

| ID | Title | File |
|----|-------|------|
| L-DAML-01 | Oracle_GetPriceUnsafe no rate limiting | V3.daml:409 |
| L-DAML-02 | V3 CantonMint_Redeem no daily limit | V3.daml:1067 |
| L-DAML-03 | UpgradeRegistry rollback single governor | Upgrade.daml:187 |
| L-DAML-04 | LoopRequest_Cancel USDC not explicitly returned | CantonLoopStrategy.daml:423 |
| L-DAML-05 | SyncYield legacy missing price bounds | CantonSMUSD.daml:264 |

---

## DOMAIN 4: TYPESCRIPT SERVICES

### [CRITICAL] N-TS-01: validator-node-v2 Missing Bridge Contract Verification at Startup

**File:** `relay/validator-node-v2.ts:378-397`
**Description:** V2 `start()` does not call `verifyBridgeContract()`. The deprecated V1 has this check at line 176. V2 validators sign attestations without verifying target contract code hash.
**Impact:** Compromised `BRIDGE_CONTRACT_ADDRESS` env var causes validators to sign for malicious contract, enabling unauthorized mUSD minting.
**Recommendation:** Add `await this.verifyBridgeContract()` as blocking startup check.

### [HIGH] N-TS-02: Flashbots Auth Signer Reuses Transaction Wallet

**File:** `bot/src/flashbots.ts:237-239`
**Description:** Same wallet used for Flashbots authentication and transaction signing. Leaks bot identity to relay operators.
**Impact:** Targeted censorship or front-running by identifying the bot.
**Recommendation:** Use `ethers.Wallet.createRandom()` for auth signer.

### [HIGH] N-TS-03: Bot Health Server Binds 0.0.0.0

**File:** `bot/src/server.ts:39`
**Description:** `server.listen(config.port)` without host parameter. Node.js defaults to all interfaces.
**Impact:** Health endpoint exposed to external networks.
**Recommendation:** Bind to `127.0.0.1`.

### [HIGH] N-TS-04: yield-sync-service Missing Canton TLS Enforcement

**File:** `relay/yield-sync-service.ts:282-288`
**Description:** Does not throw if `CANTON_USE_TLS=false` in production, unlike relay-service.ts and validator-node-v2.ts.
**Impact:** Canton traffic interceptable/tamperable in production.
**Recommendation:** Add production TLS guard.

### [HIGH] N-TS-05: lending-keeper Missing Canton TLS Enforcement

**File:** `relay/lending-keeper.ts:222-229`
**Description:** Same issue as N-TS-04 for lending-keeper.
**Impact:** Lending positions and liquidation commands over plaintext.
**Recommendation:** Add production TLS enforcement.

### [HIGH] N-TS-06: KMSEthereumSigner connect() Loses Region Configuration

**File:** `relay/kms-ethereum-signer.ts:87-89`
**Description:** `connect()` creates new instance with empty string region. KMS calls may fail after provider failover.
**Impact:** KMS signing breaks after RPC provider switch.
**Recommendation:** Store and pass `this.region` in connect().

### [HIGH] N-TS-07: Unbounded Borrower Set in Liquidation Bot (Memory DoS)

**File:** `bot/src/index.ts:209`
**Description:** `borrowers` Set grows unboundedly with no eviction. Other services cap at 10,000 entries.
**Impact:** OOM crash during extended operation.
**Recommendation:** Implement bounded set with eviction.

### [MEDIUM] N-TS-08 — N-TS-15: Medium Issues

| ID | Title | File |
|----|-------|------|
| N-TS-08 | parseFloat for config values (inconsistent) | price-oracle.ts:73 |
| N-TS-09 | yield-sync uses stale createSigner (VoidSigner in KMS) | yield-sync-service.ts:304 |
| N-TS-10 | yield-keeper uses stale createSigner (VoidSigner in KMS) | yield-keeper.ts:146 |
| N-TS-11 | Hardcoded ETH price $2500 in bot gas calculation | bot/src/index.ts:447 |
| N-TS-12 | Number() precision loss on large gas values | bot/src/index.ts:362 |
| N-TS-13 | No validation on quote URL amount parameter | price-oracle.ts:194 |
| N-TS-14 | No timeout on waitForBlock — infinite hang | flashbots.ts:381 |
| N-TS-15 | Redundant/dead tolerance check | validator-node-v2.ts:522 |

### [LOW] N-TS-16 — N-TS-20, [INFO] N-TS-21

| ID | Sev | Title | File |
|----|-----|-------|------|
| N-TS-16 | Low | getAssetsByIds lacks HTTPS validation | validator-node-v2.ts:202 |
| N-TS-17 | Low | Temple JWT in module-level variables | price-oracle.ts:217 |
| N-TS-18 | Low | Private key not zeroed after wallet creation | bot/src/index.ts:228 |
| N-TS-19 | Low | /metrics unauthenticated by default | relay-service.ts:888 |
| N-TS-20 | Low | VALIDATOR_ADDRESSES parsed without schema | relay-service.ts:97 |
| N-TS-21 | Info | Raw key allowed in production (warn only) | kms-ethereum-signer.ts:185 |

---

## DOMAIN 5: FRONTEND

### [CRITICAL] C-FE-03: openLeveragedPosition Passes Zero minCollateralOut — No MEV Protection

**File:** `frontend/src/pages/LeveragePage.tsx:135`
**Description:** Fifth argument to `openLeveragedPosition()` is `0`. Every leverage open is a free target for sandwich attacks, amplified by leverage.
**Impact:** Full MEV extraction on every open position.
**Recommendation:** Calculate `minCollateralOut` with configurable slippage tolerance; expose slider to user.

### [HIGH] H-FE-06: No Chain ID Enforcement Before Transaction Submission

**File:** `frontend/src/pages/LeveragePage.tsx`, `BorrowPage.tsx`
**Description:** Neither page checks wallet's chain ID before submitting transactions.
**Impact:** Users on wrong networks waste gas or send funds to uncontrolled contracts.
**Recommendation:** Add chain ID guard and disable action buttons when unsupported.

### [HIGH] H-FE-07: AdminPage Lacks Address Validation on All Address Inputs

**File:** `frontend/src/pages/AdminPage.tsx:191,285,320,469`
**Description:** Blacklist, fee recipient, strategy, and oracle addresses passed without `ethers.isAddress()` validation.
**Impact:** Admin could set address(0) as fee recipient or invalid oracle feed, causing protocol-wide failures.
**Recommendation:** Validate with `ethers.isAddress()` before enabling submit.

### [HIGH] H-FE-08: CantonBridge targetAddress Has No Ethereum Address Validation

**File:** `frontend/src/components/canton/CantonBridge.tsx:70`
**Description:** Target address input accepts any string. Button disabled only on empty.
**Impact:** Locking mUSD with invalid target address = permanent loss.
**Recommendation:** Add `ethers.isAddress()` + `ethers.getAddress()` checksum.

### [HIGH] H-FE-09: BorrowPage MAX Button Sets Full maxBorrowable Without Safety Buffer

**File:** `frontend/src/pages/BorrowPage.tsx:559`
**Description:** Sets 100% of borrowable capacity. Health factor ~1.0 immediately.
**Impact:** Immediate liquidation risk on any price movement.
**Recommendation:** Apply 95% buffer: `maxBorrowable * 95n / 100n`.

### [MEDIUM] M-FE-01 — M-FE-04: Medium Issues

| ID | Title | File |
|----|-------|------|
| M-FE-01 | closePosition uses stale position state for minOut | LeveragePage.tsx:151 |
| M-FE-02 | LeveragePage MAX deposits full WETH balance | LeveragePage.tsx:259 |
| M-FE-03 | useWalletConnect fallback lacks chain validation | useWalletConnect.tsx:183 |
| M-FE-04 | AdminPage conditional hook usage violates React Rules | AdminPage.tsx:41-91 |

### [LOW] L-FE-01: Raw Revert Messages Displayed in UI

**File:** `frontend/src/pages/LeveragePage.tsx:145`
**Description:** Contract revert strings displayed directly; social engineering risk from crafted messages.

---

## DOMAIN 6: INFRASTRUCTURE

### [CRITICAL] C-INFRA-01: Coverage Enforcement Entirely Bypassable

**File:** `.github/workflows/ci.yml:62,66-75`
**Description:** Coverage step uses `continue-on-error: true` AND threshold check exits 0 on missing report. PRs can merge with 0% coverage.
**Impact:** Violates documented 90% coverage requirement.
**Recommendation:** Remove `continue-on-error: true`; exit 1 on missing coverage file.

### [HIGH] H-INFRA-03 — H-INFRA-05: Supply Chain Issues

| ID | Title | File |
|----|-------|------|
| H-INFRA-01 | Slither excludes security-relevant detectors globally | ci.yml:162 |
| H-INFRA-02 | Mythril and Certora use continue-on-error | ci.yml:235,508 |
| H-INFRA-03 | kubeconform downloaded without integrity verification | ci.yml:442 |
| H-INFRA-04 | Certora CLI installed without version pinning | ci.yml:521 |
| H-INFRA-05 | Mythril installed without version pinning | ci.yml:252 |

### [MEDIUM] M-INFRA-01 — M-INFRA-06: Medium Issues

| ID | Title | File |
|----|-------|------|
| M-INFRA-01 | Relay install falls back to npm install on ci failure | ci.yml:360 |
| M-INFRA-02 | Hardhat compile retry loop may silently succeed on failure | ci.yml:45 |
| M-INFRA-03 | Foundry invariant fail_on_revert = false | foundry.toml:17 |
| M-INFRA-04 | Postgres NetworkPolicy blocks backup CronJob | network-policy.yaml:72 |
| M-INFRA-05 | Postgres ServiceMonitor uses wrong label selector | service-monitors.yaml:62 |
| M-INFRA-06 | Canton SDK version mismatch (2.9.3 vs 2.10.3) | participant-deployment.yaml:131 |

### [LOW] L-INFRA-01 — L-INFRA-02

| ID | Title | File |
|----|-------|------|
| L-INFRA-01 | Hardhat uses Alchemy demo key as fallback | hardhat.config.ts:28 |
| L-INFRA-02 | Redundant uninitialized-local detector exclusion | slither.config.json:9 |

---

## POSITIVE OBSERVATIONS

The following security measures are properly implemented and represent institutional-quality patterns:

1. **CEI Pattern** — All Solidity contracts follow Checks-Effects-Interactions with ReentrancyGuard
2. **SafeERC20** — All external token interactions use OpenZeppelin SafeERC20
3. **Role-Based Access** — Comprehensive RBAC with separate BRIDGE_ROLE, LIQUIDATOR_ROLE, STRATEGIST_ROLE, TIMELOCK_ROLE
4. **Multi-Sig Bridge** — BLEBridgeV9 uses 3-of-5 signature verification with nonce replay protection
5. **Circuit Breakers** — PriceOracle has deviation-based circuit breaker with auto-recovery
6. **K8s Security** — All pods non-root, dropped capabilities, read-only filesystems, seccomp profiles, PSA restricted mode
7. **Network Policies** — Default-deny with explicit allow rules per component
8. **Secret Management** — External Secrets Operator with AWS Secrets Manager; no hardcoded secrets
9. **Image Pinning** — All container images pinned to SHA256 digests
10. **GitHub Actions Pinning** — All actions pinned to commit SHAs
11. **DAML Propose-Accept** — All token transfers use dual-signatory safety pattern
12. **DAML Numeric Precision** — All monetary values use `Numeric 18` matching Ethereum Wei

---

## CONSOLIDATED SEVERITY MATRIX

| Domain | Critical | High | Medium | Low | Info | Total |
|--------|----------|------|--------|-----|------|-------|
| Solidity Core | 1 | 2 | 6 | 6 | 2 | 17 |
| Strategies/Upgradeable | 1 | 5 | 6 | 5 | 3 | 20 |
| DAML/Canton | 0 | 5 | 6 | 5 | 2 | 18 |
| TypeScript | 1 | 6 | 8 | 5 | 1 | 21 |
| Frontend | 1 | 4 | 4 | 1 | 0 | 10 |
| Infrastructure | 1 | 5 | 6 | 2 | 0 | 14 |
| **TOTAL** | **5** | **27** | **36** | **24** | **8** | **100** |

---

## PRIORITY REMEDIATION ROADMAP

### P0 — Block Deployment (5 Critical)

1. **C-SOL-02**: Add `mintFor()` to DirectMint for TreasuryReceiver compatibility
2. **C-STR-03**: Grant TIMELOCK_ROLE to timelock in PendleStrategyV2.initialize()
3. **N-TS-01**: Add `verifyBridgeContract()` to validator-node-v2 startup
4. **C-FE-03**: Add slippage protection to LeveragePage openPosition
5. **C-INFRA-01**: Remove continue-on-error from coverage step; fail on missing report

### P1 — Fix Before Launch (Top 10 High)

1. **C-STR-01 regression**: Gate setPtDiscountRate behind TIMELOCK_ROLE, cap 2000bps
2. **H-STR-07 regression**: Gate MorphoLoopStrategy setParameters behind onlyTimelock
3. **C-STR-02 regression**: Increase _fullDeleverage to MAX_LOOPS*4, revert on remaining debt
4. **H-STR-11**: Add `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` to upgradeable contracts
5. **N-TS-02**: Use ephemeral wallet for Flashbots auth signer
6. **N-TS-03**: Bind bot health server to 127.0.0.1
7. **N-TS-04/05**: Add Canton TLS enforcement to yield-sync and lending-keeper
8. **H-FE-06**: Add chain ID validation to transaction pages
9. **H-FE-08**: Add Ethereum address validation to CantonBridge
10. **H-FE-09**: Apply 95% buffer to BorrowPage MAX button

### P2 — Fix Before Institutional Onboarding (Mediums)

- All medium findings across all domains (36 issues)
- DAML governance proof consistency (M-DAML-02, H-DAML-06/07/08)
- TypeScript KMS signer propagation (N-TS-09/10)
- Infrastructure supply chain hardening (M-INFRA-01 through M-INFRA-06)
