# Audit Report: Automatic Weighted Yield Distribution (Cross-Chain)

**Date:** 2026-02-15  
**Scope:** End-to-end yield flow — Ethereum strategies → TreasuryV2 → SMUSD → Canton pools  
**Architecture:** Automatic bot-driven weighted distribution to all pools including Canton  

---

## Summary

| Severity | Count |
|----------|-------|
| **CRITICAL** | 3 |
| **HIGH** | 4 |
| **MEDIUM** | 5 |
| **LOW** | 4 |

The Minted protocol has well-engineered Solidity contracts and a clear unified share price model for cross-chain yield. However, the **infrastructure layer** has significant gaps: 3 of 4 required bot services lack K8s deployment manifests, an architectural mismatch causes Canton to systematically receive yield updates late, and role-key management for production bots is entirely absent.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ YIELD GENERATION (Ethereum)                                     │
│                                                                 │
│   Strategies (Pendle/Morpho/Fluid/Euler)                        │
│         │ earn yield (continuous)                                │
│         ▼                                                       │
│   TreasuryV2.totalValue() rises                                 │
│         │                                                       │
│   yield-harvest-keeper (5min poll)                               │
│         │ calls harvestYield()                                   │
│         ├── _accrueFees() → 20% perf fee                        │
│         ├── withdraw netYield from strategies                    │
│         ├── SMUSD.distributeYield(netYield)                      │
│         │       └── 12h linear vesting (SOL-M-9)                │
│         └── MetaVault.rebalance() per vault                     │
│                                                                 │
│   SMUSD (ERC-4626)                                              │
│         │ globalSharePrice = globalTotalAssets / globalTotalShares│
│         │ where globalTotalAssets = treasury.totalValue() * 1e12 │
│         │   and globalTotalShares = ethShares + cantonShares     │
└────┬────────────────────────────────────────────────────────────┘
     │
     │ yield-sync-service (1h poll)
     │   Step 1: Canton shares → SMUSD.syncCantonShares()
     │   Step 2: Read SMUSD.globalSharePrice()
     │   Step 3: SyncGlobalSharePrice → Canton
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ CANTON POOLS                                                    │
│                                                                 │
│   CantonStakingService (smUSD Global Yield)                     │
│       └── Unified share price from Ethereum                     │
│                                                                 │
│   CantonETHPoolService (smUSD-E via Fluid)                      │
│       └── Tiered multipliers: 1x/1.25x/1.5x/2x by lock        │
│                                                                 │
│   CantonBoostPoolService (Validator Rewards)                    │
│       └── 60/40 split (LP / protocol), LP proportional          │
└─────────────────────────────────────────────────────────────────┘
```

**Weighted distribution flow:**
- Ethereum strategies: 45% / 45% / 10% via TreasuryV2 `rebalance()` (ALLOCATOR_ROLE)
- Canton yield: unified `globalSharePrice` propagated to all Canton stakers equally
- CantonBoostPool: separate yield from validator rewards, not from TreasuryV2

---

## Findings (ordered by severity)

### CRITICAL

#### CRIT-01: `globalTotalAssets()` drops after harvest — Canton sees stale share price

**Component:** SMUSD.sol ↔ yield-sync-service.ts  
**File:** [contracts/SMUSD.sol](contracts/SMUSD.sol#L345-L368), [relay/yield-sync-service.ts](relay/yield-sync-service.ts#L420-L445)

`globalTotalAssets()` reads `TreasuryV2.totalValue() * 1e12`. When `harvestYield()` withdraws net yield from strategies and sends it to SMUSD via `distributeYield()`, Treasury's `totalValue()` **drops** by the distributed amount. The USDC is now in SMUSD's balance, but `globalTotalAssets()` only reads Treasury, not SMUSD's `totalAssets()`.

**Consequence:** yield-sync-service's `syncUnifiedYield()` reads a **lower** `globalSharePrice()` post-harvest and skips the Canton sync ("No yield increase detected"). Canton stakers systematically receive yield updates 1+ hours late.

**Proof:**
1. T=0: strategies hold $10.5M, Treasury `totalValue() = 10.5M`, peak = 10M → $500K gross yield
2. T=0: `harvestYield()` sends $400K net to SMUSD → Treasury `totalValue()` drops to $10.1M
3. T=0+1h: yield-sync reads `globalSharePrice()` → sees 10.1M, which is ≤ last synced 10.5M → skips

**Recommendation:** `globalTotalAssets()` should include SMUSD's local mUSD balance (the distributed-but-vesting yield). Alternatively, the yield-sync-service should read `globalSharePrice()` **before** harvest, or use a separate "announced yield" value.

---

#### CRIT-02: No yield-harvest-keeper K8s deployment

**Component:** Infrastructure  
**File:** [k8s/](k8s/) — missing manifest

The yield-harvest-keeper bot code is complete (745 lines at `bot/src/yield-harvest-keeper.ts`) but has **zero** Kubernetes deployment infrastructure:
- No Deployment manifest
- No ServiceAccount
- No NetworkPolicy
- No ExternalSecret for `KEEPER_PRIVATE_KEY`
- Not referenced in `base/kustomization.yaml`
- No npm script in `bot/package.json`

Without this, yield is **never harvested or distributed** in any deployed environment.

**Recommendation:** Create `k8s/canton/yield-keeper-deployment.yaml` mirroring the liquidation-bot pattern with: projected secrets, restricted NetworkPolicy (egress RPC+Telegram only), PodDisruptionBudget, health probe on port 8082.

---

#### CRIT-03: No yield-sync-service K8s deployment

**Component:** Infrastructure  
**File:** [k8s/](k8s/) — missing manifest

Same as CRIT-02 but for the yield-sync-service relay. The code exists at `relay/yield-sync-service.ts` (556 lines) but has no K8s Deployment. A `PodMonitor` named `yield-sync-metrics` exists in [k8s/monitoring/service-monitors.yaml](k8s/monitoring/service-monitors.yaml) targeting `app.kubernetes.io/name: yield-sync` — but the pod it targets **does not exist**.

Without this, Canton never receives share price updates and Canton stakers earn **zero yield**.

**Recommendation:** Create `k8s/canton/yield-sync-deployment.yaml` with KMS-backed signing (BRIDGE_ROLE key), Canton TLS client cert, and the existing PodMonitor label.

---

### HIGH

#### HIGH-01: No `ALLOCATOR_ROLE` key management for yield bot

**Component:** Secret management  
**File:** [k8s/canton/secrets.yaml](k8s/canton/secrets.yaml), [k8s/canton/external-secrets.yaml](k8s/canton/external-secrets.yaml)

The yield-harvest-keeper requires `KEEPER_PRIVATE_KEY` with `ALLOCATOR_ROLE` to call `treasury.harvestYield()` and `metaVault.rebalance()`. No ExternalSecret, Secret, or KMS reference exists for this key anywhere in K8s manifests.

In dev, all bots share one private key. In production, this key controls **Treasury fund movement** and must be:
- AWS KMS-backed (matching the `createSigner()` pattern in relay)
- Separate from liquidation bot / bridge relay keys
- Rate-limited or require multi-sig for amounts > threshold

**Recommendation:** Add `yield-keeper-key` ExternalSecret in `external-secrets.yaml`; enforce KMS in production (`KMS_KEY_ID` required).

---

#### HIGH-02: `rebalance()` before `harvestYield()` suppresses yield distribution

**Component:** TreasuryV2.sol, bot ordering  
**File:** [contracts/TreasuryV2.sol](contracts/TreasuryV2.sol#L852-L926)

If `rebalance()` is called before `harvestYield()` in the same block/epoch:
1. `rebalance()` calls `_accrueFees()` → updates `lastRecordedValue = totalValue()`
2. `harvestYield()` sees `currentValue ≈ peakRecordedValue` → `grossYield ≈ 0` → distributes nothing

This means the ordering of keeper calls is **critical**. The yield-harvest-keeper correctly calls harvest first, then rebalance — but there's no on-chain enforcement preventing an external ALLOCATOR_ROLE holder from calling `rebalance()` independently.

**Recommendation:** Add a `lastHarvestBlock` check: `rebalance()` should call `_accrueFees()` but NOT reset `peakRecordedValue`. Only `harvestYield()` should reset the peak. Alternatively, document that `rebalance()` must never be called by external actors between harvests.

---

#### HIGH-03: Canton yield sync has no liveness fallback

**Component:** DAML/Canton ↔ yield-sync-service  
**File:** [relay/yield-sync-service.ts](relay/yield-sync-service.ts#L310-L340), [daml/CantonSMUSD.daml](daml/CantonSMUSD.daml)

Canton stakers' yield depends **entirely** on the yield-sync-service being alive. If the relay is down for hours:
- Ethereum stakers continue earning (SMUSD vesting is local)
- Canton stakers see stale `globalSharePrice` — redeem at below-market rates
- No on-chain timeout or fallback mechanism on Canton

Extended outage (>6h) means `SMUSD.lastKnownTreasuryValue` goes stale and `globalTotalAssets()` reverts on Ethereum, which ironically helps Canton (no one can mint/redeem either). But a 1-5h outage creates **cross-chain yield inequality** with no protection.

**Recommendation:**
1. Canton DAML template should track `lastSyncTimestamp` and freeze redemptions if stale > 2h
2. Add a `YieldSyncStale` Prometheus alert at > 2× sync interval
3. Consider a standby relay instance (active/passive with leader election)

---

#### HIGH-04: Fluid rebalancer has no K8s deployment

**Component:** Infrastructure  
**File:** [k8s/](k8s/) — missing manifest

`bot/src/fluid-rebalancer.ts` (675 lines) — third bot with complete code but no K8s manifest. Without this, FluidLoopStrategy LTV drifts unchecked, potentially leading to liquidation and material capital loss.

**Recommendation:** Create `k8s/canton/fluid-rebalancer-deployment.yaml` with health probe on port 8081, `KEEPER_ROLE` + `GUARDIAN_ROLE` keys.

---

### MEDIUM

#### MED-01: Vesting overlap accelerates prior drip

**Component:** SMUSD.sol  
**File:** [contracts/SMUSD.sol](contracts/SMUSD.sol#L189-L210)

When `distributeYield()` is called twice within a 12h window, `_checkpointVesting()` realizes the vested portion of batch 1, then **extends** the vesting of the remaining unvested amount over a new 12h window alongside batch 2. This accelerates batch 1's remaining drip.

With the yield-harvest-keeper polling every 5 minutes, this means virtually every cycle stacks new yield onto the existing vesting schedule. The effective vesting duration for any single batch is shorter than 12h.

**Impact:** Sandwich protection is weakened — an attacker who knows the harvest schedule can time deposits to capture yield that vests faster than the nominal 12h.

**Recommendation:** Track vesting tranches separately, or extend `VESTING_DURATION` to account for stacking (e.g., 24h to match `WITHDRAW_COOLDOWN`).

---

#### MED-02: `globalSharePrice()` denominator includes Canton shares but numerator excludes Canton assets

**Component:** SMUSD.sol  
**File:** [contracts/SMUSD.sol](contracts/SMUSD.sol#L335-L383)

```solidity
globalTotalShares() = totalSupply() + cantonTotalShares;
globalTotalAssets() = treasury.totalValue() * 1e12; // Ethereum-only Treasury
```

The share price formula dilutes the denominator with Canton shares but the numerator only counts **Ethereum** Treasury assets. This is correct if Canton shares represent only claims on Ethereum yield. However, if Canton's `CantonBoostPool` or `CantonETHPool` generate independent yield (validator rewards, Fluid smart debt), those assets are **not reflected** in `globalTotalAssets()`.

**Impact:** If Canton pools generate material yield independently, the global share price understates the true per-share value. Canton-originated yield is invisible to `globalSharePrice()`.

**Recommendation:** Document explicitly that Canton-originated yield (boost pool validator rewards) flows through a separate mechanism and is NOT part of `globalSharePrice()`. Verify the frontend does not combine these APYs misleadingly.

---

#### MED-03: Phantom PodMonitor targeting non-existent yield-sync pod

**Component:** Monitoring  
**File:** [k8s/monitoring/service-monitors.yaml](k8s/monitoring/service-monitors.yaml)

A `PodMonitor` named `yield-sync-metrics` targets `app.kubernetes.io/name: yield-sync`, but no Deployment with this label exists. This means:
- No scrape targets matched → Prometheus silently collects nothing
- No alert fires because there's nothing to alert on
- The monitoring gap is invisible to operators

**Recommendation:** Either deploy the yield-sync pod (see CRIT-03) or remove the phantom PodMonitor to avoid false confidence.

---

#### MED-04: `syncCantonShares()` rate limits could block yield-sync during high activity

**Component:** SMUSD.sol  
**File:** [contracts/SMUSD.sol](contracts/SMUSD.sol#L282-L332)

Three layers of rate limiting on Canton share sync:
1. `MIN_SYNC_INTERVAL = 1 hour` between syncs
2. `MAX_SHARE_CHANGE_BPS = 500` (5%) per sync
3. `MAX_DAILY_CHANGE_BPS = 1500` (15%) rolling 24h cap

During rapid Canton adoption (many new stakers in <24h), legitimate share increases >15%/day would be **rejected**. The yield-sync-service has no retry/backoff logic for this — it would log an error and move on, leaving shares unsynchronized.

**Recommendation:** Add exponential backoff + alerting in yield-sync-service when `syncCantonShares()` reverts with `DailyShareChangeExceeded`. Consider a governance-tunable daily cap.

---

#### MED-05: No Grafana dashboard or Prometheus alerts for yield infrastructure

**Component:** Monitoring  
**File:** [k8s/monitoring/grafana-dashboards.yaml](k8s/monitoring/grafana-dashboards.yaml), [k8s/monitoring/prometheus-rules.yaml](k8s/monitoring/prometheus-rules.yaml)

Grafana dashboards exist for liquidation-bot and fluid-rebalancer, but nothing for:
- yield-harvest-keeper (harvest frequency, amounts, failures)
- yield-sync-service (sync latency, Canton share price drift, epoch progress)
- Cross-chain yield parity (Ethereum vs Canton share price divergence)

**Recommendation:** Add dashboards tracking: harvest frequency, net yield per cycle, Canton sync latency, cross-chain price divergence.

---

### LOW

#### LOW-01: yield-harvest-keeper has no npm script

**File:** [bot/package.json](bot/package.json)

Scripts exist for `dev` (liquidation), `rebalancer`, `sentinel`, but not `yield-keeper`.

**Recommendation:** Add `"yield-keeper": "ts-node src/yield-harvest-keeper.ts"`.

---

#### LOW-02: Security sentinel deployment lacks hardening

**File:** [k8s/monitoring/security-sentinel-deployment.yaml](k8s/monitoring/security-sentinel-deployment.yaml)

Uses `latest` image tag (mutable), no `securityContext` (runAsNonRoot, readOnlyRootFilesystem), no projected secrets, no NetworkPolicy.

**Recommendation:** Pin image digest, add security context, add NetworkPolicy.

---

#### LOW-03: Dev environment uses shared private key across all bots

**File:** Bot `.env` configuration

All bots use the same private key in development. While not a production issue, it prevents testing role separation and could mask permission bugs.

**Recommendation:** Use distinct dev keys with correct on-chain roles per bot.

---

#### LOW-04: `harvestYield()` partial distribution on strategy withdrawal failure

**File:** [contracts/TreasuryV2.sol](contracts/TreasuryV2.sol#L750-L780)

If `_withdrawFromStrategies()` can't provide the full `netYield` amount, a partial distribution is sent to SMUSD. The `peakRecordedValue` is still reset, meaning the un-distributed yield portion is **never re-harvested** — it remains in strategies and is captured only when it generates further yield above the new peak.

**Impact:** Minor yield leakage. Stakers receive slightly less than expected in edge cases.

**Recommendation:** Only reset `peakRecordedValue` proportionally to the amount actually distributed, not the full `grossYield`.

---

## Cross-Cutting Observations

### 1. Two distinct yield models coexist without documentation

The protocol has **two independent yield mechanisms**:
- **Global unified yield** via `globalSharePrice` (Treasury strategies → Ethereum + Canton smUSD stakers)
- **Canton-local yield** via `CantonBoostPool.DistributeRewards` (validator rewards → Canton boost LPs)

These do NOT interact, but the frontend's "3 pool" UI (smUSD / ETH Pool / Boost Pool) presents them as peers. Users may incorrectly assume all pools draw from the same yield source.

### 2. The yield-sync-service is the single point of failure for Canton

No redundancy, no standby instance, no on-chain circuit breaker. The entire Canton yield experience depends on one TypeScript process running continuously.

### 3. Bot deployment gap pattern

A systematic pattern: bot **code** is production-ready but **infrastructure** is missing for 3 of 4 bots (yield-keeper, yield-sync, fluid-rebalancer). Only the liquidation bot has full K8s manifests.

### 4. `harvestYield()` + `distributeYield()` creates a double accounting moment

After `harvestYield()`, USDC has left Treasury (lowering `totalValue()`) and entered SMUSD (raising local `totalAssets()`). But `globalTotalAssets()` only reads Treasury, so the global share price **temporarily drops** until strategies re-earn. This 1-hour accounting gap affects Canton users disproportionately.

---

## Recommendations (Prioritized)

| Priority | Action | Addresses |
|----------|--------|-----------|
| **P0** | Fix `globalTotalAssets()` to include SMUSD's distributed-but-vesting yield, or have yield-sync read share price pre-harvest | CRIT-01 |
| **P0** | Create K8s Deployment for yield-harvest-keeper | CRIT-02 |
| **P0** | Create K8s Deployment for yield-sync-service | CRIT-03 |
| **P1** | Create ExternalSecret for KEEPER_PRIVATE_KEY with KMS backing | HIGH-01 |
| **P1** | Enforce harvest-before-rebalance ordering on-chain or document invariant | HIGH-02 |
| **P1** | Add Canton-side staleness guard (freeze if no sync in 2h) | HIGH-03 |
| **P1** | Create K8s Deployment for fluid-rebalancer | HIGH-04 |
| **P2** | Align VESTING_DURATION with WITHDRAW_COOLDOWN or separate tranches | MED-01 |
| **P2** | Document Canton-originated yield is separate from globalSharePrice | MED-02 |
| **P2** | Deploy or remove phantom yield-sync PodMonitor | MED-03 |
| **P2** | Add backoff + alerting for rate-limited Canton sync | MED-04 |
| **P2** | Add Grafana + Prometheus coverage for yield infrastructure | MED-05 |
| **P3** | Add `yield-keeper` npm script | LOW-01 |
| **P3** | Harden security-sentinel deployment | LOW-02 |
| **P3** | Use distinct dev keys per bot role | LOW-03 |
| **P3** | Proportional peak reset on partial harvest | LOW-04 |

---

## Test Coverage Assessment

The existing `test/YieldIntegrationE2E.test.ts` (23 tests, all passing) covers the **manual** `deployToStrategy()` flow with `autoAllocate=false`. This should be augmented with:

1. **`rebalance()` weighted distribution test** — verify `treasury.rebalance()` distributes to strategies proportionally to `targetBps`
2. **`harvestYield()` end-to-end test** — simulate yield in strategies → harvest → verify SMUSD receives mUSD and vesting starts
3. **Canton share sync test** — verify `syncCantonShares()` updates `globalSharePrice()` correctly, including dilution
4. **Harvest-then-rebalance ordering test** — verify yield is not suppressed when harvest runs before rebalance
5. **Cross-chain yield parity test** — verify `globalSharePrice()` is identical whether called pre- or post-Canton sync
6. **Rate-limit boundary test** — verify `syncCantonShares()` rejects >5% per-sync and >15% daily cumulative changes

---

*Report produced by Lead Auditor Agent — Minted mUSD Canton Protocol*
