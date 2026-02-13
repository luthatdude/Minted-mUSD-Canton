# Minted mUSD Canton — Comprehensive Test Coverage Audit

**Date:** February 13, 2026  
**Scope:** All test layers — Hardhat, Foundry, Certora, DAML, TypeScript, Integration  
**Auditor:** testing-agent

---

## 1. Executive Summary

| Metric | Value |
|--------|-------|
| **Total Hardhat test cases (`it()`)** | **1,769** |
| **Foundry test functions** | **35** (12 fuzz + 8 invariant + 8 fork + 7 reentrancy) |
| **Certora rules + invariants** | **91** across 11 spec files |
| **Halmos symbolic specs** | **4** |
| **DAML test scenarios** | **~245** across 6 test files |
| **TypeScript (relay + bot) test cases** | **73** |
| **Frontend test cases** | **0** |
| **Production contracts** | **21** (core) + **5** (upgradeable) + **3** (strategies) |
| **Contracts with dedicated unit tests** | **21/21** core |
| **Contracts with Certora specs** | **11/21** |
| **Deploy/migration scripts tested** | **0/6** |
| **Test Coverage Score** | **7.5 / 10** |

---

## 2. Test Layer Analysis

### 2.1 Hardhat Tests (test/*.test.ts)

| Test File | Contract(s) Covered | Test Count | Edge Cases | Negative Tests | Boundary |
|-----------|---------------------|------------|------------|----------------|----------|
| BLEBridgeV9.test.ts | BLEBridgeV9 | 37 | ✅ | ✅ | ✅ |
| BorrowModule.test.ts | BorrowModule | 35 | ✅ | ✅ | ✅ |
| CollateralVault.test.ts | CollateralVault | 36 | ✅ | ✅ | ✅ |
| DirectMintV2.test.ts | DirectMintV2 | 26 | ✅ | ✅ | ✅ |
| InterestRateModel.test.ts | InterestRateModel | 29 | ✅ | ✅ | ✅ |
| LeverageVault.test.ts | LeverageVault | 40 | ✅ | ✅ | ✅ |
| LeverageVaultFlashLoan.test.ts | LeverageVault (security) | 30 | ✅ | ✅ | ✅ |
| LiquidationEngine.test.ts | LiquidationEngine | 28 | ✅ | ✅ | ✅ |
| MUSD.test.ts | MUSD | 40 | ✅ | ✅ | ✅ |
| SMUSD.test.ts | SMUSD | 64 | ✅ | ✅ | ✅ |
| SMUSDPriceAdapter.test.ts | SMUSDPriceAdapter | 39 | ✅ | ✅ | ✅ |
| PriceOracle.test.ts | PriceOracle | 22 | ✅ | ✅ | ✅ |
| TreasuryV2.test.ts | TreasuryV2 | 53 | ✅ | ✅ | ✅ |
| TreasuryReceiver.test.ts | TreasuryReceiver | 32 | ✅ | ✅ | ✅ |
| DepositRouter.test.ts | DepositRouter | 51 | ✅ | ✅ | ✅ |
| RedemptionQueue.test.ts | RedemptionQueue | 37 | ✅ | ✅ | ✅ |
| PendleMarketSelector.test.ts | PendleMarketSelector | 31 | ✅ | ✅ | ✅ |
| PendleStrategyV2.test.ts | PendleStrategyV2 | 70 | ✅ | ✅ | ✅ |
| MorphoLoopStrategy.test.ts | MorphoLoopStrategy | 55 | ✅ | ✅ | ✅ |
| SkySUSDSStrategy.test.ts | SkySUSDSStrategy | 13 | ⚠️ | ✅ | ⚠️ |
| TimelockWiring.test.ts | MintedTimelockController | 14 | ✅ | ✅ | ✅ |
| UpgradeablePath.test.ts | All 5 Upgradeable contracts | 19 | ✅ | ✅ | ⚠️ |
| FuzzTests.test.ts | InterestRateModel, PriceOracle, SMUSD | 28 | ✅ | ✅ | ✅ |
| RelayIntegration.test.ts | Relay utils | 43 | ✅ | ✅ | ✅ |
| BotServiceCoverage.test.ts | Bot service | 32 | ✅ | ✅ | — |

