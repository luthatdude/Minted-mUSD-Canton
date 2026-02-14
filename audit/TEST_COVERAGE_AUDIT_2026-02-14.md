# Institutional Test Coverage Audit — Minted mUSD Protocol

**Date:** 2026-02-14  
**Auditor:** Test Coverage Specialist  
**Scope:** All contracts in `contracts/`, all test suites in `test/`, `test/foundry/`, `certora/`

---

## Executive Summary

The Minted mUSD protocol has **extensive functional test coverage** across 43 Hardhat test files (~22,000 lines), 5 Foundry test files (1,298 lines), 1 Halmos symbolic spec, and 11 Certora formal verification specs. However, the **instrumented coverage report (`coverage.json`) shows 0% branch coverage** for all core contracts except `PendleStrategyV2.sol` (87% branches), indicating the coverage report is **stale or was generated from an incomplete run**. This should be regenerated immediately.

Despite the stale report, manual analysis of the test suites reveals strong scenario coverage for core flows, but **critical gaps exist** in edge cases, attack vectors, and several untested contracts.

---

## 1. Coverage Matrix

### Core Contracts — Test Coverage Assessment

| Contract | Dedicated Test | Lines | Scenarios | Branch Est. | Formal Spec | Risk |
|---|---|---|---|---|---|---|
| **MUSD.sol** | MUSD.test.ts | 326 | 23 | ~85% | Certora ✅ Halmos ✅ | ✅ Good |
| **SMUSD.sol** | SMUSD.test.ts | 429 | 28 | ~75% | Certora ✅ | ⚠️ Gaps |
| **BorrowModule.sol** | BorrowModule.test.ts | 399 | 16 | ~55% | Certora ✅ | 🔴 Major gaps |
| **CollateralVault.sol** | CollateralVault.test.ts | 278 | 22 | ~70% | — | ⚠️ Gaps |
| **LiquidationEngine.sol** | LiquidationEngine.test.ts | 432 | 15 | ~60% | Certora ✅ | 🔴 Major gaps |
| **DirectMintV2.sol** | DirectMintV2.test.ts + CoverageBoost | 979 | 30+ | ~80% | Certora ✅ | ✅ Good |
| **InterestRateModel.sol** | InterestRateModel.test.ts | 363 | 22 | ~90% | Certora ✅ | ✅ Excellent |
| **BLEBridgeV9.sol** | BLEBridgeV9.test.ts + CoverageBoosts | 1,026 | 35+ | ~75% | Certora ✅ | ⚠️ Gaps |
| **PriceOracle.sol** | PriceOracle.test.ts | 198 | 16 | ~60% | Certora ✅ | 🔴 Major gaps |
| **TreasuryV2.sol** | TreasuryV2.test.ts | 658 | 28 | ~65% | Certora ✅ | ⚠️ Gaps |
| **LeverageVault.sol** | LeverageVault.test.ts + FlashLoan | 1,348 | 50+ | ~80% | Certora ✅ | ✅ Good |
| **RedemptionQueue.sol** | RedemptionQueue.test.ts | 427 | 25 | ~80% | — | ✅ Good |
| **DepositRouter.sol** | DepositRouter.test.ts | 395 | 22 | ~75% | Certora ✅ | ⚠️ Gaps |
| **SMUSDPriceAdapter.sol** | SMUSDPriceAdapter.test.ts | 412 | 30 | ~85% | — | ✅ Good |
| **TreasuryReceiver.sol** | TreasuryReceiver.test.ts | 395 | 20 | ~75% | — | ⚠️ Gaps |
| **PendleMarketSelector.sol** | PendleMarketSelector.test.ts + Boosts | 1,462 | 40+ | ~70% | — | ⚠️ Gaps |
| **PendleStrategyV2.sol** | PendleStrategyV2.test.ts + Boosts | 2,119 | 60+ | ~87% | — | ✅ Good |
| **MintedTimelockController.sol** | TimelockWiring.test.ts | 278 | 12 | ~80% | — | ✅ Good |

### Strategy Contracts — Coverage Assessment

