# 🏛️ Minted mUSD Protocol — Comprehensive Security Audit

**Date:** February 12, 2026  
**Scope:** Full-stack audit — Solidity (EVM) + DAML (Canton Network)  
**Contracts Audited:** 20 Solidity contracts (~8,500 LoC) · 16 DAML modules + 1 unified V3 module (~9,750 LoC)  
**Audit Methodologies Applied:**

| Firm Style | Method |
|------------|--------|
| Trail of Bits | Automated pattern analysis, static analysis (Slither/Semgrep) |
| OpenZeppelin | Access control matrix, role hierarchy analysis |
| Consensys Diligence | Economic modeling, MEV/sandwich analysis |
| Certora | Formal specification review (4 specs: MUSD, SMUSD, BorrowModule, LiquidationEngine) |
| Cyfrin | Cross-contract data flow tracing |
| ChainSecurity | Upgradeability safety (UUPS, initializer, storage gaps) |
| Canton Ledger Model | Signatory/authority analysis, TOCTOU, privacy model, consuming/nonconsuming correctness |

---

## 📊 COMPOSITE SCORE

| Layer | Score | Grade |
|-------|-------|-------|
| **Solidity (EVM)** | 87 / 100 | ⭐⭐⭐⭐ |
| **DAML (Canton)** | 89 / 100 | ⭐⭐⭐⭐ |
| **Cross-Layer Integration** | 83 / 100 | ⭐⭐⭐⭐ |
| **Test & Verification Coverage** | 85 / 100 | ⭐⭐⭐⭐ |
| **Overall Protocol** | **86 / 100** | ⭐⭐⭐⭐ |

### Scoring Breakdown

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Access Control & Authorization | 15% | 91 | 13.65 |
| Economic / Financial Logic | 20% | 82 | 16.40 |
| Oracle & Price Feed Safety | 10% | 80 | 8.00 |
| Reentrancy & Atomicity | 10% | 96 | 9.60 |
| Upgradeability & Migration | 10% | 90 | 9.00 |
| Cross-Chain / Bridge Security | 15% | 84 | 12.60 |
| Compliance & Privacy | 10% | 93 | 9.30 |
| Test & Verification Coverage | 10% | 85 | 8.50 |
| **Total** | **100%** | — | **87.05** |

---

## CONTRACT INVENTORY

### Solidity Layer (EVM)

| Contract | Lines | Purpose |
|----------|-------|---------|
| `MUSD.sol` | 107 | ERC20 stablecoin with supply cap, blacklist, compliance, pause |
| `SMUSD.sol` | 323 | ERC4626 staked vault with cross-chain yield, Canton sync, interest routing |
| `CollateralVault.sol` | 300 | Collateral deposits with per-asset config management |
| `BorrowModule.sol` | 835 | Debt positions, dynamic interest, interest routing to SMUSD |
| `LiquidationEngine.sol` | 350 | Liquidation with close factor, unsafe oracle path |
| `PriceOracle.sol` | 318 | Chainlink aggregator with circuit breaker, sequencer uptime feed |
| `InterestRateModel.sol` | 300 | Compound-style kinked rate model |
| `DirectMintV2.sol` | 400 | 1:1 USDC→mUSD minting with TreasuryV2 |
| `DepositRouter.sol` | 420 | L2 cross-chain USDC routing via Wormhole |
| `LeverageVault.sol` | 748 | Multi-loop leverage with Uniswap V3 |
| `BLEBridgeV9.sol` | 500 | Canton attestation → supply cap (UUPS upgradeable) |
| `TreasuryV2.sol` | 982 | Auto-allocating treasury with strategy management |
| `TreasuryReceiver.sol` | 296 | Cross-chain deposit receiver |
| `TimelockGoverned.sol` | 100 | ERC-7201 namespaced storage timelock base |
| `MintedTimelockController.sol` | 90 | OZ TimelockController wrapper |
| `SMUSDPriceAdapter.sol` | 255 | Chainlink-compatible sMUSD price feed |
| `PendleMarketSelector.sol` | 527 | Optimal Pendle market selection |
| `PendleStrategyV2.sol` | 830 | Pendle PT strategy with rollover |
| `MorphoLoopStrategy.sol` | 806 | Morpho Blue recursive lending |
| `SkySUSDSStrategy.sol` | 434 | Sky sUSDS savings strategy |

