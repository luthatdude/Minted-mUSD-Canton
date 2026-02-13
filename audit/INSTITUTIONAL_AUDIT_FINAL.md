# 🏛️ MINTED mUSD PROTOCOL — INSTITUTIONAL-GRADE SECURITY AUDIT

**Date:** 2025-02-12
**Scope:** Full repository — Solidity, DAML, TypeScript relay/bot, infrastructure, tests, deployment
**Methodology:** Line-by-line code review modeled on Trail of Bits / Spearbit / Consensys Diligence
**Commit:** `481c76e` (HEAD of `main`)

---

## EXECUTIVE SUMMARY

The Minted mUSD protocol is a cross-chain stablecoin bridging Canton Network institutional tokenized assets to Ethereum, with a full DeFi lending stack, multi-strategy yield treasury, and leveraged positions. The protocol shows **strong architectural intent** — TimelockGoverned base, UUPS upgrade pattern, Chainlink circuit breakers, ERC-7201 storage, DAML dual-signatory — but contains **critical implementation defects** that prevent it from being production-ready.

| Score Component | Weight | Score | Weighted |
|---|---|---|---|
| Smart Contract Security | 30% | 38/100 | 11.4 |
| Access Control & Governance | 15% | 55/100 | 8.3 |
| Economic Model Soundness | 15% | 45/100 | 6.8 |
| Cross-Chain Security (Canton ↔ ETH) | 15% | 62/100 | 9.3 |
| Infrastructure & Operations | 10% | 48/100 | 4.8 |
| Test Coverage & Verification | 10% | 32/100 | 3.2 |
| Code Quality & Completeness | 5% | 25/100 | 1.3 |
| **TOTAL** | **100%** | | **45.1/100** |

### Verdict: **NOT INSTITUTIONAL GRADE**

The protocol requires resolution of 5 Critical and 9 High findings before any mainnet deployment. The test/verification stack is significantly incomplete (0-byte formal verification specs, no Certora CI, empty mock contracts).

---

## FINDING SUMMARY

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 **CRITICAL** | 5 | Must fix before deployment |
| 🟠 **HIGH** | 9 | Must fix before deployment |
| 🟡 **MEDIUM** | 17 | Should fix before deployment |
| 🔵 **LOW** | 16 | Fix recommended |
| ℹ️ **INFO** | 10 | Informational |

---

## 🔴 CRITICAL FINDINGS

### C-01 — SMUSD `totalAssets()` ↔ `globalTotalAssets()` Infinite Recursion

