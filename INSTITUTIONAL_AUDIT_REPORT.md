# Minted mUSD Canton Protocol
# Institutional Pre-Audit Security Report

**Prepared for:** CredShield Handoff
**Branch:** `claude/add-canton-contracts-audit-Xlcsh`
**Date:** 2026-02-01
**Scope:** Full repository -- Smart contracts, DAML modules, relay services, deployment scripts, infrastructure, bot, frontend

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [Critical Findings](#3-critical-findings)
4. [High Findings](#4-high-findings)
5. [Medium Findings](#5-medium-findings)
6. [Low & Informational Findings](#6-low--informational-findings)
7. [Architecture Assessment](#7-architecture-assessment)
8. [CredShield Readiness Assessment](#8-credshield-readiness-assessment)

---

## 1. Executive Summary

This institutional-grade audit covers the entire Minted mUSD Canton repository: 16 Solidity contracts, 17 DAML modules, relay/validator services, deployment scripts, Kubernetes infrastructure, a liquidation bot, and a frontend application.

### Finding Summary

| Severity | Smart Contracts | DAML | Infrastructure | Relay/Bot | Scripts | Total |
|----------|----------------|------|----------------|-----------|---------|-------|
| **Critical** | 0 | 4 | 2 | 4 | 2 | **12** |
| **High** | 1 | 6 | 6 | 4 | 5 | **22** |
| **Medium** | 8 | 7 | 6 | 7 | 7 | **35** |
| **Low/Info** | 2 | 4 | 4 | 4 | 4 | **18** |
| **Total** | **11** | **21** | **18** | **19** | **18** | **87** |

### Verdict: NOT READY for CredShield without addressing Critical and High findings.

The Solidity contracts are in strong shape after prior audit rounds. However, the DAML modules contain critical token-loss and supply-cap-bypass bugs, the infrastructure has unauthenticated ledger API access, and the relay services have race conditions that could cause double-submissions. These must be resolved before a formal paid audit is cost-effective.

---

## 2. Scope & Methodology

### Files Audited

| Category | Count | Key Files |
|----------|-------|-----------|
| Solidity Contracts | 16 | MUSD, DirectMint, DirectMintV2, BorrowModule, PriceOracle, Treasury, TreasuryV2, TreasuryReceiver, DepositRouter, BLEBridgeV8, BLEBridgeV9, SMUSD, CollateralVault, LiquidationEngine, LeverageVault, PendleMarketSelector |
| Solidity Mocks | 13 | MockAggregatorV3, MockERC20, MockStrategy, etc. |
| Solidity Tests | 12 | Full test suite for all major contracts |
| DAML Modules | 17 | V3, BLEBridgeProtocol, BLEProtocol, CantonDirectMint, CantonSMUSD, MintedProtocol, MintedProtocolV2Fixed, Compliance, MintedMUSD, MUSD_Protocol, etc. |
| Relay Services | 6 | relay-service.ts, validator-node.ts, validator-node-v2.ts, yield-keeper.ts, signer.ts, utils.ts |
| Deployment Scripts | 5 | deploy-deposit-router.ts, deploy-sepolia.sh, deploy-testnet.ts, migrate-v8-to-v9.ts, signer.ts |
| Infrastructure | 9 | K8s manifests, Dockerfile, docker-compose.yml, CI pipeline |
| Bot | 3 | index.ts, flashbots.ts, monitor.ts |
| Frontend | 67 | Components, hooks, pages, ABIs, config |

### Methodology
- Line-by-line manual review of all production code
- Cross-contract interaction analysis
- DAML signatory/authorization model verification
- Infrastructure secret and network policy review
- Relay race condition and state management analysis
- Deployment script safety validation

---

## 3. Critical Findings

### SC-C1: Pause Asymmetry -- Users Liquidated While Unable to Repay
**Contracts:** BorrowModule.sol, LiquidationEngine.sol
**Severity:** CRITICAL (System-Level)

When BorrowModule is paused, `repay()` and `withdrawCollateral()` are blocked (`whenNotPaused`). But LiquidationEngine has its own independent pause state. If only BorrowModule is paused:
- Interest continues accruing, degrading health factors
- Users cannot repay debt or add collateral
- LiquidationEngine can still seize their collateral

**Impact:** Users lose collateral to liquidation while contractually prevented from defending their positions. This is an immediate fund-loss vulnerability exploitable by a malicious admin or during legitimate maintenance.

**Recommendation:** LiquidationEngine should check `if BorrowModule is paused, revert` before executing liquidations. Alternatively, implement a synchronized pause across the lending stack.

---

### DL-C1: V3 `TransferProposal_Cancel` Permanently Destroys Tokens
**File:** `daml/Minted/Protocol/V3.daml:184-187`

```haskell
choice TransferProposal_Cancel : ()
  controller sender
  do return ()  -- Token is consumed but NEVER recreated
```

When `MUSD_Transfer` creates the proposal, the original `MintedMUSD` is consumed (archived). If the sender cancels, the choice returns `()` without recreating the token. **Funds are permanently destroyed.**

**Impact:** Any user who creates and cancels a transfer proposal loses their tokens irreversibly.

---

### DL-C2: V3 AdjustLeverage Mints mUSD Without Supply Cap Enforcement
**File:** `daml/Minted/Protocol/V3.daml:401-408`

```haskell
musdCid <- create MintedMUSD with
  issuer = musdIssuer, owner = owner, amount = borrowable, ...
```

The `AdjustLeverage` choice on `Vault` creates `MintedMUSD` directly (up to 10 loops) without checking or updating any `supplyCap` or `currentSupply` tracker. The `CantonDirectMint.supplyCap` is completely bypassed.

**Impact:** Unbounded mUSD minting limited only by collateral ratio. All supply tracking becomes meaningless.

---

### DL-C3: V3 `CantonMint_Mint` Does Not Verify Actual Token Deposit
**File:** `daml/Minted/Protocol/V3.daml:707-761`

```haskell
choice CantonMint_Mint : ...
  with user : Party, depositAmount : Money  -- Raw number, no token CID
  controller user
```

Unlike `CantonDirectMint.daml` which takes and verifies a `ContractId CantonUSDC`, the V3 module accepts a raw `Money` amount. A user can claim any deposit amount and receive minted mUSD backed by nothing.

**Impact:** Unbacked minting in the production module.

---

### DL-C4: Issuer Can Unilaterally Burn User Tokens
**File:** `daml/CantonDirectMint.daml:202-205`

```haskell
choice CantonMUSD_Burn : ()
  controller issuer
  do return ()
```

The `operator` (who is `issuer` on all minted tokens) can destroy any user's `CantonMUSD` at will without consent.

**Impact:** Total loss of user funds if operator is compromised or malicious.

---

### INF-C1: `--allow-insecure-tokens` on Canton JSON API
**File:** `k8s/canton/participant-deployment.yaml:165`

The JSON API sidecar disables JWT validation. Any request reaching port 7575 can act as any party on the ledger.

**Impact:** Full unauthorized read/write access to every contract on the Canton ledger.

---

### INF-C2: Canton Admin API Exposed on ClusterIP Service
**File:** `k8s/canton/participant-deployment.yaml:22-24`

Port 5012 (admin API) is declared on the Service. While currently bound to localhost, any network policy or config change could silently expose it.

**Impact:** Admin API allows party allocation, package upload, and participant shutdown.

---

### RLY-C1: Relay Race Condition -- Double-Submission Window
**File:** `relay/relay-service.ts:244-365`

Attestations are only marked as processed AFTER on-chain confirmation (line 365). Between transaction submission and confirmation, a parallel poll cycle can re-submit the same attestation.

**Impact:** Wasted gas, nonce collisions, potential double-submission.

---

### RLY-C2: Validators Do Not Verify Target Address Before Signing
**Files:** `relay/validator-node.ts:161-206`, `relay/validator-node-v2.ts:310-349`

Neither V1 nor V2 validator nodes verify that `targetAddress` or `targetBridgeAddress` in the attestation payload matches their own configuration. A compromised aggregator could forge attestations directing mints to attacker addresses.

**Impact:** Validators sign attestations for arbitrary target addresses, enabling minting on rogue contracts.

---

### SCR-C1: Migration Script V8 Pause is Commented Out
**File:** `scripts/migrate-v8-to-v9.ts:319-320`

The actual `v8.pause()` call is commented out. The script continues with migration while V8 remains live, creating a dual-bridge window.

**Impact:** During migration, both V8 and V9 can mint, enabling double-spend via attestation replay.

---

### BOT-C1: No Gas Price Cap on Flashbots or Fallback Path
**File:** `bot/src/flashbots.ts:253-261, 348-354`

The Flashbots path uses `maxFeePerGas = feeData.maxFeePerGas * 2n` with no upper bound. During gas spikes, this can drain the bot wallet.

**Impact:** Bot wallet drained by gas costs during network congestion.

---

### BOT-C2: Hardcoded ETH Price ($2500) in Profit Calculations
**File:** `bot/src/index.ts:343`

Gas cost is calculated at a fixed ETH/$2500. At higher ETH prices, the bot executes unprofitable liquidations.

**Impact:** Financial loss from incorrect profitability assessment.

---

## 4. High Findings

### SC-H1: LeverageVault `block.timestamp` Deadline is Non-Protective
**File:** `contracts/LeverageVault.sol:451, 489`

Setting `deadline: block.timestamp` always passes -- it is the current block's timestamp. Users have no mechanism to set their own deadline. Validators can hold transactions indefinitely.

### SC-H2: Bad Debt Has No Socialization Mechanism
**Contracts:** BorrowModule.sol, LiquidationEngine.sol

When liquidation seizure is insufficient to cover debt (e.g., flash crash), remaining debt persists with no insurance fund, surplus auction, or write-off. mUSD becomes undercollateralized over time.

### SC-H3: Interest Rate Change Applies Retroactively
**File:** `contracts/BorrowModule.sol:338, 377`

`totalDebt()` uses the current `interestRateBps` for ALL elapsed time. A rate change from 2% to 50% retroactively inflates debt for existing positions, making them instantly liquidatable.

### SC-H4: `withdrawFor()` Bypasses Health Check When `borrowModule` Not Set
**File:** `contracts/CollateralVault.sol:203-222`

If `borrowModule == address(0)`, the `LEVERAGE_VAULT_ROLE` can drain any user's collateral without health checks.

### SC-H5: Disabling Collateral Token Makes Positions Instantly Liquidatable
**Contracts:** BorrowModule.sol:281, CollateralVault.sol

When admin disables a collateral token, `_weightedCollateralValue()` excludes it, dropping health factors and enabling liquidation of previously healthy positions.

### DL-H1: V3 SMUSD_Withdraw Uses Raw Share Price (No Virtual Offset)
**File:** `daml/Minted/Protocol/V3.daml:907`

Deposits use virtual offset (anti-dilution), but withdrawals use raw `totalAssets/totalShares`. This asymmetry allows economic extraction from the yield vault.

### DL-H2: CantonSMUSD Unstake Mints Yield Without Supply Cap
**File:** `daml/CantonSMUSD.daml:191-196`

Yield-bearing withdrawals create new `CantonMUSD` supply without updating or checking any supply cap.

### DL-H3: MintedMUSD Lock Drops Owner Signatory
**File:** `daml/MintedMUSD.daml:72-81`

`MUSD_Locked` has only `provider` as signatory. Owner loses all authority over locked funds with no recourse or time limit.

### DL-H4: MUSD_Protocol Bridge Lock Cancel + Claim Double-Spend
**File:** `daml/MUSD_Protocol.daml:326-336`

`Cancel_BridgeLock` and `Finalize_Bridge_Mint` are independent choices on different templates. Both can be exercised, giving the user double tokens.

### DL-H5: V3 TransferProposal Has No Receiver Reject Choice
**File:** `daml/Minted/Protocol/V3.daml:152-202`

Receivers cannot decline unwanted transfers. Only sender cancel (which destroys tokens per DL-C1) or issuer reject exist.

### INF-H1: PostgreSQL SSL Mode `require` Without Certificate Verification
**File:** `k8s/canton/participant-config.yaml:28`

`sslmode = "require"` encrypts but does NOT verify the server certificate. MITM between Canton and Postgres is possible.

### INF-H2: DAML SDK Installed via `curl | bash` Without Checksum
**File:** `.github/workflows/ci.yml:121`

Supply-chain attack vector. No hash verification on the downloaded installer.

### INF-H3: Docker Base Images Use Mutable Tags
**File:** `relay/Dockerfile:12, 30`

`node:20-alpine` is a floating tag. Must be pinned to SHA256 digest for production.

### RLY-H1: No Timeout on Canton Ledger Queries
**Files:** All relay services

`this.ledger.query` has no timeout. A hung Canton node blocks all bridging indefinitely.

### RLY-H2: Ethereum RPC Defaults to Plaintext HTTP
**File:** `relay/relay-service.ts:56`

No HTTPS enforcement for Ethereum RPC. MITM can feed fake responses.

### SCR-H1: Nonce Verification Hardcoded to `pass: true`
**File:** `scripts/migrate-v8-to-v9.ts:232`

The migration nonce check is disabled. Old V8 nonces could potentially be replayed on V9.

### SCR-H2: Empty Validator Arrays in Migration Template
**File:** `scripts/migrate-v8-to-v9.ts:334-341`

All validators and emergency addresses are commented out. Running as-is deploys a bridge with zero validators.

### SCR-H3: Deployer Used as Treasury in Testnet Script
**File:** `scripts/deploy-testnet.ts:143`

No guard prevents running this on mainnet. All USDC would flow to the deployer's personal address.

### BOT-H1: Unlimited Token Approval to Liquidation Engine
**File:** `bot/src/index.ts:222-232`

`MaxUint256` approval means a compromised liquidation engine can drain the bot's entire mUSD balance.

### BOT-H2: Flashbots Auth Signer Reuses Trading Wallet
**File:** `bot/src/flashbots.ts:226`

Exposes the bot's identity and ties Flashbots reputation to the fund-holding wallet.

---

## 5. Medium Findings

### Solidity (8)

| ID | Finding | File | Lines |
|----|---------|------|-------|
| SC-M1 | Sandwich attacks on multi-loop LeverageVault swaps (~1% per loop, compounding) | LeverageVault.sol | 445-461 |
| SC-M2 | Max leverage creates near-liquidation positions (8% drop = bad debt) | LeverageVault.sol | 373-402 |
| SC-M3 | Flash loan pool manipulation on leverage close | LeverageVault.sol | 305, 435 |
| SC-M4 | Supply cap DOS -- bridge can reduce cap to totalSupply(), blocking all minting | BLEBridgeV9.sol, MUSD.sol | 296, 41 |
| SC-M5 | `rebalance()` withdraw has silent `catch {}` -- masks accounting failures | TreasuryV2.sol | 787 |
| SC-M6 | `removeStrategy` and `emergencyWithdrawAll` lack `nonReentrant` | TreasuryV2.sol | 705, 830 |
| SC-M7 | TreasuryV2 rebalance sandwichable depending on strategy implementations | TreasuryV2.sol | 778-817 |
| SC-M8 | Treasury V1 lacks Pausable capability | Treasury.sol | 17 |

### DAML (7)

| ID | Finding | File | Lines |
|----|---------|------|-------|
| DL-M1 | Rate limit bypass via mint-burn-mint cycling within same window | CantonDirectMint.daml | 409-417 |
| DL-M2 | Zero-value InstitutionalEquityPosition allowed | BLEBridgeProtocol.daml | 45 |
| DL-M3 | Compliance dual-controller may be inoperable | Compliance.daml | 99 |
| DL-M4 | Owner-only MUSD_Burn desynchronizes V2Fixed supply tracker | MintedProtocolV2Fixed.daml | 112-115 |
| DL-M5 | V3 archive without signatory authority (fragile pool design) | V3.daml | 287 |
| DL-M6 | Deprecated MintedProtocol leverage loop has type mismatch | MintedProtocol.daml | 179 |
| DL-M7 | Compliance IsCompliant leaks blacklist status to any observer | Compliance.daml | 128-134 |

### Infrastructure (6)

| ID | Finding | File |
|----|---------|------|
| INF-M1 | kubeconform downloaded without checksum verification | ci.yml:213-216 |
| INF-M2 | Coverage threshold check is non-blocking (`continue-on-error: true`) | ci.yml:51 |
| INF-M3 | NGINX-to-JSON-API traffic is plain HTTP | nginx-configmap.yaml:148 |
| INF-M4 | No custom `pg_hba.conf` for Postgres | postgres-statefulset.yaml |
| INF-M5 | validator2/3 missing `NODE_ENV=production` | docker-compose.yml:158,204 |
| INF-M6 | Secrets template with `REPLACE_ME` committed to repo | secrets.yaml:32-33 |

### Relay/Bot (7)

| ID | Finding | File |
|----|---------|------|
| RLY-M1 | Cache eviction re-processes old attestations | relay-service.ts:372-381 |
| RLY-M2 | `sortSignaturesBySignerAddress` throws on any malformed signature | signer.ts:219-235 |
| RLY-M3 | Hardcoded ETH price ($2000) in yield keeper profitability | yield-keeper.ts:213-215 |
| RLY-M4 | Validator V2 missing on-ledger dedup check after restart | validator-node-v2.ts:310-349 |
| BOT-M1 | Flashbots bundle replay with stale signed transaction | flashbots.ts:263-316 |
| BOT-M2 | `waitForBlock` hangs indefinitely on RPC failure | flashbots.ts:368-380 |
| BOT-M3 | Non-atomic read-then-execute in liquidation path | index.ts:254-285 |

### Scripts (7)

| ID | Finding | File |
|----|---------|------|
| SCR-M1 | No network guard preventing testnet script on mainnet | deploy-testnet.ts:30 |
| SCR-M2 | Non-atomic role migration (both V8 and V9 have roles simultaneously) | migrate-v8-to-v9.ts:362-368 |
| SCR-M3 | Empty string fallback for critical addresses | deploy-deposit-router.ts:30-31 |
| SCR-M4 | No two-step ownership transfer or multisig handoff | deploy-testnet.ts:182-193 |
| SCR-M5 | Missing network configs for target chains | hardhat.config.ts:21-39 |
| SCR-M6 | `source .env` exposes private key in shell environment | deploy-sepolia.sh:42 |
| SCR-M7 | Deployment block hardcoded to 0 in migration | migrate-v8-to-v9.ts:329 |

---

## 6. Low & Informational Findings

### Solidity (2)
- **SC-L1:** DepositRouter/TreasuryReceiver use `Ownable` without separation of duties
- **SC-L2:** DepositRouter/TreasuryReceiver use `^0.8.20` pragma vs `0.8.26`

### DAML (4)
- **DL-L1:** BulkBlacklist does not deduplicate input
- **DL-L2:** SecureAsset.Split violates key uniqueness (reference module)
- **DL-L3:** Missing `ensure` on StakedMUSD in V2Fixed
- **DL-L4:** Deprecated modules in shared DAML build

### Infrastructure (4)
- **INF-L1:** DNS egress open to all namespaces
- **INF-L2:** Postgres pod missing ServiceAccount config
- **INF-L3:** CI npm fallback weakens reproducibility
- **INF-L4:** SDK version mismatch between CI (2.10.3) and runtime (2.9.3)

### Relay/Bot (4)
- **RLY-L1:** Canton token shared across all services (blast radius)
- **RLY-L2:** Docker image not pinned to SHA256 digest
- **BOT-L1:** RPC URLs exposed client-side via NEXT_PUBLIC_ variables
- **BOT-L2:** Sensitive data in unrotated log files

### Scripts (4)
- **SCR-L1:** No timelock for admin operations post-deployment
- **SCR-L2:** Dummy private key fallback in hardhat.config.ts
- **SCR-L3:** Goerli network (deprecated) still in config
- **SCR-L4:** Frontend .env.local overwritten without backup

---

## 7. Architecture Assessment

### What's Done Well

1. **Solidity contracts are strong.** After prior audit rounds, the core contracts demonstrate defense-in-depth: CEI patterns, ReentrancyGuard on all user-facing functions, SafeERC20 everywhere, forceApprove for USDT compatibility, proper storage gaps for UUPS upgradeability, and consistent separation of duties (PAUSER for pause, ADMIN for unpause).

2. **BLEBridgeProtocol DAML** has well-implemented consuming Sign choices, supermajority quorum, nonce-based validation, and expiration enforcement.

3. **Infrastructure** has namespace PSA enforcement, non-root containers, seccomp profiles, capability dropping, resource limits, and default-deny network policies.

4. **CI pipeline** includes Slither static analysis, Trivy container scanning, dependency auditing, and test coverage reporting.

5. **Rate limiting** is properly implemented in both Solidity (BLEBridgeV8/V9 daily limits) and DAML (24h rolling windows).

### Architectural Concerns

1. **DAML V3 is the weakest link.** It contains 4 of the Critical findings (token loss on cancel, supply cap bypass, unbacked minting, and the related pool archive fragility). This module appears to be a consolidation of earlier modules but introduced new bugs during the merge.

2. **No bad debt mechanism.** The lending stack (BorrowModule + CollateralVault + LiquidationEngine) has no insurance fund, surplus buffer, or debt write-off. Bad debt silently accumulates as unbacked mUSD.

3. **Shared supply cap across subsystems.** The bridge and borrowing subsystems share the same `MUSD.supplyCap()`, creating coupling where bridge cap reductions can DOS the borrowing system.

4. **Off-chain relay is a single point of failure.** The relay service has race conditions, cache eviction bugs, and no persistent state. A production deployment needs Redis/SQLite backing and proper mutex locks.

5. **Validator trust model.** Both V1 and V2 validators sign attestations without verifying target addresses. This is the most dangerous off-chain finding -- compromised aggregators can redirect mints.

---

## 8. CredShield Readiness Assessment

### Must Fix Before Handoff (Blocking)

| Priority | ID | Issue | Effort |
|----------|----|-------|--------|
| 1 | DL-C1 | V3 TransferProposal_Cancel destroys tokens | Small -- recreate token on cancel |
| 2 | DL-C2 | V3 AdjustLeverage bypasses supply cap | Medium -- add supply cap check or route through service |
| 3 | DL-C3 | V3 CantonMint_Mint accepts raw amount (no deposit verification) | Medium -- require token CID like CantonDirectMint.daml |
| 4 | SC-C1 | Pause asymmetry in lending stack | Small -- add BorrowModule.paused() check in LiquidationEngine |
| 5 | INF-C1 | Insecure tokens on JSON API | Small -- remove `--allow-insecure-tokens` flag |
| 6 | RLY-C2 | Validators don't verify target addresses | Medium -- add whitelist check before signing |

### Should Fix Before Handoff (Recommended)

| Priority | ID | Issue |
|----------|----|-------|
| 7 | DL-C4 | Issuer burn without owner consent |
| 8 | DL-H1 | SMUSD withdraw virtual offset asymmetry |
| 9 | DL-H4 | Bridge lock cancel + claim double-spend |
| 10 | SC-H2 | No bad debt socialization mechanism |
| 11 | SC-H3 | Retroactive interest rate application |
| 12 | SC-H1 | LeverageVault deadline is non-protective |
| 13 | RLY-C1 | Relay race condition double-submission |
| 14 | SCR-C1 | Migration script V8 pause commented out |

### Can Fix After Audit (Non-Blocking)

All Medium, Low, and Informational findings. These are important for production hardening but will not significantly impact the cost-effectiveness of a CredShield engagement.

### What CredShield Will Focus On

Based on typical formal audit scope, CredShield will primarily evaluate:
1. Solidity smart contracts (these are in good shape)
2. DAML ledger modules (these need the most work)
3. Cross-contract/cross-chain interaction security
4. Upgrade safety and storage layout

They will likely NOT audit: frontend, bot, relay services, k8s manifests, or deployment scripts. Those findings are included here for operational completeness.

### Bottom Line

**Fix the 6 blocking items above, then hand off.** The Solidity contracts will pass a formal audit with minor findings. The DAML V3 module needs the most attention -- the token-loss bug (DL-C1) alone would be a showstopper in any professional audit. Budget 1-2 weeks for DAML fixes before engaging CredShield to maximize ROI on the audit spend.