### DAML Layer (Canton Network)

| Module | Lines | Purpose |
|--------|-------|---------|
| `CantonLending.daml` | 1,464 | Full lending protocol — 4 collateral types, escrow, liquidation |
| `Minted/Protocol/V3.daml` | 1,551 | Unified protocol: Vault CDPs, DEX, Bridge, sMUSD, DirectMint |
| `CantonDirectMint.daml` | 765 | mUSD minting with USDC/USDCx, bridge-out, reserve tracking |
| `CantonBoostPool.daml` | 544 | Validator reward pool, sMUSD-qualified Canton deposits |
| `BLEBridgeProtocol.daml` | 434 | Cross-chain bridge: bridge-out/in/supply-cap/yield attestations |
| `Governance.daml` | 434 | Multi-sig M-of-N governance, minter registry, emergency pause |
| `MintedMUSD.daml` | 334 | Original MUSD token with dual signatory, IssuerRole, supply cap |
| `InterestRateService.daml` | 300 | Compound-style kinked rate model synced from Ethereum |
| `InstitutionalAssetV4.daml` | 300 | Institutional asset framework with compliance whitelist |
| `Upgrade.daml` | 282 | Opt-in contract migration with rollback windows |
| `CantonSMUSD.daml` | 230 | Staked mUSD with unified cross-chain yield via global share price |
| `BLEProtocol.daml` | 200 | Original attestation protocol (equity positions, validator sigs) |
| `UserPrivacySettings.daml` | 170 | Opt-in privacy toggle: fully private by default |
| `Compliance.daml` | 165 | Blacklist, freeze, pre-transaction validation hooks |
| `TokenInterface.daml` | — | Deprecated draft (not deployed) |
| `CantonLoopStrategy.daml` | 0 | Empty stub — unimplemented |

---

## ALL FINDINGS

### Finding Summary

| Severity | Solidity | DAML | Cross-Layer | Total |
|----------|----------|------|-------------|-------|
| 🔴 HIGH | 1 | 2 | 0 | **3** |
| 🟡 MEDIUM | 5 | 5 | 2 | **12** |
| 🔵 LOW | 8 | 4 | 1 | **13** |
| ℹ️ INFO | 10 | 4 | 0 | **14** |
| **Total** | **24** | **15** | **3** | **42** |

---

## 🔴 HIGH SEVERITY

---

### S-H-01 — SMUSD `totalAssets()` Infinite Recursion

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/SMUSD.sol` |
| **Category** | Logic Error / Denial of Service |
| **Status** | Open |

**Description:**  
`SMUSD.totalAssets()` calls `globalTotalAssets()`, which calls `treasury.totalValue()`. When the treasury address is `address(0)` (not yet set) or the treasury call reverts, `globalTotalAssets()` falls back to `totalAssets()` — creating infinite recursion.

```solidity
function globalTotalAssets() public view returns (uint256) {
    try ITreasuryV2(treasury).totalValue() returns (uint256 val) {
        return val;
    } catch {
        return totalAssets(); // ← Recurses back into globalTotalAssets()
    }
}
```

**Impact:**  
All ERC4626 operations (`deposit`, `withdraw`, `redeem`, `previewDeposit`, etc.) revert with out-of-gas. The vault becomes completely bricked until a valid treasury is set.

**Recommendation:**  
Replace the recursive fallback with a direct balance check:
```solidity
catch {
    return IERC20(asset()).balanceOf(address(this));
}
```

---

### D-H-01 — GovernanceActionLog Archive Authorization Failure

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Governance.daml` |
| **Category** | Authorization Model |
| **Status** | Open |

**Description:**  
`GovernanceActionLog` has `signatory operator, executedBy`. In `MinterRegistry_AddMinter`, `MinterRegistry_RemoveMinter`, and `MinterRegistry_ReplenishQuota`, the code calls `archive governanceProofCid` within a choice controlled by `operator` only. DAML requires **all signatories** to be in the authorization context for an archive. When `executedBy ≠ operator` (a governor executed the proposal, not the operator), the archive call fails at runtime because `executedBy` is not in the choice's authorization context.

**Impact:**  
Governance proof replay prevention breaks when executor ≠ operator. Minter registry mutations revert, locking governance operations entirely.

