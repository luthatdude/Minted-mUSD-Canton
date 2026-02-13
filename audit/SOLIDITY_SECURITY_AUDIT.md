# Minted mUSD Protocol — Comprehensive Solidity Security Audit

**Auditor Agent:** solidity-auditor  
**Date:** 2026-02-13  
**Scope:** All Solidity contracts in `/contracts/`  
**Compiler:** Solidity 0.8.26  
**Framework:** Hardhat + OpenZeppelin 5.x  

---

## Executive Summary

The Minted mUSD protocol is a sophisticated DeFi stablecoin system featuring cross-chain bridging (Ethereum ↔ Canton), overcollateralized borrowing, ERC-4626 yield vault, multi-strategy treasury, leveraged positions, and a Wormhole-based deposit router. The codebase demonstrates **strong security awareness** with consistent use of ReentrancyGuard, SafeERC20, AccessControl, Pausable, circuit breakers, timelocks, and separation of duties.

**Overall Smart Contract Security Score: 8.2 / 10**  
**Formal Verification Coverage Score: 7.5 / 10**

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 7 |
| LOW | 9 |
| INFORMATIONAL | 8 |

---

## Findings

---

### SOL-H-01: PendleStrategyV2 — Unlimited Router Approval Creates Persistent Approval Risk

**Severity:** HIGH  
**File:** `contracts/strategies/PendleStrategyV2.sol` (Line 360)  
**Also:** Line 633 (`_selectNewMarket` grants `type(uint256).max` to PT token)

**Description:**  
In `initialize()`, the strategy grants `type(uint256).max` approval to the Pendle Router for USDC:

```solidity
usdc.forceApprove(PENDLE_ROUTER, type(uint256).max);
```

And in `_selectNewMarket()`:
```solidity
IERC20(currentPT).forceApprove(PENDLE_ROUTER, type(uint256).max);
```

While the Pendle Router is a hardcoded immutable address, the unlimited approval means if the Pendle Router itself is compromised or has an upgrade path, all USDC and PT tokens held by this strategy could be drained. This is inconsistent with the per-operation approval pattern used in `SkySUSDSStrategy` and `MorphoLoopStrategy`, which both explicitly limit approvals per-call.

**Impact:** If the Pendle Router is exploited, the entire USDC balance of PendleStrategyV2 can be stolen.

**Recommendation:**  
Switch to per-operation `forceApprove` + clear pattern, consistent with the other strategies:
```solidity
usdc.forceApprove(PENDLE_ROUTER, amount);
// ... execute swap ...
usdc.forceApprove(PENDLE_ROUTER, 0);
```

---

### SOL-H-02: PendleStrategyV2 — `_authorizeUpgrade` Uses `DEFAULT_ADMIN_ROLE` Instead of Timelock

**Severity:** HIGH  
**File:** `contracts/strategies/PendleStrategyV2.sol` (Line 878)

**Description:**  
```solidity
function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
```

All other upgradeable contracts (TreasuryV2, SkySUSDSStrategy, MorphoLoopStrategy, BLEBridgeV9) use `onlyTimelock` or `onlyRole(TIMELOCK_ROLE)` for upgrade authorization. PendleStrategyV2 uses `DEFAULT_ADMIN_ROLE`, bypassing the 48-hour timelock delay required for upgrades. A compromised admin can instantly swap the implementation to a malicious one.

**Impact:** Admin key compromise allows instant upgrade to a malicious implementation, draining all strategy funds without the 48h governance delay.

**Recommendation:**  
Make PendleStrategyV2 inherit `TimelockGoverned` (like the other strategies) and use:
```solidity
function _authorizeUpgrade(address) internal override onlyTimelock {}
```

---

### SOL-M-01: BLEBridgeV9 — Storage Gap Mismatch

**Severity:** MEDIUM  
**File:** `contracts/BLEBridgeV9.sol` (Line 533)

**Description:**  
The header comment documents 12 state variables + `__gap[38] = 50`, but counting the actual state variables:

1. `musdToken` 2. `attestedCantonAssets` 3. `collateralRatioBps` 4. `currentNonce` 5. `minSignatures` 6. `lastAttestationTime` 7. `lastRatioChangeTime` 8. `dailyCapIncreaseLimit` 9. `dailyCapIncreased` 10. `dailyCapDecreased` 11. `lastRateLimitReset` 12. `unpauseRequestTime` 13. `lastCantonStateHash` 

Plus 2 mappings (`usedAttestationIds`, `verifiedStateHashes`) — mappings don't occupy sequential slots, so they don't count against the gap.

That's 13 explicit state variables. The `__gap[35]` at line 533 gives 13 + 35 = 48, not 50. The comment says "15 state variables → 50 - 15 = 35" but only 13 are actual slot-occupying vars.

**Impact:** Future upgrades may encounter storage slot collision if the gap arithmetic is wrong. The actual count needs careful verification before any upgrade.

**Recommendation:**  
Audit the actual slot layout with `hardhat-storage-layout` plugin and ensure vars + gap = 50 consistently.

---

### SOL-M-02: TreasuryV2 — Storage Gap Calculation Needs Verification  

**Severity:** MEDIUM  
**File:** `contracts/TreasuryV2.sol` (Line 116)

**Description:**  
The gap is declared as `uint256[39] private __gap` with a comment "reduced by 1 for peakRecordedValue." Counting explicit slot-consuming state vars:

1. `asset` 2. `vault` 3. `strategies` (dynamic array = 1 slot for length) 4. `strategyIndex` (mapping = 0 slots) 5. `isStrategy` (mapping = 0 slots) 6. `reserveBps` 7. `fees` (struct with 3 fields = 2 slots: 2 uint256 + 1 address packed) 8-9. `lastRecordedValue` 10. `lastFeeAccrual` 11. `minAutoAllocateAmount` 12. `peakRecordedValue`

