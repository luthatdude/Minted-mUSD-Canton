# Audit Report: ETH Pool Yield Return Cycle

**Date:** 2026-02-15
**Scope:** Full ETH Pool yield return path — Solidity, TypeScript keeper, TypeScript relay, DAML integration
**Auditor:** Lead Auditor Agent (consolidated from Solidity, TypeScript, and infrastructure sub-reviews)

---

## Summary

| Severity | Count | Mitigated |
|----------|-------|-----------|
| CRITICAL | 0     | —         |
| HIGH     | 1     | 1 ✅      |
| MEDIUM   | 3     | 3 ✅      |
| LOW      | 5     | 3 ✅ (2 informational) |
| INFO     | 4     | N/A       |

**All actionable findings (HIGH-01, MEDIUM-01/02/03, LOW-01/02) have been mitigated.**

**Scope:** New `ETHPoolYieldDistributor.sol` contract, keeper integration in `yield-harvest-keeper.ts`, relay Direction 4b in `relay-service.ts`, and DAML `ETHPool_ReceiveYield` choice interaction.

**Overall assessment:** The ETH Pool yield cycle is architecturally sound. The v2 mint-and-burn design eliminates the circular USDC flow present in v1, and the high-water mark (HWM) mechanism correctly tracks yield. The relay's Direction 4b correctly mirrors the existing Direction 4 (smUSD yield) pattern. No critical vulnerabilities found.

---

## Architecture Overview

```
Canton Side (Deposit):
  USDCx → ETHPool_StakeWithUSDCx → BridgeOutRequest(source="ethpool")
  ↓
Ethereum Side (Deposit — Relay Direction 3, existing):
  Relay → USDC → Treasury.depositToStrategy(MetaVault #3)
  ↓
Ethereum Side (Yield Accrual):
  MetaVault #3 (Fluid) → yield USDC accrues in strategy
  ↓
Ethereum Side (Yield Return — ETHPoolYieldDistributor, NEW):
  Keeper → distributeETHPoolYield()
    1. Read MetaVault3.totalValue() vs lastRecordedValue (HWM)
    2. yield = currentValue - HWM
    3. Mint mUSD(yield * 1e12) via BRIDGE_ROLE
    4. Bridge.bridgeToCanton(musdAmount, ethPoolRecipient) → burns mUSD
    5. Net mUSD supply Δ = 0 (mint + burn in same tx)
  ↓
Canton Side (Yield Receipt — Relay Direction 4b, NEW):
  Relay detects ETHPoolYieldBridged event
    → Creates CantonMUSD (agreementHash: ethpool-yield-epoch-{N})
    → Exercises ETHPool_ReceiveYield on CantonETHPoolService
    → Archives CantonMUSD, increments pooledUsdc
    → Share price rises for ETH Pool depositors
```

---

## Findings (ordered by severity)

### HIGH-01: Unbacked mUSD Minting Risk if Strategy Value is Inflated

**File:** [contracts/ETHPoolYieldDistributor.sol](contracts/ETHPoolYieldDistributor.sol#L173-L185)
**Component:** Solidity

**Description:** The distributor mints mUSD based solely on `metaVault3.totalValue()` delta above the HWM. If the strategy's `totalValue()` is temporarily inflated (e.g., via a donation attack to the Fluid vault, a flash loan that inflates the vault's TVL, or an oracle manipulation in the strategy), mUSD is minted without real yield backing. The mUSD is burned in the same transaction (net supply Δ = 0 on Ethereum), but the Canton side creates real `CantonMUSD` and credits `pooledUsdc` — this inflates the ETH Pool share price with unbacked value.

**Impact:** An attacker could inflate MetaVault #3's `totalValue()` within a single block (e.g., by depositing and then withdrawing from the Fluid protocol in a way that temporarily inflates accounting), trigger `distributeETHPoolYield()`, and cause the Canton ETH Pool to credit fake yield. However, the `KEEPER_ROLE` access control limits who can trigger distribution, significantly reducing exploitability.

**Recommendation:**
1. Add a `minYieldAccrualPeriod` check — require the yield to persist across multiple blocks before distribution
2. Consider reading `totalValue()` from two separate blocks and taking the minimum
3. Alternatively, add a yield cap per epoch (e.g., max 5% of HWM per distribution)

**Status:** ✅ Mitigated