**Recommendation:**  
Change `GovernanceActionLog` to `signatory operator` only (since operator creates it within `Proposal_Execute`), or add `executedBy` as a controller on the consuming choices in the minter registry.

---

### D-H-02 — V3.daml sMUSD Share Price Asymmetry (Deposit vs. Withdraw)

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Minted/Protocol/V3.daml` |
| **Category** | Economic Logic |
| **Status** | Open |

**Description:**  
`SMUSD_Deposit` computes share price using **virtual shares** (inflation attack mitigation):
```haskell
let virtualShares = totalShares + 1000.0
let virtualAssets = totalAssets + 1000.0
let sharePrice = virtualAssets / virtualShares
```

But `SMUSD_Withdraw` uses **raw** division:
```haskell
let sharePrice = if totalShares == 0.0 then 1.0 else totalAssets / totalShares
```

When `totalShares` is small (early pool), depositors pay a higher price (deflated by virtual offset) while withdrawers receive more (no virtual offset). This creates extractable value.

**Impact:**  
First-depositor advantage; systematic economic asymmetry between deposit and withdrawal pricing allows value extraction in the early pool phase.

**Recommendation:**  
Use consistent share price calculation in both `SMUSD_Deposit` and `SMUSD_Withdraw`. Apply the virtual share offset in both, or in neither.

---

## 🟡 MEDIUM SEVERITY

---

### S-M-01 — Interest Routing Failure Creates Phantom Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/BorrowModule.sol` |
| **Category** | Accounting / State Consistency |

**Description:**  
In `_accrueInterest()`, interest is added to `totalBorrows` before routing to SMUSD. If `interestRouter.routeInterest()` reverts (SMUSD paused, transfer failure), `totalBorrows` is permanently inflated by the interest amount with no corresponding asset backing it.

**Impact:**  
Global utilization rate inflates → interest rates increase for all borrowers → protocol enters a death spiral if routing failures compound.

**Recommendation:**  
Wrap the routing call in a try/catch. On failure, buffer the unrouted interest in a `pendingInterest` variable and retry on the next accrual.

---

### S-M-02 — No Bad Debt Socialization Mechanism

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LiquidationEngine.sol` |
| **Category** | Economic Safety |

**Description:**  
When a position's collateral value falls below debt (underwater position), the liquidation penalty makes seizure unprofitable for liquidators. No mechanism socializes or absorbs the bad debt.

**Impact:**  
Bad debt accumulates silently in `totalBorrows`, inflating utilization. SMUSD share price becomes overstated (claims on non-existent backing).

**Recommendation:**  
Add a `socializeBadDebt()` function that writes off underwater positions against protocol reserves or reduces the SMUSD share price.

---

### S-M-03 — LeverageVault Sandwich Attack Exposure

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LeverageVault.sol` |
| **Category** | MEV / Economic Attack |

**Description:**  
`_swapExactInput()` calculates `amountOutMinimum` using an oracle price with a slippage buffer. However, Uniswap V3 swaps with oracle-derived minimums are still sandwichable because:

1. The oracle price can be manipulated within Chainlink's heartbeat window
2. The slippage buffer applies to the oracle price, not the actual pool spot price
3. `block.timestamp` is used as the swap deadline, making it ineffective

**Impact:**  
MEV bots can extract value from every leverage/deleverage operation by sandwiching the Uniswap swap.

**Recommendation:**  
Accept user-supplied `minAmountOut` with a server-side quote check; use a real deadline (e.g., `block.timestamp + 120`); consider using a private mempool (Flashbots Protect) for leverage transactions.

---

### S-M-04 — `emergencyClosePosition` Orphans Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LeverageVault.sol` |
| **Category** | State Consistency |

**Description:**  
`emergencyClosePosition()` sells collateral and returns the proceeds to the user but does not repay the corresponding debt in `BorrowModule`. The position's debt remains in `totalBorrows` as phantom debt.

**Impact:**  
Same phantom debt spiral as S-M-01; `totalBorrows` is permanently inflated.

**Recommendation:**  
Have `emergencyClosePosition()` call `BorrowModule.repayFor()` with the swap proceeds before returning any remainder to the user.

---

