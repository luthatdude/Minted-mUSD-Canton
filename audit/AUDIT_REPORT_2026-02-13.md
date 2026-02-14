# Minted mUSD Protocol — Comprehensive Security Audit Report

**Date:** February 13, 2026  
**Auditor:** Minted Security Team (Solidity, DAML, TypeScript, Infrastructure)  
**Scope:** Full protocol — 25+ Solidity contracts, 22 DAML templates, 13 relay/service TypeScript files, 16+ bot files, 14 scripts, K8s manifests, CI/CD pipelines, Certora specs, Foundry/Hardhat tests  
**Total LOC Reviewed:** ~25,000+ lines across all layers  

---

## Executive Summary

The Minted mUSD protocol is a **dual-chain stablecoin system** spanning Ethereum (EVM) and Canton Network (DAML). It consists of:

- **MUSD.sol** — ERC-20 stablecoin with supply cap, blacklist, and emergency pause
- **BLEBridgeV9.sol** — Canton→ETH attestation bridge with BFT validator multisig
- **TreasuryV2.sol** — Multi-strategy USDC reserve vault (Pendle, Morpho, Fluid, Euler)
- **DirectMintV2.sol** — 1:1 USDC↔mUSD direct mint/redeem
- **SMUSD.sol** — ERC-4626 yield vault with cross-chain share synchronization
- **BorrowModule.sol** — CDP-style overcollateralized mUSD lending
- **CollateralVault.sol** — Multi-asset collateral deposits (ETH, BTC, etc.)
- **LiquidationEngine.sol** — Liquidation of undercollateralized CDP positions
- **MetaVault.sol** — Vault-of-vaults strategy aggregator (UUPS)
- **LeverageVault.sol** — Uniswap V3 leverage loop positions
- **9 Strategy contracts** — Pendle, Morpho, Fluid, Euler, Contango, AAVE, Sky, etc.
- **Canton DAML layer** — Mint/redeem, lending, staking, governance, compliance, bridge, DEX
- **Relay/Validator services** — Canton→ETH bridge relay, validator nodes, KMS signing
- **Bot services** — Yield scanning, pool monitoring, strategy scoring

The codebase shows **significant maturity** with many prior audit fixes already applied (marked inline as SOL-H-01 FIX, INFRA-H-01, etc.). Key strengths include KMS-based signing, TLS enforcement watchdog, Chainlink circuit breakers, rate-limited supply cap updates, and timelocked critical parameters.

---

## Summary

| Severity | Count | Fixed (Prior) | New |
|----------|-------|---------------|-----|
| 🔴 CRITICAL | 2 | 0 | 2 |
| 🟠 HIGH | 7 | 0 | 7 |
| 🟡 MEDIUM | 11 | 0 | 11 |
| 🟢 LOW | 8 | 0 | 8 |
| ℹ️ INFO | 6 | 0 | 6 |
| ✅ ALREADY FIXED | 12 | 12 | — |

**Audit Score: 72/100** (Significant — production-ready with targeted fixes)

---

## 🔴 CRITICAL Findings

### C-01: DAML LiquidityPool Fixed Exchange Rate Enables Flash-Leverage Exploitation

**File:** `daml/Minted/Protocol/V3.daml` (LiquidityPool)  
**Severity:** CRITICAL  
**Status:** Open  

The V3 `LiquidityPool` uses a **fixed `exchangeRate`** with no AMM curve or price impact. The `Swap_mUSD_For_Collateral` choice converts at a constant rate:

```haskell
let collateralOut = musdAmount / exchangeRate
```

In `AdjustLeverage`, the recursive loop can execute up to **10 iterations** of mint→swap→deposit at the same exchange rate with zero slippage. This allows achieving theoretical maximum leverage without market friction.

**Impact:** Over-leveraged positions that wouldn't be possible in a real market. The fixed-rate DEX creates risk-free arbitrage between the DEX and oracle prices, potentially draining pool reserves.

**Recommendation:** Implement a constant-product formula (`x * y = k`) or apply a per-swap impact fee that scales with trade size relative to pool reserves.

---

### C-02: DAML Supply Cap Cooldown Shares Timer with Rate Limiter

