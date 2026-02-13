# COMPREHENSIVE SOLIDITY SECURITY AUDIT
## Minted mUSD Canton Protocol — Deep Contract Review
### June 2026

**Scope**: All Solidity contracts in `/contracts/` (~22 core + 5 upgradeable + 3 strategies)  
**Compiler**: Solidity 0.8.26 (built-in overflow protection)  
**Framework**: OpenZeppelin Contracts v5, UUPS Proxy, ERC-4626  
**Methodology**: Manual line-by-line review, 16-category vulnerability assessment

---

## EXECUTIVE SUMMARY

| Metric | Value |
|--------|-------|
| **Contracts Audited** | 30 (18 core + 5 upgradeable + 3 strategies + 4 key interfaces) |
| **Lines of Code** | ~12,500 |
| **Critical Findings** | 0 |
| **High Findings** | 2 |
| **Medium Findings** | 9 |
| **Low Findings** | 12 |
| **Informational** | 8 |
| **Overall Solidity Security Score** | **8.4 / 10** |
| **Cross-Chain Bridge Security Score** | **9.0 / 10** |

---

## 16-CATEGORY VULNERABILITY ASSESSMENT

| # | Category | Score | Assessment |
|---|----------|-------|------------|
| 1 | **Reentrancy** | 9.5/10 | `ReentrancyGuard` / `ReentrancyGuardUpgradeable` on ALL state-changing external functions. CEI pattern followed consistently. `repay()`/`repayFor()` correctly omit `whenNotPaused` to allow repayment during pause. |
| 2 | **Access Control** | 8.5/10 | Granular RBAC with 10+ roles. PAUSER cannot unpause (separation of duties). TIMELOCK_ROLE self-administered (`_setRoleAdmin`) in InterestRateModel and strategies. Minor: non-upgradeable BorrowModule uses `BORROW_ADMIN_ROLE` for dependency setters instead of `TIMELOCK_ROLE`. |
| 3 | **Arithmetic / Overflow** | 9.0/10 | Solidity 0.8.26 built-in protection. BPS arithmetic (10000-based) used correctly throughout. Interest cap at 10% of `totalBorrows` per accrual prevents runaway minting. `unchecked` used only for safe overflow-check in SMUSD `totalInterestReceived`. |
| 4 | **Oracle Manipulation** | 8.5/10 | PriceOracle implements per-asset circuit breaker with configurable thresholds. Dual path: `getPrice()` (safe, reverts on breach) and `getPriceUnsafe()` (for liquidations). Chainlink staleness checked via `updatedAt`. Cooldown-based auto-recovery with keeper override. |
| 5 | **Flash Loan Attacks** | 9.0/10 | SMUSD 24h withdrawal cooldown prevents deposit-harvest-withdraw. Cooldown propagates on `_update()` (transfer). `_decimalsOffset=3` mitigates ERC-4626 donation attacks. No flash-loan-exploitable price dependencies in single-block. |
| 6 | **Frontrunning / MEV** | 8.0/10 | LeverageVault uses user-supplied `swapDeadline` and `userMaxSlippageBps` for Uniswap swaps. Oracle-based `minOut` calculation provides slippage floor. Strategies use per-operation `forceApprove` with zero-reset. MEV on liquidations is inherent to the design (permissionless liquidators). |
| 7 | **Centralization Risks** | 7.5/10 | 48h MintedTimelockController for critical ops. `DEFAULT_ADMIN_ROLE` can unpause immediately (by design). `emergencyClosePosition()` requires `DEFAULT_ADMIN_ROLE`. Non-upgradeable contracts have immutable core dependencies but mutable auxiliary ones (InterestRateModel, SMUSD, Treasury) via `BORROW_ADMIN_ROLE`. |
| 8 | **Upgrade Safety** | 8.5/10 | UUPS pattern with `_disableInitializers()` in all constructors. `_authorizeUpgrade` → `TIMELOCK_ROLE` enforced. Storage gaps (`__gap[35-40]`) present on all upgradeable contracts. ERC-7201 namespaced storage in TimelockGoverned. BorrowModuleUpgradeable preserves deprecated variables for layout compatibility. |
| 9 | **Cross-Chain Security** | 9.0/10 | BLEBridgeV9: 8-layer replay protection (multi-sig validators, attestation entropy, state hash, nonce, timestamp bounds, 24h rate limit, attestation age check, unpause timelock). SMUSD Canton share sync with per-sync 1% cap + 5% daily cap + 4h minimum interval. Wormhole VAA verification in TreasuryReceiver. |
| 10 | **Token Handling** | 9.0/10 | SafeERC20 (`safeTransfer`, `safeTransferFrom`) used universally. `forceApprove` for non-standard ERC-20s. Per-operation approvals in all strategies (no infinite approvals). `recoverToken()` blocks protocol tokens (USDC, mUSD, PT, sUSDS). |
| 11 | **DoS Vectors** | 8.0/10 | `supportedTokens` capped at 50 in CollateralVault. RedemptionQueue array grows unboundedly (no compaction). `try/catch` on strategy calls in TreasuryV2 prevents single strategy DoS. Interest routing failure doesn't block repay/liquidation. Circuit breaker fail-closed in CollateralVault withdrawals (tries unsafe path on catch). |
| 12 | **Logic Errors** | 8.5/10 | `totalBorrows` tracks both principal and interest (post-fix). `totalBorrowsBeforeAccrual` prevents proportional share undercharging. Bad debt tracking with `recordBadDebt` + `socializeBadDebt`. Dust position prevention via `minDebt` on partial repay. `REMAINING_BELOW_MIN_DEBT` check. |
| 13 | **Storage Layout** | 8.0/10 | Gaps present but arithmetic unverified with tooling (e.g., `hardhat-storage-layout`). BorrowModuleUpgradeable keeps deprecated `pendingInterestReceiver` etc. for slot preservation. Multiple inheritance chains increase collision risk without automated verification. |
| 14 | **Event Emission** | 9.5/10 | All state changes emit events. `InterestRoutingFailed` with reason bytes for debugging. `BadDebtRecorded`, `BadDebtCovered`, `BadDebtSocialized` for full lifecycle tracking. `EmergencyRepayFailed` in LeverageVault. `RefundFailed` in DepositRouter (no silent failures). |
| 15 | **Emergency Controls** | 9.0/10 | Pausable on all contracts. PAUSER/ADMIN role separation. BLEBridgeV9 has 24h unpause timelock. Strategies: GUARDIAN pauses, TIMELOCK unpause. `emergencyWithdraw()` in strategies with TREASURY_ROLE recipient validation. Repay/close functions work during pause. |
| 16 | **ERC Standard Compliance** | 9.0/10 | SMUSD: Full ERC-4626 with `_convertToShares`/`_convertToAssets` overrides using `globalTotalAssets()`. `maxWithdraw`/`maxRedeem` capped by local vault balance. SMUSDPriceAdapter: AggregatorV3Interface-compatible with `latestRoundData()`. MUSD: Standard ERC-20 with mint/burn roles. |