| Strategy | Test File | Lines | Status |
|---|---|---|---|
| **AaveV3LoopStrategy.sol** | AaveV3LoopStrategy.test.ts | **0** | 🔴 **EMPTY — No tests** |
| **ContangoLoopStrategy.sol** | ContangoLoopStrategy.test.ts | **0** | 🔴 **EMPTY — No tests** |
| **CompoundV3LoopStrategy.sol** | — | **0** | 🔴 **No test file** |
| **EulerV2LoopStrategy.sol** | — | **0** | 🔴 **No test file** |
| **EulerV2CrossStableLoopStrategy.sol** | EulerV2CrossStableLoop.test.ts | 885 | ⚠️ Partial |
| **FluidLoopStrategy.sol** | FluidLoopStrategy.test.ts | 1,189 | ✅ Good |
| **MorphoLoopStrategy.sol** | MorphoLoopStrategy.test.ts | 449 | ⚠️ Partial |
| **SkySUSDSStrategy.sol** | SkySUSDSStrategy.test.ts | 275 | ⚠️ Partial |
| **StabilityDAOFeatures** | StabilityDAOFeatures.test.ts | **0** | 🔴 **EMPTY — No tests** |

### Untested Contracts (No dedicated test files)

| Contract | Status | Risk |
|---|---|---|
| **MetaVault.sol** | 🔴 No test file | HIGH — aggregation logic untested |
| **GlobalPausable.sol** | 🔴 No test file | MEDIUM — inherited by other contracts |
| **GlobalPauseRegistry.sol** | 🔴 No test file | MEDIUM — system-wide pause |
| **StrategyFactory.sol** | 🔴 No test file | MEDIUM — factory pattern |
| **ReferralRegistry.sol** | 🔴 No test file | LOW — non-critical |
| **PriceAggregator.sol** | 🔴 No test file | HIGH — price aggregation logic |
| **UniswapV3TWAPOracle.sol** | 🔴 No test file | HIGH — oracle manipulation surface |
| **YieldScanner.sol** | 🔴 No test file | LOW — view functions |
| **YieldVerifier.sol** | 🔴 No test file | MEDIUM — yield validation |
| **MorphoMarketRegistry.sol** | 🔴 No test file | MEDIUM — market registry |
| **Adapters (6 files)** | 🔴 No test files | HIGH — adapter logic untested |

### Upgradeable Contracts — Coverage

| Contract | UpgradeablePath Test | TimelockWiring Test | Status |
|---|---|---|---|
| CollateralVaultUpgradeable | ✅ | ✅ | ✅ Good |
| BorrowModuleUpgradeable | ✅ | — | ✅ Good |
| LeverageVaultUpgradeable | ✅ | — | ✅ Good |
| LiquidationEngineUpgradeable | ✅ | — | ✅ Good |
| SMUSDUpgradeable | ✅ | — | ✅ Good |

### Foundry & Formal Verification Coverage

| Framework | File | Tests | Scope |
|---|---|---|---|
| Foundry Fuzz | FuzzTest.t.sol | 12+ fuzz tests | IRM, MUSD mint/burn, borrow/repay, liquidation, supply cap |
| Foundry Invariant | InvariantTest.t.sol | 6 invariants | mUSD cap, collateral backing, debt consistency, HF |
| Foundry Reentrancy | ReentrancyTest.t.sol | 5 attack tests | Vault deposit, borrow, repay, liquidation |
| Foundry Fork | ForkTest.t.sol | Mainnet fork | Chainlink integration, real prices |
| Halmos | HalmosSpec.t.sol | 4 symbolic tests | Supply cap, transfer conservation, access control |
| Certora | 11 spec files | 50+ rules | Core protocol invariants |

---

## 2. Missing Test Scenarios — Prioritized

### 🔴 CRITICAL (Must-fix before mainnet)