**Coverage Boost / Audit Tests (supplementary):**

| Test File | Test Count | Purpose |
|-----------|------------|---------|
| CoverageBoost_MiscContracts.test.ts | 204 | Broad coverage |
| InstitutionalAudit.test.ts | 150 | Institutional-grade audit |
| CoverageBoost_PendleStrategyV2_Full.test.ts | 136 | Strategy coverage |
| DeepAudit.test.ts | 82 | Deep audit |
| CoverageBoost_PendleMarketSelector_Full.test.ts | 60 | Market selector |
| CoverageBoost_DirectMintV2.test.ts | 60 | Mint/redeem |
| DeepAuditV2.test.ts | 58 | Follow-up audit |
| CoverageBoost_PendleStrategyV2.test.ts | 38 | Strategy |
| CoverageBoost_BLEBridgeV9_Branches.test.ts | 28 | Bridge branches |
| CoverageBoost_BLEBridgeV9.test.ts | 27 | Bridge |
| CoverageBoost_PendleMarketSelector.test.ts | 15 | Market selector |
| CoverageBoost_EdgeCases.test.ts | 7 | Edge cases |

### 2.2 Foundry/Forge Tests (test/foundry/)

| Test File | Lines | Test Count | Type | Contracts Covered |
|-----------|-------|------------|------|-------------------|
| FuzzTest.t.sol | 344 | 12 | Fuzz (property-based) | MUSD, SMUSD, BorrowModule, CollateralVault, InterestRateModel, DirectMintV2 |
| InvariantTest.t.sol | 234 | 8 | Stateful invariant | MUSD, SMUSD, BorrowModule, CollateralVault, PriceOracle, InterestRateModel |
| ProtocolHandler.sol | 264 | — | Handler for invariants | All core contracts |
| ForkTest.t.sol | 302 | 8 | Mainnet fork | Chainlink, Morpho Blue, Sky PSM, Pendle, Uniswap V3 |
| ReentrancyTest.t.sol | 317 | 7 | Reentrancy attack | CollateralVault, BorrowModule, LiquidationEngine, SMUSD |
| HalmosSpec.t.sol | 106 | 4 | Symbolic execution | MUSD |

### 2.3 Certora Formal Verification (certora/specs/)

| Spec File | Lines | Rules + Invariants | Key Properties Verified |
|-----------|-------|-------------------|------------------------|
| MUSD.spec | 151 | 13 | Supply cap, balance conservation, blacklist, mint/burn correctness |
| SMUSD.spec | 157 | 12 | Vault solvency, share price monotonicity, ERC-4626 roundtrip, pause |
| BorrowModule.spec | 187 | 12 | Health factor, min debt, repay correctness, interest, pause |
| DirectMintV2.spec | 162 | 12 | Fee bounds, preview/actual match, limits, fee monotonicity, pause |
| InterestRateModel.spec | 126 | 10 | Utilization bounds, rate monotonicity, interest split, parameter bounds |
| LiquidationEngine.spec | 109 | 8 | Healthy position guard, self-liquidation, close factor, seizure monotonicity |
| DepositRouter.spec | 109 | 7 | Fee cap, fee accounting, deposit bounds, completion finality, pause |
| BLEBridgeV9.spec | 53 | 5 | Mint cap, nonce replay, minting totals |
| LeverageVault.spec | 63 | 4 | Zero collateral, close repays debt, emergency auth, skip-health-check |
| PriceOracle.spec | 46 | 4 | Zero amount, circuit breaker, monotonicity |
| TreasuryV2.spec | 38 | 4 | Non-negative value, allocated ≤ value, withdrawal, access control |