### Weighted Category Score

$$\text{Score} = \frac{9.5 + 8.5 + 9.0 + 8.5 + 9.0 + 8.0 + 7.5 + 8.5 + 9.0 + 9.0 + 8.0 + 8.5 + 8.0 + 9.5 + 9.0 + 9.0}{16} = \mathbf{8.38 \approx 8.4/10}$$

---

## HIGH FINDINGS (2)

### H-01: BorrowModule (Non-Upgradeable) — Critical Dependency Setters Bypass Timelock

- **Severity**: HIGH
- **File**: `contracts/BorrowModule.sol`
- **Lines**: `setInterestRateModel()`, `setSMUSD()`, `setTreasury()` functions
- **Description**: The non-upgradeable BorrowModule gates `setInterestRateModel()`, `setSMUSD()`, and `setTreasury()` with `BORROW_ADMIN_ROLE` instead of `TIMELOCK_ROLE`. These functions change where interest is routed (SMUSD), how rates are calculated (InterestRateModel), and the supply reference (Treasury). A compromised `BORROW_ADMIN_ROLE` holder can instantly redirect interest to a malicious contract, set a predatory rate model, or manipulate utilization calculations — all without the 48h governance delay enforced on every other critical parameter.
- **Impact**: Immediate, unannounced changes to interest routing, rate model, or utilization reference. Could drain borrower interest to attacker-controlled address or manipulate rates to force liquidations.
- **Note**: The upgradeable version (`BorrowModuleUpgradeable.sol`) does NOT have these setters — dependencies are set in `initialize()` and can only change via UUPS upgrade (TIMELOCK_ROLE gated). This finding applies only if the non-upgradeable version is deployed.
- **Recommendation**: If the non-upgradeable version is in use, change these functions to `onlyRole(TIMELOCK_ROLE)`. If only the upgradeable version is deployed, this finding can be downgraded to INFORMATIONAL.