#### C-01: BorrowModule — Global Interest Accrual Edge Cases
**Current gap:** No tests for `_accrueGlobalInterest()` edge cases.
- [ ] Interest accrual with `totalBorrows = 0` (no borrows active)
- [ ] Interest accrual when `interestRateModel` is not set (address(0))
- [ ] Interest distribution to SMUSD/Treasury when connected
- [ ] Multiple users borrowing and repaying in same block (MEV resistance)
- [ ] Interest accrual across extremely long time gaps (years)
- [ ] `borrowFor()` and `repayFor()` via LEVERAGE_VAULT_ROLE — only tested indirectly through LeverageVault

#### C-02: BorrowModule — Missing `setInterestRateModel` / `setSMUSD` / `setTreasury` Tests
**Current gap:** Admin setters for critical dependencies lack direct tests.
- [ ] Setting IRM to zero address (should revert or have defined behavior)
- [ ] Setting SMUSD/Treasury to zero address
- [ ] Changing IRM mid-operation (positions exist with debt)
- [ ] Interest distribution to treasury with `reserveBps > 0`
- [ ] `reduceDebt()` edge cases: reducing more than user's debt, reducing to below `minDebt`

#### C-03: LiquidationEngine — Insufficient Edge Case Coverage
**Current gap:** Only basic liquidation flows tested.
- [ ] Full liquidation when health factor < `fullLiquidationThreshold`
- [ ] Liquidation with multiple collateral types
- [ ] Liquidation penalty calculation accuracy
- [ ] Liquidation when collateral price is exactly at liquidation threshold
- [ ] Gas griefing via many small collateral deposits
- [ ] Liquidation race conditions (two liquidators competing)
- [ ] Bad debt scenario (collateral < debt after liquidation)

#### C-04: PriceOracle — Circuit Breaker Not Tested
**Current gap:** `updatePrice()`, circuit breaker logic, max deviation are untested.
- [ ] Circuit breaker triggers on price deviation > `maxDeviationBps`
- [ ] `updatePrice()` caching mechanism
- [ ] Multi-feed aggregation (if PriceAggregator is used)
- [ ] Feed with different decimal formats (6, 8, 18)
- [ ] Negative oracle answers (Chainlink can return negative in some feeds)
- [ ] Oracle manipulation via flash loan (TWAP vs spot price)

#### C-05: MetaVault — Completely Untested
**Risk:** MetaVault aggregates strategy positions — no tests exist.
- [ ] All public/external functions
- [ ] Deposit/withdraw routing
- [ ] Share price calculation
- [ ] Access control

#### C-06: Adapter Contracts — Completely Untested
**Risk:** All 6 adapter contracts lack test files.
- [ ] `AaveV3Adapter.sol` — Aave V3 integration
- [ ] `CompoundV3Adapter.sol` — Compound V3 integration
- [ ] `MorphoBlueAdapter.sol` — Morpho integration
- [ ] `ChainlinkOracleAdapter.sol` — Oracle adapter
- [ ] `API3OracleAdapter.sol` — API3 integration
- [ ] `ERC4626Adapter.sol` — ERC-4626 adapter

#### C-07: UniswapV3TWAPOracle — No Tests
**Risk:** TWAP oracle is a primary target for oracle manipulation.
- [ ] TWAP calculation accuracy
- [ ] Manipulation resistance over different windows
- [ ] Multi-hop price derivation
- [ ] Stale TWAP handling

#### C-08: Strategy Contracts — 4 Empty Test Files
**Risk:** AaveV3, ContangoLoop, CompoundV3Loop, and EulerV2Loop strategies have 0 tests.
- [ ] All `deposit()`, `withdraw()`, `withdrawAll()` flows
- [ ] `totalValue()` accuracy
- [ ] Health factor monitoring for leveraged strategies
- [ ] Emergency exit scenarios
- [ ] Slippage protection during looping

### ⚠️ HIGH (Should fix before audit sign-off)

#### H-01: SMUSD — Donation Attack Mitigation Not Fully Tested
**Current gap:** `decimalsOffset = 3` is mentioned but never specifically attacked.
- [ ] Classic donation attack: deposit 1 wei, donate large amount, sandwich next depositor
- [ ] First depositor gets correct shares
- [ ] Share inflation attack with very small initial deposits
- [ ] Withdrawal with rounding exploitation
- [ ] Cross-chain share accounting accuracy (Canton sync)

