# 🔒 Minted mUSD Protocol — Institutional Solidity Security Audit

**Date:** 2026-02-14  
**Auditor:** Minted Security Team — Solidity  
**Scope:** All Solidity smart contracts in `contracts/`  
**Compiler:** Solidity 0.8.26 (overflow/underflow protection built-in)  
**Framework:** Hardhat + OpenZeppelin 5.x  

---

## 1. Executive Summary

The Minted mUSD protocol is a sophisticated cross-chain stablecoin system spanning 36 non-empty contracts totaling **~20,115 lines** of Solidity. The architecture includes a USDC-backed stablecoin (mUSD), yield vault (smUSD/ERC-4626), over-collateralized borrowing, multi-strategy treasury, cross-chain bridge (Wormhole + Canton), leverage vault, and liquidation engine.

The codebase demonstrates strong security posture overall. Previous audit findings (SOL-H-01 through SOL-H-04) have been remediated. Critical parameters across most contracts are properly gated by `TIMELOCK_ROLE` enforced via `MintedTimelockController` (48h delay). ReentrancyGuard, SafeERC20, Pausable, and CEI pattern are consistently applied.

**However, several contracts have inconsistent access control for sensitive parameters, and a handful of state-changing admin functions remain gated only by `DEFAULT_ADMIN_ROLE` instead of `TIMELOCK_ROLE`, breaking the governance model.**

| Severity | Count |
|----------|-------|
| CRITICAL | 0     |
| HIGH     | 4     |
| MEDIUM   | 7     |
| LOW      | 8     |
| **Total** | **19** |

**Overall Solidity Readiness Score: 88 / 100**

---

## 2. Contracts Audited

| # | Contract | Lines | Category |
|---|----------|-------|----------|
| 1 | MUSD.sol | 130 | Core Token |
| 2 | SMUSD.sol | 340 | Yield Vault (ERC-4626) |
| 3 | CollateralVault.sol | 318 | Lending |
| 4 | BorrowModule.sol | 909 | Lending |
| 5 | DirectMintV2.sol | 335 | Mint/Redeem |
| 6 | TreasuryV2.sol | 1,006 | Treasury (UUPS) |
| 7 | LiquidationEngine.sol | 297 | Liquidation |
| 8 | PriceOracle.sol | 353 | Oracle |
| 9 | BLEBridgeV9.sol | 538 | Bridge (UUPS) |
| 10 | InterestRateModel.sol | 289 | Rate Curve |
| 11 | LeverageVault.sol | 822 | Leverage |
| 12 | RedemptionQueue.sol | 242 | Redemption |
| 13 | TreasuryReceiver.sol | 346 | Cross-Chain |
| 14 | DepositRouter.sol | 431 | Cross-Chain |
| 15 | SMUSDPriceAdapter.sol | 275 | Oracle Adapter |
| 16 | UniswapV3TWAPOracle.sol | 149 | TWAP Oracle |
| 17 | GlobalPauseRegistry.sol | 68 | Emergency |
| 18 | GlobalPausable.sol | 33 | Emergency |
| 19 | TimelockGoverned.sol | 81 | Governance |
| 20 | MintedTimelockController.sol | 80 | Governance |
| 21 | PendleMarketSelector.sol | 540 | Strategy Infra (UUPS) |
| 22 | Errors.sol | 241 | Shared Errors |
| 23 | BorrowModuleUpgradeable.sol | 1,112 | Upgradeable |
| 24 | CollateralVaultUpgradeable.sol | 306 | Upgradeable |
| 25 | LeverageVaultUpgradeable.sol | 851 | Upgradeable |
| 26 | LiquidationEngineUpgradeable.sol | 241 | Upgradeable |
| 27 | SMUSDUpgradeable.sol | 525 | Upgradeable |
| 28 | PendleStrategyV2.sol | 1,358 | Strategy |
| 29 | AaveV3LoopStrategy.sol | 1,097 | Strategy |
| 30 | ContangoLoopStrategy.sol | 1,199 | Strategy |
| 31 | EulerV2CrossStableLoopStrategy.sol | 1,026 | Strategy |
| 32 | FluidLoopStrategy.sol | 936 | Strategy |
| 33 | EulerV2LoopStrategy.sol | 841 | Strategy |
| 34 | CompoundV3LoopStrategy.sol | 834 | Strategy |
| 35 | MorphoLoopStrategy.sol | 821 | Strategy |
| 36 | SkySUSDSStrategy.sol | 453 | Strategy |