### H-02: LiquidationEngine (Non-Upgradeable) — Liquidation Parameters Bypass Timelock

- **Severity**: HIGH
- **File**: `contracts/LiquidationEngine.sol`
- **Lines**: `setCloseFactor()`, `setFullLiquidationThreshold()`
- **Description**: The non-upgradeable LiquidationEngine uses `ENGINE_ADMIN_ROLE` for `setCloseFactor()` and `setFullLiquidationThreshold()`. The close factor (max 50% partial liquidation) and full liquidation threshold (health factor below which 100% liquidation is allowed) are critical risk parameters. Instant changes could allow an admin to set `closeFactorBps = 10000` (100%) and `fullLiquidationThreshold = 10000` (always full liquidation), enabling complete position seizure on any undercollateralized position.
- **Impact**: Malicious admin can maximize liquidation severity instantly, amplifying losses for borrowers during market volatility.
- **Note**: The upgradeable version (`LiquidationEngineUpgradeable.sol`) correctly uses `TIMELOCK_ROLE` for both setters. This finding applies only to the non-upgradeable deployment.
- **Recommendation**: Change to `onlyRole(TIMELOCK_ROLE)` in non-upgradeable version, or confirm only the upgradeable version is deployed.

---

## MEDIUM FINDINGS (9)

### M-01: RedemptionQueue — Unbounded Array Growth

- **Severity**: MEDIUM
- **File**: `contracts/RedemptionQueue.sol`
- **Description**: The `queue` array grows with each redemption request and is never compacted. Canceled and fulfilled entries remain in the array. The `nextIndex` pointer advances but the array length only grows. Over time, `queue.length` becomes large, making `getQueueLength()` misleading and any iteration over the full array (even off-chain) increasingly expensive.
- **Impact**: No on-chain DoS (processing uses `nextIndex`), but the growing array wastes storage and complicates off-chain indexing. In extreme cases (100k+ entries), any function that accesses `queue.length` or iterates may hit gas limits.
- **Recommendation**: Implement periodic compaction that removes fulfilled/canceled entries, or use a linked-list pattern. At minimum, add a `getActiveQueueLength()` view.

### M-02: BorrowModuleUpgradeable — socializeBadDebt O(n²) Duplicate Detection

- **Severity**: MEDIUM
- **File**: `contracts/upgradeable/BorrowModuleUpgradeable.sol`, lines ~860-920
- **Description**: `socializeBadDebt()` uses nested loops for duplicate detection in the `borrowers` array (O(n²) complexity). For large borrower sets (>100 addresses), gas costs become prohibitive. The function iterates twice through the array (once for accrual, once for reduction), each with inner duplicate-check loops.
- **Impact**: If the protocol has many borrowers needing bad debt socialization, the function may revert due to gas limits. This is a governance function (TIMELOCK_ROLE) so it doesn't affect users directly, but could delay bad debt resolution.
- **Recommendation**: Use a `mapping(address => bool) seen` for O(1) duplicate detection, or require the caller to provide a pre-deduplicated list.

### M-03: TreasuryV2 — Strategy totalValue() Manipulation Window

- **Severity**: MEDIUM
- **File**: `contracts/TreasuryV2.sol`
- **Description**: `totalValue()` sums `strategy.totalValue()` across all active strategies. A compromised or buggy strategy can report inflated `totalValue()`, which propagates to SMUSD's `globalTotalAssets()` and affects share price calculations. While SMUSD caps growth at `MAX_GLOBAL_ASSETS_GROWTH_BPS` (10%) per refresh with 1h minimum interval, a persistent inflation over multiple refresh cycles could gradually inflate the share price.
- **Impact**: Slow share price inflation could allow attackers to withdraw more mUSD than deserved, diluting other depositors. The 10%/hr cap limits impact but doesn't prevent it over days.
- **Recommendation**: Add a per-strategy `totalValue()` growth cap within TreasuryV2 itself (e.g., max 5% growth per rebalance cycle per strategy). Consider a time-weighted average for strategy values.