#### H-02: TreasuryV2 — Strategy Failure Cascades
**Current gap:** Only tests single strategy failure; no cascade tests.
- [ ] All strategies failing simultaneously
- [ ] Strategy returning wrong value (malicious strategy)
- [ ] Strategy holding funds hostage (never returns on withdrawAll)
- [ ] Strategy draining reserve via malicious deposit callback
- [ ] Fee accrual with negative yield (strategy loss)
- [ ] Min/max allocation bounds enforcement

#### H-03: BLEBridgeV9 — Validator Set Management
**Current gap:** No tests for validator changes during operation.
- [ ] Removing a validator while attestation is in-flight
- [ ] Reducing `minSignatures` below current validator count
- [ ] Validator key compromise scenario (invalidation + rotation)
- [ ] Attestation with timestamp exactly at `MIN_ATTESTATION_GAP`
- [ ] Multiple attestations per day (rate limiting accuracy)

#### H-04: CollateralVault — Multi-Token Health Check
**Current gap:** Only single-token (WETH) deposits tested.
- [ ] Position with 2+ collateral types
- [ ] Withdrawal of one collateral affecting overall health factor
- [ ] Collateral token with 6 decimals (USDC/USDT)
- [ ] Token with fee-on-transfer behavior
- [ ] Collateral token getting disabled while positions exist

#### H-05: LeverageVault — Deadline Protection
**Current gap:** Tests use `futureDeadline = 99999999999` — never testing actual expiry.
- [ ] Position opening with expired deadline
- [ ] Position closing with expired deadline
- [ ] Deadline just at current block timestamp (boundary)

#### H-06: RedemptionQueue — FIFO Manipulation
**Current gap:** No adversarial tests.
- [ ] Sandwich attack: attacker queues before and after target
- [ ] Queue griefing with many dust-sized requests
- [ ] Processing order consistency under reorgs
- [ ] Processor processing specific subsets to favor users

### ⚠️ MEDIUM

#### M-01: DirectMintV2 — Fee Precision Edge Cases
- [ ] Minting exactly 1 USDC (minimum) — fee calculation rounding
- [ ] Fee equal to entire mint amount (100% fee — should be rejected)
- [ ] Fee withdrawal when `mintFees + redeemFees > contract balance`
- [ ] Redeem when treasury has exact amount needed (no extra buffer)

#### M-02: InterestRateModel — Boundary Precision
- [ ] `calculateInterest` with 1 second elapsed (smallest unit)
- [ ] Interest rate exactly at kink point — both sides of the branch
- [ ] Supply rate calculation with 0 borrows (division by zero guard)

#### M-03: DepositRouter — Wormhole Integration
- [ ] Re-delivery attack (same payload delivered twice)
- [ ] Insufficient gas for cross-chain execution
- [ ] Token bridge returning less than expected
- [ ] Native token handling edge cases (ETH refund to contract)

#### M-04: TreasuryReceiver — Pending Mint Edge Cases
- [ ] Claiming pending mint twice (double-claim)
- [ ] Pending mint with stale USDC (USDC blacklisting of contract)
- [ ] Emergency withdrawal of pending mint funds
- [ ] DirectMint contract change while pending mints exist

---

## 3. Missing Attack Vector Tests

### Flash Loan Attacks
| Vector | Tested? | Details |
|---|---|---|
| Flash loan → borrow → manipulate price → liquidate | ❌ | No oracle manipulation test |
| Flash loan → deposit SMUSD → inflate share → withdraw | ❌ | Donation attack not tested |
| Flash loan → open leverage → sandwich close | ⚠️ Partial | Basic tests, no oracle manipulation |
| Flash loan → drain treasury via strategy | ❌ | No malicious strategy test |

### Sandwich Attacks
| Vector | Tested? | Details |
|---|---|---|
| Sandwich DirectMint (front-run supply cap) | ❌ | Not tested |
| Sandwich SMUSD deposit (share price manipulation) | ❌ | Not tested |
| Sandwich leverage position open/close | ❌ | Not tested |
| Sandwich redemption queue processing | ❌ | Not tested |