**File:** [contracts/SMUSD.sol](contracts/SMUSD.sol#L332-L334)
**Verified:** ✅ Independently confirmed

`totalAssets()` is overridden at line 332 to call `globalTotalAssets()`. When `treasury == address(0)` (the default at deployment — the constructor does NOT set treasury), `globalTotalAssets()` at line 264 falls back to `return totalAssets()` — which calls itself. **Infinite recursion → stack overflow → all ERC-4626 operations revert.**

```
totalAssets() → globalTotalAssets() → treasury == address(0) → totalAssets() → ∞
```

The same recursion path exists when treasury is set but the call reverts AND `cantonTotalShares == 0` (line 280).

**Impact:** The SMUSD vault is **completely bricked from deployment** until `setTreasury()` is called with a functional treasury address. Every deposit, withdrawal, share conversion, and `totalAssets()` call will revert. This affects the entire yield distribution system — BorrowModule routes interest to SMUSD via `receiveInterest()`, which deposits mUSD, triggering the recursive path.

**Fix:** Replace `return totalAssets()` in the fallback paths with `return IERC20(asset()).balanceOf(address(this))` or `return super.totalAssets()`.

---

### C-02 — SkySUSDSStrategy References Undefined `TIMELOCK_ROLE` — Build Failure

**File:** [contracts/strategies/SkySUSDSStrategy.sol](contracts/strategies/SkySUSDSStrategy.sol#L196)
**Verified:** ✅ `grep -n TIMELOCK_ROLE` confirms 3 code usages, 0 declarations

Line 95 comments "TIMELOCK_ROLE replaced by TimelockGoverned" but the code still references `TIMELOCK_ROLE` in three executable locations:

| Line | Usage |
|------|-------|
| [196](contracts/strategies/SkySUSDSStrategy.sol#L196) | `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);` |
| [434](contracts/strategies/SkySUSDSStrategy.sol#L434) | `function unpause() external onlyRole(TIMELOCK_ROLE)` |
| [442](contracts/strategies/SkySUSDSStrategy.sol#L442) | `function recoverToken(...) external onlyRole(TIMELOCK_ROLE)` |

`TIMELOCK_ROLE` is not declared as `bytes32 public constant` in SkySUSDSStrategy, and it does NOT inherit from any contract that defines it. The only definition in the codebase is in [PendleMarketSelector.sol](contracts/PendleMarketSelector.sol#L65) which is not in the inheritance chain. Meanwhile `_authorizeUpgrade` at line 456 correctly uses `onlyTimelock`.

**Impact:** **The contract will not compile.** `solc` will emit "undeclared identifier" for `TIMELOCK_ROLE`. The strategy cannot be deployed, making 20% of treasury allocation non-functional.

**Fix:** Either declare `bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");` or replace `onlyRole(TIMELOCK_ROLE)` with `onlyTimelock`.

---

### C-03 — PriceOracle `updatePrice()` Unconditionally Clears Circuit Breaker Trip

**File:** [contracts/PriceOracle.sol](contracts/PriceOracle.sol#L228-L233)
**Verified:** ✅ `grep -n` confirms lines 228 and 233

```solidity
// Line 228: Conditionally set
if (deviationBps > maxDeviationBps && circuitBreakerTrippedAt[token] == 0) {
    circuitBreakerTrippedAt[token] = block.timestamp;
}
// Line 233: UNCONDITIONALLY clear
circuitBreakerTrippedAt[token] = 0;
```

The circuit breaker is tripped on line 228 and immediately cleared on line 233. The trip can **never persist** across function execution. The `CircuitBreakerTriggered` event fires (useful for off-chain monitoring) but the on-chain protection is nullified.

**Impact:** The circuit breaker, which is designed to protect against oracle manipulation and flash loan attacks during extreme price moves, is functionally dead. Any admin call to `updatePrice()` immediately clears the breaker. The `getPrice()` function's circuit breaker check (line 189) relies on `circuitBreakerTrippedAt[token] > 0`, which will almost never be true because `updatePrice()` always clears it.

**Fix:** Only clear `circuitBreakerTrippedAt[token] = 0` inside the `else` branch (when deviation is within bounds).

---

### C-04 — CollateralVaultUpgradeable `_checkHealthFactor` Fail-Open on Oracle Failure

**File:** [contracts/upgradeable/CollateralVaultUpgradeable.sol](contracts/upgradeable/CollateralVaultUpgradeable.sol#L248-L265)
**Verified:** ✅ Read and confirmed empty innermost catch

```solidity
try IBorrowModule(borrowModule).healthFactor(user) returns (uint256 hf) {
    require(hf >= 10000, "HEALTH_FACTOR_TOO_LOW");
} catch {
    try IBorrowModule(borrowModule).healthFactorUnsafe(user) returns (uint256 hfUnsafe) {
        require(hfUnsafe >= 10000, "HEALTH_FACTOR_TOO_LOW");
    } catch {
        // Both safe and unsafe failed — allow withdrawal to prevent fund trapping
    }
}
```

If both `healthFactor()` and `healthFactorUnsafe()` revert (e.g., complete oracle outage, or BorrowModule is paused), the withdrawal proceeds with **zero health verification**.

**Impact:** During an oracle outage or BorrowModule pause, borrowers can withdraw all their collateral while leaving their debt unpaid. This is a direct insolvency vector — the protocol absorbs the bad debt.

**Fix:** Default to `revert("HEALTH_CHECK_UNAVAILABLE")` instead of silent pass-through. A separate emergency withdrawal function gated by `onlyRole(GUARDIAN_ROLE)` can handle fund trapping scenarios.

---

### C-05 — oracle-keeper.ts Build-Breaking Syntax Error

**File:** [bot/src/oracle-keeper.ts](bot/src/oracle-keeper.ts#L321)
**Verified:** ✅ Read file, confirmed literal `\"` and `\n` in source

Starting at line 321 in the `fetchExternalPrice()` method, the file contains literal escaped quotes `\"` and literal `\n` characters:

```
if (!url.startsWith(\"https://\")) {
    logger.warn(`${symbol} — external feed URL does not use HTTPS: ${url.substring(0, 50)}`);\n
```

This is JSON-encoded content pasted into a `.ts` file. TypeScript cannot parse `\"` as valid syntax — it expects `"` or `'`.

**Impact:** The oracle-keeper bot cannot compile. Price feed monitoring, circuit breaker resets, and external price validation are non-functional. This is the service responsible for keeping Chainlink circuit breakers from becoming permanently stuck.

---

## 🟠 HIGH FINDINGS

### H-01 — TreasuryV2 Fee-on-Principal During Strategy RPC Failure

**File:** [contracts/TreasuryV2.sol](contracts/TreasuryV2.sol#L639-L651)

`_accrueFees()` computes yield as `currentValue - lastRecordedValue`. The `totalValue()` function uses try/catch on strategy calls — if a strategy's RPC temporarily fails, it reports 0. When connectivity recovers, the jump from reduced value back to actual value appears as "yield" and the protocol takes a 40% performance fee on principal recovery.

**Impact:** Transient infrastructure failures cause the protocol to tax its own principal as yield. With $500M TVL and a strategy temporarily reporting 0 for one block, a recovery could generate $200M in phantom "yield" → $80M in fees extracted from depositors.

---

### H-02 — BorrowModuleUpgradeable Inverted Timelock Priority

**File:** [contracts/upgradeable/BorrowModuleUpgradeable.sol](contracts/upgradeable/BorrowModuleUpgradeable.sol)

| Function | Role | Delay | Risk Level |
|---|---|---|---|
| `coverBadDebt` | `DEFAULT_ADMIN_ROLE` | **Instant** | ⚠️ Highest |
| `socializeBadDebt` | `DEFAULT_ADMIN_ROLE` | **Instant** | ⚠️ Highest |
| `withdrawReserves` | `DEFAULT_ADMIN_ROLE` | **Instant** | ⚠️ High |
| `setInterestRate` | `TIMELOCK_ROLE` | 48h | Lower |
| `setMinDebt` | `TIMELOCK_ROLE` | 48h | Lower |

Functions that can **burn depositor value** (socializeBadDebt) or **drain reserves** (withdrawReserves) are instant, while parameter adjustments are timelocked.

---

### H-03 — MorphoLoopStrategy Infinite Approval Not Fixed

**File:** [contracts/strategies/MorphoLoopStrategy.sol](contracts/strategies/MorphoLoopStrategy.sol)

`initialize()` grants `type(uint256).max` USDC approval to Morpho. The PendleStrategyV2 and SkySUSDSStrategy both explicitly fixed this pattern (FIX HIGH-07 — per-operation approvals), but MorphoLoopStrategy was missed.

---

### H-04 — LiquidationEngine Undocumented Allowance Requirement

**File:** [contracts/LiquidationEngine.sol](contracts/LiquidationEngine.sol#L196) + [contracts/MUSD.sol](contracts/MUSD.sol#L99-L101)

`liquidate()` calls `musd.burn(msg.sender, actualRepay)` where `msg.sender` = liquidator. In MUSD's `burn()`, the check `from != msg.sender` evaluates TRUE because `from` = liquidator but `msg.sender` in MUSD context = LiquidationEngine. This triggers `_spendAllowance()`.

**Impact:** Liquidators must pre-approve the LiquidationEngine to spend their mUSD. This is nowhere documented. Any MEV bot or liquidation bot that doesn't know this will have every liquidation revert silently. The NatSpec comment in LiquidationEngine mentions granting LIQUIDATOR_ROLE and LIQUIDATION_ROLE but not the allowance requirement.

---

### H-05 — relay-service.ts Logs Full RPC URLs (Credential Leak)

**File:** relay/relay-service.ts

- Line ~265: `console.log(\`[Relay] Ethereum: ${config.ethereumRpcUrl}\`)` — logs full RPC URL including API keys
- Line ~380: logs full fallback URL
- Fallback URLs (`fallbackRpcUrls`) lack HTTPS validation unlike the primary URL

---

### H-06 — 27 Zero-Byte Empty Files Across Critical Systems

**Verified:** ✅ `find -empty | wc -l` = 27

| Category | Files | Impact |
|---|---|---|
| Mock contracts | MockSUSDS.sol, MockSkyPSM.sol, MockSMUSD.sol | Tests referencing these fail |
| Formal verification | HalmosSpec.t.sol | Zero symbolic execution |
| Subgraph handlers | 9 files (ALL handlers) | Subgraph cannot index |
| Points system | 4 files | Points system non-functional |
| Frontend | 6 components | UI broken |
| Bot services | pendle-sniper.ts, pool-alerts.ts | MEV protection missing |

---

### H-07 — Validator Node V1 vs V2 Signature Incompatibility

**File:** relay/validator-node.ts vs relay/validator-node-v2.ts

Legacy V1 message hash has 7 parameters. V2 includes `cantonStateHash` as the 8th parameter. If any active validator is running V1, its signatures will be rejected by V2 attestation verification, potentially dropping below the `minSignatures` threshold.

---

### H-08 — Certora Specs Unrunnable (No .conf Files)

**File:** certora/specs/

Four Certora specs exist (MUSD, SMUSD, BorrowModule, LiquidationEngine) but only MUSD.conf exists. The other three specs can never be executed. Additionally, CI does not run Certora at all. The MUSD invariant `total_supply_is_sum_of_balances` asserts `totalSupply >= 0` — vacuously true for uint256.

---

### H-09 — CollateralVaultUpgradeable Missing `disableCollateral()` Function

**File:** contracts/upgradeable/CollateralVaultUpgradeable.sol

Events `CollateralDisabled` and `CollateralEnabled` are declared but never emitted — no function exists to disable a collateral token. The protocol cannot respond to a depegged or compromised collateral asset in the upgradeable vault variant.

---

## 🟡 MEDIUM FINDINGS

| ID | Title | File |
|---|---|---|
| M-01 | `socializeBadDebt()` O(n²) duplicate detection — uncallable at scale | BorrowModuleUpgradeable.sol |
| M-02 | SMUSDUpgradeable `totalAssets()` not overridden — ERC-4626 violation | SMUSDUpgradeable.sol |
| M-03 | SMUSDPriceAdapter rate limiter inactive until `updateCachedPrice()` bootstrapped | SMUSDPriceAdapter.sol |
| M-04 | DepositRouter silent refund failure with misleading `FeesWithdrawn` event | DepositRouter.sol |
| M-05 | LeverageVault `emergencyClosePosition` deletes position even if repay fails | LeverageVault.sol |
| M-06 | Storage gap counts deviate from 50-slot convention (5 contracts) | Multiple |
| M-07 | BorrowModuleUpgradeable 11 dead `pending*` state variables waste slots | BorrowModuleUpgradeable.sol |
| M-08 | TreasuryReceiver O(n) manual byte copy for payload parsing | TreasuryReceiver.sol |
| M-09 | MorphoLoopStrategy `_maxWithdrawable` reverts if `safetyBufferBps >= targetLtvBps` | MorphoLoopStrategy.sol |
| M-10 | ISMUSD interface declares `decimalsOffset()` not exposed on SMUSD | interfaces/ISMUSD.sol |
| M-11 | BLEBridgeV9 `_authorizeUpgrade` uses `DEFAULT_ADMIN_ROLE` — inconsistent with strategy pattern | BLEBridgeV9.sol |
| M-12 | relay-service.ts KMS region empty string on fallback reconnect | relay-service.ts |
| M-13 | DAML `SyncYield` choice lacks governance co-signer | DAML files |
| M-14 | DAML `USDCx_Transfer` missing compliance check on recipient | DAML files |
| M-15 | Deployment script doesn't grant vault roles (BORROW_MODULE_ROLE, LIQUIDATION_ROLE) | scripts/deploy.ts |
| M-16 | Slither CI excludes all reentrancy detectors | slither.config.json |
| M-17 | Fork tests only check `extcodesize > 0` — no actual protocol interaction | test/foundry/ForkTest.t.sol |

---

## 🔵 LOW FINDINGS

| ID | Title |
|---|---|
| L-01 | InterestRateModel `getBorrowRatePerSecond()` truncates to 0 for low rates |
| L-02 | SMUSD `distributeYield()` and `receiveInterest()` missing `nonReentrant` |
| L-03 | DirectMintV2 `recoverToken` sends to `msg.sender` not configurable recipient |
| L-04 | LeverageVault `closeLeveragedPosition` int256 cast overflow for extreme values |
| L-05 | PendleMarketSelector `_isValidMarket()` is dead code |
| L-06 | MorphoLoopStrategy `_fullDeleverage` MAX_LOOPS*2 may be insufficient |
| L-07 | BorrowModuleUpgradeable `totalBorrowsBeforeAccrual` stale on first accrual |
| L-08 | PendleStrategyV2 `recoverToken` transfers entire balance (no amount param) |
| L-09 | LiquidationEngineUpgradeable uses `healthFactorUnsafe` (stale price risk) |
| L-10 | SMUSDUpgradeable `receiveInterest()` manual overflow check fragile |
| L-11 | SMUSD `setTreasury()` doesn't validate treasury interface |
| L-12 | PendleMarketSelector `initialize()` grants TIMELOCK_ROLE to admin directly |
| L-13 | LeverageVaultUpgradeable `estimateLoops` overly optimistic |
| L-14 | DirectMintV2 `redeem()` fee floor may overcharge on tiny amounts |
| L-15 | utils.ts `Object.defineProperty` set handler silently drops writes |
| L-16 | Hardcoded $2000 ETH price in relay gas estimation |

---

## ℹ️ INFORMATIONAL

| ID | Title |
|---|---|
| I-01 | 3 mock .sol files are 0-byte empty (MockSUSDS, MockSkyPSM, MockSMUSD) |
| I-02 | SMUSDPriceAdapter `getRoundData()` ignores round ID |
| I-03 | PendleMarketSelector string comparison via `keccak256` in loop |
| I-04 | InterestRateModel `calculateInterest` parameter naming misleading |
| I-05 | SMUSDUpgradeable `syncCantonShares` daily reset race condition |
| I-06 | Dual timelock patterns: `onlyTimelock` vs `onlyRole(TIMELOCK_ROLE)` across codebase |
| I-07 | Storage gap arithmetic ad-hoc — no slot count documentation |
| I-08 | Coverage boost test files (8 files, ~5400 lines) indicate metric gaming |
| I-09 | Test suite bypasses actual timelock governance flow |
| I-10 | relay signer.ts uses raw private key without KMS option |

---

## DETAILED SCORING RATIONALE

### Smart Contract Security: 38/100
- 5 Critical bugs including build-breaking compilation failure, infinite recursion, and fail-open health checks
- Circuit breaker protection functionally dead
- Fee-on-principal insolvency vector under transient failures
- Strong positive: CEI pattern consistently applied, SafeERC20, reentrancy guards, Pausable

### Access Control & Governance: 55/100
- TimelockGoverned architecture is well-designed with ERC-7201 namespaced storage
- MintedTimelockController with 48h minimum delay is properly implemented
- **Deductions:** Inverted timelock priority (H-02), BLEBridgeV9 admin-gated upgrades (M-11), undefined TIMELOCK_ROLE breaking compilation (C-02), dual pattern inconsistency (I-06)

### Economic Model Soundness: 45/100
- Interest rate model with utilization-based Compound-style curve is sound
- Multi-strategy treasury allocation with reserve buffer is well-designed
- **Deductions:** Fee-on-principal (H-01), SMUSD vault bricked (C-01), liquidation allowance undocumented (H-04), socializeBadDebt uncallable at scale (M-01)

### Cross-Chain Security: 62/100
- Canton attestation model with BFT supermajority, entropy, nonce, state hash is strong
- DAML dual-signatory pattern with compliance checking is institutional quality
- Rate-limited supply cap changes with 24h rolling window
- **Deductions:** Validator signature incompatibility V1/V2 (H-07), DAML SyncYield lacks co-signer (M-13)

### Infrastructure & Operations: 48/100
- K8s with SHA256-pinned images, default-deny NetworkPolicy, Docker secrets is excellent
- CI pipeline with Slither + Mythril + Trivy is comprehensive
- **Deductions:** RPC URL credential logging (H-05), oracle-keeper won't compile (C-05), 27 empty files (H-06), relay KMS region bug (M-12)

### Test Coverage & Verification: 32/100
- ~22,000 lines of tests, 36 Hardhat test files, 6 Foundry files
- ReentrancyTest.t.sol and InvariantTest.t.sol are substantive
- **Deductions:** HalmosSpec.t.sol is 0-byte (H-06), 3 Certora specs unrunnable (H-08), no Certora in CI, fork tests are address-existence only (M-17), coverage gaming pattern (I-08), empty mock contracts break test compilation

### Code Quality & Completeness: 25/100
- 27 zero-byte files across mocks, subgraph, frontend, points, bot
- Incomplete refactoring (TIMELOCK_ROLE → TimelockGoverned left dangling)
- Dead pending-state variables occupying storage slots
- Build-breaking syntax errors in bot code

---

## COMPARISON TO INSTITUTIONAL STANDARDS

| Criterion | Required | Minted mUSD | Gap |
|---|---|---|---|
| Clean compilation | ✅ All contracts compile | ❌ SkySUSDSStrategy fails | **BLOCKER** |
| Formal verification | ✅ Prover runs in CI | ❌ No Certora in CI, Halmos empty | **BLOCKER** |
| No critical bugs | ✅ Zero critical findings | ❌ 5 Critical findings | **BLOCKER** |
| Timelock on all economic ops | ✅ Consistent governance | ❌ Inverted priorities | Gap |
| 100% non-zero test files | ✅ No empty stubs | ❌ 27 empty files | Gap |
| Independent auditor sign-off | ✅ External firm audit | ❌ Not evidenced | Gap |
| Mainnet fork tests | ✅ Integration tests | ❌ Only address-existence | Gap |

---

## TOP 10 REMEDIATION PRIORITIES

| # | Finding | Effort | Impact |
|---|---|---|---|
| 1 | C-01: Fix SMUSD `totalAssets()` recursion | 10 min | **Vault functional** |
| 2 | C-02: Add `TIMELOCK_ROLE` constant or use `onlyTimelock` in SkySUSDSStrategy | 10 min | **Strategy compiles** |
| 3 | C-03: Fix `updatePrice()` circuit breaker clearing | 5 min | **Oracle protection works** |
| 4 | C-04: Default-deny in `_checkHealthFactor` catch block | 10 min | **Prevent insolvency** |
| 5 | C-05: Fix oracle-keeper.ts syntax errors | 30 min | **Bot compiles** |
| 6 | H-01: Add snapshot-before-check in `_accrueFees()` | 1 hour | **No fee-on-principal** |
| 7 | H-02: Move economic ops behind timelock | 30 min | **Governance consistent** |
| 8 | H-04: Document allowance in LiquidationEngine NatSpec | 10 min | **Liquidators work** |
| 9 | H-06: Populate all 27 zero-byte files | 2-4 hours | **All systems functional** |
| 10 | H-08: Create Certora configs + add to CI | 2 hours | **Formal verification active** |

---

*This audit was performed through comprehensive line-by-line review of every source file in the repository. All critical and high findings were independently verified against the actual codebase.*