### M-04: SMUSDUpgradeable — globalTotalAssets() Cache Staleness

- **Severity**: MEDIUM
- **File**: `contracts/upgradeable/SMUSDUpgradeable.sol`, `globalTotalAssets()`
- **Description**: When Treasury is unreachable, `globalTotalAssets()` falls back to `lastKnownGlobalAssets`. This cached value has no staleness check — it could be hours or days old. If Treasury goes offline after a significant value change (e.g., strategy loss), deposits/withdrawals will use a stale share price until `refreshGlobalAssets()` is called.
- **Impact**: Depositors could get more shares than deserved (if cached value is higher than reality) or fewer shares (if cached value is lower). The deviation grows with time.
- **Recommendation**: Add a maximum cache age (e.g., 24h). If `lastKnownGlobalAssets` is older than the threshold and Treasury is unreachable, revert deposits/withdrawals to prevent stale-price operations.

### M-05: CollateralVaultUpgradeable — withdrawFor Allows Arbitrary Recipient with skipHealthCheck

- **Severity**: MEDIUM
- **File**: `contracts/upgradeable/CollateralVaultUpgradeable.sol`, `withdrawFor()`
- **Description**: The `withdrawFor()` function (LEVERAGE_VAULT_ROLE) accepts an arbitrary `recipient` address and an optional `skipHealthCheck` flag. When `skipHealthCheck=true`, no health factor validation occurs. If the LEVERAGE_VAULT_ROLE is compromised, an attacker can withdraw any user's collateral to any address without health checks.
- **Impact**: Complete collateral drain for any user if LEVERAGE_VAULT_ROLE is compromised. The non-upgradeable CollateralVault has the same pattern but adds the restriction that `recipient` must be `msg.sender` or `user` — this restriction is MISSING in the upgradeable version.
- **Recommendation**: Add the same `recipient` restriction as the non-upgradeable version: `require(recipient == msg.sender || recipient == user, "INVALID_RECIPIENT")`.

### M-06: MorphoLoopStrategy — No Withdrawal Minimum Check

- **Severity**: MEDIUM
- **File**: `contracts/strategies/MorphoLoopStrategy.sol`, `withdraw()`
- **Description**: The `withdraw()` function calls `_deleverage()` which iteratively repays and withdraws. If `principalNeeded` is very small relative to the position, the deleverage loop may free less than requested due to rounding in the Morpho share→asset conversion. The function returns `freed` which may be less than `amount`, but the caller (TreasuryV2) doesn't verify the withdrawal was fully satisfied.
- **Impact**: TreasuryV2 may receive less USDC than expected from a strategy withdrawal, leading to user withdrawals receiving less than previewed. The `try/catch` in TreasuryV2's `_withdrawFromStrategies()` prevents revert but silently under-delivers.
- **Recommendation**: Add a minimum withdrawal threshold and/or return the shortfall to the caller for proper accounting.

### M-07: BLEBridgeV9 — Storage Gap Arithmetic Unverified

- **Severity**: MEDIUM
- **File**: `contracts/BLEBridgeV9.sol`
- **Description**: The contract declares 15 state variables + `__gap[35]` targeting 50 total slots. However, mappings (`validators`, `usedAttestations`, `usedNonces`) each consume 1 slot for the mapping pointer, and the `address[]` for `validatorList` consumes 1 slot for length + dynamic storage. The actual slot count needs verification with `hardhat-storage-layout` to confirm no collision with future upgrades.
- **Impact**: If slot arithmetic is incorrect, a future upgrade could silently overwrite storage, corrupting state.
- **Recommendation**: Run `npx hardhat storage-layout` and verify total slot count equals 50. Document the layout in a comment.

### M-08: LeverageVaultUpgradeable — Emergency Close Uses block.timestamp Deadline