### Oracle Manipulation
| Vector | Tested? | Details |
|---|---|---|
| Chainlink price staleness | ✅ | Tested in PriceOracle |
| Chainlink zero/negative price | ✅ | Tested |
| TWAP manipulation | ❌ | UniswapV3TWAPOracle untested |
| Multi-block price manipulation | ❌ | Only single-block tests |
| Oracle front-running (attestation) | ❌ | Not tested |

### Reentrancy
| Vector | Tested? | Details |
|---|---|---|
| Vault deposit reentrancy | ✅ | Foundry ReentrancyTest |
| Borrow reentrancy | ✅ | Foundry ReentrancyTest |
| Liquidation reentrancy | ✅ | Foundry ReentrancyTest |
| SMUSD deposit/withdraw reentrancy | ❌ | Not tested |
| LeverageVault reentrancy | ✅ | Verified via nonReentrant in tests |
| TreasuryV2 reentrancy via strategy | ❌ | Not tested |

### Access Control
| Vector | Tested? | Details |
|---|---|---|
| Role escalation (grant own roles) | ⚠️ Partial | Only some contracts |
| DEFAULT_ADMIN_ROLE bypass | ✅ | TimelockWiring tests |
| Timelock delay bypass | ✅ | TimelockWiring tests |
| Cross-contract role confusion | ❌ | Not tested |

---

## 4. Integration Test Gaps

### Cross-Contract Interaction Tests

| Integration Path | Tested? | Risk |
|---|---|---|
| BorrowModule ↔ CollateralVault ↔ LiquidationEngine (full liquidation flow) | ⚠️ Partial | High — each tested separately |
| DirectMintV2 → TreasuryV2 → Strategies (deposit allocation) | ❌ | High — siloed tests |
| BLEBridgeV9 → MUSD → SMUSD (attestation → supply cap → staking) | ❌ | High — cross-chain flow |
| LeverageVault → BorrowModule → CollateralVault → LiquidationEngine | ✅ | Good — end-to-end tested |
| DepositRouter → TreasuryReceiver → DirectMintV2 (cross-chain deposit) | ❌ | High — only unit tests |
| SMUSD → TreasuryV2 → Strategies (yield distribution) | ❌ | High — yield flow untested end-to-end |
| PriceOracle → BorrowModule → LiquidationEngine (price impact propagation) | ⚠️ Partial | Only in liquidation tests |
| RedemptionQueue → DirectMintV2/Treasury (redemption processing) | ❌ | Medium — separate tests only |

---

## 5. Regression Tests

| Bug ID | Description | Regression Test? |
|---|---|---|
| SOL-003 | emergencyClosePosition sweeps other users' residual tokens | ✅ LeverageVaultFlashLoan.test.ts |
| SOL-002 | SMUSDPriceAdapter initial price not cached | ✅ convergePriceAdapter() helper |
| IRM-01/02 | Annual rate precision loss | ✅ InterestRateModel.test.ts regression section |
| IRM-03/04/06 | Parameter validation bounds | ✅ Enhanced Parameter Validation section |
| H-02 | RedemptionQueue FIFO | ✅ RedemptionQueue.test.ts |
| H-03 | Pausable emergency controls | ✅ LeverageVaultFlashLoan.test.ts §4 |
| Finding #3 | Hand-rolled timelocks | ✅ TimelockWiring.test.ts |
| Finding #4 | UUPS upgrade auth | ✅ UpgradeablePath.test.ts |

---

## 6. Formal Verification Assessment

### Certora Specs (11 files, ~1,586 rules)