**File:** `daml/CantonDirectMint.daml` (DirectMint_UpdateSupplyCap)  
**Severity:** CRITICAL  
**Status:** Open  

The `DirectMint_UpdateSupplyCap` choice uses `lastRateLimitReset` for its 24-hour cooldown check, but this same field is **also reset by regular mint/burn operations** that cross the daily window boundary. An operator can:

1. Increase supply cap by 20%
2. Wait for any user mint (resets `lastRateLimitReset` to now)
3. Immediately increase cap again by another 20%

**Impact:** The 20%/24h supply cap increase limit can be fully bypassed by chaining cap increases around user activity. Unlimited supply inflation on Canton.

**Recommendation:** Add a dedicated `lastCapUpdateTime : Time` field separate from mint/burn rate limiting.

---

## 🟠 HIGH Findings

### H-01: DAML BurnRateLimiter Shared Across Service Instances

**File:** `daml/CantonDirectMint.daml` (BurnRateLimiter)  
**Severity:** HIGH  
**Status:** Open  

`BurnRateLimiter` is keyed only by `operator : Party`. If multiple `CantonDirectMintService` instances exist with different `serviceName`s, they share one rate limiter. Burns from one service consume the daily limit for all services.

**Impact:** Cross-service interference. A high-volume service could block burns on other services.

**Recommendation:** Key by `(operator, serviceName)` to isolate rate limits per service instance.

---

### H-02: DAML Nonconsuming Deposits Contend on Aggregate Updates

**File:** `daml/CantonLending.daml` (Lending_DepositCTN et al.)  
**Severity:** HIGH  
**Status:** Open  

Deposit choices are marked `nonconsuming` for concurrency, but they exercise `Aggregate_AddDeposit` on `LendingCollateralAggregate`, which is a **consuming** choice. Concurrent deposits of the same collateral type will serialize on the aggregate contract, creating a bottleneck.

**Impact:** Under high throughput, concurrent deposits of the same collateral type will fail with contention errors, partially defeating the concurrency optimization.

**Recommendation:** Implement a batched aggregation pattern or sharded aggregates (e.g., per-participant aggregates that periodically merge).

---

### H-03: Single-Validator BFT Threshold Permits Unilateral Bridge Actions

**File:** `daml/Minted/Protocol/V3.daml` (BridgeService, AttestationRequest)  
**Severity:** HIGH  
**Status:** Open  

The BFT formula `(n * 2 + 2) / 3` for `n=1` yields 1. Combined with `ensure length validatorGroup > 0`, a BridgeService with a single validator requires only 1 signature — no Byzantine fault tolerance.

**Impact:** If deployed with fewer than 3 validators, a single compromised validator can unilaterally mint mUSD on Canton via `Bridge_ReceiveFromEthereum`.

**Recommendation:** Add `ensure length validators >= 3` to both `BridgeService` and `AttestationRequest` templates.

---

### H-04: V3 BridgeOutRequest Missing Validator Field

**File:** `daml/Minted/Protocol/V3.daml` (BridgeOutRequest)  
**Severity:** HIGH  
**Status:** Open  

V3's `BridgeOutRequest` lacks a `validators` field that exists in the canonical `CantonDirectMint` version. Bridge-out requests created via V3 cannot be validated by the validator set.

**Impact:** Bridge-out requests from V3's CantonDirectMint bypass validator validation, weakening bridge security for that code path.

**Recommendation:** Add `validators : [Party]` to V3's `BridgeOutRequest` for consistency with the canonical module.

---

### H-05: DirectMintV2 Redeem Fee Accounting Discrepancy

**File:** `contracts/DirectMintV2.sol` (redeem, withdrawRedeemFees)  
**Severity:** HIGH  
**Status:** Open  

`redeem()` tracks `redeemFees` locally but the actual fee USDC amount remains in the Treasury (only `usdcOut` is withdrawn). When `withdrawRedeemFees()` is called, it executes `treasury.withdraw(feeRecipient, fees)`. This creates a race condition: if the Treasury's available reserves have been deployed to yield strategies, the fee withdrawal may fail or compete with user redemptions for limited liquidity.