**Contracts WITHOUT Certora specs:**
- ❌ CollateralVault
- ❌ RedemptionQueue
- ❌ PendleMarketSelector
- ❌ SMUSDPriceAdapter
- ❌ TreasuryReceiver
- ❌ MintedTimelockController
- ❌ TimelockGoverned
- ❌ MorphoLoopStrategy
- ❌ PendleStrategyV2
- ❌ SkySUSDSStrategy

### 2.4 DAML Tests (daml/)

| Test File | Estimated Scenarios | Modules Covered |
|-----------|-------------------|-----------------|
| CantonBoostPoolTest.daml | ~50 | CantonBoostPool |
| CantonLendingTest.daml | ~82 | CantonLending |
| CantonLoopStrategyTest.daml | ~50 | CantonLoopStrategy |
| CrossModuleIntegrationTest.daml | ~64 | Cross-module integration |
| NegativeTests.daml | ~52 | Negative/error paths |
| UserPrivacySettingsTest.daml | ~49 | UserPrivacySettings |

**DAML modules WITHOUT test files:**
- ❌ BLEBridgeProtocol.daml
- ❌ BLEProtocol.daml
- ❌ CantonCoinToken.daml
- ❌ CantonDirectMint.daml
- ❌ CantonSMUSD.daml
- ❌ Compliance.daml
- ❌ Governance.daml
- ❌ InstitutionalAssetV4.daml
- ❌ InterestRateService.daml
- ❌ MUSD_Protocol.daml
- ❌ MintedMUSD.daml
- ❌ TokenInterface.daml
- ❌ Upgrade.daml

### 2.5 TypeScript Tests (Relay / Bot)

| File | Location | Test Count | Covers |
|------|----------|------------|--------|
| signer.test.ts | relay/__tests__/ | 14 | KMS signer |
| utils.test.ts | relay/__tests__/ | 15 | Utility functions |
| relay-integration.test.ts | relay/test/ | 20 | Relay integration |
| bot-services.test.ts | bot/test/ | 24 | Bot keeper services |

### 2.6 Frontend Tests

**⚠️ ZERO frontend test files found.** No unit tests, no integration tests, no E2E tests exist under `frontend/`.

### 2.7 Integration / E2E Tests

- `RelayIntegration.test.ts` — Tests relay utility validation (key validation), **not full E2E**
- `CrossModuleIntegrationTest.daml` — DAML-side cross-module tests
- `ForkTest.t.sol` — Mainnet fork integration against real DeFi protocols
- **No true E2E test** that exercises: Relay → Bridge → DAML → EVM in sequence

---

## 3. Contract × Test Type Coverage Matrix

| Contract | Unit Tests | Fuzz Tests | Invariant Tests | Reentrancy Tests | Formal Verification | Fork Tests | Upgrade Tests |
|----------|-----------|------------|-----------------|------------------|-------------------|------------|---------------|
| **MUSD** | ✅ 40 | ✅ Foundry | ✅ Foundry | — | ✅ 13 rules + Halmos | — | — |
| **SMUSD** | ✅ 64 | ✅ HH + Foundry | ✅ Foundry | ✅ Foundry | ✅ 12 rules | — | ✅ |
| **BLEBridgeV9** | ✅ 37+55 | — | — | — | ✅ 5 rules | — | — |
| **BorrowModule** | ✅ 35 | ✅ Foundry | ✅ Foundry | ✅ Foundry | ✅ 12 rules | — | ✅ |
| **CollateralVault** | ✅ 36 | ✅ Foundry | ✅ Foundry | ✅ Foundry | ❌ | — | ✅ |
| **DirectMintV2** | ✅ 26+60 | ✅ Foundry | — | — | ✅ 12 rules | — | — |
| **InterestRateModel** | ✅ 29+28 | ✅ HH + Foundry | ✅ Foundry | — | ✅ 10 rules | — | — |
| **LeverageVault** | ✅ 40+30 | — | — | — | ✅ 4 rules | — | ✅ |
| **LiquidationEngine** | ✅ 28 | — | — | ✅ Foundry | ✅ 8 rules | — | ✅ |
| **PriceOracle** | ✅ 22 | ✅ HH | — | — | ✅ 4 rules | ✅ Chainlink | — |
| **TreasuryV2** | ✅ 53 | — | — | — | ✅ 4 rules | — | — |
| **TreasuryReceiver** | ✅ 32 | — | — | — | ❌ | — | — |
| **DepositRouter** | ✅ 51 | — | — | — | ✅ 7 rules | — | — |
| **RedemptionQueue** | ✅ 37 | — | — | — | ❌ | — | — |
| **PendleMarketSelector** | ✅ 31+75 | — | — | — | ❌ | — | — |
| **PendleStrategyV2** | ✅ 70+174 | — | — | — | ❌ | ✅ Pendle Router | — |
| **MorphoLoopStrategy** | ✅ 55 | — | — | — | ❌ | ✅ Morpho | — |
| **SkySUSDSStrategy** | ✅ 13 | — | — | — | ❌ | ✅ Sky PSM | — |
| **SMUSDPriceAdapter** | ✅ 39 | — | — | — | ❌ | — | — |
| **MintedTimelockController** | ✅ 14 | — | — | — | ❌ | — | — |
| **TimelockGoverned** | ⚠️ indirect | — | — | — | ❌ | — | — |