**Mitigation (implemented):**
1. `maxYieldBps` parameter (default 500 = 5% of HWM per epoch) caps distribution. Excess yield remains for the next epoch (HWM advances by capped amount only). Hard ceiling: `MAX_YIELD_BPS_CAP = 2000` (20%).
2. `yieldMaturityBlocks` parameter (default 10 blocks ≈ 2 min) requires yield to persist across multiple blocks. Keeper must call `observeYield()` to start the maturity timer, then `distributeETHPoolYield()` reverts with `YieldNotMature` until sufficient blocks elapse.
3. `YieldCapped` event emitted when cap triggers, enabling monitoring.
4. Comprehensive test coverage: 8 yield cap tests + 7 yield persistence tests in `ETHPoolYieldDistributor.test.ts`.

---: HWM Desync After Manual Strategy Withdrawal

**File:** [contracts/ETHPoolYieldDistributor.sol](contracts/ETHPoolYieldDistributor.sol#L254-L260)
**Component:** Solidity

**Description:** If an admin withdraws USDC from MetaVault #3 (via Treasury rebalance or emergency withdrawal), `totalValue()` drops below `lastRecordedValue`. This blocks yield distribution until value recovers past the HWM. The `syncHighWaterMark()` governance function exists to reset the HWM, but if the admin forgets to call it, yield distribution is silently blocked indefinitely.

**Impact:** Yield distribution stalls without error. The keeper's `previewYield()` returns `(0, false)` — no alerts are raised.

**Recommendation:** Add a keeper-visible event or view function that explicitly flags "HWM exceeds current value — governance sync required." Consider adding an automatic HWM reduction if value stays below HWM for > N hours.

**Status:** ✅ Mitigated

**Mitigation (implemented):**
1. `hwmDesyncFlagged` boolean state variable — automatically set to `true` in `distributeETHPoolYield()` when `currentValue < lastRecordedValue`.
2. `HWMDesyncDetected(currentValue, hwm)` and `HWMDesyncResolved(newHwm)` events for monitoring.
3. `checkHwmDesync()` public view function returns `(bool desyncFlagged, uint256 currentValue, uint256 hwm)` — keeper calls this to detect stale HWM and sends Telegram alerts.
4. `syncHighWaterMark()` governance function resolves the desync and emits `HWMDesyncResolved`.
5. Keeper integration: `yield-harvest-keeper.ts` checks `checkHwmDesync()` and sends Telegram alert when desync detected.
6. 4 dedicated test cases in `ETHPoolYieldDistributor.test.ts` covering flag on drop, view function, recovery, and sync resolution.

---: Relay Replay Protection Relies on In-Memory Set

**File:** [relay/relay-service.ts](relay/relay-service.ts#L1403-L1474)
**Component:** TypeScript (Relay)

**Description:** `processedETHPoolYieldEpochs` is an in-memory `Set<string>` populated by scanning the last 50,000 blocks on startup. If the relay restarts and the yield event is older than 50,000 blocks, the epoch won't be in the set, and the relay will attempt to re-process it on Canton.

However, Canton's `ETHPool_ReceiveYield` choice archives the `CantonMUSD` contract, so duplicate exercise would fail (attempting to exercise an archived contract). The relay also uses a unique `agreementHash: ethpool-yield-epoch-{N}` per epoch, so the `CantonMUSD` create would succeed (creating a duplicate) but the exercise would reference the wrong contract.

**Impact:** Low — Canton's DAML runtime prevents double-archiving. But a duplicate `CantonMUSD` contract would be created and left orphaned on Canton.

**Recommendation:**
1. Persist processed epochs to disk (e.g., a JSON file or SQLite) rather than relying solely on chain scanning
2. Before creating `CantonMUSD`, query Canton for existing contracts with matching `agreementHash` to prevent duplicates
3. Increase the lookback window from 50,000 to 200,000 blocks (or make it configurable)

**Status:** ✅ Mitigated

**Mitigation (implemented):**
1. **File-based state persistence:** `relay-service.ts` now persists all processed epoch/attestation IDs and last-scanned block numbers to `relay-state.json` (configurable via `RELAY_STATE_FILE` env var). Uses atomic write (temp file + rename) to prevent corruption on crash. State is loaded on startup before chain scanning, providing a baseline that chain data supplements.
2. **Canton duplicate check:** Before creating `CantonMUSD`, the relay queries Canton for existing contracts with matching `agreementHash` (e.g., `ethpool-yield-epoch-{N}`). If found, skips creation and marks epoch as processed — preventing orphaned CantonMUSD contracts.
3. **Configurable lookback window:** `RELAY_LOOKBACK_BLOCKS` env var (default 200,000 blocks ≈ 28 days on Ethereum, up from 50,000). Applied to all four chain-scan functions (attestations, bridge-outs, yield epochs, ETH Pool yield epochs).
4. State file includes version field for future migration, 5MB size guard, and graceful fallback on corruption.

---: No Maximum Yield Cap Per Distribution

**File:** [contracts/ETHPoolYieldDistributor.sol](contracts/ETHPoolYieldDistributor.sol#L165-L195)
**Component:** Solidity

**Description:** There is a `minYieldUsdc` floor ($50 default) but no maximum yield cap. A sudden large `totalValue()` increase (legitimate or manipulated) would distribute an unbounded amount of mUSD in a single transaction.

**Impact:** In conjunction with HIGH-01, this amplifies the impact of any `totalValue()` inflation. Even for legitimate large yields, distributing all at once could cause a sharp ETH Pool share price jump that benefits depositors who happened to stake just before the distribution.

**Recommendation:** Add a `maxYieldPerEpoch` parameter (e.g., 5% of `lastRecordedValue`). Excess yield above the cap remains for the next epoch.

**Status:** ✅ Mitigated

**Mitigation (implemented):**
1. `maxYieldBps` parameter (default 500 = 5% of `lastRecordedValue` per distribution). Governance-adjustable via `setMaxYieldBps()`, bounded by `MAX_YIELD_BPS_CAP = 2000` (20%).
2. Excess yield above the cap remains for the next epoch — HWM advances by `cappedYield` only, not to `currentValue`.
3. `YieldCapped(cappedYield, actualYield)` event emitted for monitoring.
4. Can be disabled by setting `maxYieldBps = 0`.
5. 8 dedicated test cases covering cap enforcement, rollover, disable/enable, update, events, and preview.

---: `rescueToken()` Can Extract mUSD Allowance

**File:** [contracts/ETHPoolYieldDistributor.sol](contracts/ETHPoolYieldDistributor.sol#L281-L283)
**Component:** Solidity

**Description:** The `rescueToken()` function has no token restrictions. A governor could rescue mUSD tokens that were mid-transaction (between mint and bridge burn), though in practice the mint-and-burn happens atomically in `distributeETHPoolYield()` so there should never be leftover mUSD. However, the `forceApprove(bridge, type(uint256).max)` in the constructor means the bridge already has unlimited allowance to pull mUSD — `rescueToken` for mUSD is redundant but not harmful.

**Recommendation:** Consider adding `require(token != address(musd))` to `rescueToken()` for defense-in-depth, or document that this is intentional.

**Status:** ✅ Mitigated

**Mitigation (implemented):** `rescueToken()` now includes `if (token == address(musd)) revert CannotRescueMusd();` guard. Custom error `CannotRescueMusd` defined. Test coverage: 2 tests (blocks mUSD rescue, allows non-mUSD rescue).

---: Keeper `executeETHPoolDistribution()` Lacks Gas Estimation

**File:** [bot/src/yield-harvest-keeper.ts](bot/src/yield-harvest-keeper.ts#L702-L760)
**Component:** TypeScript (Keeper)

**Description:** The keeper calls `distributeETHPoolYield()` without pre-estimating gas or setting gas limits. If the transaction reverts on-chain (e.g., due to MUSD supply cap reached), the keeper spends gas on a failed transaction.

**Recommendation:** Add `ethPoolYieldDistributor.distributeETHPoolYield.estimateGas()` before submission, consistent with the existing smUSD harvest pattern.

**Status:** ✅ Mitigated

**Mitigation (implemented):** `yield-harvest-keeper.ts` line 756: `await this.ethPoolYieldDistributor.distributeETHPoolYield.estimateGas()` — gas estimation occurs before transaction submission, consistent with the smUSD harvest pattern. Failed estimation prevents wasted gas on revert.

---: `CooldownNotElapsed` Error Imported from `Errors.sol`

**File:** [contracts/ETHPoolYieldDistributor.sol](contracts/ETHPoolYieldDistributor.sol#L9)
**Component:** Solidity

**Description:** The contract uses `CooldownNotElapsed` and `InvalidRecipient` from `Errors.sol`, but defines `RecipientNotSet`, `NoYieldAvailable`, and `BelowMinYield` locally. This inconsistency in error definition location makes the code harder to audit — some errors need to be traced to `Errors.sol`.

**Recommendation:** Either define all custom errors locally or import them all from `Errors.sol` for consistency.

**Status:** Informational

---

### LOW-04: Direction 2 Skip Logic Uses Case-Insensitive Address Comparison

**File:** [relay/relay-service.ts](relay/relay-service.ts#L1128-L1134)
**Component:** TypeScript (Relay)

**Description:** The Direction 2 (`watchEthereumBridgeOut`) skip logic correctly uses `.toLowerCase()` for address comparison:
```typescript
sender.toLowerCase() === this.config.ethPoolYieldDistributorAddress.toLowerCase()
```
This is correct, but the `ethPoolYieldDistributorAddress` is loaded from an env var without validation. If the env var contains a non-checksummed address with incorrect casing, the contract instance creation via `new ethers.Contract()` will throw at startup — this is actually good (fail-fast).

**Recommendation:** Add explicit address validation in config loading:
```typescript
ethPoolYieldDistributorAddress: process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS
  ? ethers.getAddress(process.env.ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS) : "",
```

**Status:** Informational

---

### LOW-05: Cache Eviction in Relay Removes Oldest Epochs First

**File:** [relay/relay-service.ts](relay/relay-service.ts#L1477-L1484)
**Component:** TypeScript (Relay)

**Description:** The cache eviction for `processedETHPoolYieldEpochs` removes the first 10% of Set entries when the cache exceeds `MAX_PROCESSED_CACHE`. JavaScript `Set` iteration order is insertion order, so the oldest epochs are evicted first. This is correct behavior — oldest epochs are least likely to be re-encountered. However, if a very old event is somehow re-scanned (block reorg or provider data issue), it could be re-processed.

**Recommendation:** This is acceptable. The Canton-side `ETHPool_ReceiveYield` choice provides additional protection against double-crediting.

**Status:** Informational

---

### INFO-01: MUSD Supply Cap Could Block Distribution

**Component:** Solidity

**Description:** `musd.mint(address(this), musdAmount)` will revert if the total mUSD supply plus `musdAmount` exceeds the MUSD supply cap. Since the bridge burns the mUSD in the same transaction, the net supply doesn't change — but the transient supply peak must be within the cap.

**Recommendation:** Ensure the MUSD supply cap has sufficient headroom for the largest expected yield distribution. The keeper should check `musd.supplyCap() - musd.totalSupply() >= musdAmount` before calling `distributeETHPoolYield()`.

---

### INFO-02: ETH Pool Denomination Mismatch (USDC vs ETH)

**Component:** Cross-cutting

**Description:** The contract and keeper operate in USDC (6 decimals), but the Canton ETH Pool is denominated in ETH. The mUSD bridge carries USD-equivalent value; Canton must convert to ETH-denominated returns via its oracle. This conversion happens in `ETHPool_ReceiveYield` which directly increments `pooledUsdc` (not pooledETH). The ETH Pool's share price is ETH-denominated on the user-facing side but USDC-denominated internally — this is an architectural choice, not a bug.

**Recommendation:** Document this denomination flow clearly in the ETH Pool user docs to avoid confusion about "ETH-denominated yield backed by USDC."

---

### INFO-03: Test Coverage Assessment

**Component:** Testing

**Coverage for `ETHPoolYieldDistributor.sol`: 30+ tests passing** (expanded from 15)
- ✅ Core distribution flow (mint, burn, HWM update, event emission)
- ✅ Multi-epoch HWM tracking
- ✅ No-yield revert
- ✅ Below-minimum-yield revert
- ✅ Cooldown enforcement
- ✅ Recipient-not-set revert
- ✅ Preview function accuracy
- ✅ Cooldown preview state
- ✅ Access control (KEEPER_ROLE, GOVERNOR_ROLE)
- ✅ Governance parameter updates
- ✅ HWM manual sync
- ✅ Pause/unpause
- ✅ Empty recipient rejection
- ✅ **Yield cap enforcement** (8 tests — cap limit, rollover, disable, enable, update, events, preview)
- ✅ **Yield persistence / maturity** (7 tests — YieldNotMature revert, block elapsed, observeYield, no yield, maturity update, preview)
- ✅ **HWM desync detection** (4 tests — flag on drop, checkHwmDesync view, recovery resolve, syncHWM resolve)
- ✅ **rescueToken mUSD restriction** (2 tests — blocks mUSD, allows non-mUSD)

**Not covered:**
- ❌ Supply cap exhaustion scenario (MUSD mint reverts)
- ❌ Reentrancy attempt (though `nonReentrant` modifier is present)
- ❌ Multiple keepers racing (only relevant with mempool)

---

### INFO-04: Pre-Existing Test Failures in YieldDistributor.test.ts

**Component:** Testing

**Description:** The `test-output.txt` snapshot shows 2 failing tests in the smUSD `YieldDistributor` test suite ("Share Price Integrity" section). These are pre-existing failures related to `globalSharePrice` returning 0 due to the test fixture having Canton shares without corresponding Treasury backing (integer division rounds to 0). The tests were subsequently rewritten to verify `Treasury.totalValue()` instead, and the final full test suite run showed 2086 passing, 0 failing. These failures are **not related** to the ETH Pool yield changes.

---

## Cross-Cutting Observations

### 1. Bridge Security — Mint-and-Burn Model

The v2 design is fundamentally sound: mUSD is minted and burned atomically in the same transaction, so the Ethereum-side mUSD supply cap is only transiently affected. The yield USDC remains in MetaVault #3 as backing for the existing mUSD supply. The Canton side receives value through `pooledUsdc` incrementing in `CantonETHPoolService`, which is controlled by `operator + governance` — both required signatories on `ETHPool_ReceiveYield`.

### 2. Secret Management

The ETH Pool yield cycle introduces one new environment variable:
- `ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS` — used by both relay and keeper

No new secrets (private keys, API keys) are introduced. The existing relay signer and keeper signer handle all transactions.

### 3. Upgrade Safety

`ETHPoolYieldDistributor.sol` is **non-upgradeable** (no UUPS/transparent proxy). All external dependencies are `immutable`. To upgrade, a new contract must be deployed and roles migrated:
1. Revoke `BRIDGE_ROLE` on MUSD from old distributor
2. Deploy new distributor
3. Grant `BRIDGE_ROLE` on MUSD to new distributor
4. Update `ethPoolRecipient` on new distributor
5. Update `ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS` env var in relay and keeper

### 4. Consistency with smUSD Yield Path

The ETH Pool yield return path (Direction 4b) correctly mirrors the smUSD yield return path (Direction 4):
- Both scan for distributor events on Ethereum
- Both create `CantonMUSD` on Canton
- Both exercise a receive-yield choice on the appropriate Canton service
- Both use epoch-based deduplication
- Both share the same in-memory cache + chain-scan pattern (with the same limitations)

---

## Deployment Checklist

### Solidity Roles Required
| Contract | Role | Grantee | Purpose |
|----------|------|---------|---------|
| MUSD | `BRIDGE_ROLE` | ETHPoolYieldDistributor | Mint mUSD for bridge vehicle |
| MUSD | `BRIDGE_ROLE` | BLEBridgeV9 | Burn mUSD on bridgeToCanton (already granted) |
| ETHPoolYieldDistributor | `KEEPER_ROLE` | Keeper bot address | Trigger distributions |
| ETHPoolYieldDistributor | `GOVERNOR_ROLE` | Governance multisig | Set parameters |

### Environment Variables
| Service | Variable | Description |
|---------|----------|-------------|
| Keeper | `ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS` | Deployed contract address |
| Relay | `ETH_POOL_YIELD_DISTRIBUTOR_ADDRESS` | Same deployed contract address |

### Canton Prerequisites
- `CantonETHPoolService` must be deployed with `operator` matching relay's `CANTON_PARTY`
- `ETHPool_ReceiveYield` choice already exists in `CantonETHPool.daml` (no DAML changes needed)
- `CANTON_GOVERNANCE_PARTY` must be set for the relay to exercise the governance-cosigned choice

### Post-Deployment Verification
1. Call `setEthPoolRecipient()` with the correct Canton ETH Pool operator party
2. Verify `lastRecordedValue` matches expected MetaVault #3 totalValue
3. Simulate yield by depositing test USDC to MetaVault #3
4. Trigger `distributeETHPoolYield()` and verify `ETHPoolYieldBridged` event
5. Verify relay picks up the event and credits Canton ETH Pool

---

## Recommendations (Prioritized)

1. ~~**[HIGH]** Add a maximum yield cap per epoch to prevent unbounded distribution (MEDIUM-03 + HIGH-01)~~ ✅ Done — `maxYieldBps` (default 5%, hard cap 20%)
2. ~~**[MEDIUM]** Add multi-block yield persistence check before distribution (HIGH-01)~~ ✅ Done — `yieldMaturityBlocks` + `observeYield()`
3. ~~**[MEDIUM]** Add keeper alerting when HWM exceeds current strategy value (MEDIUM-01)~~ ✅ Done — `checkHwmDesync()` + Telegram alerts in keeper
4. ~~**[LOW]** Persist processed epochs to disk for relay crash recovery (MEDIUM-02)~~ ✅ Done — `relay-state.json` + Canton duplicate check + 200k lookback
5. ~~**[LOW]** Add gas estimation in keeper before distribution tx (LOW-02)~~ ✅ Done — `estimateGas()` before submission
6. ~~**[LOW]** Add `rescueToken` test coverage and token restriction (LOW-01, INFO-03)~~ ✅ Done — `CannotRescueMusd` guard + 2 tests