| Spec | Key Rules |
|---|---|
| MUSD.spec | Supply cap invariant, mint/burn conservation, blacklist enforcement |
| SMUSD.spec | Share price monotonicity, cooldown enforcement, yield distribution |
| BorrowModule.spec | Debt consistency, health factor bounds, interest accrual |
| LiquidationEngine.spec | Liquidation eligibility, close factor enforcement, penalty bounds |
| DirectMintV2.spec | 1:1 peg maintenance, fee bounds, supply cap check |
| TreasuryV2.spec | Total value conservation, allocation bounds, fee cap |
| InterestRateModel.spec | Rate monotonicity, utilization bounds, kink continuity |
| LeverageVault.spec | Position isolation, leverage bounds, no-value-extraction |
| PriceOracle.spec | Price positivity, staleness check, normalization |
| BLEBridgeV9.spec | Nonce monotonicity, signature uniqueness, rate limiting |
| DepositRouter.spec | Fee calculation, amount bounds, deposit isolation |

### Foundry Invariants (6 invariants via stateful testing)

1. ✅ mUSD supply ≤ supply cap
2. ✅ Total collateral value ≥ total debt (system solvency)
3. ✅ Individual position debt = principal + accrued interest
4. ✅ Health factor calculation consistency
5. ✅ No tokens created from nothing (conservation)
6. ✅ Interest rate monotonicity with utilization

---

## 7. Recommendations — Priority Order

### P0 — Block-before-mainnet

1. **Regenerate `coverage.json`** — Run `npx hardhat coverage` with all test files. The current report shows 0% for all contracts, which is clearly stale.

2. **Write tests for AaveV3LoopStrategy, ContangoLoopStrategy, CompoundV3LoopStrategy, EulerV2LoopStrategy** — 4 strategy contracts with 0 tests. Combined ~200+ functions untested.

3. **Write tests for MetaVault, PriceAggregator, UniswapV3TWAPOracle** — Critical financial primitives without any test coverage.

4. **Write tests for all 6 adapter contracts** — These bridge between external protocols and the treasury. Bugs here could lead to fund loss.

5. **Add oracle manipulation tests** — Flash loan → price manipulation → liquidation profit extraction is a top DeFi attack vector.

### P1 — Before audit sign-off

6. **BorrowModule integration tests** — Global interest accrual, multi-user scenarios, IRM/SMUSD/Treasury wiring.

7. **TreasuryV2 end-to-end tests** — Deposit → strategy allocation → yield → fee → distribution → withdrawal complete cycle.

8. **Donation attack test for SMUSD** — Verify the `decimalsOffset = 3` mitigation works under adversarial conditions.

9. **Cross-chain integration tests** — DepositRouter → TreasuryReceiver → DirectMintV2 full flow.

10. **Bad debt scenario tests** — What happens when collateral is worth less than debt after price crash?

### P2 — Best practice

11. **Deadline expiry tests** for LeverageVault operations.
12. **Gas consumption regression tests** for all critical paths.
13. **Multi-collateral liquidation tests** with mixed token types.
14. **Fee-on-transfer token tests** for CollateralVault.
15. **Chaos/stress tests** — 100+ concurrent users, random operation sequences.

---

## 8. Overall Assessment

| Dimension | Score | Notes |
|---|---|---|
| **Core Contract Coverage** | 7/10 | All core contracts have dedicated tests, but many branches uncovered |
| **Strategy Coverage** | 3/10 | 4/9 strategies have 0 tests; 3/9 partial; 2/9 good |
| **Edge Case Coverage** | 5/10 | Basic happy paths well tested; boundary conditions often missing |
| **Attack Vector Coverage** | 6/10 | Reentrancy + flash loan basics ✅; oracle/sandwich/donation ❌ |
| **Integration Coverage** | 4/10 | Most contracts tested in isolation; few cross-contract tests |
| **Formal Verification** | 8/10 | 11 Certora specs + Foundry invariants + Halmos = strong formal layer |
| **Regression Coverage** | 9/10 | All known bugs have dedicated regression tests |
| **Upgradeability Coverage** | 9/10 | All 5 upgradeable contracts tested for auth + storage preservation |

**Overall: 6.4/10** — The protocol has a solid testing foundation with good formal verification, but significant gaps exist in strategy testing, adapter testing, and adversarial scenario coverage. The stale coverage report must be regenerated. Four strategy contracts with empty test files represent the highest immediate risk.