**Legend:** ✅ = covered | ⚠️ = partial | ❌ = missing | — = not applicable

---

## 4. Deploy & Migration Script Test Coverage

| Script | Has Test? | Risk |
|--------|-----------|------|
| deploy-deposit-router.ts | ❌ | HIGH — production deploy |
| deploy-leverage-vault.ts | ❌ | HIGH — production deploy |
| deploy-mock-oracles.ts | ❌ | LOW — testnet only |
| deploy-testnet.ts | ❌ | MEDIUM — testnet deploy |
| migrate-to-multisig.ts | ❌ | CRITICAL — access transfer |
| migrate-v8-to-v9.ts | ❌ | CRITICAL — state migration |
| validate-storage-layout.ts | ❌ | HIGH — upgrade safety |
| verify-roles.ts | ❌ | MEDIUM — access validation |

---

## 5. Upgrade Path Test Coverage

| Upgradeable Contract | Proxy Deploy Test | Auth-Gated Upgrade | Storage Preservation | Re-init Block |
|---------------------|-------------------|-------------------|---------------------|---------------|
| CollateralVaultUpgradeable | ✅ | ✅ | — | ✅ |
| BorrowModuleUpgradeable | ✅ | ✅ | ✅ | ✅ |
| SMUSDUpgradeable | ✅ | ✅ | ✅ | ✅ |
| LiquidationEngineUpgradeable | ✅ | ✅ | — | ✅ |
| LeverageVaultUpgradeable | ✅ | ✅ | — | ✅ |

**Gaps:** CollateralVault and LiquidationEngine upgrade tests do NOT verify storage preservation. LeverageVault upgrade also lacks storage preservation test.

---

## 6. Top 10 Critical Test Gaps

### TEST-H-01 — No Certora Spec for CollateralVault
- **Severity:** HIGH
- **Description:** CollateralVault manages all protocol collateral but has zero formal verification rules. Its accounting invariant (vault balance = sum of deposits) is only tested in Foundry, not formally proven.
- **Impact:** Subtle collateral accounting bugs (e.g., rounding, deposit/withdrawal ordering) could go undetected, leading to insolvency.
- **Recommendation:** Create `certora/specs/CollateralVault.spec` with rules for: deposit/withdraw conservation, multi-collateral balance invariants, access control, and health factor integration.

### TEST-H-02 — No Certora Spec for RedemptionQueue
- **Severity:** HIGH
- **Description:** RedemptionQueue handles mUSD → USDC redemptions with FIFO ordering, cooldowns, and daily limits — all of which are critical safety mechanisms that lack formal verification.
- **Impact:** Queue ordering bugs, cooldown bypasses, or daily limit circumvention could drain USDC reserves.
- **Recommendation:** Create `certora/specs/RedemptionQueue.spec` with rules for FIFO ordering, cooldown enforcement, daily limit monotonicity, and no-skip guarantees.