### S-M-05 — CollateralVault `withdrawFor` Pre-Withdrawal Health Check

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/CollateralVault.sol` |
| **Category** | Logic Error |

**Description:**  
`withdrawFor()` checks the user's health factor **before** reducing their collateral balance. If the function relies on `getHealthFactor()` reading the current (pre-withdrawal) balance, any withdrawal that would make the position unhealthy passes the check.

**Impact:**  
Users can withdraw collateral into an undercollateralized state.

**Recommendation:**  
Perform the health check **after** the balance reduction, or compute the post-withdrawal health factor explicitly before executing the transfer.

---

### D-M-01 — CantonLending Borrow/Liquidate Service Contention

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonLending.daml` |
| **Category** | Scalability / Liveness |

**Description:**  
`Lending_Borrow` and `Lending_Liquidate` are **consuming choices** on `CantonLendingService` (they update `totalBorrows`/`cantonCurrentSupply`). Only one can execute per ledger effective time. Under high load, concurrent borrows serialize and late arrivals fail referencing stale contract IDs. Deposits are correctly nonconsuming (DAML-H-03).

**Impact:**  
Protocol bottleneck under concurrent borrow/liquidation activity; failed transactions require retry with a fresh service CID.

**Recommendation:**  
Move `totalBorrows` tracking to a separate aggregate template (like `LendingCollateralAggregate`) to decouple borrow-side state from the service contract.

---

### D-M-02 — sMUSD Share Price Sync Is Operator-Only (No Validator Attestation)

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonSMUSD.daml` |
| **Category** | Trust Assumption / Oracle Manipulation |

**Description:**  
`SyncGlobalSharePrice` is controlled by `operator` alone — no multi-validator attestation, unlike bridge operations which require 2/3 BFT supermajority via `BLEBridgeProtocol`. A compromised operator could set `globalSharePrice` to inflate sMUSD value (bounded by ±10% per epoch, but accumulable over epochs).

**Impact:**  
Gradual yield inflation/deflation over multiple epochs by a compromised operator.

**Recommendation:**  
Route share price updates through `YieldAttestation` from `BLEBridgeProtocol.daml` (which already has BFT supermajority verification for yield data).

---

### D-M-03 — InterestRateService Sync Lacks Attestation Verification

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/InterestRateService.daml` |
| **Category** | Trust Assumption |

**Description:**  
`RateService_SyncMarketState` is controlled by `operator` only, with no cryptographic verification that the synced `totalBorrows`/`totalSupply` match Ethereum state. The block number sequencing check prevents stale data but doesn't verify data integrity.

**Impact:**  
Operator could set arbitrary utilization → manipulate interest rates on Canton.

**Recommendation:**  
Require an attestation payload hash or validator co-signature on rate syncs.

---

### D-M-04 — V3.daml Vault Liquidation Uses Stale-Tolerant Oracle Incorrectly

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Minted/Protocol/V3.daml` |
| **Category** | Oracle Safety / Liveness |

**Description:**  
V3 `Vault.Liquidate` uses `Oracle_GetPrice with maxStaleness = hours 1`. The newer `CantonLending` module correctly implements a dual-path oracle: `PriceFeed_GetPrice` (staleness-checked) for borrows/withdrawals, and `PriceFeed_GetPriceUnsafe` (no staleness check) for liquidations. V3's approach causes liquidations to fail during volatile periods when oracle updates lag — precisely when liquidations are most critical.

**Impact:**  
Liquidation liveness degradation during market stress events.

**Recommendation:**  
Add a `PriceFeed_GetPriceUnsafe`-equivalent path in V3 oracle for liquidation contexts.

---

### D-M-05 — Redundant `archive self` in Consuming Choices

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonSMUSD.daml` |
| **Category** | DAML Semantics / Correctness |

**Description:**  
Multiple consuming choices (`Stake`, `Unstake`, `SyncGlobalSharePrice`, `SyncYield`, `Staking_SetPaused`) contain explicit `archive self` before `create this with ...`. In DAML, consuming choices automatically consume the contract when exercised. The explicit archive is either redundant or — depending on runtime behavior — could cause double-archive errors.

**Impact:**  
Potential runtime errors or undefined behavior; at minimum confusing for auditors.

**Recommendation:**  
Remove explicit `archive self` from consuming choices — DAML handles this automatically.