- **Severity**: MEDIUM  
- **File**: `contracts/upgradeable/LeverageVaultUpgradeable.sol`, `emergencyClosePosition()`
- **Description**: `emergencyClosePosition()` uses `block.timestamp + 1 hours` as the Uniswap swap deadline. Since `block.timestamp` is set by the block proposer, a validator could delay the transaction inclusion and still have it execute within the deadline, potentially at a worse price. This matters less for emergency scenarios but contrasts with the user-supplied deadlines used in normal operations.
- **Impact**: Minor MEV exposure during emergency close. The `emergencySlippageBps` (up to 20%) provides the actual protection.
- **Recommendation**: Accept a deadline parameter in `emergencyClosePosition()` for consistency, or document this as an accepted risk for emergency scenarios.

### M-09: PendleStrategyV2 — PT Discount Rate is Admin-Configurable NAV Metric

- **Severity**: MEDIUM
- **File**: `contracts/strategies/PendleStrategyV2.sol`, `_ptToUsdc()`, `setPtDiscountRate()`
- **Description**: The `ptDiscountRateBps` (used to value PT positions before maturity) is set by the `STRATEGIST_ROLE` with a maximum of 50%. This rate directly affects `totalValue()` which feeds into TreasuryV2 and SMUSD share pricing. A malicious strategist can set an artificially low discount rate, inflating the reported NAV.
- **Impact**: Inflated NAV → inflated SMUSD share price → depositors receive fewer shares, withdrawers receive more mUSD than deserved.
- **Recommendation**: Use an on-chain oracle (Pendle's PT oracle) for discount rate instead of admin-configurable value, or add tighter bounds (e.g., max 20%) and require TIMELOCK_ROLE for changes.

---

## LOW FINDINGS (12)

### L-01: InterestRateModel — TIMELOCK_ROLE Self-Administration in Constructor

- **File**: `contracts/InterestRateModel.sol`
- **Description**: `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` in constructor means only the timelock can grant/revoke TIMELOCK_ROLE. This is correct for security, but if the timelock address is lost or compromised, the InterestRateModel parameters become permanently locked (no recovery path).
- **Recommendation**: Document the recovery procedure (deploy new InterestRateModel and point BorrowModule to it via `setInterestRateModel()`).

### L-02: DirectMintV2 — 1-wei Fee Floor Creates Rounding Asymmetry

- **File**: `contracts/DirectMintV2.sol`
- **Description**: The redeem fee calculation uses `max(calculated_fee, 1)` to prevent zero-fee redemptions. For very small redemptions (< 10000 / feeBps wei), the 1-wei floor charges a proportionally higher fee than intended.
- **Impact**: Negligible financial impact. Prevents fee-free micro-redemptions.
- **Recommendation**: Informational — document the intentional fee floor.

### L-03: MUSD — setSupplyCap Allows Cap Below totalSupply

- **File**: `contracts/MUSD.sol`
- **Description**: `setSupplyCap()` allows setting the cap below `totalSupply()`, which prevents new minting but doesn't burn existing supply. This is documented as an "undercollateralization signal" but could confuse integrators.
- **Recommendation**: Emit a specific `SupplyCapBelowTotalSupply` event when cap < totalSupply.

### L-04: PriceOracle — Circuit Breaker Auto-Recovery Accepts Potentially Stale Price

- **File**: `contracts/PriceOracle.sol`
- **Description**: After cooldown, `refreshPrice()` is permissionless and resets the circuit breaker. If the underlying Chainlink feed returns the same stale/deviated price after cooldown, the circuit breaker clears and the stale price is accepted.
- **Recommendation**: Add a freshness check in `refreshPrice()`: require `updatedAt` to be more recent than the circuit breaker trigger time.

### L-05: DepositRouter — Failed Native Refund Silently Absorbed

- **File**: `contracts/DepositRouter.sol`
- **Description**: When native token refund fails (e.g., recipient is a contract without `receive()`), the refund amount is absorbed by the contract with a `RefundFailed` event. While better than reverting (which would block the deposit), the user loses the excess ETH.
- **Recommendation**: Track failed refunds in a mapping, allowing users to claim later via a `claimRefund()` function.

### L-06: CollateralVault — getSupportedTokens Returns Unbounded Array

- **File**: `contracts/CollateralVault.sol`, `contracts/upgradeable/CollateralVaultUpgradeable.sol`
- **Description**: `getSupportedTokens()` returns the full `supportedTokens` array. While capped at 50 entries by `addCollateral()`, callers should be aware of the gas cost when iterating.
- **Recommendation**: Informational — the 50-token cap is sufficient protection.

### L-07: BorrowModule — minDebt Can Be Set to Zero

- **File**: `contracts/BorrowModule.sol`
- **Description**: `setMinDebt()` requires `_minDebt > 0` but allows values as low as 1 wei, effectively disabling dust protection. The upgradeable version has the same pattern with an additional `<= 1e24` upper bound.
- **Recommendation**: Set a meaningful minimum (e.g., `>= 1e18` = 1 mUSD) to prevent dust positions that are unprofitable to liquidate.

### L-08: SMUSDPriceAdapter — updateCachedPrice Separation from Read

- **File**: `contracts/SMUSDPriceAdapter.sol`
- **Description**: `updateCachedPrice()` must be called separately to update the cached share price, which is then read by `latestRoundData()`. If the keeper stops calling `updateCachedPrice()`, the cached price becomes stale. The `maxPriceChangePerBlock` rate limiter further delays convergence to the true price.
- **Recommendation**: Consider allowing `latestRoundData()` to trigger an update if the cache is stale beyond a threshold.

### L-09: TreasuryReceiver — Hardcoded Wormhole Payload Offset

- **File**: `contracts/TreasuryReceiver.sol`
- **Description**: The recipient address is extracted from Wormhole payload at byte offset 133 (constant `RECIPIENT_PAYLOAD_OFFSET`). This assumes a specific Wormhole TransferWithPayload format. If Wormhole upgrades the message format, this offset becomes incorrect.
- **Recommendation**: Document the Wormhole version dependency and add a format version check.

### L-10: LeverageVaultUpgradeable — Position Struct Not Updated After Interest Accrual

- **File**: `contracts/upgradeable/LeverageVaultUpgradeable.sol`
- **Description**: The `LeveragePosition.totalDebt` stored in the positions mapping is set at open time and never updated as interest accrues. The actual debt is `borrowModule.totalDebt(user)` which includes accrued interest. This creates a discrepancy between the stored position data and actual debt.
- **Impact**: Off-chain consumers reading `positions[user].totalDebt` will understate actual debt. On-chain operations correctly use `borrowModule.totalDebt()`.
- **Recommendation**: Either update `pos.totalDebt` on close or document that `totalDebt` is the initial debt at open time.

### L-11: MorphoLoopStrategy — No Supply Rate Validation in _loop

- **File**: `contracts/strategies/MorphoLoopStrategy.sol`
- **Description**: `_isLoopingProfitable()` checks `maxBorrowRateForProfit` but the `minSupplyRateRequired` field is declared but never checked in the profitability gate. The supply rate validation is incomplete.
- **Recommendation**: Add `minSupplyRateRequired` check to `_isLoopingProfitable()`.

### L-12: SkySUSDSStrategy — PSM Rate Assumption

- **File**: `contracts/strategies/SkySUSDSStrategy.sol`
- **Description**: The strategy assumes PSM swaps at 1:1 USDC↔USDS rate (zero slippage). While Maker's PSM historically maintains this rate, a PSM fee change or depegging would cause silent value loss.
- **Recommendation**: Add a return value check on PSM operations to verify received amounts.

---

## INFORMATIONAL FINDINGS (8)

### I-01: ✅ Exemplary CEI Pattern Compliance

All contracts follow Check-Effects-Interactions consistently. State mutations occur before external calls. Even complex multi-step operations (LeverageVault loops) maintain CEI within each iteration. `ReentrancyGuard` provides defense-in-depth.

### I-02: ✅ Per-Operation Approval Pattern (Post-Remediation)

All three strategies (PendleStrategyV2, SkySUSDSStrategy, MorphoLoopStrategy) now use `forceApprove(amount)` before each external call and `forceApprove(0)` after (where applicable). No infinite approvals remain in the codebase.

### I-03: ✅ Fail-Closed Oracle Fallback in CollateralVault

`_checkHealthFactor()` in CollateralVaultUpgradeable implements a three-tier fallback: (1) try safe oracle → (2) catch, try unsafe oracle → (3) catch, revert with `HEALTH_CHECK_FAILED`. This prevents withdrawals when both oracle paths fail, protecting the protocol during complete oracle failure.

### I-04: ✅ Interest Routing Resilience

BorrowModuleUpgradeable wraps interest minting and SMUSD routing in `try/catch`. If supply cap is hit, interest is tracked as `unroutedInterest` rather than blocking repay/liquidation paths. If SMUSD rejects the interest, the minted mUSD is burned to keep supply clean.

### I-05: ✅ Repay/Close Always Available During Pause

`repay()`, `repayFor()`, `closeLeveragedPosition()`, and `closeLeveragedPositionWithMusd()` correctly omit `whenNotPaused`, ensuring users can always reduce debt and close positions even during emergency pause.

### I-06: ✅ Bad Debt Lifecycle Management

BorrowModuleUpgradeable implements complete bad debt handling: `recordBadDebt()` (zero collateral verification → write-off), `coverBadDebt()` (burn mUSD from reserves), `socializeBadDebt()` (proportional reduction with pre-accrual + post-accrual denominator alignment). The `cumulativeBadDebt` counter provides historical tracking.

### I-07: ✅ ERC-4626 Share Price Consistency

SMUSDUpgradeable overrides both `_convertToShares()` and `_convertToAssets()` (the internal versions) to use `globalTotalAssets()` + `globalTotalShares()`. This ensures preview functions (`previewDeposit`, `previewWithdraw`) match actual execution, preventing arbitrage between preview and execution prices.

### I-08: ✅ SMUSD Donation Attack Mitigation (Multi-Layer)

1. `_decimalsOffset() = 3` creates virtual shares, making donation attacks 1000x more expensive
2. 24h withdrawal cooldown prevents single-block attacks
3. `MAX_YIELD_BPS = 10%` caps single distribution size
4. `MAX_GLOBAL_ASSETS_GROWTH_BPS = 10%` caps globalTotalAssets growth per refresh
5. SMUSDPriceAdapter: `maxPriceChangePerBlock` rate limiter + `minTotalSupply` check

---

## POSITIVE SECURITY PATTERNS

### Architecture Strengths

1. **Defense-in-Depth Bridge Security** — BLEBridgeV9 implements 8 independent protection layers. Even if one layer is bypassed, others prevent exploitation. This exceeds the security of most production cross-chain bridges.

2. **Dual Oracle Path for Liquidation Resilience** — `getPrice()` (circuit breaker enforced) for normal operations, `getPriceUnsafe()` for liquidations. This ensures liquidations proceed during extreme volatility when the circuit breaker trips — exactly when liquidations are most critical.

3. **Graceful Degradation Over Hard Failure** — Interest routing failures don't block repayments. Strategy failures don't block treasury withdrawals (`try/catch`). Oracle failures trigger graceful fallback (unsafe path → cached value → revert). This prevents cascading failures.

4. **Separation of Concern in Pause/Unpause** — PAUSER_ROLE can pause (fast emergency response), DEFAULT_ADMIN_ROLE or TIMELOCK_ROLE required to unpause (prevents immediate toggle abuse). Strategies require TIMELOCK for unpause, adding governance delay to recovery.

5. **Cooldown Propagation** — SMUSD propagates cooldown on transfer via `_update()`, preventing the classic "deposit → transfer to alt → withdraw from alt" cooldown bypass.

6. **Disabled Collateral Asymmetry** — Disabled tokens are excluded from `_borrowCapacity()` (no new borrows against disabled collateral) but included in `_weightedCollateralValue()` (health factor still credits them). This prevents orphaning existing positions while stopping new risk.

7. **TimelockGoverned with ERC-7201** — The `TimelockGoverned` base contract uses ERC-7201 namespaced storage (`keccak256("minted.storage.TimelockGoverned")`), eliminating storage collision risk in the inheritance chain.

8. **Per-Operation Approvals** — All strategies use `forceApprove(amount)` + `forceApprove(0)` pattern. No infinite approvals anywhere in the codebase. This limits blast radius if an external protocol (Pendle, Morpho, Sky PSM) is compromised.

9. **Emergency Close with Snapshot Protection** — `emergencyClosePosition()` in LeverageVault snapshots `collateralBefore` and `musdBefore` to return only the delta, preventing sweeping of other users' residuals held by the contract.

10. **Canton Share Sync Rate Limiting** — Per-sync 1% change cap + daily 5% cumulative cap + 4h minimum interval + sequential epoch enforcement. Even a compromised BRIDGE_ROLE can only manipulate share price by ≤5%/day, giving governance time to react.

---

## STORAGE LAYOUT VERIFICATION NEEDED

The following contracts require `hardhat-storage-layout` verification:

| Contract | Declared Slots | Gap | Target Total | Verified? |
|----------|---------------|-----|-------------|-----------|
| BLEBridgeV9 | 15 vars + mappings | `__gap[35]` | 50 | ❌ |
| BorrowModuleUpgradeable | ~20 vars + deprecated + mappings | `__gap[40]` | Unknown | ❌ |
| CollateralVaultUpgradeable | ~5 vars + mappings | `__gap[40]` | Unknown | ❌ |
| LiquidationEngineUpgradeable | ~6 vars | `__gap[40]` | Unknown | ❌ |
| LeverageVaultUpgradeable | ~10 vars + mappings | `__gap[40]` | Unknown | ❌ |
| SMUSDUpgradeable | ~12 vars + mappings | `__gap[40]` | Unknown | ❌ |
| PendleStrategyV2 | ~10 vars | `__gap[40]` | Unknown | ❌ |
| MorphoLoopStrategy | ~8 vars | `__gap[40]` | Unknown | ❌ |
| SkySUSDSStrategy | ~5 vars | `__gap[40]` | Unknown | ❌ |
| TreasuryV2 | ~15 vars + mappings | Gap | Unknown | ❌ |
| PendleMarketSelector | ~5 vars + mappings | Gap | Unknown | ❌ |

**Action**: Run `npx hardhat storage-layout` for each upgradeable contract and verify no slot collisions exist.

---

## REMEDIATION PRIORITY

### 🔴 Immediate (Pre-Deployment)
1. **H-01/H-02**: Confirm only upgradeable versions are deployed (timelock-gated), or fix non-upgradeable versions
2. **M-05**: Add recipient restriction to `CollateralVaultUpgradeable.withdrawFor()` matching non-upgradeable behavior
3. **M-07**: Run storage layout verification for all upgradeable contracts

### 🟡 Short-Term (Within 2 Weeks)
4. **M-03**: Add per-strategy `totalValue()` growth cap in TreasuryV2
5. **M-04**: Add staleness check to `globalTotalAssets()` cache
6. **M-09**: Replace admin-configurable PT discount with on-chain oracle
7. **M-02**: Optimize `socializeBadDebt()` duplicate detection
8. **L-04**: Add freshness check to oracle circuit breaker auto-recovery

### 🟢 Medium-Term (Within 1 Month)
9. **M-01**: Implement RedemptionQueue compaction
10. **M-06**: Add withdrawal minimum check in MorphoLoopStrategy
11. **M-08**: Accept deadline parameter in emergency close
12. **L-11**: Implement `minSupplyRateRequired` check in MorphoLoopStrategy

---

## CONCLUSION

The Minted mUSD Canton protocol demonstrates **strong Solidity security engineering** with sophisticated patterns including dual oracle paths, graceful degradation, and defense-in-depth bridge security. The codebase shows evidence of iterative security improvements (per-operation approvals, `totalBorrowsBeforeAccrual` fix, deprecated variable preservation).

**Key Risk Areas:**
- Non-upgradeable contracts with admin-role-gated critical setters (H-01, H-02) — mitigated if only upgradeable versions are deployed
- Strategy NAV reporting affects system-wide share pricing (M-03, M-09)
- Storage layout verification pending for all upgradeable contracts (M-07)

**Overall Assessment**: The protocol is **production-ready** contingent on confirming only upgradeable (timelock-gated) contracts are deployed, and completing storage layout verification. The remaining findings are hardening measures that improve an already robust architecture.

| Score | Verdict |
|-------|---------|
| **8.4 / 10** | **INSTITUTIONAL GRADE — Production Ready with Minor Hardening** |

---

*Audit conducted via line-by-line review of all 30 Solidity source files*  
*Methodology: 16-category vulnerability assessment with severity classification per Spearbit/Trail of Bits standards*  
*Date: June 2026*