More critically, `redeemFees` is an accounting variable that doesn't represent tokens held by DirectMintV2 — it represents tokens that *should* be withdrawable from Treasury. If Treasury's `totalValue()` decreases due to strategy losses, redeem fees may become partially unrecoverable.

**Impact:** Protocol fee collection can fail under low Treasury liquidity, and accumulated fee accounting may diverge from actual recoverable value.

**Recommendation:** Either (a) hold redeem fees in DirectMintV2 directly (withdraw the fee amount during redeem), or (b) add a view function `isRedeemFeeWithdrawable()` that checks Treasury reserves before calling `withdrawRedeemFees()`.

---

### H-06: SMUSD globalTotalAssets() Silently Falls Back on Treasury Failure

**File:** `contracts/SMUSD.sol` (globalTotalAssets)  
**Severity:** HIGH  
**Status:** Open  

```solidity
try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
    return usdcValue * 1e12;
} catch {
    return totalAssets(); // Silent fallback
}
```

If Treasury's `totalValue()` reverts (e.g., strategy reverts, reentrancy guard, or paused), `globalTotalAssets()` silently falls back to local `totalAssets()`. This means `globalSharePrice()` and yield distribution caps suddenly use a much smaller denominator, which could:
- Allow outsized yield distributions relative to actual backing
- Cause `syncCantonShares()` to use an incorrect share price

The inline comment acknowledges this: *"Cannot emit events in a view function — monitoring should detect divergence."* However, no monitoring is implemented on-chain.

**Impact:** Silent fallback masks Treasury failures. Yield distributions or Canton share syncs during a Treasury outage use incorrect asset values, potentially inflating share prices.

**Recommendation:** Add a `bool treasuryFallbackActive` state variable updated by a keeper/admin when the fallback triggers. Consider reverting `globalSharePrice()` when treasury call fails instead of silent fallback, or at minimum gate `distributeYield()` and `syncCantonShares()` on treasury reachability.

---

### H-07: Validator-Node-V2 Duplicate Total-Value Tolerance Check (Dead Code Hiding Bug)

**File:** `relay/validator-node-v2.ts` (verifyAgainstCanton)  
**Severity:** HIGH  
**Status:** Open  

Lines 500-518 contain **two identical** `if (totalDiff > tolerance)` blocks in sequence. The second is unreachable dead code because the first already returns early:

```typescript
if (totalDiff > tolerance) {
    return { valid: false, reason: `Total value mismatch...`, stateHash };
}
// Enforce total-value tolerance — previously computed but never checked.
if (totalDiff > tolerance) {  // DEAD CODE — already returned above
    return { valid: false, reason: `Total value mismatch...`, stateHash };
}
```

The comment "previously computed but never checked" suggests the second check was added to fix a missing validation, but it was placed after the identical first check — so the fix is inert.

**Impact:** If the developer intended the second check to have different tolerance parameters (e.g., stricter for totals), the intended security check is missing. The dead code creates a false sense of validation.

**Recommendation:** Remove the duplicate block. If a different tolerance was intended (e.g., aggregate tolerance vs per-asset tolerance), implement it with distinct parameters.

---

## 🟡 MEDIUM Findings

### M-01: Dual DAML Implementation Risk — V3 vs Canonical Modules

**Files:** `daml/Minted/Protocol/V3.daml` vs `daml/CantonDirectMint.daml`, `daml/CantonSMUSD.daml`  
**Severity:** MEDIUM  

V3.daml contains **alternative implementations** of CantonDirectMint, CantonSMUSD, and BridgeService that diverge from standalone canonical modules. Key differences:

| Feature | Canonical | V3 |
|---|---|---|
| Compliance checks in DirectMint | Yes (via registry) | No |
| BridgeOutRequest validators | Yes | No |
| CantonSMUSD cooldown | via CantonStakingService | via CooldownTicket |
| mUSD token template | CantonMUSD | MintedMUSD |

**Impact:** Security fixes applied to one version may not propagate to the other. **The V3 DirectMint lacks compliance checks**, meaning Canton-side mints via V3 bypass KYC/AML enforcement.