**Empty stubs (0 lines, excluded from scoring):** MetaVault, PriceAggregator, MorphoMarketRegistry, YieldScanner, YieldVerifier, ReferralRegistry, StrategyFactory, all adapters, all libraries = 12 files.

**Total non-empty contracts: 36 | Total lines: ~20,115**

---

## 3. Findings

### 🔴 HIGH Severity

#### H-01: SMUSD.setTreasury() gated by DEFAULT_ADMIN_ROLE instead of TIMELOCK_ROLE

**Contract:** [SMUSD.sol](contracts/SMUSD.sol#L194)  
**Impact:** The treasury address determines `globalTotalAssets()`, which drives `globalSharePrice()` — the core metric for cross-chain yield distribution to all smUSD holders (Ethereum + Canton). A compromised `DEFAULT_ADMIN_ROLE` can instantly swap the treasury to a malicious contract that reports inflated `totalValue()`, creating phantom yield, or deflated values, causing incorrect share pricing.  
**Root Cause:** `setTreasury()` uses `onlyRole(DEFAULT_ADMIN_ROLE)` whereas every other critical setter in the borrowing subsystem uses `TIMELOCK_ROLE`.

```solidity
// SMUSD.sol:194 — should be TIMELOCK_ROLE
function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
```

**Recommendation:** Change to `onlyRole(TIMELOCK_ROLE)`, add a TIMELOCK_ROLE definition, and grant it to `MintedTimelockController`. This aligns with the governance model used by BorrowModule, DirectMintV2, and LiquidationEngine.

---

#### H-02: RedemptionQueue critical parameters lack TIMELOCK_ROLE

**Contract:** [RedemptionQueue.sol](contracts/RedemptionQueue.sol#L223-L230)  
**Impact:** `setMaxDailyRedemption()` and `setMinRequestAge()` are gated only by `DEFAULT_ADMIN_ROLE`. A compromised admin can:  
- Set `maxDailyRedemption = 0` → freeze all redemptions permanently  
- Set `minRequestAge = type(uint256).max` → block all fulfillments  
- Set `minRequestAge = 0` → bypass cooldown protections  

These are protocol-level economic parameters that control liquidity access for all users.

**Recommendation:** Gate both setters with `TIMELOCK_ROLE` to enforce 48h governance delay. The unpause function should also use `TIMELOCK_ROLE` for consistency with BorrowModule and DirectMintV2.

---

#### H-03: LeverageVault.emergencyWithdraw() has no pause guard or timelock

**Contract:** [LeverageVault.sol](contracts/LeverageVault.sol#L757)  
**Impact:** `emergencyWithdraw(token, amount)` is gated only by `DEFAULT_ADMIN_ROLE` with no `whenPaused` restriction and no timelock delay. A compromised admin can drain any ERC-20 token held by the contract (including user collateral passing through during leverage loops) at any time.

```solidity
function emergencyWithdraw(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    IERC20(token).safeTransfer(msg.sender, amount);
}
```

**Recommendation:** Add `whenPaused` modifier (as DepositRouter does) and consider gating with `onlyTimelock`. Add a check that prevents extracting the primary collateral tokens of active positions.

---

#### H-04: Inconsistent unpause governance creates subsystem desync

**Contracts:** CollateralVault, LiquidationEngine, SMUSD, TreasuryV2, RedemptionQueue, LeverageVault  
**Impact:** The borrowing subsystem has inconsistent unpause governance:

| Contract | Unpause Role | Delay |
|----------|-------------|-------|
| BorrowModule | TIMELOCK_ROLE | 48h ✅ |
| DirectMintV2 | TIMELOCK_ROLE | 48h ✅ |
| DepositRouter | TIMELOCK_ROLE | 48h ✅ |
| TreasuryReceiver | onlyTimelock | 48h ✅ |
| CollateralVault | DEFAULT_ADMIN_ROLE | Instant ❌ |
| LiquidationEngine | DEFAULT_ADMIN_ROLE | Instant ❌ |
| SMUSD | DEFAULT_ADMIN_ROLE | Instant ❌ |
| TreasuryV2 | DEFAULT_ADMIN_ROLE | Instant ❌ |
| RedemptionQueue | DEFAULT_ADMIN_ROLE | Instant ❌ |
| LeverageVault | DEFAULT_ADMIN_ROLE | Instant ❌ |

A compromised admin can selectively unpause contracts to create states where, e.g., liquidations are active but borrowing isn't, or the treasury is active but the vault is paused — enabling economic exploits.

**Recommendation:** Standardize on TIMELOCK_ROLE for unpause across all core contracts. The only exception should be BLEBridgeV9 which correctly implements a 24h unpause timelock pattern.

---

### 🟡 MEDIUM Severity

#### M-01: MUSD.setSupplyCap() allows DEFAULT_ADMIN to bypass BLEBridgeV9 rate limiting

**Contract:** [MUSD.sol](contracts/MUSD.sol#L58)  
**Impact:** `setSupplyCap()` accepts both `DEFAULT_ADMIN_ROLE` and `CAP_MANAGER_ROLE`. The `BLEBridgeV9` enforces daily rate limits on supply cap increases, but `DEFAULT_ADMIN_ROLE` can bypass all of these protections by calling `setSupplyCap()` directly. Only the 24h cooldown in `MUSD` applies.

**Recommendation:** Gate `setSupplyCap()` with `TIMELOCK_ROLE || CAP_MANAGER_ROLE` instead of `DEFAULT_ADMIN_ROLE || CAP_MANAGER_ROLE`.

---

#### M-02: MUSD.setLocalCapBps() lacks TIMELOCK_ROLE

**Contract:** [MUSD.sol](contracts/MUSD.sol#L82)  
**Impact:** `localCapBps` controls what fraction of the supply cap is mintable on this chain. Changing from 6000 (60%) to 10000 (100%) effectively doubles the local minting capacity. Uses `DEFAULT_ADMIN_ROLE` without timelock delay.

**Recommendation:** Gate with `TIMELOCK_ROLE`.

---

#### M-03: LiquidationEngine.socializeBadDebt() gated by ENGINE_ADMIN_ROLE not TIMELOCK_ROLE

**Contract:** [LiquidationEngine.sol](contracts/LiquidationEngine.sol#L273)  
**Impact:** Bad debt socialization calls `borrowModule.reduceDebt()`, writing off a user's debt. A compromised `ENGINE_ADMIN_ROLE` could selectively socialize bad debt for colluding borrowers, effectively creating free mUSD.

**Recommendation:** Gate with `TIMELOCK_ROLE` or dual-role requirement.

---

#### M-04: TreasuryReceiver.emergencyWithdraw() not timelock-gated

**Contract:** [TreasuryReceiver.sol](contracts/TreasuryReceiver.sol#L329)  
**Impact:** `DEFAULT_ADMIN_ROLE` can extract any token, including the USDC held for pending mints. Users who have completed cross-chain deposits via Wormhole but haven't had mUSD minted yet (pending mints) would lose their funds.

**Recommendation:** Gate with `onlyTimelock` or add a `whenPaused` guard.

---

#### M-05: BorrowModule pendingInterest livelock potential

**Contract:** [BorrowModule.sol](contracts/BorrowModule.sol#L472-L502)  
**Impact:** When SMUSD's `MAX_YIELD_BPS` cap causes `receiveInterest()` to fail, `pendingInterest` grows monotonically. Each retry attempts to route the entire accumulated buffer, making it increasingly likely to exceed the cap again. While `drainPendingInterest()` exists as an escape hatch, it requires TIMELOCK_ROLE (48h delay), during which utilization rates are distorted.

**Recommendation:** Consider splitting `pendingInterest` into smaller tranches for retry, or automatically capping the retry amount to `MAX_YIELD_BPS * currentAssets / 10000`.

---

#### M-06: RedemptionQueue.queue[] grows unboundedly

**Contract:** [RedemptionQueue.sol](contracts/RedemptionQueue.sol#L103)  
**Impact:** The `queue` array only appends. With `MAX_QUEUE_SIZE = 10,000` active requests, but unlimited fulfilled+cancelled entries, the total array length can grow indefinitely. Storage costs increase linearly and `queue.length` becomes unreliable for "pending count" semantics. While `processBatch` uses `nextFulfillIndex` to skip old entries, the storage waste is permanent.

**Recommendation:** Consider using a mapping-based queue with head/tail pointers instead of a dynamic array, or periodically compact the array.

---

#### M-07: SMUSDPriceAdapter rate limiter only effective when updateCachedPrice() is called

**Contract:** [SMUSDPriceAdapter.sol](contracts/SMUSDPriceAdapter.sol#L180-L216)  
**Impact:** The `_getSharePriceUsd()` view function applies rate limiting based on `_lastPrice` and `_lastPriceBlock`, but these are only updated when `updateCachedPrice()` is called externally. If no one calls this function, the rate limiter uses stale state and the protection degrades (becomes a large allowed change window after `MAX_RATE_LIMIT_BLOCKS`).

**Recommendation:** Document the keeper dependency clearly or consider making `latestRoundData()` non-view and auto-updating the cache.

---

### 🟢 LOW Severity

#### L-01: 12 empty contract files in the contracts directory

**Files:** MetaVault.sol (692 lines per wc but empty content), PriceAggregator.sol, MorphoMarketRegistry.sol, YieldScanner.sol, YieldVerifier.sol, ReferralRegistry.sol, StrategyFactory.sol, and all 6 adapters.  
**Impact:** Incomplete implementation. If these are referenced by other contracts or deployment scripts, deployments will fail or produce zero-code contracts.

#### L-02: MUSD.burn() uses manual dual-role check instead of modifier

**Contract:** [MUSD.sol](contracts/MUSD.sol#L103-L105)  
**Impact:** Code readability. The pattern `if (!hasRole(A) && !hasRole(B)) revert` is correct but non-standard for OpenZeppelin AccessControl. A custom modifier would be clearer.

#### L-03: BorrowModule.reconcileTotalBorrows() gas risk with large borrower arrays

**Contract:** [BorrowModule.sol](contracts/BorrowModule.sol#L858-L892)  
**Impact:** The function iterates over an externally-supplied `borrowers` array. With thousands of borrowers, this could exceed the block gas limit. The `MAX_DRIFT_BPS` check provides safety against malicious inputs but not gas exhaustion.

**Recommendation:** Add a `maxBorrowers` cap (e.g., 500 per call) or process in batches.

#### L-04: BLEBridgeV9.migrateUsedAttestations() unbounded loop

**Contract:** [BLEBridgeV9.sol](contracts/BLEBridgeV9.sol#L181-L189)  
**Impact:** Gas limit risk with large attestation arrays. Admin-only so low exploitation risk.

#### L-05: DirectMintV2 redeem fee precision loss for tiny amounts

**Contract:** [DirectMintV2.sol](contracts/DirectMintV2.sol#L166)  
**Impact:** `(musdAmount * redeemFeeBps) / (1e12 * 10000)` loses precision for small `musdAmount`. The 1 wei fee floor mitigates complete fee bypass, but the minimum fee is economically insignificant.

#### L-06: PriceOracle auto-recovery in view doesn't clear circuitBreakerTrippedAt

**Contract:** [PriceOracle.sol](contracts/PriceOracle.sol#L210-L224)  
**Impact:** The view function `_getPrice()` allows price through after cooldown (auto-recovery), but doesn't clear `circuitBreakerTrippedAt`. This means `isCircuitBreakerActive()` checks would still show the breaker as tripped even after auto-recovery. The permissionless `refreshPrice()` handles this, but monitoring could report false positives.

#### L-07: TreasuryV2 fee accrual doesn't account for strategy losses correctly

**Contract:** [TreasuryV2.sol](contracts/TreasuryV2.sol#L646-L667)  
**Impact:** The `peakRecordedValue` high-water mark prevents double-charging fees, but if a strategy suffers a loss and then recovers, fees are only charged on the recovery above the peak. This is actually correct behavior (no fee on recovered principal), but the comments could be clearer about this intentional design.

#### L-08: CollateralVault.addCollateral() supportedTokens cap of 50 may be insufficient

**Contract:** [CollateralVault.sol](contracts/CollateralVault.sol#L100)  
**Impact:** 50 tokens is generous for current usage but may become limiting. Cannot be changed post-deployment. However, the cap prevents gas DoS on loops, which is the correct trade-off.

---

## 4. Per-Contract Security Scores

| Contract | Score | Key Strengths | Key Risks |
|----------|-------|---------------|-----------|
| MUSD.sol | 8/10 | Supply cap cooldown, blacklist, pause | DEFAULT_ADMIN bypasses bridge rate limits |
| SMUSD.sol | 7/10 | Cooldown, donation offset, Canton sync rate-limiting | setTreasury() not timelocked (H-01) |
| CollateralVault.sol | 8/10 | CEI, nonReentrant, SafeERC20, fail-closed oracle | Unpause not timelocked |
| BorrowModule.sol | 9/10 | TIMELOCK on all admin, dynamic rates, reconciliation | pendingInterest livelock (M-05) |
| DirectMintV2.sol | 9/10 | TIMELOCK on fees/limits/feeRecipient, dust prevention | Clean |
| TreasuryV2.sol | 8/10 | UUPS+onlyTimelock, try/catch strategies, HWM fees | unpause DEFAULT_ADMIN |
| LiquidationEngine.sol | 8/10 | TIMELOCK on close factor, unsafe oracle for crashes | socializeBadDebt not timelocked (M-03) |
| PriceOracle.sol | 9/10 | Per-asset deviation, circuit breaker, keeper recovery | Auto-recovery state gap (L-06) |
| BLEBridgeV9.sol | 9/10 | Multi-sig attestation, rate limiting, unpause timelock | Clean, well-designed |
| InterestRateModel.sol | 10/10 | TIMELOCK, max rate validation, self-admin TIMELOCK | No issues found |
| LeverageVault.sol | 7/10 | TWAP oracle, slippage protection, onlyTimelock config | emergencyWithdraw ungated (H-03) |
| RedemptionQueue.sol | 7/10 | FIFO, dust prevention, queue caps | No TIMELOCK on params (H-02) |
| TreasuryReceiver.sol | 8/10 | onlyTimelock admin, pending mint queue, replay prevention | emergencyWithdraw (M-04) |
| DepositRouter.sol | 9/10 | TIMELOCK on all admin, limits, pause | Clean |
| SMUSDPriceAdapter.sol | 8/10 | Rate limiter, donation protection, TIMELOCK bounds | Keeper dependency (M-07) |
| UniswapV3TWAPOracle.sol | 9/10 | Tick math from Uniswap V3, min duration | Clean |
| GlobalPauseRegistry.sol | 10/10 | Clean separation of duties, minimal surface | No issues |
| TimelockGoverned.sol | 10/10 | ERC-7201 namespaced storage, self-migrating | No issues |
| MintedTimelockController.sol | 10/10 | OZ TimelockController, min delay enforcement | No issues |
| PendleMarketSelector.sol | 9/10 | UUPS+TIMELOCK, bounded loops, scoring system | Clean |
| Upgradeable variants (5) | 9/10 | All use TIMELOCK_ROLE for _authorizeUpgrade, storage gaps | Clean |
| Strategies (9) | 8/10 | All UUPS+onlyTimelock, try/catch, bounded loops | Complex DeFi integrations |

---

## 5. Top 5 Most Critical Observations

1. **SMUSD.setTreasury() is the single most impactful non-timelocked setter** — it controls the share price computation for all smUSD holders globally. Compromising this function would affect every depositor.

2. **Unpause governance split** — Half the protocol's contracts require 48h timelock to unpause, the other half allow instant unpause. An attacker who compromises DEFAULT_ADMIN can selectively unpause contracts to create exploitable state inconsistencies.

3. **LeverageVault.emergencyWithdraw() is a direct token extraction path** — No pause requirement, no timelock, no token restrictions. Should be the first function to remediate.

4. **RedemptionQueue parameters control user liquidity access** — Setting `maxDailyRedemption = 0` effectively freezes all redemptions. These parameters need the same governance protection as fee parameters.

5. **The protocol has correctly remediated prior audit findings (SOL-H-01 through SOL-H-04)** — Interest rate model, borrow admin params, PriceOracle feeds, and DirectMintV2 feeRecipient are all properly gated by TIMELOCK_ROLE. This demonstrates strong audit response discipline.

---

## 6. Architecture Assessment

### ✅ Strengths

- **MintedTimelockController** — Centralized 48h governance delay using battle-tested OZ TimelockController
- **TimelockGoverned** — ERC-7201 namespaced storage, safe for UUPS inheritance
- **Circuit breaker with per-asset deviation** — PriceOracle allows tighter bounds for stablecoins
- **BLEBridgeV9 attestation model** — Multi-sig + entropy + Canton state hash + rate limiting
- **Dual oracle paths** — `healthFactor()` (safe) and `healthFactorUnsafe()` (for liquidation during crashes)
- **GlobalPauseRegistry** — Protocol-wide emergency stop with separation of duties
- **All UUPS contracts use TIMELOCK_ROLE for `_authorizeUpgrade()`**
- **Storage gaps present on all upgradeable contracts**
- **SafeERC20 used consistently** — No raw `transfer`/`transferFrom` calls
- **ReentrancyGuard on all state-changing external functions**
- **CEI pattern followed** — State updates before external calls

### ⚠️ Areas for Improvement

- Standardize unpause governance (TIMELOCK_ROLE across all contracts)
- Gate remaining DEFAULT_ADMIN setters with TIMELOCK_ROLE
- Add `whenPaused` to all `emergencyWithdraw()` functions
- Complete the 12 empty contract stubs
- Consider formal verification for core financial functions

---

## 7. Overall Readiness Score

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Access Control | 82/100 | 25% | 20.5 |
| Reentrancy Protection | 98/100 | 15% | 14.7 |
| Input Validation | 95/100 | 10% | 9.5 |
| Economic Security | 90/100 | 20% | 18.0 |
| Upgrade Safety | 97/100 | 10% | 9.7 |
| Emergency Controls | 85/100 | 10% | 8.5 |
| Cross-Contract Integration | 88/100 | 5% | 4.4 |
| Gas Optimization | 90/100 | 5% | 4.5 |
| **Overall** | | **100%** | **88 / 100** |

---

## 8. Remediation Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| 🔴 P1 | H-01: SMUSD.setTreasury() → TIMELOCK_ROLE | Low (1-line change) | High |
| 🔴 P1 | H-03: LeverageVault.emergencyWithdraw() → add whenPaused + timelock | Low | High |
| 🟠 P2 | H-02: RedemptionQueue params → TIMELOCK_ROLE | Low (2-line change) | High |
| 🟠 P2 | H-04: Standardize unpause → TIMELOCK_ROLE | Medium (6 contracts) | High |
| 🟡 P3 | M-01: MUSD.setSupplyCap() → TIMELOCK_ROLE + CAP_MANAGER | Low | Medium |
| 🟡 P3 | M-02: MUSD.setLocalCapBps() → TIMELOCK_ROLE | Low | Medium |
| 🟡 P3 | M-03: socializeBadDebt → TIMELOCK_ROLE | Low | Medium |
| 🟡 P3 | M-04: TreasuryReceiver.emergencyWithdraw → onlyTimelock | Low | Medium |
| 🔵 P4 | All LOW findings | Low-Medium | Low |

---

*End of Audit Report — Minted Security Team*