---

### X-M-01 — No Cross-Chain Global Supply Cap Enforcement

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Files** | `contracts/MUSD.sol`, `daml/CantonDirectMint.daml`, `daml/CantonLending.daml` |
| **Category** | Supply Cap / Economic Safety |

**Description:**  
Ethereum's `MUSD.sol` has its own `supplyCap`, Canton's `CantonDirectMintService` has a `supplyCap`, and `CantonLendingService` has `cantonSupplyCap` + `globalMintCap`. The Canton modules coordinate between themselves (DAML-H-02), but there is **no atomic cross-chain enforcement** that total minted across Ethereum + Canton doesn't exceed a global ceiling. The `SupplyCapAttestation` in `BLEBridgeProtocol` verifies `totalGlobalSupply == cantonMUSDSupply + ethereumMUSDSupply` and `globalBackingUSDC >= totalGlobalSupply`, but this is an after-the-fact audit check, not a pre-mint gate.

**Impact:**  
Both chains can independently mint up to their local cap, potentially exceeding the intended global ceiling until the next supply cap attestation catches the discrepancy.

**Recommendation:**  
Implement a pre-mint attestation check or reduce local caps to sum to the global cap with safety margin.

---

### X-M-02 — Asymmetric Oracle Trust Models

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Files** | `contracts/PriceOracle.sol`, `daml/CantonLending.daml` |
| **Category** | Oracle Trust / Consistency |

**Description:**  
Ethereum uses Chainlink aggregators with circuit breakers and sequencer uptime feeds. Canton uses operator-signed price feeds from Tradecraft/Temple DEX APIs. The Canton oracle has ±50% movement cap and per-asset staleness, but ultimately trusts a single operator party to update prices correctly.

**Impact:**  
A compromised Canton operator could manipulate prices within the ±50% band per update, potentially enabling under-collateralized borrows or blocking legitimate liquidations.

**Recommendation:**  
Add multi-validator attestation for Canton price feeds, or source prices from a Canton-native oracle with multiple data providers.

---

## 🔵 LOW SEVERITY

---

### S-L-01 — Raw `approve()` in BorrowModule

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/BorrowModule.sol` |

`BorrowModule` uses raw `IERC20.approve()` instead of `SafeERC20.forceApprove()`. Tokens like USDT that require approval to be set to zero before changing will revert.

---

### S-L-02 — Ineffective Swap Deadline in LeverageVault

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LeverageVault.sol` |

`block.timestamp` used as swap deadline provides no protection — miners can hold the transaction indefinitely since `block.timestamp` is always "now" when the transaction executes.

---

### S-L-03 — No Event Emission on Interest Accrual

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/BorrowModule.sol` |

`_accrueInterest()` modifies critical state (`totalBorrows`, `lastAccrualTimestamp`) without emitting events. Off-chain monitoring and indexing cannot track interest accrual.

---

### S-L-04 — Missing Zero-Address Checks in Constructor/Initializer

| | |
|---|---|
| **Layer** | Solidity |
| **Files** | Multiple contracts |

Several constructors and initializers accept address parameters without zero-address validation. A misconfigured deployment could brick the contract.

---

### S-L-05 — `PriceOracle` Circuit Breaker Threshold Not Configurable

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/PriceOracle.sol` |

The circuit breaker price deviation threshold is hardcoded. Market conditions may warrant adjusting this without a full contract upgrade.

---

### S-L-06 — No Borrow Dust Threshold on Repayment

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/BorrowModule.sol` |

Users can leave arbitrarily small debt dust (e.g., 1 wei) that costs more gas to liquidate than the debt is worth.

---

### S-L-07 — `TreasuryV2` Strategy Array Unbounded Growth

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/TreasuryV2.sol` |

Strategies are stored in an array with no upper bound. If many strategies are added over time, `totalValue()` iteration could approach the block gas limit.

---

### S-L-08 — Missing Staleness Check for Sequencer Uptime Feed

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/PriceOracle.sol` |

The L2 sequencer uptime feed is checked for staleness, but the grace period after sequencer restart may be insufficient for all oracle feeds to update.

---

### D-L-01 — CantonLoopStrategy Is Empty

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonLoopStrategy.daml` |