**Recommendation:** Consolidate into a single implementation or clearly deprecate V3's duplicates. Add compliance enforcement to V3's DirectMint.

---

### M-02: DAML Oracle_GetPriceUnsafe Unrestricted Usage

**File:** `daml/Minted/Protocol/V3.daml` (Oracle)  
**Severity:** MEDIUM  

`Oracle_GetPriceUnsafe` is `nonconsuming` and accessible to any observer. While intended for liquidation paths that must operate during oracle staleness, there's no mechanism to restrict its use to only liquidation contexts.

**Impact:** Any observer can use stale prices for decisions that should use freshness-checked prices.

**Recommendation:** Add a caller-role check or a dedicated liquidation-only oracle choice.

---

### M-03: DAML Vault.Liquidate Uses Oracle_GetPriceUnsafe Without Freshness Floor

**File:** `daml/Minted/Protocol/V3.daml` (Vault.Liquidate)  
**Severity:** MEDIUM  

The `Liquidate` choice uses `Oracle_GetPriceUnsafe` which returns any price regardless of age. While the ±50% movement cap limits manipulation per update, a severely stale price (weeks old) combined with a large market move could allow incorrect liquidations.

**Impact:** Stale oracle data in liquidation path could cause liquidation of healthy positions or prevention of liquidation of unhealthy ones.

**Recommendation:** Add a maximum staleness floor (e.g., 24 hours) even for unsafe queries.

---

### M-04: CollateralVault.withdrawFor skipHealthCheck Recipient Restriction Insufficient

**File:** `contracts/CollateralVault.sol` (withdrawFor)  
**Severity:** MEDIUM  

When `skipHealthCheck=true`, the recipient is restricted to `msg.sender` (LeverageVault) or the `user`. However, if LeverageVault has an internal vulnerability allowing arbitrary `user` parameters, the restriction is weakened because the attacker can set `recipient = user` for any user and drain their collateral.

The current code:
```solidity
if (skipHealthCheck) {
    if (recipient != msg.sender && recipient != user) revert SkipHcRecipientRestricted();
}
```

**Impact:** If LeverageVault is compromised or has a logic bug, the `skipHealthCheck` path could be exploited to withdraw collateral without health checks.

**Recommendation:** Consider removing the `skipHealthCheck` parameter entirely and instead have LeverageVault do atomic repay+withdraw in a single transaction where health check is enforced after the combined operation.

---

### M-05: SMUSD cantonTotalShares First-Sync 2x Cap is Arbitrary

**File:** `contracts/SMUSD.sol` (syncCantonShares)  
**Severity:** MEDIUM  

The first Canton share sync allows up to `2x` Ethereum shares. If Ethereum has minimal shares at the time of first sync (e.g., 1 wei), Canton could set shares up to 2 wei — which is fine. But if Ethereum has significant shares (say 100M), Canton can claim up to 200M shares on first sync. There's no validation that these Canton shares correspond to actual deposits.

**Impact:** A compromised BRIDGE_ROLE could inflate Canton shares on first sync to dilute Ethereum holders' share price.

**Recommendation:** Require initial Canton share sync to go through a timelock or governance approval, or use a more restrictive initial cap.

---

### M-06: MetaVault Missing Slippage Protection on Rebalance Withdrawals

**File:** `contracts/MetaVault.sol`  
**Severity:** MEDIUM  

Strategy withdrawals during rebalance have no slippage protection. If a strategy's underlying positions have MEV-sensitive unwinding (e.g., Uniswap LP positions), a rebalance transaction could be sandwiched.

**Impact:** Value leakage during rebalance operations due to MEV/sandwich attacks on strategy withdrawals.

**Recommendation:** Add minimum expected output parameter to rebalance operations, or implement time-weighted batched rebalancing.

---

### M-07: DAML EscrowedCollateral Operator-Controlled caller Parameter

**File:** `daml/CantonLending.daml` (Escrow_AddCollateral)  
**Severity:** MEDIUM  

`Escrow_AddCollateral` uses `controller operator` with a soft `assertMsg "CALLER_MISMATCH" (caller == owner)` check. The `caller` is a parameter passed by the operator, not cryptographically verified. The operator can pass any `caller` value.