The `ProtocolFees` struct has `uint256 performanceFeeBps`, `uint256 accruedFees`, `address feeRecipient` — which takes 3 slots (address doesn't pack with uint256 in storage). So that's approximately 11-12 slot-consuming vars + `__gap[39]` = ~50-51. This needs precise verification.

**Impact:** Storage collision risk on upgrade.

**Recommendation:**  
Use `hardhat-storage-layout` to verify exact slot counts.

---

### SOL-M-03: LeverageVault — `emergencyWithdraw` Can Drain Any Token Including User Collateral

**Severity:** MEDIUM  
**File:** `contracts/LeverageVault.sol` (Line 735)

**Description:**  
```solidity
function emergencyWithdraw(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    IERC20(token).safeTransfer(msg.sender, amount);
}
```

There is no restriction on which tokens can be withdrawn. If tokens temporarily reside in the LeverageVault during swap operations (between `withdrawFor` and `safeTransfer`), or if leftover mUSD/collateral tokens are held, admin can extract them. The function should exclude `musd` and any actively-used collateral tokens.

**Impact:** Admin can extract tokens that should be returned to users in edge cases.

**Recommendation:**  
Add safeguards similar to DirectMintV2's `recoverToken`:
```solidity
require(token != address(musd), "CANNOT_RECOVER_MUSD");
```

---

### SOL-M-04: SMUSD — `globalTotalAssets()` Fallback May Undervalue Assets

**Severity:** MEDIUM  
**File:** `contracts/SMUSD.sol` (Lines 242-253)

**Description:**  
```solidity
function globalTotalAssets() public view returns (uint256) {
    if (treasury == address(0)) {
        return totalAssets(); // local ERC-4626 balance only
    }
    try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
        return usdcValue * 1e12;
    } catch {
        return totalAssets(); // fallback to local
    }
}
```

If the Treasury call reverts (e.g., a strategy's `totalValue()` reverts), the fallback returns only the local vault's `totalAssets()`, which may be significantly less than the true global value. This affects `globalSharePrice()` which is used for yield distribution caps. A depressed `globalTotalAssets` could prevent legitimate yield distributions from going through.

**Impact:** Silent degradation of yield distribution if Treasury view function fails.

**Recommendation:**  
Add an event or monitoring flag when falling back to local assets, and consider a cached value approach.

---

### SOL-M-05: BorrowModule — Interest Accrual Drift Between Global and Per-User Accounting

**Severity:** MEDIUM  
**File:** `contracts/BorrowModule.sol` (Lines 492-540)

**Description:**  
The `_accrueInterest(user)` function calculates `interest = (globalInterest * userTotal) / totalBorrows`. However, `totalBorrows` in the denominator is the value *after* `_accrueGlobalInterest()` runs, which may or may not have added global interest (depending on routing success). Meanwhile, user interest is always added to `pos.accruedInterest` regardless of routing success. Over time, `Σ(user_interest)` can diverge from the `totalBorrows` increment, leading to accounting drift.

The `reconcileTotalBorrows()` function mitigates this (with a 5% drift cap), but the drift can accumulate between reconciliations.

**Impact:** Protocol accounting drift. The `reconcileTotalBorrows` function bounds this to 5%, but it requires off-chain keeper coordination.

**Recommendation:**  
This is a known design tradeoff (documented in the code). The reconciliation mechanism adequately bounds the risk. Consider running reconciliation more frequently if utilization is high.

---

### SOL-M-06: DirectMintV2 — Redeem Fee Calculation Precision Edge Case

**Severity:** MEDIUM  
**File:** `contracts/DirectMintV2.sol` (Lines 149-155)

**Description:**  
```solidity
uint256 feeUsdc = (musdAmount * redeemFeeBps) / (1e12 * 10000);
if (redeemFeeBps > 0 && feeUsdc == 0) {
    feeUsdc = 1; // Minimum 1 wei USDC fee
}
usdcOut = usdcEquivalent - feeUsdc;
```

For very small redemptions (< `1e12 * 10000 / redeemFeeBps` mUSD), the fee calculation rounds to 0, triggering the 1 wei minimum. If `usdcEquivalent` is exactly 1, then `usdcOut = 0`, which hits the `ZERO_OUTPUT` check. This means there's a range of very small redemptions that revert.

**Impact:** Extremely small redemptions (sub-penny) may revert. Minimal practical impact since `minRedeemAmount = 1e6` (1 USDC) is enforced.

**Recommendation:**  
The `minRedeemAmount` check adequately prevents this edge case. No action needed.

---

### SOL-M-07: RedemptionQueue — Unbounded Queue Growth

**Severity:** MEDIUM  
**File:** `contracts/RedemptionQueue.sol` (Lines 87-108)

**Description:**  
The `queue` array grows unboundedly. Each `queueRedemption` call pushes a new element, and cancelled/fulfilled entries are never cleaned up. Over time, `queueLength()` and `pendingCount()` become increasingly expensive to track off-chain, and the `nextFulfillIndex` pointer moves forward but never reclaims storage.

**Impact:** Gas cost for view functions is constant, but storage bloat over time. No direct vulnerability, but operational concern at scale.

**Recommendation:**  
Consider a mapping-based queue or periodic compaction mechanism for long-term operation.

---

### SOL-L-01: MUSD — `setSupplyCap` Allows CAP_MANAGER_ROLE to Bypass 24h Cooldown for Decreases

**Severity:** LOW  
**File:** `contracts/MUSD.sol` (Lines 56-85)

**Description:**  
The `setSupplyCap` function allows both `DEFAULT_ADMIN_ROLE` and `CAP_MANAGER_ROLE` (BLEBridgeV9) to set supply caps. Cap decreases bypass the 24h cooldown, which is by design for undercollateralization response. However, a compromised `CAP_MANAGER_ROLE` could rapidly decrease-then-increase the cap (decrease resets no cooldown, but increase sets `lastCapIncreaseTime`). This is bounded by the increase cooldown but worth noting.

**Impact:** Low. The 24h cooldown on increases limits exploitation.

**Recommendation:**  
Acceptable design. The separation is intentional.

---

### SOL-L-02: CollateralVault — `withdrawFor` Health Check Bypass Mode

**Severity:** LOW  
**File:** `contracts/CollateralVault.sol` (Lines 210-256)

**Description:**  
The `skipHealthCheck` parameter allows LEVERAGE_VAULT_ROLE to bypass health checks. The contract properly restricts `recipient` to either `msg.sender` or `user` when skipping, preventing arbitrary drain. However, the health check fallback from safe to unsafe oracle is well-implemented with fail-closed semantics.

**Impact:** Low. Properly mitigated by recipient restriction.

**Recommendation:**  
The current implementation is sound. No changes needed.

---

### SOL-L-03: PriceOracle — `getPrice` Circuit Breaker Auto-Recovery Logic

**Severity:** LOW  
**File:** `contracts/PriceOracle.sol` (Lines 209-227)

**Description:**  
The auto-recovery logic in `getPrice()` has two paths:
1. Formal trip (via `updatePrice`) + cooldown elapsed
2. Never formally tripped but Chainlink feed has been at new level for > cooldown

Path 2 checks `updatedAt + circuitBreakerCooldown`, but `updatedAt` is the Chainlink feed's last update time, not when the price move happened. If Chainlink updates frequently, `updatedAt` keeps refreshing, meaning `updatedAt + circuitBreakerCooldown` is always in the future. This auto-recovery path may never trigger for frequently-updated feeds.

**Impact:** Low. The `refreshPrice()` and `keeperResetPrice()` functions provide alternative recovery paths.

**Recommendation:**  
Consider using the timestamp of the first deviation detection rather than `updatedAt` for path 2.

---

### SOL-L-04: LiquidationEngine — No Event for `socializeBadDebt` Debt Reduction Failure

**Severity:** LOW  
**File:** `contracts/LiquidationEngine.sol` (Lines 247-253)

**Description:**  
`socializeBadDebt` calls `borrowModule.reduceDebt(borrower, amount)`. If `reduceDebt` reverts (e.g., BorrowModule is paused), the entire `socializeBadDebt` transaction reverts. There's no try/catch or fallback mechanism.

**Impact:** Bad debt cannot be socialized while BorrowModule is paused. This is acceptable since pausing is temporary.

**Recommendation:**  
No action needed — this is acceptable behavior.

---

### SOL-L-05: BLEBridgeV9 — `computeAttestationId` Uses `block.chainid` Making It Block-Dependent

**Severity:** LOW  
**File:** `contracts/BLEBridgeV9.sol` (Lines 270-281)

**Description:**  
```solidity
function computeAttestationId(...) public view returns (bytes32) {
    return keccak256(abi.encodePacked(
        _nonce, _cantonAssets, _timestamp, _entropy, _cantonStateHash,
        block.chainid, address(this)
    ));
}
```

The use of `block.chainid` is correct for replay protection across chains. However, `computeAttestationId` is a view function that validators use to pre-compute IDs. If called on a different chain, the returned ID will differ from what `processAttestation` expects.

**Impact:** Negligible. Validators should always call this on the target chain.

**Recommendation:**  
Document that `computeAttestationId` must be called on the same chain as `processAttestation`.

---

### SOL-L-06: MorphoLoopStrategy — `_deleverage` May Not Free Full Requested Amount

**Severity:** LOW  
**File:** `contracts/strategies/MorphoLoopStrategy.sol` (Lines 515-560)

**Description:**  
`_deleverage` iterates up to `MAX_LOOPS` (5) to repay and withdraw. In some market conditions, 5 iterations may not be enough to fully deleverage a 4-loop position. The function returns the actual freed amount, and the caller (`withdraw`) sends whatever was freed.

**Impact:** Partial withdrawal — Treasury may receive less than requested. The caller handles this gracefully.

**Recommendation:**  
Consider allowing `_deleverage` to use `MAX_LOOPS * 2` (10 iterations) like `_fullDeleverage` does.

---

### SOL-L-07: TreasuryV2 — `deposit` Enforces `from == msg.sender` but Signature Says "from Address to Pull From"

**Severity:** LOW  
**File:** `contracts/TreasuryV2.sol` (Lines 481-500)

**Description:**  
```solidity
function deposit(address from, uint256 amount) external ... onlyRole(VAULT_ROLE) {
    require(from == msg.sender, "MUST_DEPOSIT_OWN_FUNDS");
    asset.safeTransferFrom(from, address(this), amount);
}
```

The `from` parameter is redundant since it must equal `msg.sender`. This is a defensive measure (noted in the comment) but adds gas cost for the extra parameter and check.

**Impact:** None. Defense-in-depth.

**Recommendation:**  
Acceptable. The explicit check prevents a compromised VAULT_ROLE from draining arbitrary approvers.

---

### SOL-L-08: InterestRateModel — Constructor Grants All Roles to Single Admin

**Severity:** LOW  
**File:** `contracts/InterestRateModel.sol` (Lines 95-100)

**Description:**  
The constructor grants `DEFAULT_ADMIN_ROLE`, `RATE_ADMIN_ROLE`, and `TIMELOCK_ROLE` all to the same `_admin` address. While TIMELOCK_ROLE is made self-administering (`_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)`), the initial state has the admin holding the timelock role directly. This means the admin can bypass the intended 48h delay for `setParams()` until they renounce the TIMELOCK_ROLE and grant it to the MintedTimelockController.

**Impact:** During the window between deployment and role transfer, the admin can change rate parameters instantly.

**Recommendation:**  
Deployment scripts should immediately transfer TIMELOCK_ROLE to the MintedTimelockController and have the admin renounce it. Document this as a deployment requirement.

---

### SOL-L-09: DepositRouter — Native Token Refund Failure is Silently Absorbed

**Severity:** LOW  
**File:** `contracts/DepositRouter.sol` (Lines 400-409)

**Description:**  
```solidity
if (msg.value > bridgeCost) {
    (bool success, ) = msg.sender.call{value: msg.value - bridgeCost}("");
    if (!success) {
        emit RefundFailed(msg.sender, msg.value - bridgeCost);
    }
}
```

If the caller is a contract that rejects ETH, the excess native token stays in the DepositRouter. The `RefundFailed` event is emitted, and admin can recover via `emergencyWithdraw`. This is a reasonable design choice.

**Impact:** Excess ETH may be stranded. Recoverable via admin.

**Recommendation:**  
Acceptable. The event provides monitoring capability.

---

### SOL-I-01: Consistent Pause/Unpause Pattern Across All Contracts

**Severity:** INFORMATIONAL  

**Description:**  
All contracts consistently implement:
- `pause()` → `onlyRole(PAUSER_ROLE)` or `onlyRole(GUARDIAN_ROLE)`
- `unpause()` → `onlyRole(DEFAULT_ADMIN_ROLE)` or higher privilege

This separation of duties is well-executed and prevents a compromised pauser from both pausing and unpausing.

---

### SOL-I-02: CEI Pattern Compliance

**Severity:** INFORMATIONAL  

**Description:**  
All state-modifying functions follow the Checks-Effects-Interactions pattern or use `nonReentrant`. Key observations:
- `BorrowModule.borrow()`: Checks capacity, updates state, then calls `musd.mint()` — correct CEI
- `LiquidationEngine.liquidate()`: transferFrom + burn + seize + reduceDebt — protected by nonReentrant
- `CollateralVault.deposit()`: Updates `deposits[user][token]` before `safeTransferFrom` — this is actually a deliberate optimistic accounting that's safe because `safeTransferFrom` reverts on failure, and `nonReentrant` prevents reentrancy
- `SMUSD.deposit()`: Sets cooldown before `super.deposit()` — correct

**Finding:** All external call patterns are properly guarded.

---

### SOL-I-03: Event Coverage Assessment

**Severity:** INFORMATIONAL  

**Description:**  
Event coverage is comprehensive. All state-changing functions emit events. Notable:
- ✅ MUSD: Mint, Burn, SupplyCapUpdated, BlacklistUpdated
- ✅ SMUSD: YieldDistributed, CooldownUpdated, CantonSharesSynced
- ✅ BorrowModule: Borrowed, Repaid, InterestAccrued, GlobalInterestAccrued
- ✅ LiquidationEngine: Liquidation, BadDebtRecorded, BadDebtSocialized
- ✅ BLEBridgeV9: AttestationReceived, SupplyCapUpdated, EmergencyCapReduction
- ✅ CollateralVault: Deposited, Withdrawn, Seized
- ✅ TreasuryV2: Deposited, Withdrawn, FeesAccrued, Rebalanced
- ✅ DirectMintV2: Minted, Redeemed, FeesWithdrawn
- ✅ RedemptionQueue: RedemptionQueued, RedemptionFulfilled, RedemptionCancelled
- ✅ All strategies: Deposited, Withdrawn, EmergencyWithdraw

---

### SOL-I-04: `forceApprove` Usage Is Correct and Consistent

**Severity:** INFORMATIONAL  

**Description:**  
The codebase consistently uses `SafeERC20.forceApprove()` instead of raw `approve()`. This prevents issues with tokens like USDT that require approval to be 0 before setting a new value. Pattern is correctly applied across DirectMintV2, LeverageVault, TreasuryV2, and all strategies.

---

### SOL-I-05: SMUSD ERC-4626 Compliance Is Correct

**Severity:** INFORMATIONAL  

**Description:**  
- `convertToShares()` and `convertToAssets()` correctly delegate to OZ's implementation using local vault accounting (not global Treasury)
- `maxWithdraw()` and `maxRedeem()` correctly return 0 when paused or cooldown is active (EIP-4626 compliance)
- `_decimalsOffset()` returns 3, providing donation attack mitigation
- Cooldown propagation on transfer is correctly implemented (stricter cooldown wins)

---

### SOL-I-06: Cross-Chain Bridge Security Is Well-Architected

**Severity:** INFORMATIONAL  

**Description:**  
BLEBridgeV9 implements multiple layers of bridge security:
- ✅ Multi-sig validation with sorted signatures (prevents duplicate signer)
- ✅ Attestation replay protection (`usedAttestationIds` mapping)
- ✅ Sequential nonce enforcement
- ✅ 24h rate limiting on supply cap increases
- ✅ Maximum attestation age (6 hours)
- ✅ Minimum attestation gap (60 seconds)
- ✅ Entropy requirement (prevents pre-computation)
- ✅ Canton state hash verification
- ✅ Chain ID + contract address binding
- ✅ Timelock on critical parameter changes
- ✅ Unpause timelock (24h)

---

### SOL-I-07: LeverageVault Flash Loan Resistance

**Severity:** INFORMATIONAL  

**Description:**  
The LeverageVault does not use flash loans itself; it performs iterative leverage via borrow→swap→deposit loops within a single `nonReentrant` transaction. Key protections:
- `nonReentrant` on all external functions
- Oracle-based minimum output for swaps (not purely AMM-dependent)
- User-supplied deadline for swap expiry
- Position existence check (`positions[msg.sender].totalCollateral == 0`)
- Slippage protection via `maxSlippageBps`

The pattern is resistant to flash loan attacks because:
1. Collateral is deposited to CollateralVault (not held in LeverageVault)
2. Borrowing goes through BorrowModule's health factor checks
3. Swaps have oracle-enforced minimums

---

### SOL-I-08: TimelockGoverned ERC-7201 Storage Pattern

**Severity:** INFORMATIONAL  

**Description:**  
The `TimelockGoverned` contract uses ERC-7201 namespaced storage, which is the correct pattern for upgradeable contracts to prevent storage slot collisions. This is well-implemented and consistent with modern OpenZeppelin best practices.

---

## Per-Contract Status Summary

| Contract | Status | Notes |
|----------|--------|-------|
| **MUSD.sol** | ✅ Secure | Proper RBAC, supply caps, blacklist, pause. Clean ERC-20. |
| **SMUSD.sol** | ✅ Secure | ERC-4626 compliant, cooldown, donation attack mitigation. |
| **BorrowModule.sol** | ⚠️ Needs Attention | Interest accounting drift (bounded by reconciliation). M-05. |
| **LiquidationEngine.sol** | ✅ Secure | Proper bad debt tracking, close factor, unsafe oracle path. |
| **BLEBridgeV9.sol** | ⚠️ Needs Attention | Storage gap needs verification (M-01). Otherwise excellent security. |
| **DirectMintV2.sol** | ✅ Secure | Clean fee handling, supply cap checks, token recovery safeguards. |
| **CollateralVault.sol** | ✅ Secure | Proper seize/withdraw RBAC, 50-token cap, health check fallback. |
| **LeverageVault.sol** | ⚠️ Needs Attention | emergencyWithdraw too permissive (M-03). Otherwise solid. |
| **PriceOracle.sol** | ✅ Secure | Circuit breaker, staleness checks, per-asset deviation, unsafe path. |
| **DepositRouter.sol** | ✅ Secure | Wormhole integration with proper fee handling and refund pattern. |
| **TreasuryV2.sol** | ⚠️ Needs Attention | Storage gap verification needed (M-02). High-water mark fee model is sound. |
| **RedemptionQueue.sol** | ✅ Secure | FIFO, rate limits, cooldown, burn-on-fulfill. Queue growth is informational. |
| **InterestRateModel.sol** | ✅ Secure | Correct kinked rate curve, bounded parameters. |
| **MintedTimelockController.sol** | ✅ Secure | OZ TimelockController with minimum delay enforcement. |
| **TimelockGoverned.sol** | ✅ Secure | ERC-7201 storage, clean modifier pattern. |
| **PendleStrategyV2.sol** | ❌ Needs Fix | H-01 (unlimited approval), H-02 (upgrade not timelocked). |
| **SkySUSDSStrategy.sol** | ✅ Secure | Per-operation approvals, PSM integration, timelock upgrade. |
| **MorphoLoopStrategy.sol** | ✅ Secure | Per-operation approvals, profitability check, timelock upgrade. |
| **SMUSDPriceAdapter.sol** | ✅ Secure | Rate limiter, min/max bounds, donation attack protection. |
| **TreasuryReceiver.sol** | ✅ Secure | VAA replay protection, authorized routers, pending mint queue. |
| **PendleMarketSelector.sol** | ✅ Secure | Whitelist-based market selection, bounded parameters. |

---

## Formal Verification Coverage

Certora specs exist in `certora/specs/` for the following contracts:

| Contract | Spec File | Coverage |
|----------|-----------|----------|
| MUSD | `MUSD.spec` | ✅ |
| SMUSD | `SMUSD.spec` | ✅ |
| BorrowModule | `BorrowModule.spec` | ✅ |
| LiquidationEngine | `LiquidationEngine.spec` | ✅ |
| BLEBridgeV9 | `BLEBridgeV9.spec` | ✅ |
| DirectMintV2 | `DirectMintV2.spec` | ✅ |
| TreasuryV2 | `TreasuryV2.spec` | ✅ |
| InterestRateModel | `InterestRateModel.spec` | ✅ |
| PriceOracle | `PriceOracle.spec` | ✅ |
| LeverageVault | `LeverageVault.spec` | ✅ |
| DepositRouter | `DepositRouter.spec` | ✅ |

**Missing formal verification:**
- ❌ CollateralVault (no spec)
- ❌ RedemptionQueue (no spec)
- ❌ PendleStrategyV2 (no spec)
- ❌ SkySUSDSStrategy (no spec)
- ❌ MorphoLoopStrategy (no spec)
- ❌ SMUSDPriceAdapter (no spec)
- ❌ TreasuryReceiver (no spec)
- ❌ PendleMarketSelector (no spec)

**Coverage:** 11 / 19 contracts = ~58% of contracts have Certora specs.  
Core protocol contracts are well-covered. Strategy and peripheral contracts lack formal verification.

**Formal Verification Coverage Score: 7.5 / 10**  
(Core contracts covered; strategies and peripherals missing)

---

## Access Control & RBAC Summary

| Role | Contract(s) | Purpose | Escalation Risk |
|------|-------------|---------|-----------------|
| `DEFAULT_ADMIN_ROLE` | All | Role management, unpause | ⚠️ Can grant any role — must be multisig |
| `BRIDGE_ROLE` | MUSD, SMUSD | Mint/burn mUSD, sync Canton shares | Medium — controls supply |
| `COMPLIANCE_ROLE` | MUSD | Blacklist accounts | Low — no fund access |
| `CAP_MANAGER_ROLE` | MUSD | Supply cap changes | Medium — bounded by cooldown |
| `EMERGENCY_ROLE` | MUSD, BLEBridgeV9 | Pause, emergency cap reduction | Low — can only reduce |
| `LIQUIDATOR_ROLE` | MUSD | Burn during liquidation | Low — only burn path |
| `MINTER_ROLE` | DirectMintV2 | Cross-chain mint via TreasuryReceiver | Medium — must pair with USDC deposit |
| `PAUSER_ROLE` | Most contracts | Pause operations | Low — cannot unpause |
| `BORROW_ADMIN_ROLE` | BorrowModule | Set IRM, SMUSD, Treasury | Medium — timelocked where critical |
| `LIQUIDATION_ROLE` | BorrowModule | Reduce debt | Low — only reduce |
| `LEVERAGE_VAULT_ROLE` | BorrowModule, CollateralVault | BorrowFor, depositFor, withdrawFor | Medium — bounded by health checks |
| `TIMELOCK_ROLE` | Multiple | Critical parameter changes | Low — enforced by MintedTimelockController |
| `VALIDATOR_ROLE` | BLEBridgeV9 | Sign attestations | High — multi-sig required |
| `ENGINE_ADMIN_ROLE` | LiquidationEngine | Close factor, threshold | Low — bounded parameters |
| `VAULT_ROLE` | TreasuryV2 | Deposit/withdraw | Medium — must be SMUSD/DirectMint |
| `ALLOCATOR_ROLE` | TreasuryV2 | Rebalance, update strategies | Low — moves within protocol |
| `STRATEGIST_ROLE` | TreasuryV2, Strategies | Add/remove strategies, params | Medium — bounded by validations |
| `GUARDIAN_ROLE` | TreasuryV2, Strategies | Emergency withdraw, pause | Low — protective only |
| `TREASURY_ROLE` | Strategies | Deposit/withdraw from strategies | Medium — access to strategy funds |

**Role Hierarchy:** No role can escalate to another without `DEFAULT_ADMIN_ROLE`. The TIMELOCK_ROLE is self-administering where used, preventing DEFAULT_ADMIN bypass. This is a sound RBAC architecture.

---

## Scores

| Category | Score | Rationale |
|----------|-------|-----------|
| **Smart Contract Security** | **8.2 / 10** | 0 critical, 2 high (both in PendleStrategyV2), strong patterns throughout. Excellent use of OZ libraries, timelocks, circuit breakers, and separation of duties. Deduction for unlimited approvals and inconsistent upgrade authorization in PendleStrategyV2. |
| **Formal Verification Coverage** | **7.5 / 10** | 11/19 contracts have Certora specs covering all core protocol contracts. Strategy contracts and peripherals lack formal verification. |

---

## Recommendations Priority

1. **[H-01] Fix PendleStrategyV2 unlimited router approval** — Switch to per-operation approve pattern
2. **[H-02] Fix PendleStrategyV2 upgrade authorization** — Use `onlyTimelock` instead of `DEFAULT_ADMIN_ROLE`
3. **[M-01, M-02] Verify storage gaps** — Run `hardhat-storage-layout` on BLEBridgeV9 and TreasuryV2
4. **[M-03] Restrict LeverageVault emergencyWithdraw** — Exclude musd from recoverable tokens
5. Add Certora specs for CollateralVault and RedemptionQueue (highest priority missing specs)
6. Add Certora specs for strategy contracts

---

*End of Audit Report*