### TEST-H-03 — Zero Frontend Tests
- **Severity:** HIGH
- **Description:** The Next.js frontend (`frontend/`) has zero test files — no unit, integration, or E2E tests.
- **Impact:** UI bugs could cause users to submit transactions with wrong parameters, display incorrect balances, or interact with wrong contracts.
- **Recommendation:** Add React Testing Library unit tests for all components, and Cypress/Playwright E2E tests for critical user flows (connect wallet → mint → stake → redeem).

### TEST-H-04 — Deploy/Migration Scripts Untested
- **Severity:** HIGH
- **Description:** All 6 deploy scripts and 2 migration scripts have zero automated tests. `migrate-to-multisig.ts` (access transfer) and `migrate-v8-to-v9.ts` (state migration) are especially critical.
- **Impact:** A deploy script bug could initialize contracts with wrong parameters, grant wrong roles, or fail to revoke deployer admin. Migration bugs could lose state or break access control.
- **Recommendation:** Write fork-simulation tests for each deploy/migration script using Hardhat mainnet fork. Validate: role assignments, parameter values, storage layout, and post-migration state.

### TEST-H-05 — No True End-to-End Cross-Layer Tests
- **Severity:** HIGH
- **Description:** No automated test exercises the full deposit path: User → DepositRouter → Wormhole → TreasuryReceiver → DirectMint → MUSD mint. The relay, bridge, and EVM contracts are tested in isolation.
- **Impact:** Integration bugs at layer boundaries (serialization, nonce handling, chain ID mismatch) would go undetected until production.
- **Recommendation:** Create an E2E integration test harness that simulates: (1) relay signing, (2) Wormhole VAA generation, (3) TreasuryReceiver processing, (4) DirectMint execution, (5) balance verification.

### TEST-M-01 — SkySUSDSStrategy Has Minimal Tests (13 cases)
- **Severity:** MEDIUM
- **Description:** SkySUSDSStrategy has only 13 test cases — the least of any strategy. Missing: yield accrual testing, partial withdrawal, recover with non-protected tokens, boundary conditions on deposit amounts.
- **Impact:** Bugs in yield accounting or edge-case deposit amounts could cause loss of funds in the Sky/Maker yield strategy.
- **Recommendation:** Add tests for: yield simulation, withdrawAll, partial withdrawals with rounding, max deposit amounts, and integration with TreasuryV2 allocation.

### TEST-M-02 — No Fuzz/Invariant Tests for LeverageVault
- **Severity:** MEDIUM
- **Description:** LeverageVault (flash-loan leveraged positions) has good unit/security tests but zero Foundry fuzz or invariant tests. Its Certora spec has only 4 rules — the fewest of any financial-critical contract.
- **Impact:** Complex state transitions in leverage/deleverage cycles may have edge cases that only property-based testing would discover (e.g., rounding at extreme leverage ratios, dust amounts after close).
- **Recommendation:** Add Foundry fuzz tests for `openLeveragedPosition` / `closeLeveragedPosition` with random amounts and leverage ratios. Add invariants: user always gets back ≤ deposited, no orphaned positions.

### TEST-M-03 — No Certora Specs for Any Strategy Contract
- **Severity:** MEDIUM
- **Description:** All 3 yield strategies (MorphoLoopStrategy, PendleStrategyV2, SkySUSDSStrategy) lack formal verification specs. These contracts hold protocol treasury funds.
- **Impact:** Strategy bugs could lead to silent fund loss, incorrect yield reporting, or stuck funds.
- **Recommendation:** Create Certora specs verifying: deposit increases totalValue, withdraw decreases totalValue, only TREASURY_ROLE can deposit/withdraw, total value ≥ 0.