**Impact:** The operator could theoretically add collateral to any user's escrow. Mitigated by the fact that token consumption happens at the service level.

**Recommendation:** Use `controller owner, operator` for dual-authorization, or rely on service-level token proof consumption (document this as the security boundary).

---

### M-08: RedemptionQueue mUSD Burns May Create Circular Dependency

**File:** `contracts/RedemptionQueue.sol` (processBatch)  
**Severity:** MEDIUM  

RedemptionQueue needs `BRIDGE_ROLE` on MUSD to call `burn()`. BRIDGE_ROLE is also used by the Canton bridge (BLEBridgeV9 isn't the direct caller — DirectMintV2 holds BRIDGE_ROLE). The deployment comment correctly identifies this dependency, but sharing BRIDGE_ROLE between the bridge-oriented mint path and the redemption queue conflates two distinct security domains.

**Impact:** A role meant for bridge minting is reused for queue burning. If BRIDGE_ROLE permissions are tightened for bridge security, it could inadvertently break the redemption queue.

**Recommendation:** Add a dedicated `QUEUE_BURNER_ROLE` to MUSD, or use the existing `LIQUIDATOR_ROLE` (which already allows burns).

---

### M-09: Relay processedAttestations In-Memory Cache Eviction May Cause Gas Waste

**File:** `relay/relay-service.ts`  
**Severity:** MEDIUM  

The `processedAttestations` Set is bounded at 10,000 entries with oldest-first eviction. After eviction, the relay may re-attempt already-processed attestations. While the on-chain `usedAttestationIds` check prevents double-processing, the relay will waste gas on `staticCall` simulations and RPC queries for previously-processed attestations.

**Impact:** Gas waste and unnecessary RPC load after cache eviction. In a long-running relay with high attestation volume, this could become significant.

**Recommendation:** Use a persistent cache (SQLite, Redis, or a simple append-only file) instead of an in-memory Set.

---

### M-10: V3 CantonSMUSD Yield Sync Missing Attestation

**File:** `daml/Minted/Protocol/V3.daml` (SMUSD_SyncYield)  
**Severity:** MEDIUM  

V3's `SMUSD_SyncYield` is controlled by `operator, governance` (dual-signatory) but unlike the canonical `CantonSMUSD` which uses validator attestation for yield data, V3 has no validator attestation mechanism.

**Impact:** Yield injection relies solely on operator+governance trust without cross-chain attestation verification.

**Recommendation:** Add BFT validator attestation for yield data, matching the canonical module's security model.

---

### M-11: BorrowModule Interest Routing Failure Silently Buffers

**File:** `contracts/BorrowModule.sol` (pendingInterest)  
**Severity:** MEDIUM  

When interest routing to SMUSD fails (e.g., SMUSD is paused or has insufficient allowance), the interest is buffered in `pendingInterest` and retried on next accrual. However, there's no maximum retry window or escalation mechanism. If SMUSD remains unreachable, interest accumulates indefinitely in `pendingInterest`, creating phantom debt that borrowers must pay but that never reaches suppliers.

**Impact:** Borrowers pay interest that sits in a limbo buffer instead of reaching SMUSD stakers. Extended SMUSD unavailability creates accounting divergence.

**Recommendation:** Add a maximum `pendingInterest` cap. If exceeded, pause new borrowing until routing is restored. Add an admin function to redirect stuck interest.

---

## 🟢 LOW Findings

### L-01: DAML MintedMUSD Split/Merge Redundant Authorization Check
**File:** `daml/Minted/Protocol/V3.daml`  
`MUSD_Split` has `controller issuer, owner` but also checks `assertMsg "Only issuer can split"`. The controller clause already enforces authorization.

### L-02: DAML MUSDTransferProposal_Reject Discards ContractId
**File:** `daml/Minted/Protocol/V3.daml`  
Issuer-initiated reject creates a new MintedMUSD for the sender but discards the ContractId (returns `()`). The sender must query the ledger to find returned tokens.

### L-03: CantonLoopStrategy Uncapped Leverage via Config
**File:** `daml/CantonLoopStrategy.daml`  
`maxLoops` is capped at 20, but `maxLeverage` in config allows arbitrary values. With aggressive LTV and 20 loops, theoretical leverage can exceed safety margins.

### L-04: DAML CollateralDepositProof Storage Accumulation
**File:** `daml/CantonDirectMint.daml`  
Consumed proofs (`used = True`) remain on-ledger as audit records but accumulate storage over time.

### L-05: MUSD.sol burn() Allows Blacklisted Address Burns
**File:** `contracts/MUSD.sol`  
A BRIDGE_ROLE holder can burn tokens from a blacklisted address (since `_update` checks `isBlacklisted[from]` but the zero address `to` passes). This is potentially by design for compliance seizure, but should be documented.

### L-06: PriceOracle lastKnownPrice Not Initialized
**File:** `contracts/PriceOracle.sol`  
When a feed is first added, `lastKnownPrice[token]` is 0. The first `getPrice()` call skips the circuit breaker check (since `lastKnownPrice == 0`). This is handled correctly in the code but could be confusing.

### L-07: DirectMintV2 Not Upgradeable
**File:** `contracts/DirectMintV2.sol`  
Uses `immutable` for USDC, mUSD, and Treasury addresses. If any dependency needs to change, a new DirectMintV2 must be deployed with role migrations. This is a design trade-off (gas savings vs flexibility).

### L-08: KMS Signer connect() Creates Instance Without Region
**File:** `relay/kms-ethereum-signer.ts`  
`connect()` creates a new `KMSEthereumSigner` with empty string region: `new KMSEthereumSigner(this.kmsKeyId, "", provider)`. This would use the default AWS SDK region resolution, which may differ from the original configuration.

---

## ℹ️ INFORMATIONAL Findings

### I-01: TreasuryV2 Strategy Count Unbounded Iteration
Strategy loops iterate over all registered strategies. With `MAX_STRATEGIES = 10`, this is safe, but should be documented as an invariant.

### I-02: Validator-Node-V2 Hardcoded 1-Hour Signing Window
`SIGNING_WINDOW_MS` defaults to 1 hour with max 50 signatures. In high-frequency attestation scenarios, this may need tuning.

### I-03: Relay Health Server Exposes Operational Metrics
The `/metrics` endpoint exposes `processedCount`, `activeProviderIndex`, and `consecutiveFailures`. Auth is optional (`HEALTH_AUTH_TOKEN`). Should always require auth in production.

### I-04: Multiple Hardhat Test Files Use `hardhat_setStorageAt`
Direct storage manipulation in tests may mask issues that would surface with proper state transitions.

### I-05: DAML Test Coverage Gaps
The following scenarios lack test coverage: V3 LiquidityPool price impact, V3 BridgeOutRequest without validators, concurrent deposit contention on aggregates.

### I-06: Foundry Fuzz Tests Exist but Invariant Tests Are Limited
The `test/foundry/` directory has fuzz tests but limited invariant tests. Critical invariants like `totalSupply <= supplyCap` should have dedicated invariant test suites.

---

## ✅ Previously Fixed Findings (Verified)

| ID | Description | Location | Status |
|----|-------------|----------|--------|
| SOL-H-01 | Missing timelock on critical params | LiquidationEngine, BorrowModule | ✅ Fixed (TIMELOCK_ROLE) |
| INFRA-H-01 | HTTP used for external connections | relay-service.ts | ✅ Fixed (HTTPS required) |
| INFRA-H-02 | No TLS cert validation | validator-node-v2.ts | ✅ Fixed (enforceTLSSecurity) |
| INFRA-H-03 | Insecure RPC fallback | relay-service.ts config | ✅ Fixed (no HTTP fallback) |
| INFRA-H-06 | Runtime TLS bypass | utils.ts | ✅ Fixed (TLS watchdog) |
| INFRA-CRIT-02 | Bridge address not verified | validator-node-v2.ts | ✅ Fixed (targetBridgeAddress check) |
| TS-H-03-NEW | Plaintext Canton in production | validator-node-v2.ts | ✅ Fixed (production block) |
| H-07 | Validator key in memory | relay-service.ts | ✅ Fixed (KMS signer) |
| SOL-C-05 | globalTotalAssets() Treasury revert | SMUSD.sol | ✅ Fixed (try/catch fallback) |
| GAS-05 | String require vs custom errors | Errors.sol | ✅ Fixed (shared error library) |
| EIP-2 | S-value normalization | signer.ts | ✅ Fixed |
| SOL-M-XX | BLEBridgeV9 sorted signatures | BLEBridgeV9.sol | ✅ Fixed (ascending sort) |

---

## Cross-Cutting Observations

### 1. Canton↔Ethereum State Consistency
The protocol relies on Canton attestations to set Ethereum supply caps. The Ethereum-side rate limiter (`dailyCapIncreaseLimit`) constrains the blast radius of a bad attestation, but the Canton-side rate limiter (C-02) can be bypassed. **Both layers must enforce their own rate limits independently.**

### 2. Role Proliferation Risk
The protocol uses 15+ distinct roles across contracts. Role assignment errors during deployment could create security gaps. The `scripts/verify-roles.ts` script checks 9 critical bindings but doesn't cover all roles. **Consider a comprehensive role matrix test.**

### 3. Dual Implementation Maintenance Burden
V3.daml duplicates substantial logic from canonical DAML modules with divergent security properties. This creates a maintenance trap where fixes to one version don't propagate. **This is the most concerning systemic risk in the codebase.**

### 4. Strategy Composability Risk
MetaVault→TreasuryV2→9 Strategies creates a deep composability stack. A revert in any strategy's `totalValue()` or `withdraw()` can cascade. The existing `try/catch` patterns help but aren't comprehensive.

### 5. Secret Management
Good: Docker secrets with env var fallback, KMS signing, private key zeroing, TLS enforcement.
Gap: No rotation procedure for Canton ledger tokens, no secret expiry enforcement.

---

## Recommendations (Prioritized)

| Priority | Action | Finding |
|----------|--------|---------|
| 🔴 P0 | Fix DAML supply cap cooldown bypass | C-02 |
| 🔴 P0 | Implement AMM curve in V3 LiquidityPool | C-01 |
| 🟠 P1 | Enforce minimum 3 validators in BridgeService | H-03 |
| 🟠 P1 | Add validators field to V3 BridgeOutRequest | H-04 |
| 🟠 P1 | Fix SMUSD globalTotalAssets silent fallback | H-06 |
| 🟠 P1 | Fix DirectMintV2 redeem fee accounting | H-05 |
| 🟠 P1 | Remove dead duplicate tolerance check in validator | H-07 |
| 🟠 P1 | Key BurnRateLimiter by (operator, serviceName) | H-01 |
| 🟡 P2 | Consolidate V3 vs canonical DAML modules | M-01 |
| 🟡 P2 | Add compliance checks to V3 DirectMint | M-01 |
| 🟡 P2 | Add staleness floor to Vault.Liquidate oracle | M-03 |
| 🟡 P2 | Use persistent attestation cache in relay | M-09 |
| 🟡 P2 | Add pendingInterest cap to BorrowModule | M-11 |
| 🟢 P3 | Address remaining LOW/INFO items | L-01..L-08 |

---

## Audit Score Breakdown

| Category | Weight | Score | Notes |
|----------|--------|-------|-------|
| Solidity Security | 30% | 82/100 | Strong: OZ, ECDSA, reentrancy, timelocks. Gaps: fee accounting, silent fallback |
| DAML Security | 25% | 58/100 | V3 dual-impl risk, fixed-rate DEX, cap cooldown bypass, single-validator |
| TypeScript Services | 15% | 80/100 | KMS signing, TLS enforcement, pre-flight simulation. Gap: in-memory cache |
| Infrastructure | 10% | 85/100 | Docker secrets, K8s RBAC, CI scanning. Good overall |
| Test Coverage | 10% | 75/100 | ~40 test files, Certora specs, Foundry fuzz. Gap: invariant tests, V3 DEX tests |
| Architecture | 10% | 70/100 | Solid separation. Risk: deep composability stack, dual DAML implementations |

**Weighted Score: 72/100**

---

*Report generated by Minted Security Team — February 13, 2026*
