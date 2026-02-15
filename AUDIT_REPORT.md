# Minted mUSD Protocol — Comprehensive Security Audit Report

**Auditor:** Claude Opus 4.6 Automated Institutional Security Review
**Date:** 2026-02-15
**Scope:** Full protocol — Solidity, DAML, TypeScript, Infrastructure, Testing, Cross-cutting
**Methodology:** 6 parallel domain-specialist agents with consolidated synthesis

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Scope & Methodology](#scope--methodology)
3. [Risk Summary](#risk-summary)
4. [Solidity Smart Contract Findings](#solidity-smart-contract-findings)
5. [DAML / Canton Network Findings](#daml--canton-network-findings)
6. [TypeScript Services Findings](#typescript-services-findings)
7. [Infrastructure & DevOps Findings](#infrastructure--devops-findings)
8. [Test Coverage Findings](#test-coverage-findings)
9. [Cross-Cutting Concerns](#cross-cutting-concerns)
10. [Positive Security Observations](#positive-security-observations)
11. [Recommendations Summary](#recommendations-summary)

---

## Executive Summary

The Minted mUSD protocol is a cross-chain stablecoin system spanning Ethereum (Solidity) and the Canton Network (DAML), with TypeScript services for bridging, monitoring, liquidation, and a Next.js frontend. The protocol encompasses an ERC-20 stablecoin (mUSD), an ERC-4626 staking vault (smUSD), a 3-of-5 multi-sig attestation bridge, lending/borrowing with collateral vaults, leveraged positions, and multiple DeFi yield strategies (Morpho, Aave V3, Compound V3, Fluid, Pendle, Sky sUSDS, Yield Basis, MetaVault).

### Overall Assessment

The protocol demonstrates **strong security architecture** in its core components — the bridge attestation system, cross-chain share sync rate limiting, per-operation approval pattern, CEI compliance, and ERC-4626 implementation are well-designed. However, **inconsistent application of governance patterns** across newer strategy contracts (YieldBasisStrategy, MetaVault) compared to the hardened core contracts represents the primary systemic risk.

### Aggregate Finding Count

| Severity | Solidity | DAML | TypeScript | Infra | Testing | Cross-cutting | Total |
|---|---|---|---|---|---|---|---|
| **CRITICAL** | 2 | 0 | 0 | 0 | 0 | 0 | **2** |
| **HIGH** | 6 | 1 | 2 | 1 | 0 | 1 | **11** |
| **MEDIUM** | 8 | 3 | 3 | 3 | 2 | 2 | **21** |
| **LOW** | 4 | 2 | 2 | 2 | 3 | 1 | **14** |
| **INFO** | 2 | 1 | 1 | 1 | 1 | 0 | **6** |
| **Total** | **22** | **7** | **8** | **7** | **6** | **4** | **54** |

---

## Scope & Methodology

### Contracts Audited

| Domain | Files | Description |
|---|---|---|
| Solidity | 26+ contracts | ERC-20, ERC-4626, Bridge, Governance, Strategies, Lending |
| DAML | 14 templates (V3 module) | Institutional accounting, compliance, settlement |
| TypeScript | 3 services (relay, bot, frontend) | Cross-chain relay, liquidation bot, Next.js UI |
| Infrastructure | K8s manifests, Docker, CI/CD | Canton node, PostgreSQL, NGINX, monitoring |
| Tests | 60+ Hardhat test files, Foundry tests | Unit, integration, fuzz, invariant tests |

### Methodology

Six domain-specialist agents conducted parallel audits:
1. **Solidity Auditor** — Smart contract security, DeFi-specific risks, access control
2. **DAML Auditor** — Authorization, privacy, lifecycle, Canton-specific issues
3. **TypeScript Reviewer** — Type safety, error handling, security, async patterns
4. **Infrastructure Reviewer** — K8s security, Docker hardening, CI/CD pipeline
5. **Testing Agent** — Coverage gaps, missing edge cases, test quality
6. **Cross-cutting Analyst** — Secrets management, dependency supply chain, integration risks

---

## Risk Summary

### Critical Risk Areas

1. **Zero-slippage swaps** (CRITICAL) — YieldBasisStrategy and CompoundV3LoopStrategy execute token swaps with `minOut = 0`, enabling sandwich attacks
2. **Inconsistent timelock governance** (HIGH) — YieldBasisStrategy, MetaVault, MUSD, and SMUSD allow admin to bypass timelock for sensitive operations
3. **No-op reentrancy guard** (HIGH) — MintedLevAMM's `checkNonreentrant()` never actually checks reentrancy state

### Systemic Patterns

- **Newer contracts less hardened** — YieldBasisStrategy and MetaVault were written after the core contracts and missed several security patterns (SOL-C-01 through SOL-C-04) that were applied to MorphoLoopStrategy, AaveV3LoopStrategy, etc.
- **Access control inconsistency** — The protocol mixes `DEFAULT_ADMIN_ROLE`, `TIMELOCK_ROLE`, `onlyTimelock` (TimelockGoverned), and delayed unpause patterns without a clear unified standard
- **Cross-chain trust boundary** — Canton ↔ Ethereum bridge relies on off-chain relay attestations with no on-chain verification of Canton state transitions

---

## Solidity Smart Contract Findings

### SOL-CRITICAL-01: YieldBasisStrategy Swaps with Zero Slippage Protection

**Severity:** CRITICAL
**Location:** `contracts/strategies/YieldBasisStrategy.sol:503,529`
**Category:** MEV / Sandwich Attack

Both `_swapUsdcToAsset()` and `_swapAssetToUsdc()` pass `minOut = 0` to the swap router. The code comment says "slippage handled by strategy-level checks" but no such check exists. The `slippageBps` parameter exists on the contract but is never used in swap calls.

```solidity
// Line 503-511 — _swapUsdcToAsset
(bool success, bytes memory data) = swapRouter.call(
    abi.encodeWithSignature(
        "swap(address,address,uint256,uint256)",
        address(usdc), address(assetToken), usdcAmount,
        0 // min out — slippage handled by strategy-level checks
    )
);
```

**Impact:** An attacker can sandwich any deposit/withdrawal to extract value from every swap. For large Treasury rebalances, losses could be substantial.

**Recommendation:** Compute minimum output from oracle price and apply `slippageBps`:
```solidity
uint256 expectedOut = _estimateAssetAmount(usdcAmount);
uint256 minOut = (expectedOut * (BPS - slippageBps)) / BPS;
```

---

### SOL-CRITICAL-02: CompoundV3LoopStrategy Flash Loan Swap with Zero Slippage

**Severity:** CRITICAL
**Location:** `contracts/strategies/CompoundV3LoopStrategy.sol:509-519`
**Category:** MEV / Sandwich Attack

During flash-loan-powered withdrawal, the strategy sells all collateral to USDC via Uniswap V3 with `amountOutMinimum: 0`. The `claimCompRewards()` function (line 662-670) also swaps COMP to USDC with zero slippage. Flash loan callbacks involve large amounts and cannot be retried, making sandwich extraction highly profitable.

```solidity
swapRouter.exactInputSingle(
    ISwapRouterV3Compound.ExactInputSingleParams({
        tokenIn: address(collateralAsset),
        tokenOut: address(usdc),
        fee: defaultSwapFeeTier,
        recipient: address(this),
        amountIn: uint256(collBalance),
        amountOutMinimum: 0, // Protected by overall slippage check
        sqrtPriceLimitX96: 0
    })
);
```

**Recommendation:** Use oracle-based minimum output or keeper-supplied minimum.

---

### SOL-HIGH-01: YieldBasisStrategy `unpause()` and `recoverToken()` Bypass Timelock

**Severity:** HIGH
**Location:** `contracts/strategies/YieldBasisStrategy.sol:449,452`
**Category:** Access Control Inconsistency

Every other strategy uses `onlyTimelock` for `unpause()` and `recoverToken()`. YieldBasisStrategy uses `onlyRole(DEFAULT_ADMIN_ROLE)`, allowing a compromised admin to immediately unpause and extract tokens without the 48-hour governance delay.

Additionally, `recoverToken()` takes an arbitrary `to` address parameter (unlike other strategies that send to `msg.sender`).

**Recommendation:** Change to `onlyTimelock` and remove the `to` parameter.

---

### SOL-HIGH-02: MetaVault `unpause()` and `_authorizeUpgrade()` Bypass Timelock

**Severity:** HIGH
**Location:** `contracts/strategies/MetaVault.sol:566,649`
**Category:** Access Control Inconsistency

MetaVault uses `DEFAULT_ADMIN_ROLE` for `unpause()` and `_authorizeUpgrade()`. Since MetaVault is a "vault-of-vaults" aggregating multiple sub-strategies, compromising its upgrade path compromises ALL sub-strategies it manages.

**Recommendation:** Change both to `onlyTimelock`.

---

### SOL-HIGH-03: MetaVault Unlimited Token Approvals to Sub-Strategies

**Severity:** HIGH
**Location:** `contracts/strategies/MetaVault.sol:392`
**Category:** Token Approval Risk

When adding a sub-strategy, MetaVault grants `type(uint256).max` approval. If any sub-strategy is compromised or maliciously upgraded (possible since they are UUPS upgradeable), it can drain ALL USDC from MetaVault.

All other contracts use per-operation `forceApprove()` followed by clearing (SOL-C-02 pattern). MetaVault is the exception.

**Recommendation:** Use per-operation approvals in `deposit()` and `rebalance()`.

---

### SOL-HIGH-04: MintedLevAMM `checkNonreentrant()` is a No-Op

**Severity:** HIGH
**Location:** `contracts/yb/MintedLevAMM.sol:600-603`
**Category:** Reentrancy

The function is meant to be called by external contracts (like MintedLT) to verify no reentrant state. The implementation is an empty view function that never checks `_status`. It always succeeds regardless of reentrancy state.

```solidity
function checkNonreentrant() external view override {
    // ReentrancyGuard's _status would be _ENTERED if reentered
    // This is a view function -- just needs to not revert when not reentered
}
```

**Recommendation:** Use OpenZeppelin v5's `_reentrancyGuardEntered()`:
```solidity
function checkNonreentrant() external view override {
    require(!_reentrancyGuardEntered(), "ReentrancyGuard: reentrant call");
}
```

---

### SOL-HIGH-05: MUSD `unpause()` Not Protected by Timelock

**Severity:** HIGH
**Location:** `contracts/MUSD.sol:127`
**Category:** Access Control

MUSD is the core stablecoin — all transfers, mints, and burns go through `_update()` which checks `whenNotPaused`. `unpause()` only requires `DEFAULT_ADMIN_ROLE`, allowing immediate unpause during an ongoing exploit. Compare with BLEBridgeV9's 24-hour unpause delay pattern.

**Recommendation:** Implement timelock-delayed unpause or require `TIMELOCK_ROLE`.

---

### SOL-HIGH-06: SMUSD `unpause()` Not Protected by Timelock

**Severity:** HIGH
**Location:** `contracts/SMUSD.sol:355`
**Category:** Access Control

The staking vault holding user mUSD deposits can be immediately unpaused by admin. A compromised admin could unpause during share price manipulation.

**Recommendation:** Add timelock or delayed unpause mechanism.

---

### SOL-MEDIUM-01: YieldBasisStrategy LT Deposit Uses `minShares = 0`

**Severity:** MEDIUM
**Location:** `contracts/strategies/YieldBasisStrategy.sol:238,429`

LT deposits and migrations pass `minShares = 0`, accepting any exchange rate.

**Recommendation:** Calculate expected shares from `pricePerShare()` and apply `slippageBps`.

---

### SOL-MEDIUM-02: YieldBasisStrategy LT Withdraw Uses `minAssets = 0`

**Severity:** MEDIUM
**Location:** `contracts/strategies/YieldBasisStrategy.sol:278,310`

Combined with CRITICAL-01, creates double vulnerability: unfavorable LT redemption + unfavorable swap.

**Recommendation:** Calculate expected assets and apply slippage protection.

---

### SOL-MEDIUM-03: TreasuryReceiver `emergencyWithdraw()` Lacks Timelock

**Severity:** MEDIUM
**Location:** `contracts/TreasuryReceiver.sol:329`

`DEFAULT_ADMIN_ROLE` can withdraw any token to any address without timelock, pause gate, or limits. Includes USDC held for pending cross-chain mints.

**Recommendation:** Gate behind `onlyTimelock` or require `whenPaused`.

---

### SOL-MEDIUM-04: BLEBridgeV9 `migrateUsedAttestations()` Has No Size Limit

**Severity:** MEDIUM
**Location:** `contracts/BLEBridgeV9.sol:183-192`

Unbounded array iteration could exceed block gas limit.

**Recommendation:** Add batch size limit (e.g., 500).

---

### SOL-MEDIUM-05: MorphoLoopStrategy `_maxWithdrawable()` Potential Underflow

**Severity:** MEDIUM
**Location:** `contracts/strategies/MorphoLoopStrategy.sol:631`

If `targetLtvBps` is reduced below `safetyBufferBps`, subtraction reverts, trapping funds.

**Recommendation:** Add explicit check: `if (safetyBufferBps >= targetLtvBps) return 0;`

---

### SOL-MEDIUM-06: FluidLoopStrategy Missing Timelock Documentation

**Severity:** MEDIUM
**Location:** `contracts/strategies/FluidLoopStrategy.sol`

Inconsistent timelock management pattern compared to other strategies. While functionally safe (uses `TimelockGoverned`), the deviation could confuse developers.

---

### SOL-MEDIUM-07: DirectMintV2 `recoverToken()` Uses Wrong Role

**Severity:** MEDIUM
**Location:** `contracts/DirectMintV2.sol:329`

Uses `DEFAULT_ADMIN_ROLE` while all other functions correctly use `TIMELOCK_ROLE`.

**Recommendation:** Change to `onlyRole(TIMELOCK_ROLE)`.

---

### SOL-MEDIUM-08: SMUSD Cross-Chain Share Price Accounting Asymmetry

**Severity:** MEDIUM
**Location:** `contracts/SMUSD.sol:279-297`

Local vault accounting for deposits/withdrawals but global accounting for yield caps creates potential for disproportionate yield capture when Canton/Ethereum share ratios diverge significantly.

**Recommendation:** Add monitoring for local/global price divergence.

---

### SOL-LOW-01: DepositRouter `markDepositComplete()` No On-Chain Verification

**Severity:** LOW
**Location:** `contracts/DepositRouter.sol`

Admin can mark any deposit complete without proof. Trust assumption on ROUTER_ADMIN should be documented.

---

### SOL-LOW-02: MorphoLoopStrategy Borrow Rate Annualization Overflow

**Severity:** LOW
**Location:** `contracts/strategies/MorphoLoopStrategy.sol:456`

Multiplication by `31536000` could overflow with extreme IRM return values.

---

### SOL-LOW-03: AaveV3LoopStrategy Reward Swap Minimum Uses Wrong Basis

**Severity:** LOW
**Location:** `contracts/strategies/AaveV3LoopStrategy.sol:752`

`minSwapOutputBps` applied to raw token balance (not USD value), making slippage protection meaningless for tokens with different unit prices.

---

### SOL-LOW-04: FluidLoopStrategy Position Read Functions Return Zero

**Severity:** LOW
**Location:** `contracts/strategies/FluidLoopStrategy.sol:873-883`

Stub implementations always return 0, causing `totalValue()` and related functions to malfunction if base contract deployed without override.

---

### SOL-INFO-01: Inconsistent Storage Gap Sizes

**Severity:** INFORMATIONAL

Gap sizes range from `uint256[30]` to `uint256[40]` across contracts. Verify total slots are consistent per contract family.

---

### SOL-INFO-02: Empty Placeholder Contracts

**Severity:** INFORMATIONAL

`GlobalPauseRegistry.sol`, `YieldVerifier.sol`, `YieldScanner.sol`, `MorphoMarketRegistry.sol`, `ReferralRegistry.sol`, `PriceAggregator.sol` are empty/minimal placeholders.

---

### Access Control Consistency Matrix

| Contract | `unpause()` | `recoverToken()` | `_authorizeUpgrade()` |
|---|---|---|---|
| MorphoLoopStrategy | onlyTimelock | onlyTimelock | onlyTimelock |
| AaveV3LoopStrategy | onlyTimelock | onlyTimelock | onlyTimelock |
| CompoundV3LoopStrategy | onlyTimelock | onlyTimelock | onlyTimelock |
| FluidLoopStrategy | onlyTimelock | onlyTimelock | onlyTimelock |
| PendleStrategyV2 | onlyTimelock | onlyTimelock | onlyTimelock |
| SkySUSDSStrategy | onlyTimelock | onlyTimelock | onlyTimelock |
| **YieldBasisStrategy** | **DEFAULT_ADMIN** | **DEFAULT_ADMIN** | onlyTimelock |
| **MetaVault** | **DEFAULT_ADMIN** | N/A | **DEFAULT_ADMIN** |
| DirectMintV2 | TIMELOCK_ROLE | **DEFAULT_ADMIN** | N/A |
| BLEBridgeV9 | 24h delay | N/A | TIMELOCK_ROLE |
| **MUSD** | **DEFAULT_ADMIN** | N/A | N/A |
| **SMUSD** | **DEFAULT_ADMIN** | N/A | N/A |
| TreasuryReceiver | onlyTimelock | **DEFAULT_ADMIN** | N/A |

Bold entries deviate from the expected `onlyTimelock` pattern.

---

## DAML / Canton Network Findings

### DAML-HIGH-01: Party Authorization Gaps in Multi-Party Templates

**Severity:** HIGH
**Category:** Authorization

Several DAML templates in the V3 module allow operations without full multi-party authorization verification. The propose-accept pattern is implemented but some acceptance flows don't verify all required signatories before settlement finalization. Canton's sub-transaction privacy model means unauthorized parties could observe settlement details if template visibility is not correctly scoped.

**Recommendation:** Audit all `signatory` and `observer` declarations. Ensure `exerciseByKey` calls validate all required parties.

---

### DAML-MEDIUM-01: Compliance Template Lifecycle Gaps

**Severity:** MEDIUM
**Category:** Lifecycle Management

Compliance check templates lack explicit archive/expiry mechanisms. Stale compliance attestations could remain active past their validity period, allowing operations that should be blocked by expired KYC/AML checks.

**Recommendation:** Add `expiresAt` field and validate freshness on all compliance-gated choices.

---

### DAML-MEDIUM-02: Settlement Atomicity Across Canton Domains

**Severity:** MEDIUM
**Category:** Cross-Domain Consistency

Canton's multi-domain transaction model requires careful handling of settlements that span participant nodes. The current templates don't explicitly handle the case where a settlement succeeds on one domain but fails on another (e.g., due to a domain disconnect during commit).

**Recommendation:** Implement explicit rollback choices and pending-settlement tracking.

---

### DAML-MEDIUM-03: Decimal Precision in Cross-Chain Amount Translation

**Severity:** MEDIUM
**Category:** Arithmetic

DAML uses `Decimal` (38 digits) while Solidity uses `uint256`. The relay service translates between these, but there's no explicit precision validation in the DAML templates themselves. Amounts that exceed `uint256` precision could silently truncate during bridge attestation.

**Recommendation:** Add DAML-side validation constraining amounts to `uint256` range.

---

### DAML-LOW-01: Missing Disclosure Controls on Institutional Templates

**Severity:** LOW
**Category:** Privacy

Some institutional accounting templates expose more data to observers than necessary. Canton's privacy model only shares sub-transactions with stakeholders, but observer lists in some templates are broader than required.

**Recommendation:** Minimize observer lists to strict need-to-know.

---

### DAML-LOW-02: Incomplete Error Handling in Choice Bodies

**Severity:** LOW
**Category:** Robustness

Some choice implementations use `abort` with generic messages instead of structured error types. This makes debugging failed transactions harder in production Canton environments.

**Recommendation:** Use structured error types with unique identifiers.

---

### DAML-INFO-01: Template Naming Inconsistencies

**Severity:** INFORMATIONAL

Some V3 templates use `PascalCase` and others use `camelCase` for choice names. Standardize naming conventions.

---

## TypeScript Services Findings

### TS-HIGH-01: Relay Service Missing Attestation Replay Protection

**Severity:** HIGH
**Location:** `relay/`
**Category:** Cross-Chain Security

The relay service constructs bridge attestations from Canton events but lacks idempotency checks for processed events. If the relay restarts or processes an event queue replay, duplicate attestations could be submitted to the Ethereum bridge. While BLEBridgeV9 has on-chain replay protection (`usedAttestationIds`), duplicate submissions waste gas and could be used to grief validators.

**Recommendation:** Implement persistent event watermarking (e.g., PostgreSQL sequence tracking) and deduplicate before signing.

---

### TS-HIGH-02: Environment Variable Validation Gaps

**Severity:** HIGH
**Location:** `relay/`, `bot/`
**Category:** Configuration Security

While the codebase uses `zod` for environment validation (per CLAUDE.md conventions), several critical configuration values lack runtime validation:
- Private key format validation (could accept malformed keys silently)
- RPC URL validation (no URL format check, could connect to wrong chain)
- Threshold values (validator count, quorum) not validated against expected ranges

**Recommendation:** Extend zod schemas to validate format, range, and semantic correctness of all critical config values.

---

### TS-MEDIUM-01: Liquidation Bot Missing Circuit Breaker

**Severity:** MEDIUM
**Location:** `bot/`
**Category:** Operational Safety

The liquidation bot lacks a circuit breaker pattern for rapid consecutive liquidations. During a flash crash, the bot could execute many liquidations in quick succession, potentially draining gas wallets or triggering cascading liquidations that harm protocol health.

**Recommendation:** Implement per-block and per-hour liquidation count limits with automatic pause.

---

### TS-MEDIUM-02: Frontend Wallet Connection Trust Assumptions

**Severity:** MEDIUM
**Location:** `frontend/`
**Category:** Client-Side Security

The Next.js frontend's wallet integration doesn't validate chain ID before submitting transactions. Users on wrong networks could sign transactions that fail or, worse, succeed on unintended chains if contract addresses collide.

**Recommendation:** Add chain ID validation pre-transaction and prompt network switch.

---

### TS-MEDIUM-03: Relay Validator Key Management

**Severity:** MEDIUM
**Location:** `relay/`
**Category:** Key Management

The 3-of-5 multi-sig validator setup stores signing logic alongside relay logic. If the relay process is compromised, attacker gains access to signing capability. The CLAUDE.md mentions AWS KMS signing but the relay implementation should enforce that keys are never loaded into process memory.

**Recommendation:** Ensure all signing goes through AWS KMS SDK calls (never local key material). Add key usage audit logging.

---

### TS-LOW-01: Unhandled Promise Rejections in Async Flows

**Severity:** LOW
**Location:** `relay/`, `bot/`
**Category:** Error Handling

Several async operation chains don't have top-level error boundaries, risking unhandled promise rejections that crash the Node.js process.

**Recommendation:** Add `process.on('unhandledRejection')` handlers and structured error boundaries.

---

### TS-LOW-02: Telegram Alert Injection

**Severity:** LOW
**Location:** `bot/`
**Category:** Input Validation

Liquidation bot Telegram alerts may include user-controlled data (addresses, amounts) without sanitization. While Telegram's API handles most injection risks, HTML-mode messages could be exploited for formatting attacks.

**Recommendation:** Sanitize all user-controlled data before embedding in alert messages.

---

### TS-INFO-01: Missing TypeScript Strict Null Checks in Some Modules

**Severity:** INFORMATIONAL

Some TypeScript modules don't enforce `strictNullChecks`, allowing potential null reference errors.

---

## Infrastructure & DevOps Findings

### INFRA-HIGH-01: Kubernetes Secrets Not Encrypted at Rest

**Severity:** HIGH
**Location:** `k8s/`
**Category:** Secrets Management

K8s manifests reference Secrets but don't configure encryption at rest (EncryptionConfiguration). Default Kubernetes stores secrets base64-encoded in etcd, which is not encryption. Anyone with etcd access can read all secrets including database credentials and API keys.

**Recommendation:** Enable Kubernetes envelope encryption with a KMS provider. Consider using Sealed Secrets or External Secrets Operator.

---

### INFRA-MEDIUM-01: Container Images Not Pinned to Digests

**Severity:** MEDIUM
**Location:** `k8s/`
**Category:** Supply Chain

Container image references use tags (`:latest`, `:v1.2`) instead of SHA256 digests. Tags are mutable — a compromised registry could serve different images for the same tag.

**Recommendation:** Pin all images to `@sha256:` digests in production manifests.

---

### INFRA-MEDIUM-02: Canton Participant Node Network Exposure

**Severity:** MEDIUM
**Location:** `k8s/`
**Category:** Network Security

Canton participant node configuration exposes ledger API and admin API ports without explicit NetworkPolicy restrictions. In a multi-tenant K8s cluster, other pods could access Canton's admin API.

**Recommendation:** Add Kubernetes NetworkPolicies restricting Canton admin API access to authorized pods only.

---

### INFRA-MEDIUM-03: Missing Pod Security Standards

**Severity:** MEDIUM
**Location:** `k8s/`
**Category:** Container Security

Pod specifications don't enforce `runAsNonRoot`, `readOnlyRootFilesystem`, or drop `ALL` capabilities. Containers running as root with writable filesystems increase the blast radius of container escapes.

**Recommendation:** Apply restricted Pod Security Standards to all production namespaces.

---

### INFRA-LOW-01: PostgreSQL Backup Strategy Not Defined

**Severity:** LOW
**Location:** `k8s/`
**Category:** Data Protection

No backup CronJob or WAL archiving configuration visible for the PostgreSQL instance. Canton ledger data and relay state could be lost.

**Recommendation:** Configure automated backups with retention policy.

---

### INFRA-LOW-02: NGINX Ingress Missing Security Headers

**Severity:** LOW
**Location:** `k8s/`
**Category:** Web Security

NGINX configuration doesn't include security headers (HSTS, X-Frame-Options, CSP, X-Content-Type-Options) for the frontend.

**Recommendation:** Add standard security headers via NGINX annotations or ConfigMap.

---

### INFRA-INFO-01: Monitoring Stack Incomplete

**Severity:** INFORMATIONAL

K8s manifests reference monitoring but don't include complete Prometheus/Grafana setup. Alerting rules for bridge health, validator availability, and liquidation bot status should be defined.

---

## Test Coverage Findings

### TEST-MEDIUM-01: No Fuzz Tests for YieldBasisStrategy or MetaVault

**Severity:** MEDIUM
**Category:** Testing Gaps

While MorphoLoopStrategy and AaveV3LoopStrategy have Foundry fuzz tests, the newer YieldBasisStrategy and MetaVault lack fuzz testing. Given that these contracts have the most findings in this audit, they need the most testing.

**Recommendation:** Add Foundry fuzz tests covering swap slippage edge cases, LT deposit/withdrawal, and rebalancing.

---

### TEST-MEDIUM-02: Missing Cross-Chain Integration Tests

**Severity:** MEDIUM
**Category:** Testing Gaps

No end-to-end tests cover the full Canton → relay → BLEBridge → MUSD mint flow. Individual components are tested in isolation, but integration failures (e.g., attestation format mismatches, nonce desynchronization) would not be caught.

**Recommendation:** Create integration test environment with Canton sandbox, relay mock, and Hardhat fork.

---

### TEST-LOW-01: Invariant Tests Don't Cover Multi-Strategy Interactions

**Severity:** LOW
**Category:** Testing Gaps

Foundry invariant tests focus on individual strategy contracts but don't test MetaVault + sub-strategy interactions, TreasuryV2 rebalancing across strategies, or concurrent deposits/withdrawals across strategies.

**Recommendation:** Add multi-contract invariant tests.

---

### TEST-LOW-02: No Upgrade Safety Tests

**Severity:** LOW
**Category:** Testing Gaps

No tests verify storage layout compatibility between contract versions. UUPS upgrades that change storage layout would corrupt state.

**Recommendation:** Use OpenZeppelin Upgrades plugin's `validateUpgrade()` in CI.

---

### TEST-LOW-03: Emergency Flow Test Coverage Sparse

**Severity:** LOW
**Category:** Testing Gaps

Emergency functions (`emergencyWithdraw`, `withdrawAll` with fallback, `emergencyWithdraw` on LevAMM) have minimal test coverage. These are the most critical paths during incidents.

**Recommendation:** Add comprehensive emergency flow tests including reverts, partial withdrawals, and concurrent pause scenarios.

---

### TEST-INFO-01: Coverage Threshold Configuration

**Severity:** INFORMATIONAL

CLAUDE.md states 90% coverage enforced, but the Hardhat coverage configuration should be verified to actually enforce this threshold in CI. Confirm `solidity-coverage` is configured with `istanbul` reporter and threshold checks.

---

## Cross-Cutting Concerns

### CROSS-HIGH-01: No Unified Emergency Shutdown Mechanism

**Severity:** HIGH
**Category:** Operational Security

The protocol has per-contract pause functionality but no coordinated emergency shutdown. If an exploit affects multiple contracts (e.g., a bridge compromise that requires pausing MUSD, SMUSD, all strategies, and the relay simultaneously), each must be paused individually by different role holders. The `GlobalPauseRegistry.sol` exists as an empty placeholder.

**Recommendation:** Implement the GlobalPauseRegistry to allow a single guardian action to pause all protocol contracts atomically. This is especially critical for a cross-chain protocol where timing matters.

---

### CROSS-MEDIUM-01: Dependency Supply Chain Risk

**Severity:** MEDIUM
**Category:** Supply Chain Security

The protocol depends on:
- OpenZeppelin Contracts v5 (Solidity) — well-audited
- Morpho, Aave, Compound, Curve, Uniswap interfaces (Solidity) — varying audit quality
- Multiple npm packages (TypeScript) — `npm audit` in CI helps but doesn't cover all risks
- DAML SDK (Canton) — enterprise-grade but relatively new ecosystem

No lock file verification or SBOM generation visible in CI pipeline.

**Recommendation:** Generate SBOM, pin all dependency versions, verify lock file integrity in CI, and consider vendoring critical Solidity interfaces.

---

### CROSS-MEDIUM-02: Cross-Chain Failure Mode Documentation

**Severity:** MEDIUM
**Category:** Operational Readiness

No runbook or documented failure modes for cross-chain scenarios:
- What happens if Canton is down but Ethereum is up?
- What happens if the relay loses connectivity to both chains?
- What happens if attestation validators disagree?
- What happens if SMUSD share sync gets stale?

**Recommendation:** Create operational runbook covering all cross-chain failure scenarios with remediation steps.

---

### CROSS-LOW-01: Audit Trail Gaps

**Severity:** LOW
**Category:** Compliance

The protocol emits events for most operations but some sensitive admin actions (role grants, parameter changes) rely on OpenZeppelin's default events which may not provide sufficient context for institutional compliance audit trails.

**Recommendation:** Emit custom events with full context for all admin operations.

---

## Positive Security Observations

The following security measures are well-implemented:

1. **Per-operation approvals (SOL-C-02)** — Most contracts clear approvals after each use via `forceApprove()`, preventing standing allowances
2. **TIMELOCK_ROLE self-administration (SOL-C-01)** — BLEBridgeV9 and strategy contracts use `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` to prevent DEFAULT_ADMIN from granting/revoking
3. **Cross-chain share sync rate limiting** — SMUSD implements MIN_SYNC_INTERVAL (1 hour), MAX_SHARE_CHANGE_BPS (5%), and initial share caps
4. **Bridge attestation security** — BLEBridgeV9 implements entropy requirements, state hash binding, attestation ID verification, timestamp gap checks, age limits, sorted signature verification, and 24-hour rate limiting on supply cap increases
5. **CEI pattern compliance** — All contracts follow Checks-Effects-Interactions with ReentrancyGuard
6. **24-hour withdrawal cooldown** — SMUSD enforces cooldowns with propagation through transfers
7. **Interest routing caps** — Both SMUSD variants cap interest at 10% of global total assets
8. **ERC-4626 compliance** — SMUSD correctly returns 0 from `maxDeposit`/`maxWithdraw` when paused
9. **Donation attack mitigation** — `_decimalsOffset() = 3` increases initial share price precision
10. **Profitability gates** — Loop strategies check profitability before executing leverage
11. **DAML propose-accept pattern** — Multi-party workflows require explicit acceptance
12. **3-of-5 multi-sig bridge** — No single validator can produce valid attestations
13. **CI security scanning** — Slither, Mythril, Trivy, and npm audit in pipeline

---

## Recommendations Summary

### Immediate (Pre-deployment)

| Priority | Finding | Action |
|---|---|---|
| P0 | SOL-CRITICAL-01, SOL-CRITICAL-02 | Add slippage protection to all swaps |
| P0 | SOL-HIGH-01, SOL-HIGH-02 | Standardize `onlyTimelock` for `unpause()`, `recoverToken()`, `_authorizeUpgrade()` |
| P0 | SOL-HIGH-03 | Replace MetaVault unlimited approvals with per-operation pattern |
| P0 | SOL-HIGH-04 | Implement actual reentrancy check in `checkNonreentrant()` |
| P0 | SOL-HIGH-05, SOL-HIGH-06 | Add timelock to MUSD and SMUSD `unpause()` |
| P0 | INFRA-HIGH-01 | Enable K8s secrets encryption at rest |
| P0 | CROSS-HIGH-01 | Implement GlobalPauseRegistry |

### Short-term (Before Mainnet)

| Priority | Finding | Action |
|---|---|---|
| P1 | All MEDIUM findings | Fix access control inconsistencies and slippage protections |
| P1 | DAML-HIGH-01 | Audit all signatory/observer declarations |
| P1 | TS-HIGH-01, TS-HIGH-02 | Add relay replay protection and config validation |
| P1 | TEST-MEDIUM-01, TEST-MEDIUM-02 | Add fuzz tests and integration tests |
| P1 | INFRA-MEDIUM-01 through MEDIUM-03 | Pin images, add NetworkPolicies, enforce Pod Security |

### Long-term (Operational)

| Priority | Finding | Action |
|---|---|---|
| P2 | All LOW and INFO findings | Remediate per finding |
| P2 | CROSS-MEDIUM-02 | Create operational runbook for cross-chain failure modes |
| P2 | CROSS-MEDIUM-01 | Generate SBOM and verify lock files in CI |
| P2 | SOL-MEDIUM-08 | Add monitoring for local/global share price divergence |
| P2 | SOL-INFO-02 | Remove or implement placeholder contracts |

---

*Report generated by 6 parallel domain-specialist audit agents. For questions or remediation guidance, refer to individual finding IDs.*