### TEST-M-04 — Upgrade Storage Preservation Incomplete
- **Severity:** MEDIUM
- **Description:** Only BorrowModuleUpgradeable and SMUSDUpgradeable have storage preservation tests. CollateralVaultUpgradeable, LiquidationEngineUpgradeable, and LeverageVaultUpgradeable do NOT test that state is preserved across upgrades.
- **Impact:** An upgrade could silently zero out critical storage slots (collateral balances, liquidation parameters, position data).
- **Recommendation:** Add storage preservation tests for all 5 upgradeable contracts: set state → upgrade → verify state unchanged.

### TEST-M-05 — 13 DAML Modules Without Test Files
- **Severity:** MEDIUM
- **Description:** 13 out of 19+ DAML modules have no dedicated test files, including critical modules like `BLEBridgeProtocol.daml`, `Compliance.daml`, `Governance.daml`, and `TokenInterface.daml`.
- **Impact:** Bugs in Canton-side compliance logic, governance workflows, or token bridging could go undetected.
- **Recommendation:** Create test scripts for at minimum: BLEBridgeProtocol, Compliance, Governance, and CantonDirectMint.

---

## 7. Test Quality Assessment

### Strengths
1. **Core contracts all have unit tests** — Every production Solidity contract has a dedicated `.test.ts` file
2. **Strong fuzz testing** — Both Hardhat-based (FuzzTests.test.ts, 28 cases) and Foundry-based (12 functions) fuzz tests cover critical math
3. **Foundry stateful invariant tests** — 8 protocol-wide invariants using a proper handler pattern with ghost variables
4. **Reentrancy testing** — Dedicated `ReentrancyTest.t.sol` + `LeverageVaultFlashLoan.test.ts` test real reentrancy attack vectors
5. **Certora coverage of financial core** — 11 specs covering MUSD, SMUSD, BorrowModule, LiquidationEngine with rigorous properties
6. **Mainnet fork tests** — Validates integrations against real Chainlink, Morpho, Pendle, Uniswap, Sky deployments
7. **Coverage boost files** — Large supplementary test files (575+ additional cases) fill coverage gaps
8. **Upgrade path tests** — All 5 upgradeable contracts have proxy deploy + auth-gated upgrade tests
9. **Negative/edge case testing** — Excellent: supply cap boundaries (exact + 1 wei over), self-liquidation rejection, zero-amount guards, pause enforcement
10. **Symbolic execution** — HalmosSpec.t.sol provides symbolic proof for MUSD supply cap and transfer conservation

### Weaknesses
1. No frontend tests at all
2. Deploy scripts completely untested
3. 10/21 contracts lack formal verification
4. No true cross-chain E2E tests
5. SkySUSDSStrategy undertested relative to complexity

---

## 8. Test Count Summary

| Layer | Test Count |
|-------|-----------|
| Hardhat unit tests (`it()`) | 1,769 |
| Foundry fuzz test functions | 12 |
| Foundry invariant functions | 8 |
| Foundry fork test functions | 8 |
| Foundry reentrancy test functions | 7 |
| Halmos symbolic specs | 4 |
| Certora rules + invariants | 91 |
| DAML test scenarios | ~245 |
| Relay/Bot TypeScript tests | 73 |
| Frontend tests | 0 |
| **TOTAL** | **~2,217** |

---

## 9. Final Score

### Test Coverage: **7.5 / 10**

**Justification:**
- **+3.0** — All core Solidity contracts have unit tests with good negative/boundary coverage
- **+1.5** — Strong Foundry fuzz + invariant + reentrancy + fork tests
- **+1.5** — 11 Certora formal verification specs with 91 rules/invariants
- **+0.5** — DAML test coverage for Canton-side logic
- **+0.5** — Relay/bot TypeScript tests
- **+0.5** — Upgrade path + timelock wiring tests
- **−0.5** — No frontend tests
- **−0.5** — No deploy/migration script tests
- **−0.5** — 10 contracts without formal verification
- **−0.5** — No true E2E cross-layer tests
- **−0.5** — 13 DAML modules untested

To reach **9.0+**: Add Certora specs for CollateralVault, RedemptionQueue, and strategies; test deploy scripts on forks; add frontend E2E tests; create a cross-layer integration test harness.