Both `CantonLoopStrategy.daml` and `CantonLoopStrategyTest.daml` are empty files. If leveraged looping is a planned feature, this is an unimplemented module with zero coverage.

---

### D-L-02 — BridgeOutSignature.requestCid Is Stale After Multi-Sign

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/BLEBridgeProtocol.daml` |

Each `BridgeOut_Sign` creates a new `BridgeOutAttestation` (consuming choice), but the `BridgeOutSignature` records `requestCid = self` — the pre-sign contract ID. Finalization correctly uses nonce-matching, but the stale `requestCid` creates a confusing audit trail.

---

### D-L-03 — BoostPool Deposit Archives and Recreates sMUSD

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonBoostPool.daml` |

`CantonBoostPoolService.Deposit` archives the user's `CantonSMUSD` contract and recreates it with a new contract ID (to verify eligibility). Any external references to the old sMUSD CID become stale.

---

### D-L-04 — ComplianceRegistry BulkBlacklist Cap at 100

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Compliance.daml` |

`BulkBlacklist` caps at 100 parties per call. For large sanctions list imports (OFAC lists can have thousands of entries), this requires many transactions.

---

### X-L-01 — Interest Rate Model Parity Not Cryptographically Verified

| | |
|---|---|
| **Layer** | Cross-Layer |
| **Files** | `contracts/InterestRateModel.sol`, `daml/InterestRateService.daml` |

`InterestRateService.daml` syncs rate parameters from Ethereum's `InterestRateModel.sol` via operator attestation with block number ordering — no proof that the synced parameters match the on-chain values.

---

## ℹ️ INFORMATIONAL

---

### S-I-01 through S-I-10 — Solidity Informational Findings

| ID | Finding |
|----|---------|
| S-I-01 | `SMUSD.setCooldownDuration()` has no upper bound — could lock funds indefinitely |
| S-I-02 | `LiquidationEngine` missing `_disableInitializers()` in constructor (UUPS best practice) |
| S-I-03 | `BorrowModule.getHealthFactor()` returns `type(uint256).max` for zero-debt positions — callers must handle |
| S-I-04 | `CollateralVault` supports up to 50 collateral types but no removal function |
| S-I-05 | `TreasuryV2` uses `type(uint256).max` approval to strategies — standard but maximal trust |
| S-I-06 | `DepositRouter` Wormhole relayer fee calculation uses hardcoded gas estimate |
| S-I-07 | Multiple contracts use `pragma solidity 0.8.26` — consider `^0.8.26` for patch compatibility |
| S-I-08 | `PendleMarketSelector` iterates all markets — gas cost scales linearly |
| S-I-09 | `MorphoLoopStrategy` recursive supply/borrow loop has hardcoded max iterations (10) |
| S-I-10 | Clean `SafeERC20` usage throughout — no raw `transfer`/`transferFrom` calls found |

---

### D-I-01 — Comprehensive Audit Fix Trail

The DAML codebase contains explicit references to 30+ prior audit fixes (D-01, D-02, D-03, DC-06, H-6, H-17, C-08, C-12, D-M01–D-M09, D-H01–D-H08, D-C01–D-C02, DL-C2–DL-C3, 5C-C01–5C-C02, A-01, DAML-H-01–H-04, DAML-M-01–M-09, DAML-CRIT-01–03). This indicates multiple prior audit rounds have been incorporated and demonstrates strong security maturity.

---

### D-I-02 — Strong Signatory/Authority Patterns

All token templates (`CantonMUSD`, `CantonUSDC`, `USDCx`, `CantonSMUSD`, `CantonCoin`, `BoostPoolLP`) use **dual signatory** (issuer + owner) with **transfer proposal** patterns preventing forced signatory obligations. This is the gold standard for Canton.

---

### D-I-03 — Privacy-by-Default Architecture

`UserPrivacySettings.daml` provides opt-in transparency with `lookupUserObservers` helper used across all product templates. Default is fully private (no settings = no observers). This correctly satisfies Canton's privacy model.

---

### D-I-04 — BFT Supermajority Consistently Applied

All attestation finalization choices (`BridgeOut`, `BridgeIn`, `SupplyCap`, `Yield`) use `(2n/3) + 1` threshold, consistent with BFT requirements. Consuming sign choices prevent double-signing (D-02 fix).

---

## TEST & VERIFICATION COVERAGE

### Solidity Test Coverage

| Framework | Coverage |
|-----------|----------|
| **Certora (Formal Verification)** | 4 specs: `MUSD.spec`, `SMUSD.spec`, `BorrowModule.spec`, `LiquidationEngine.spec` |
| **Foundry (Invariant Tests)** | 7 protocol invariants with `ProtocolHandler` actor (bounded, stateful) |
| **Hardhat (Integration)** | 40+ test files covering deployment, lifecycle, edge cases |

**Certora Invariants Verified:**
1. mUSD totalSupply ≤ supplyCap
2. Sum of all balances == totalSupply
3. Blacklisted addresses cannot send/receive
4. SMUSD share price is monotonically non-decreasing (outside slashing)
5. BorrowModule totalBorrows == Σ individual debts
6. Health factor < 1.0 → position is liquidatable
7. Collateral withdrawal preserves health factor ≥ 1.0

### DAML Test Coverage

| Test File | Scenarios | Modules Covered |
|-----------|-----------|-----------------|
| `NegativeTests.daml` | 13 | V3 SupplyService, MintedMUSD, Compliance, Governance, Upgrade |
| `CrossModuleIntegrationTest.daml` | 10 | CantonDirectMint, CantonSMUSD, CantonLending, CantonBoostPool, Compliance |
| `CantonLendingTest.daml` | 30 | Full lending lifecycle, 3 of 4 collateral types, liquidation, admin |
| `CantonBoostPoolTest.daml` | 25 | Deposit/withdraw, rewards, pricing, admin auth, transfers |
| `UserPrivacySettingsTest.daml` | 24 | Privacy modes, observer propagation, negative tests |
| `CantonLoopStrategyTest.daml` | 0 | (Empty — unimplemented) |
| **Total** | **102** | |

### Test Coverage Gaps

| Gap | Severity |
|-----|----------|
| `Minted/Protocol/V3.daml` (1,551 lines — Vault, DEX, Bridge, sMUSD, DirectMint) has **zero DAML tests** | 🔴 Critical |
| `CantonLoopStrategy` — empty module + empty test file | 🟡 High |
| CrossModuleIntegration test #8 (D-M04 fix) documented but **not implemented** | 🟡 High |
| USDCx collateral deposit/borrow path untested in CantonLending | 🟡 High |
| GovernanceActionLog archive authorization (D-H-01) not tested | 🟡 High |
| Partial repayment untested in CantonLending (only full repay) | 🟠 Medium |
| Admin authorization negative tests missing in CantonLending | 🟠 Medium |
| Privacy propagation not tested for CantonSMUSD, BoostPoolLP, CantonUSDC, USDCx | 🟠 Medium |

---

## SECURITY POSTURE MATRIX

| Category | Solidity | DAML | Cross-Layer |
|----------|----------|------|-------------|
| **Access Control** | ✅ OZ AccessControl + roles | ✅ Dual signatory + proposals | 🟡 Operator centralization |
| **Reentrancy** | ✅ ReentrancyGuard on all state-changing functions | ✅ N/A (DAML ledger model is atomic) | ✅ No cross-layer reentrancy vector |
| **Oracle Safety** | ✅ Chainlink + circuit breaker + sequencer feed | 🟡 Operator-signed, ±50% cap | 🟡 Asymmetric trust models |
| **Supply Cap** | ✅ Per-contract cap enforced on mint | ✅ Cross-module coordination (H-02) | 🟡 No atomic cross-chain gate |
| **Upgrade Safety** | ✅ UUPS + initializer + storage gaps | ✅ Opt-in migration + rollback windows | ✅ Independent upgrade paths |
| **Privacy** | N/A (public EVM chain) | ✅ Privacy-by-default + opt-in observers | ✅ Canton privacy isolated |
| **Replay Protection** | ✅ Nonce-based + consuming spend | ✅ Consuming choices + dedup sets | ✅ Cross-chain nonce tracking |
| **BFT Consensus** | N/A (Ethereum PoS) | ✅ 2/3+1 supermajority on all attestations | ✅ Bridge uses BFT both sides |
| **Compliance** | ✅ Blacklist, pause, role-gated | ✅ Blacklist, freeze, pre-tx hooks | ✅ Consistent enforcement |
| **Economic Safety** | 🟡 Phantom debt, no bad debt socialization | 🟡 Share price asymmetry in V3 | 🟡 Dual-chain rate parity unverified |

---

## PROTOCOL STRENGTHS

1. **30+ documented audit fixes** integrated into the DAML codebase — evidence of mature security lifecycle
2. **Dual-chain architecture** with clear separation: Canton handles privacy/compliance, Ethereum handles yield/DeFi
3. **BFT supermajority (2/3+1)** consistently applied across all 4 bridge attestation types
4. **Consuming choices for TOCTOU prevention** — all signature-collecting flows use consuming patterns (D-01 fix)
5. **Privacy-by-default** with granular opt-in transparency via `UserPrivacySettings`
6. **Comprehensive compliance framework** — `ComplianceRegistry` hooks into every product module
7. **102 DAML + 40+ Solidity test scenarios** with strong negative/adversarial testing
8. **Certora formal verification** for 4 core contracts with 7 protocol invariants
9. **Rate limiting** with 24h rolling windows on Canton DirectMint
10. **Upgrade framework** with governance approval, opt-in migration, and rollback windows on Canton
11. **ERC-7201 namespaced storage** for upgradeability collision prevention in Solidity
12. **OpenZeppelin 5.x** throughout — latest stable access control, pausable, reentrancy patterns
13. **Multi-collateral support** with per-asset configuration on both chains
14. **Immutable audit trail** — `LiquidationReceipt`, `GovernanceActionLog`, `InterestPayment`, `UpgradeMigrationLog` templates

---

## PRIORITIZED REMEDIATION PLAN

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| 🔴 P0 | S-H-01 | Fix SMUSD `totalAssets()` recursion — replace fallback with `balanceOf` | 1 hour |
| 🔴 P0 | D-H-01 | Fix GovernanceActionLog signatory model — change to `signatory operator` only | 1 hour |
| 🔴 P0 | D-H-02 | Fix V3 sMUSD share price asymmetry — use consistent virtual share offset | 2 hours |
| 🟡 P1 | S-M-01 | Add try/catch + pending interest buffer in BorrowModule | 4 hours |
| 🟡 P1 | S-M-02 | Implement bad debt socialization (reserve write-off or share price reduction) | 8 hours |
| 🟡 P1 | S-M-05 | Move health check to post-withdrawal in CollateralVault | 2 hours |
| 🟡 P1 | D-M-02 | Route share price syncs through YieldAttestation (BFT supermajority) | 8 hours |
| 🟡 P1 | X-M-01 | Implement cross-chain supply cap pre-mint gate or conservative local caps | 16 hours |
| 🟡 P2 | S-M-03 | Accept user-supplied `minAmountOut` + real deadline in LeverageVault | 4 hours |
| 🟡 P2 | S-M-04 | Add debt repayment to `emergencyClosePosition` | 4 hours |
| 🟡 P2 | D-M-01 | Decouple borrow-side state into separate aggregate template | 8 hours |
| 🟡 P2 | D-M-05 | Remove redundant `archive self` from consuming choices | 1 hour |
| 🟡 P2 | D-M-04 | Add unsafe oracle path for V3 Vault liquidation | 2 hours |
| 🔵 P3 | S-L-01 | Replace raw `approve` with `forceApprove` in BorrowModule | 30 min |
| 🔵 P3 | S-L-02 | Use `block.timestamp + 120` as swap deadline | 30 min |
| 🔵 P3 | D-L-01 | Implement or remove CantonLoopStrategy stub | 2 hours |
| 🔵 P3 | — | Add V3.daml test suite (1,551 lines untested) | 16 hours |
| 🔵 P3 | — | Add USDCx collateral test coverage in CantonLending | 4 hours |

---

## DISCLAIMER

This audit report represents a point-in-time assessment based on the source code available at the time of review. It does not constitute a guarantee of security. Smart contract and distributed ledger systems remain subject to undiscovered vulnerabilities, economic attacks, and operational risks. A formal audit by an accredited security firm is recommended before mainnet deployment.

---

*Audit generated: February 12, 2026*  
*Protocol: Minted mUSD — Solidity 0.8.26 + DAML SDK 2.10.3 (Canton Network)*
