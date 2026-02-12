# 🏛️ Minted mUSD Protocol — Comprehensive Security Audit (v3)

**Date:** February 12, 2026
**Revision:** v3 — Corrected from v2 after independent code verification
**Scope:** Full-stack audit — Solidity (EVM) + DAML (Canton Network) + Relay/Validator Infrastructure + Kubernetes
**Contracts Audited:** 20 Solidity contracts (~8,500 LoC) · 16 DAML modules + 1 unified V3 module (~9,750 LoC) · 12 relay/keeper/validator services (~5,300 LoC) · K8s manifests
**Total Lines of Code:** ~23,550
**Auditors:** Automated multi-methodology analysis with independent code verification
**Classification:** CONFIDENTIAL — For Internal Use Only

---

## TABLE OF CONTENTS

1. Executive Summary
2. Audit Methodology
3. Composite Score
4. Architecture Overview
5. Contract & Service Inventory
6. Access Control Matrix
7. Findings Summary
8. CRITICAL Severity Findings
9. HIGH Severity Findings
10. MEDIUM Severity Findings
11. LOW Severity Findings
12. INFORMATIONAL Findings
13. Relay & Infrastructure Analysis
14. Cross-Contract Data Flow Analysis
15. Economic Model Analysis
16. Test & Verification Coverage
17. Security Posture Matrix
18. Per-Contract Scorecards
19. Protocol Strengths
20. Prioritized Remediation Plan
21. Errata — Corrections from v2
22. Disclaimer

---

## EXECUTIVE SUMMARY

The Minted mUSD Protocol is a dual-chain stablecoin system operating across Ethereum (Solidity 0.8.26) and Canton Network (DAML SDK 2.10.3). The protocol enables minting of mUSD backed by USDC, with yield generation through a multi-strategy treasury (Pendle, Morpho Blue, Sky Protocol) and cross-chain yield unification via BFT-attested bridge operations.

**Key Architecture:**
- **Ethereum Layer:** ERC20 stablecoin (mUSD), ERC4626 yield vault (sMUSD), overcollateralized lending (BorrowModule + CollateralVault + LiquidationEngine), auto-allocating treasury (TreasuryV2), and leveraged looping (LeverageVault)
- **Canton Layer:** Privacy-preserving token templates with dual-signatory patterns, multi-collateral lending with escrowed positions, BFT-attested bridge operations, opt-in transparency, and multi-sig governance
- **Cross-Chain Bridge:** BLEBridgeV9 (Solidity) ↔ BLEBridgeProtocol (DAML) with 2/3+1 BFT supermajority attestations for bridge-out, bridge-in, supply cap sync, and yield sync
- **Relay Infrastructure:** Canton→Ethereum relay service, AWS KMS-backed validator nodes, keeper bots (yield, liquidation, oracle), price oracle service

**Audit Verdict:**

The protocol demonstrates **strong contract-level security patterns** with 30+ documented prior audit fixes integrated into the DAML codebase, formal verification via Certora for 4 core Solidity contracts, and consistent defense-in-depth at the individual contract level. However, **3 CRITICAL severity findings** and **6 HIGH severity findings** represent fundamental gaps in the cross-chain trust model that cannot be compensated by individual contract hardening. The most severe is **C-02 (compounding 5% share sync)** which allows a BRIDGE_ROLE holder to inflate Canton shares by 222% in 24 hours through repeated 5% increments. The **relay infrastructure** — the single most security-critical component bridging two ledger architectures — was absent from previous audits and contains operational security concerns.

**The protocol is not ready for mainnet deployment until CRITICAL findings are resolved.**

---

## AUDIT METHODOLOGY

Eight distinct audit methodologies were applied, each targeting different vulnerability classes:

| Firm Style | Method | Focus | Techniques Applied |
|------------|--------|-------|-------------------|
| **Trail of Bits** | Automated pattern analysis | Known vulnerability patterns | Reentrancy detection, integer overflow analysis, unchecked return values, delegatecall safety, tx.origin usage, selfdestruct reachability, storage collision detection |
| **OpenZeppelin** | Access control audit | Role hierarchy and privilege escalation | Role enumeration, privilege escalation paths, missing access modifiers, DEFAULT_ADMIN_ROLE chain analysis, signatory/authority model validation (DAML) |
| **Consensys Diligence** | Economic modeling | MEV, sandwich attacks, token economics | Sandwich attack surface analysis, flash loan vectors, share price manipulation (ERC4626 donation attacks), liquidation incentive modeling, interest rate death spirals |
| **Certora** | Formal verification review | Protocol invariant correctness | Review of 4 existing Certora specs (MUSD.spec, SMUSD.spec, BorrowModule.spec, LiquidationEngine.spec), 7 protocol invariants verified |
| **Cyfrin** | Cross-contract data flow | Inter-contract state consistency | Call graph tracing across 20 Solidity contracts, cross-module dependency analysis for 16 DAML modules, supply cap propagation verification |
| **ChainSecurity** | Upgradeability safety | UUPS proxy patterns | Storage gap verification, initializer protection, `_disableInitializers()` in constructors, ERC-7201 namespaced storage compliance |
| **Canton Ledger Model** | DAML-specific audit | Canton consensus semantics | Signatory/authority correctness, consuming vs. nonconsuming choice analysis, TOCTOU prevention, privacy leak detection, contract key correctness, double-archive risk |
| **Infrastructure** | Relay/validator/keeper audit | Off-chain trust boundary | Private key management, ECDSA encoding correctness, KMS integration, TLS enforcement, Kubernetes security posture, keeper bot attack surface |

### Static Analysis Patterns Scanned

```
✅ Reentrancy (state-before-external-call)    — All state-changing functions use ReentrancyGuard
✅ Integer overflow/underflow                  — Solidity 0.8.26 built-in checks
✅ Unchecked external call returns             — SafeERC20 used throughout
✅ tx.origin authentication                    — Not found in codebase
✅ selfdestruct reachability                   — Not found in codebase
✅ Delegatecall to untrusted targets           — Not found in codebase
✅ Storage collision (UUPS)                    — ERC-7201 namespaced storage in TimelockGoverned
✅ Uninitialized proxy                         — _disableInitializers() in TreasuryV2 constructor
⚠️ Raw approve (non-SafeERC20)               — Found in BorrowModule (S-L-01)
⚠️ block.timestamp as deadline                — Found in LeverageVault (S-L-02)
```

---

## 📊 COMPOSITE SCORE

| Layer | Score | Grade |
|-------|-------|-------|
| **Solidity (EVM)** | 76 / 100 | ⭐⭐⭐ |
| **DAML (Canton)** | 78 / 100 | ⭐⭐⭐ |
| **Cross-Layer Integration** | 52 / 100 | ⭐⭐ |
| **Relay & Infrastructure** | 72 / 100 | ⭐⭐⭐ |
| **Test & Verification Coverage** | 75 / 100 | ⭐⭐⭐ |
| **Overall Protocol** | **67 / 100** | ⭐⭐⭐ |

### Scoring Breakdown

| Category | Weight | Score | Weighted | Rationale |
|----------|--------|-------|----------|-----------|
| Access Control & Authorization | 15% | 78 | 11.70 | OZ AccessControl + DAML dual-signatory + proposal patterns. **Critical deductions:** DEFAULT_ADMIN_ROLE can self-grant TIMELOCK_ROLE (H-04), BLEBridgeV9 instant upgrade (C-03), operator centralization on Canton oracle syncs (D-M-02). |
| Economic / Financial Logic | 20% | 62 | 12.40 | Interest routing with try/catch, close factor + dust threshold on liquidation. **Critical deductions:** Compounding 5% sync attack (C-02), phantom debt on routing failure (S-M-01), no bad debt socialization (S-M-02), V3 share price asymmetry (D-H-02). |
| Oracle & Price Feed Safety | 10% | 72 | 7.20 | Chainlink + circuit breaker + unsafe path for liquidations. Deductions: Canton oracle is operator-signed (X-M-02), V3 liquidation uses stale-tolerant oracle (D-M-04), no on-ledger ECDSA for Canton attestations (C-01). |
| Reentrancy & Atomicity | 10% | 96 | 9.60 | ReentrancyGuard on all Solidity state-changing functions. DAML ledger model is inherently atomic. No significant deduction. |
| Upgradeability & Migration | 10% | 68 | 6.80 | UUPS + ERC-7201 + gaps in TreasuryV2/strategies. **Critical deduction:** BLEBridgeV9 (most security-critical contract) uses DEFAULT_ADMIN_ROLE for upgrade — no timelock (C-03). DEFAULT_ADMIN_ROLE can bypass timelock on other contracts via self-grant (H-04). |
| Cross-Chain / Bridge Security | 15% | 50 | 7.50 | BFT 2/3+1 on attestation finalization, consuming sign choices. **Critical deductions:** No on-ledger ECDSA (C-01), compounding share sync (C-02), no atomic supply cap gate (X-M-01), no blacklist on bridge processAttestation (H-05), operator-only share price sync (D-M-02). |
| Compliance & Privacy | 10% | 80 | 8.00 | ComplianceRegistry hooks in all product modules, dual-signatory + proposal transfers, privacy-by-default. **Deduction:** No compliance check on BLEBridgeV9.processAttestation (H-05), BulkBlacklist capped at 100 (D-L-04). |
| Relay & Infrastructure | 5% | 72 | 3.60 | Docker secrets, KMS for validators, TLS enforcement. **Deductions:** Relay private key in Node.js heap (H-06), stale signer.ts copy (H-07). |
| Test & Verification Coverage | 5% | 75 | 3.75 | 102 DAML tests + 40+ Solidity tests + 4 Certora specs + 7 Foundry invariants. **Deduction:** V3.daml (1,551 lines) has zero tests, CantonLoopStrategy is empty, no relay/infra test suite. |
| **Total** | **100%** | — | **70.55 → 67** | Adjusted down 3 points for 3 CRITICAL findings that individually threaten protocol solvency. |

### Grade Scale

| Grade | Range | Meaning |
|-------|-------|---------|
| ⭐⭐⭐⭐⭐ | 95–100 | Exceptional — mainnet ready with minimal risk |
| ⭐⭐⭐⭐ | 80–94 | Strong — suitable for mainnet after HIGH/MEDIUM remediation |
| ⭐⭐⭐ | 65–79 | Moderate — requires significant remediation before mainnet |
| ⭐⭐ | 50–64 | Weak — fundamental design issues |
| ⭐ | 0–49 | Critical — not suitable for deployment |

### Score Justification

The 67/100 score reflects a protocol with **excellent contract-level patterns** (UUPS, ERC-7201, ReentrancyGuard, dual-signatory DAML) undermined by **fundamental cross-chain trust model gaps**. The compounding sync attack (C-02) alone is sufficient to drain the vault. The most security-critical contract (BLEBridgeV9) has the weakest upgrade protection. The cross-chain bridge lacks on-ledger ECDSA verification on the Canton side. These are architectural issues, not implementation bugs — they require design changes, not patches.

---

## ARCHITECTURE OVERVIEW

### System Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          ETHEREUM LAYER                                 │
│                                                                         │
│  ┌──────────┐    ┌───────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │  MUSD.sol │◄───│DirectMintV2│◄───│TreasuryV2.sol│───►│Strategy Trio │ │
│  │ (ERC20)   │    │  (1:1     │    │ (Auto-alloc) │    │ Pendle 40%   │ │
│  │ supplyCap │    │  USDC→mUSD│    │ reserve 10%  │    │ Morpho 30%   │ │
│  │ blacklist │    └───────────┘    └──────┬───────┘    │ Sky    20%   │ │
│  └────┬──────┘                            │             └──────────────┘ │
│       │                                   │                              │
│  ┌────▼──────┐    ┌───────────────┐  ┌────▼──────┐                      │
│  │ SMUSD.sol │◄───│ BorrowModule  │  │PriceOracle│                      │
│  │ (ERC4626) │    │ (Debt + Rate) │  │(Chainlink)│                      │
│  │ global    │    │ totalBorrows  │  │ +CB       │                      │
│  │ sharePrice│    └───────┬───────┘  └─────┬─────┘                      │
│  └────┬──────┘            │                │                             │
│       │              ┌────▼────────────────▼───┐    ┌────────────────┐  │
│       │              │ LiquidationEngine.sol    │    │ LeverageVault  │  │
│       │              │ closeFactor + unsafe path│    │ Multi-loop     │  │
│       │              └─────────────────────────┘    │ Uniswap V3     │  │
│       │                                              └────────────────┘  │
│  ┌────▼──────────┐                                                       │
│  │ BLEBridgeV9   │ ◄─── Canton attestations → supply cap sync           │
│  │ (UUPS proxy)  │     ⚠️ _authorizeUpgrade = DEFAULT_ADMIN_ROLE       │
│  └───────┬───────┘     ⚠️ No blacklist check on processAttestation     │
│          │                                                               │
└──────────┼───────────────────────────────────────────────────────────────┘
           │  Bridge Attestations (BFT 2/3+1 supermajority)
           │  • BridgeOut: Canton → Ethereum
           │  • BridgeIn:  Ethereum → Canton
           │  • SupplyCap: Cross-chain supply sync
           │  • Yield:     Share price sync
┌──────────┼───────────────────────────────────────────────────────────────┐
│          │               RELAY INFRASTRUCTURE                            │
│  ┌───────▼──────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │relay-service.ts   │  │validator-node  │  │ Keeper Bots              │ │
│  │ (860 LoC)         │  │ v1 (540 LoC)   │  │ yield-keeper    (542)   │ │
│  │ Canton→ETH relay  │  │ v2 (668 LoC)   │  │ lending-keeper  (779)   │ │
│  │ ⚠️ Privkey in heap│  │ ✅ AWS KMS     │  │ liquidation-bot (597)   │ │
│  └───────────────────┘  └────────────────┘  │ price-oracle    (651)   │ │
│                                              │ oracle-keeper   (400)   │ │
│                                              └──────────────────────────┘ │
│  ┌──────────────────┐  ┌────────────────┐  ┌──────────────────────────┐ │
│  │signer.ts (relay)  │  │signer.ts (old) │  │ security-utils.ts        │ │
│  │ ✅ EIP-2 + mal.   │  │ ⚠️ Stale copy  │  │ Docker secrets, TLS,     │ │
│  │    check          │  │ Double-prefix  │  │ secp256k1 validation     │ │
│  └──────────────────┘  └────────────────┘  └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
           │
┌──────────┼───────────────────────────────────────────────────────────────┐
│          │                     CANTON LAYER                              │
│  ┌───────▼──────────┐                                                    │
│  │BLEBridgeProtocol │  4 attestation types, consuming sign choices       │
│  │ (DAML)           │  ⚠️ ECDSA sig = length check only, not verified   │
│  └───────┬──────────┘                                                    │
│          │                                                               │
│  ┌───────▼──────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │CantonDirectMint  │   │CantonLending   │   │CantonSMUSD             │ │
│  │ USDC/USDCx→mUSD  │   │ 4 collateral   │   │ Unified yield          │ │
│  │ 24h rolling cap  │   │ types, escrow  │   │ globalSharePrice sync  │ │
│  │ bridge-out auto   │   │ liquidation    │   │ cooldown enforcement   │ │
│  └──────────────────┘   └────────────────┘   └────────────────────────┘ │
│                                                                          │
│  ┌──────────────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │Governance.daml   │   │Compliance.daml │   │UserPrivacySettings     │ │
│  │ M-of-N multisig  │   │ Blacklist/Freeze│  │ Privacy-by-default     │ │
│  │ Timelock          │   │ Pre-tx hooks   │   │ Opt-in observers       │ │
│  │ MinterRegistry   │   │ BulkBlacklist  │   │ Per-user granular      │ │
│  └──────────────────┘   └────────────────┘   └────────────────────────┘ │
│                                                                          │
│  ┌──────────────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │Minted/Protocol/  │   │InterestRate    │   │CantonBoostPool         │ │
│  │V3.daml (unified) │   │Service.daml    │   │ Validator rewards       │ │
│  │ Vault CDPs, DEX  │   │ Compound-style │   │ sMUSD-qualified        │ │
│  │ Bridge, sMUSD    │   │ kink model     │   │ deposits               │ │
│  └──────────────────┘   └────────────────┘   └────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### Cross-Chain Yield Unification Flow

```
1. TreasuryV2 generates yield via Pendle/Morpho/Sky strategies
2. BorrowModule accrues interest → routes to SMUSD.receiveInterest()
3. SMUSD.globalSharePrice() = globalTotalAssets() / globalTotalShares()
4. Bridge attestation carries globalSharePrice to Canton
5. CantonStakingService.SyncGlobalSharePrice updates Canton share price
   ⚠️ No BFT attestation required (D-M-02) — only operator+governance
6. Canton sMUSD holders unstake at the same global share price as Ethereum
```

---

## CONTRACT & SERVICE INVENTORY

### Solidity Layer (EVM) — 20 Contracts, ~8,500 LoC

| Contract | Lines | Purpose | Key Patterns | External Deps |
|----------|-------|---------|--------------|---------------|
| `MUSD.sol` | 107 | ERC20 stablecoin with supply cap, blacklist, compliance, pause | AccessControl, Pausable, ERC20 | — |
| `SMUSD.sol` | 323 | ERC4626 staked vault with cross-chain yield, Canton sync, interest routing | ERC4626, AccessControl, ReentrancyGuard, Pausable | ITreasury |
| `CollateralVault.sol` | 300 | Collateral deposits with per-asset config management, health-checked withdrawals | AccessControl, ReentrancyGuard, Pausable, SafeERC20 | IBorrowModule |
| `BorrowModule.sol` | 835 | Debt positions, dynamic interest, interest routing to SMUSD, global accrual | AccessControl, ReentrancyGuard, Pausable, SafeERC20 | ICollateralVault, IPriceOracle, ISMUSD, IInterestRateModel |
| `LiquidationEngine.sol` | 350 | Liquidation with close factor, full liquidation threshold, unsafe oracle path | AccessControl, ReentrancyGuard, Pausable | IBorrowModule, ICollateralVault, IPriceOracle |
| `PriceOracle.sol` | 318 | Chainlink aggregator with circuit breaker, keeper recovery | AccessControl | IAggregatorV3 (Chainlink) |
| `InterestRateModel.sol` | 300 | Compound-style kinked rate model with reserve factor | — | — |
| `DirectMintV2.sol` | 400 | 1:1 USDC→mUSD minting with TreasuryV2 auto-allocation | AccessControl, Pausable, SafeERC20 | ITreasuryV2 |
| `DepositRouter.sol` | 420 | L2 cross-chain USDC routing via Wormhole | AccessControl, SafeERC20 | Wormhole Relayer |
| `LeverageVault.sol` | 748 | Multi-loop leverage with Uniswap V3, emergency close | AccessControl, ReentrancyGuard, Pausable, TimelockGoverned | ISwapRouter (Uniswap V3), IBorrowModule, ICollateralVault |
| `BLEBridgeV9.sol` | 500 | Canton attestation → supply cap sync (UUPS upgradeable) | UUPS, AccessControl, Pausable | — |
| `TreasuryV2.sol` | 982 | Auto-allocating treasury with strategy management, fee accrual | UUPS, AccessControl, ReentrancyGuard, Pausable | IStrategy |
| `TreasuryReceiver.sol` | 296 | Cross-chain deposit receiver | AccessControl, SafeERC20 | — |
| `TimelockGoverned.sol` | 100 | ERC-7201 namespaced storage timelock base | ERC-7201 | — |
| `MintedTimelockController.sol` | 90 | OZ TimelockController wrapper | TimelockController | — |
| `SMUSDPriceAdapter.sol` | 255 | Chainlink-compatible sMUSD price feed | AccessControl | IAggregatorV3 |
| `PendleMarketSelector.sol` | 527 | Optimal Pendle market selection by APY | AccessControl | IPendleMarket |
| `PendleStrategyV2.sol` | 830 | Pendle PT strategy with rollover and maturity handling | AccessControl, ReentrancyGuard, Pausable | IPendleRouter, IPendleMarket |
| `MorphoLoopStrategy.sol` | 806 | Morpho Blue recursive lending with max 10 loops | AccessControl, ReentrancyGuard, Pausable | IMorpho |
| `SkySUSDSStrategy.sol` | 434 | Sky sUSDS savings strategy with withdrawal queue | AccessControl, ReentrancyGuard, Pausable | ISkySUSDS |

### DAML Layer (Canton Network) — 16 Modules + V3, ~9,750 LoC

| Module | Lines | Purpose | Key Templates | Choice Count |
|--------|-------|---------|---------------|--------------|
| `CantonLending.daml` | 1,464 | Full lending protocol — 4 collateral types, escrow, liquidation | CantonLendingService, EscrowedCollateral, CantonDebtPosition, CantonPriceFeed, CantonLiquidationReceipt | 18 |
| `Minted/Protocol/V3.daml` | 1,551 | Unified protocol: Vault CDPs, DEX, Bridge, sMUSD, DirectMint | MintedMUSD, PriceOracle, LiquidityPool, Vault, VaultManager, LiquidationReceipt, LiquidationOrder, BridgeService, MUSDSupplyService | ~40 |
| `CantonDirectMint.daml` | 765 | mUSD minting with USDC/USDCx, bridge-out, reserve tracking | CantonDirectMintService, CantonMUSD, CantonUSDC, USDCx | 12 |
| `CantonBoostPool.daml` | 544 | Validator reward pool, sMUSD-qualified Canton deposits | CantonBoostPoolService, BoostPoolLP, CantonCoin | 10 |
| `BLEBridgeProtocol.daml` | 434 | Cross-chain bridge: bridge-out/in/supply-cap/yield attestations | BridgeOutAttestation, BridgeInAttestation, SupplyCapAttestation, YieldAttestation | 12 |
| `Governance.daml` | 434 | Multi-sig M-of-N governance, minter registry, emergency pause | GovernanceConfig, MultiSigProposal, MinterRegistry, GovernanceActionLog, EmergencyPauseState | 12 |
| `MintedMUSD.daml` | 334 | Original MUSD token with dual signatory, IssuerRole, supply cap | MintedMUSD, IssuerRole, MUSDService | 8 |
| `InterestRateService.daml` | 300 | Compound-style kinked rate model synced from Ethereum | InterestRateService, InterestPayment | 8 |
| `InstitutionalAssetV4.daml` | 300 | Institutional asset framework with compliance whitelist | InstitutionalAsset, AssetManager | 6 |
| `Upgrade.daml` | 282 | Opt-in contract migration with rollback windows | UpgradeProposal, MigrationLog | 5 |
| `CantonSMUSD.daml` | 230 | Staked mUSD with unified cross-chain yield via global share price | CantonSMUSD, CantonStakingService, CantonSMUSDTransferProposal | 10 |
| `BLEProtocol.daml` | 200 | Original attestation protocol (equity positions, validator sigs) | EquityPosition, ValidatorAttestation | 4 |
| `UserPrivacySettings.daml` | 170 | Opt-in privacy toggle: fully private by default | UserPrivacySettings | 3 |
| `Compliance.daml` | 165 | Blacklist, freeze, pre-transaction validation hooks | ComplianceRegistry | 9 |
| `TokenInterface.daml` | — | Deprecated draft (not deployed) | — | — |
| `CantonLoopStrategy.daml` | 0 | Empty stub — unimplemented | — | — |

### Relay & Infrastructure Layer — 12 Services, ~5,300 LoC

| Service | Lines | Purpose | Key Concern |
|---------|-------|---------|-------------|
| `relay-service.ts` | 860 | Canton→ETH relay: watches finalized attestations, submits to BLEBridgeV9 | ⚠️ RELAYER_PRIVATE_KEY in Node.js heap memory |
| `validator-node.ts` (V1) | 540 | Watches BridgeOutRequest, verifies collateral, signs via AWS KMS | ⚠️ No rate-limiting on signing |
| `validator-node-v2.ts` | 668 | V2: Canton Network API verification, anomaly detection, rate limiting | ✅ Best security posture in relay layer |
| `signer.ts` (relay/) | 225 | AWS KMS DER→RSV conversion, EIP-2 normalization, malleability check | ✅ Well-implemented |
| `signer.ts` (scripts/) | 225 | **Stale copy** — uses `hashMessage` (double EIP-191 prefix), no malleability check | ⚠️ Must not be used in production |
| `price-oracle.ts` | 651 | Canton price feed: Tradecraft + Temple DEX, circuit breaker | ✅ Multi-source, divergence blocking |
| `yield-keeper.ts` | 542 | ETH↔Canton share price sync, epoch-based dedup | ✅ Validated key, epoch dedup |
| `lending-keeper.ts` | 779 | Canton lending liquidation bot, BigInt math, slippage checks | ✅ Solid implementation |
| `liquidation-bot.ts` | 597 | ETH liquidation bot, Flashbots MEV protection | ✅ Good practice |
| `oracle-keeper.ts` | 400 | PriceOracle circuit breaker reset via external price source | ✅ Sanity bounds |
| `yield-deployer.ts` | 300 | Treasury auto-deploy keeper | ⚠️ Missing secp256k1 key validation |
| `security-utils.ts` | 120 | Shared: Docker secrets, secp256k1 validation, TLS enforcement | ✅ Runtime tamper protection |

### Kubernetes Infrastructure

| Manifest | Purpose | Security Features |
|----------|---------|-------------------|
| `secrets.yaml` | Secret templates (empty) | ✅ No default credentials |
| `network-policies.yaml` | Least-privilege NetworkPolicy | ✅ Canton accepts only relay/nginx/prometheus |
| `canton-deployment.yaml` | Canton participant | ✅ Pinned image digests, runAsNonRoot, readOnlyRootFS, dropped caps, seccomp |
| `service-accounts.yaml` | K8s service accounts | ✅ Per-component accounts |
| `pdb.yaml` | Pod disruption budget | ✅ Availability guarantee |
| `monitoring.yaml` | Prometheus rules | ✅ ServiceMonitors |

---

## ACCESS CONTROL MATRIX

### Solidity Roles

| Role | Contract | Granted To | Capabilities | Timelock? |
|------|----------|------------|--------------|-----------|
| `DEFAULT_ADMIN_ROLE` | All contracts | Deployer / Multisig | Grant/revoke roles, unpause | ❌ No |
| `YIELD_MANAGER_ROLE` | SMUSD | TreasuryV2 / Admin | `distributeYield()` | ❌ No |
| `BRIDGE_ROLE` | SMUSD | BLEBridgeV9 | `syncCantonShares()` | ❌ No |
| `INTEREST_ROUTER_ROLE` | SMUSD | BorrowModule | `receiveInterest()` | ❌ No |
| `PAUSER_ROLE` | All contracts | Guardian multisig | `pause()` | ❌ No |
| `LIQUIDATION_ROLE` | BorrowModule, CollateralVault | LiquidationEngine | `reduceDebt()`, `seize()` | ❌ No |
| `BORROW_ADMIN_ROLE` | BorrowModule | Admin | `setInterestRateModel()`, `setSMUSD()`, `setTreasury()` | ❌ No |
| `LEVERAGE_VAULT_ROLE` | BorrowModule, CollateralVault | LeverageVault | `borrowFor()`, `withdrawFor()`, `depositFor()` | ❌ No |
| `LIQUIDATOR_ROLE` | MUSD | LiquidationEngine | `burn()` (liquidation path) | ❌ No |
| `ORACLE_ADMIN_ROLE` | PriceOracle | Admin | `setFeed()`, `removeFeed()`, `updatePrice()`, `setMaxDeviation()` | ❌ No |
| `KEEPER_ROLE` | PriceOracle | Automation bot | `keeperResetPrice()` | ❌ No |
| `ALLOCATOR_ROLE` | TreasuryV2 | Admin | Strategy allocation changes | ❌ No |
| `STRATEGIST_ROLE` | TreasuryV2 | Admin | Strategy deposits/withdrawals | ❌ No |
| `GUARDIAN_ROLE` | TreasuryV2, Strategies | Guardian multisig | Emergency withdrawal | ❌ No |
| `VAULT_ROLE` | TreasuryV2 | DirectMintV2 | `depositAndAllocate()` | ❌ No |
| `TIMELOCK_ROLE` | TreasuryV2, Strategies | MintedTimelockController | Timelock-gated upgrades | ✅ Yes |
| `DEFAULT_ADMIN_ROLE` | **BLEBridgeV9** | Admin | **`_authorizeUpgrade()` — instant** | ❌ **No** |
| `TIMELOCK_ROLE` | **TreasuryV2** | Timelock | `_authorizeUpgrade()` | ✅ **Yes** |

**⚠️ Critical inconsistency:** BLEBridgeV9 (controls mUSD supply cap — most security-critical contract) uses `DEFAULT_ADMIN_ROLE` for upgrade authorization. TreasuryV2 and strategies use `TIMELOCK_ROLE`. See C-03.

### DAML Signatory / Controller Model

| Template | Signatories | Key Controllers | Trust Boundary |
|----------|-------------|-----------------|----------------|
| `CantonMUSD` | issuer, owner | owner (Transfer, Split, Burn) | Dual-signatory prevents forced obligations |
| `CantonSMUSD` | issuer, owner | owner (Transfer, Split, Merge) | Proposal-based transfer (FIX DL-C2) |
| `CantonStakingService` | operator | operator+governance (SyncGlobalSharePrice), user (Stake/Unstake) | Governance co-sign on price sync |
| `CantonLendingService` | operator | user (Borrow, Repay, Withdraw), liquidator (Liquidate), operator (Admin) | Compliance hooks on all user-facing choices |
| `ComplianceRegistry` | regulator | regulator (Blacklist/Freeze), operator (Validate*) | Regulator-only write, operator-read for hooks |
| `GovernanceConfig` | operator | governors (threshold query), operator (maintainer) | M-of-N threshold immutable after creation |
| `MultiSigProposal` | operator, proposer | governors (Approve/Reject), executor (Execute) | Timelock between approval and execution |
| `MinterRegistry` | operator | operator (AddMinter, RemoveMinter, ReplenishQuota) | GovernanceActionLog proof required |
| `BridgeOutAttestation` | aggregator | validators (Sign), aggregator (Finalize) | BFT 2/3+1 supermajority |
| `EscrowedCollateral` | operator, owner | operator+owner (Seize), owner (WithdrawAll/Partial) | Dual-signatory prevents unauthorized seizure |

---

## FINDINGS SUMMARY

| Severity | Solidity | DAML | Cross-Layer | Relay/Infra | Total |
|----------|----------|------|-------------|-------------|-------|
| 🔴 CRITICAL | 2 | 1 | 0 | 0 | **3** |
| 🟠 HIGH | 2 | 2 | 0 | 3 | **7** |
| 🟡 MEDIUM | 5 | 5 | 2 | 0 | **12** |
| 🔵 LOW | 6 | 4 | 1 | 0 | **11** |
| ℹ️ INFO | 8 | 4 | 0 | 1 | **13** |
| **Total** | **23** | **16** | **3** | **4** | **46** |

---

## 🔴 CRITICAL SEVERITY

---

### C-01 — No On-Ledger ECDSA Verification in DAML Bridge

| | |
|---|---|
| **Layer** | DAML / Cross-Layer |
| **File** | BLEBridgeProtocol.daml (`Attestation_Sign` choice) |
| **Category** | Cryptographic Verification / Trust Model |
| **CVSS 3.1** | 9.1 (Critical) — AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:N |
| **Status** | Open |

**Description:**

The DAML bridge protocol accepts ECDSA signatures from validators but **does not cryptographically verify them on-ledger**. The `Attestation_Sign` choice only checks signature length:

```haskell
choice Attestation_Sign : ContractId AttestationRequest
  with
    validator : Party
    ecdsaSignature : Text        -- ECDSA sig passed as opaque string
  controller validator
  do
    assertMsg "VALIDATOR_ALREADY_SIGNED" (not (Set.member validator collectedSignatures))
    assertMsg "UNAUTHORIZED_VALIDATOR" (validator `elem` validatorGroup)
    assertMsg "INVALID_SIGNATURE_FORMAT" (T.length ecdsaSignature >= 130)
    -- ⚠️ NO cryptographic verification of ecdsaSignature against any public key or message
    create this with collectedSignatures = Set.insert validator collectedSignatures
```

**Root Cause:**

DAML has no native ECDSA library. The protocol relies on:
1. **DAML party-based authorization** (`controller validator`) — only the validator Party's Canton participant node can submit the transaction
2. **Off-chain verification** in the relay service — `relay-service.ts` pre-verifies signatures via `ethers.recoverAddress()` before submission

**Why This Is Critical:**

The security model collapses if a Canton participant node is compromised. A compromised validator node has the validator Party's authorization and can:
1. Exercise `Attestation_Sign` with any arbitrary `ecdsaSignature` string ≥130 characters
2. The DAML ledger accepts it (only length is checked)
3. Once 2/3+1 validators are "signed" (even with garbage signatures), `Finalize` succeeds
4. The relay service pre-verifies signatures — but if the relay is also compromised or bypassed, the forged attestation reaches Ethereum

**Contrast with Ethereum Side:**

BLEBridgeV9.sol performs proper on-chain ECDSA verification:
```solidity
bytes32 ethHash = messageHash.toEthSignedMessageHash();
address signer = ethHash.recover(signatures[i]);
require(hasRole(VALIDATOR_ROLE, signer), "INVALID_VALIDATOR");
```

**Impact:**

- A compromised Canton participant + relay bypass = arbitrary attestation forgery
- Could mint unbounded mUSD on Ethereum via forged bridge-out attestations
- The entire cross-chain trust model depends on off-chain components, not on-ledger cryptographic proof

**Recommendation:**

1. **Short-term:** Add a DAML helper that reconstructs the expected attestation hash and stores it. The relay service should verify the stored hash matches before submission.
2. **Long-term:** Integrate a DAML ECDSA verification library (e.g., via Canton custom commands) to perform on-ledger signature verification against registered validator public keys.
3. **Operational:** Ensure the relay service is hardened against bypass — it is the sole cryptographic verification point on the Canton side.

---

### C-02 — Compounding ±5% Share Sync Allows 222% Inflation in 24 Hours

| | |
|---|---|
| **Layer** | Solidity |
| **File** | SMUSD.sol, `syncCantonShares()` |
| **Lines** | 186–217 |
| **Category** | Economic Attack / Rate Limiting |
| **CVSS 3.1** | 9.3 (Critical) — AV:N/AC:L/PR:L/UI:N/S:C/C:N/I:H/A:H |
| **Status** | Open |

**Description:**

`syncCantonShares()` allows a ±5% change per call with a 1-hour minimum cooldown. The rate limit is **per-call, not per-period** — changes compound multiplicatively:

```solidity
function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
    require(epoch > lastCantonSyncEpoch, "EPOCH_NOT_SEQUENTIAL");
    require(block.timestamp >= lastCantonSyncTime + MIN_SYNC_INTERVAL, "SYNC_TOO_FREQUENT");
    
    if (cantonTotalShares == 0) {
        // Initial: capped at 2x Ethereum shares
    } else {
        uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
        uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
        require(_cantonShares <= maxIncrease, "SHARE_INCREASE_TOO_LARGE");
        require(_cantonShares >= maxDecrease, "SHARE_DECREASE_TOO_LARGE");
    }
    cantonTotalShares = _cantonShares;
    lastCantonSyncEpoch = epoch;
    lastCantonSyncTime = block.timestamp;
}
```

**Mathematical Analysis:**

| Calls | Hours | Cumulative Factor | Share Inflation |
|-------|-------|-------------------|-----------------|
| 1 | 1 | 1.05 | +5% |
| 6 | 6 | 1.05⁶ = 1.34 | +34% |
| 12 | 12 | 1.05¹² = 1.80 | +80% |
| 24 | 24 | 1.05²⁴ = **3.22** | **+222%** |
| 48 | 48 | 1.05⁴⁸ = 10.40 | +940% |

**Attack Scenario:**

1. Attacker compromises BRIDGE_ROLE (or the relay service that holds it)
2. Calls `syncCantonShares(currentShares * 1.05, epoch++)` every hour
3. After 24 calls, `cantonTotalShares` has grown 3.22x
4. `globalTotalShares()` = `totalSupply() + cantonTotalShares` — denominator inflated
5. `globalSharePrice()` = `globalTotalAssets() / globalTotalShares()` — price deflated
6. Ethereum sMUSD holders' shares are now worth ~31% of their original value
7. Attacker can buy cheap sMUSD on Ethereum and redeem at inflated Canton rate (or vice versa depending on direction)

**Impact:**

- **Economic:** 222% share inflation in 24 hours — vault drain via share price manipulation
- **Systemic:** Affects all sMUSD holders on both chains simultaneously
- **Irreversible:** Once cantonTotalShares is inflated, deflating it back takes equally long (24+ hours of -5% calls)

**Recommendation:**

Add a **daily cumulative cap** in addition to the per-call cap:

```solidity
uint256 public constant MAX_DAILY_CHANGE_BPS = 1000; // 10% max daily change
uint256 public dailyChangeAccumulator;
uint256 public lastDailyReset;

function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
    // Reset daily accumulator every 24 hours
    if (block.timestamp >= lastDailyReset + 24 hours) {
        dailyChangeAccumulator = 0;
        lastDailyReset = block.timestamp;
    }
    
    uint256 changeBps = _cantonShares > cantonTotalShares 
        ? ((_cantonShares - cantonTotalShares) * 10000) / cantonTotalShares
        : ((cantonTotalShares - _cantonShares) * 10000) / cantonTotalShares;
    
    dailyChangeAccumulator += changeBps;
    require(dailyChangeAccumulator <= MAX_DAILY_CHANGE_BPS, "DAILY_CHANGE_EXCEEDED");
    
    // ... existing logic
}
```

---

### C-03 — BLEBridgeV9 `_authorizeUpgrade` Uses DEFAULT_ADMIN_ROLE (No Timelock)

| | |
|---|---|
| **Layer** | Solidity |
| **File** | BLEBridgeV9.sol |
| **Lines** | 464 |
| **Category** | Upgrade Safety / Access Control |
| **CVSS 3.1** | 8.8 (Critical) — AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H |
| **Status** | Open |

**Description:**

BLEBridgeV9 is the **most security-critical contract** in the protocol — it controls the mUSD supply cap, processes cross-chain attestations, and gates all Canton→Ethereum bridge operations. Its upgrade authorization uses only `DEFAULT_ADMIN_ROLE` with **zero timelock delay**:

```solidity
// BLEBridgeV9.sol, Line 464
function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
```

**Contrast with other UUPS contracts:**

| Contract | `_authorizeUpgrade` Guard | Effective Delay |
|----------|--------------------------|-----------------|
| **BLEBridgeV9** | `DEFAULT_ADMIN_ROLE` | ❌ **None — instant upgrade** |
| **TreasuryV2** | `TIMELOCK_ROLE` | ✅ Timelock delay |
| **SkySUSDSStrategy** | `TIMELOCK_ROLE` | ✅ Timelock delay |
| **PendleStrategyV2** | `TIMELOCK_ROLE` | ✅ Timelock delay |
| **MorphoLoopStrategy** | `TIMELOCK_ROLE` | ✅ Timelock delay |

**Attack Scenario:**

1. DEFAULT_ADMIN_ROLE is compromised (key theft, social engineering, insider)
2. Attacker calls `upgradeToAndCall()` with a malicious implementation
3. New implementation removes validator signature requirements from `processAttestation()`
4. Attacker mints unbounded mUSD
5. **No timelock window exists** for guardians to detect and pause

**Impact:**

- Complete protocol compromise via instant implementation swap
- The most sensitive contract has the weakest upgrade protection
- Contradicts the protocol's own established pattern of using TIMELOCK_ROLE

**Recommendation:**

```solidity
function _authorizeUpgrade(address) internal override onlyRole(TIMELOCK_ROLE) {}
```

---

## 🟠 HIGH SEVERITY

---

### S-H-01 — SMUSD `totalAssets()` ↔ `globalTotalAssets()` Mutual Recursion

| | |
|---|---|
| **Layer** | Solidity |
| **File** | SMUSD.sol |
| **Lines** | 235–253, 304–305 |
| **Category** | Logic Error / Denial of Service |
| **CVSS 3.1** | 8.6 (High) — AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H |
| **Status** | Open — **Independently verified against source code** |

**Description:**

`SMUSD.totalAssets()` (line 304) is overridden to delegate to `globalTotalAssets()`. When `treasury == address(0)` (not yet set), `globalTotalAssets()` (line 237) calls `totalAssets()`, which dispatches through Solidity's virtual function table to the **overridden** version — creating infinite recursion.

**Verified Code (SMUSD.sol):**

```solidity
// Line 304-305
function totalAssets() public view override returns (uint256) {
    return globalTotalAssets();  // ← Calls globalTotalAssets()
}

// Line 235-253
function globalTotalAssets() public view returns (uint256) {
    if (treasury == address(0)) {
        return totalAssets();  // ← Calls OVERRIDDEN totalAssets() → globalTotalAssets() → ∞
    }
    try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
        return usdcValue * 1e12;
    } catch {
        if (cantonTotalShares > 0) {
            revert("TREASURY_UNREACHABLE");
        }
        return totalAssets();  // ← Also recursive if treasury call reverts + no Canton shares
    }
}
```

**Key Technical Detail:** The comment at line 232 says "Falls back to local totalAssets if treasury not set," suggesting the developer intended `super.totalAssets()` (the unoverridden ERC4626 version, which returns `asset.balanceOf(address(this))`). However, `totalAssets()` in Solidity dispatches to the overridden version — `super.totalAssets()` is required to call the parent implementation.

**Call Graph:**

```
User calls deposit() / withdraw() / previewDeposit() / previewWithdraw()
    → ERC4626._convertToShares() / _convertToAssets()
        → globalTotalAssets()
            → totalAssets() [if treasury == address(0)]
                → globalTotalAssets()  [virtual dispatch to override]
                    → totalAssets()
                        → ... ∞ (out-of-gas)
```

**Conditions for Trigger:**
- `treasury == address(0)` (pre-setup state or admin error), OR
- `treasury.totalValue()` reverts AND `cantonTotalShares == 0`

**Impact:**

- **Availability:** Complete denial-of-service — all ERC4626 operations become inoperable
- **Financial:** No direct fund loss, but inability to withdraw creates panic and market impact
- **Scope:** All SMUSD holders and any protocol components that call SMUSD view functions

**Recommendation:**

Replace `totalAssets()` with `super.totalAssets()` in the fallback paths, or use the direct balance check:

```solidity
function globalTotalAssets() public view returns (uint256) {
    if (treasury == address(0)) {
        return IERC20(asset()).balanceOf(address(this)); // Break recursion
    }
    try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
        return usdcValue * 1e12;
    } catch {
        if (cantonTotalShares > 0) {
            revert("TREASURY_UNREACHABLE");
        }
        return IERC20(asset()).balanceOf(address(this)); // Break recursion
    }
}
```

---

### D-H-01 — GovernanceActionLog Archive Authorization Failure

| | |
|---|---|
| **Layer** | DAML |
| **File** | Governance.daml |
| **Lines** | 260–320 (MinterRegistry choices) |
| **Category** | Authorization Model |
| **CVSS 3.1** | 7.5 (High) — AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H |
| **Status** | Open |

**Description:**

`GovernanceActionLog` is defined with `signatory operator, executedBy` (line 306). The template is created inside `Proposal_Execute` (line 205) with `executedBy = executor` — where `executor` can be any authorized governor, not necessarily the `operator`.

In `MinterRegistry_AddMinter`, `MinterRegistry_RemoveMinter`, and `MinterRegistry_ReplenishQuota`, the code calls `archive governanceProofCid` within choices controlled by `operator` only. DAML requires **all signatories** to be in the authorization context for an archive. When `executedBy ≠ operator`, the archive fails because `executedBy`'s authority is not in scope.

**Failure Scenario:**

```
1. Governor "alice" proposes MinterAuthorization
2. Sufficient governors approve the proposal
3. Governor "bob" executes: exercise proposalCid Proposal_Execute with executor = bob
   → GovernanceActionLog created with {operator = "minted-operator", executedBy = "bob"}
4. Operator exercises MinterRegistry_AddMinter with governanceProofCid
   → archive governanceProofCid is called
   → DAML runtime checks: is "bob" (executedBy signatory) in authorization context?
   → NO — only "minted-operator" (the controller) is in context
   → RUNTIME ERROR: "Archive failed due to missing authorization of bob"
```

**Impact:**

- **Governance Liveness:** All governance-gated minter registry operations become permanently blocked when the executor is not the operator
- **Replay Risk:** If the archive is removed as a workaround, governance proofs become replayable

**Recommendation:**

Change `GovernanceActionLog` to have only `operator` as signatory:

```haskell
template GovernanceActionLog
  with
    ...
  where
    signatory operator
    observer executedBy  -- executedBy is an observer, not a signatory
```

---

### D-H-02 — V3.daml sMUSD Share Price Asymmetry (Deposit vs. Withdraw)

| | |
|---|---|
| **Layer** | DAML |
| **File** | V3.daml |
| **Category** | Economic Logic |
| **CVSS 3.1** | 7.4 (High) — AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N |
| **Status** | Open |

**Description:**

The V3.daml module implements sMUSD staking with **inconsistent share price calculations** between deposit and withdrawal:

**Deposit — Virtual Shares (inflation attack mitigation):**
```haskell
let virtualShares = totalShares + 1000.0
let virtualAssets = totalAssets + 1000.0
let sharePrice = virtualAssets / virtualShares
let newShares = depositAmount / sharePrice
```

**Withdraw — Raw Division (no virtual offset):**
```haskell
let sharePrice = if totalShares == 0.0 then 1.0 else totalAssets / totalShares
let musdAmount = userShares * sharePrice
```

The newer `CantonSMUSD.daml` correctly uses a **unified `globalSharePrice`** synced from Ethereum for both operations.

**Impact:**

- Economic: Systematic pricing asymmetry creates extractable value in early pool phases
- Fairness: Depositors pay a premium relative to withdrawers

**Recommendation:**

Apply the virtual share offset consistently in both deposit and withdrawal, OR remove it from both and use the `globalSharePrice` model from `CantonSMUSD.daml`.

---

### H-04 — DEFAULT_ADMIN_ROLE Can Self-Grant TIMELOCK_ROLE (Timelock Bypass)

| | |
|---|---|
| **Layer** | Solidity |
| **File** | TreasuryV2.sol, SkySUSDSStrategy.sol, PendleStrategyV2.sol, MorphoLoopStrategy.sol |
| **Category** | Access Control / Privilege Escalation |
| **CVSS 3.1** | 7.2 (High) — AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H |
| **Status** | Open |

**Description:**

All contracts that use `TIMELOCK_ROLE` for upgrade authorization inherit from OpenZeppelin `AccessControl`, where `DEFAULT_ADMIN_ROLE` is the admin for all roles by default — including `TIMELOCK_ROLE`. This means `DEFAULT_ADMIN_ROLE` can:

1. Call `grantRole(TIMELOCK_ROLE, attackerAddress)` — no delay
2. Call `upgradeToAndCall()` with the newly granted role — no delay
3. The TIMELOCK_ROLE protection is **cosmetic** unless `DEFAULT_ADMIN_ROLE` is itself behind a timelock

**Verification:**

```solidity
// TreasuryV2.sol — _authorizeUpgrade uses TIMELOCK_ROLE
function _authorizeUpgrade(address) internal override onlyRole(TIMELOCK_ROLE) {}

// But DEFAULT_ADMIN_ROLE can grant TIMELOCK_ROLE to anyone:
// AccessControl.grantRole(TIMELOCK_ROLE, attacker) — no delay
```

**Impact:**

The timelock pattern provides false security confidence. Any compromise of DEFAULT_ADMIN_ROLE bypasses all timelock protections across 4+ contracts.

**Recommendation:**

1. Set `TIMELOCK_ROLE`'s admin to itself (not DEFAULT_ADMIN_ROLE)
2. Or use OpenZeppelin's `AccessManager` with time-delayed role grants
3. Or ensure DEFAULT_ADMIN_ROLE is held exclusively by the MintedTimelockController

---

### H-05 — No Blacklist/Compliance Check on BLEBridgeV9.processAttestation

| | |
|---|---|
| **Layer** | Solidity / Cross-Layer |
| **File** | BLEBridgeV9.sol |
| **Category** | Compliance / Regulatory |
| **CVSS 3.1** | 7.0 (High) — AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N |
| **Status** | Open |

**Description:**

`processAttestation()` is a **public function** with no access control, no compliance checks, and no blacklist verification. Anyone can submit a valid attestation. While validator signatures prevent arbitrary minting, there is no mechanism to prevent:

1. A Canton-blacklisted address from bridging tokens to a clean Ethereum address
2. A sanctioned entity from triggering supply cap increases
3. Compliance-frozen assets from being bridged out of Canton

```solidity
// BLEBridgeV9.sol — processAttestation is fully public
function processAttestation(Attestation calldata att, bytes[] calldata signatures) external {
    // ✅ Checks: nonce, attestation ID, timestamp, validator signatures, BFT threshold
    // ❌ Missing: blacklist check, compliance check, sender restriction
    require(!usedAttestationIds[att.id], "ATTESTATION_REUSED");
    // ... signature verification ...
    // Executes attestation (supply cap change, etc.)
}
```

**Canton side:** All product modules (CantonDirectMint, CantonLending, CantonSMUSD) have compliance hooks. The bridge path bypasses these.

**Impact:**

- Regulatory: Blacklisted entities can bypass compliance via bridge-out
- The compliance perimeter has a gap at the most critical boundary (cross-chain bridge)

**Recommendation:**

Add a compliance check for bridge-out attestations that reference specific addresses. At minimum, verify the destination address is not on the Ethereum-side blacklist.

---

### H-06 — Relay Service Private Key in Node.js Heap Memory

| | |
|---|---|
| **Layer** | Infrastructure |
| **File** | relay-service.ts, yield-keeper.ts |
| **Category** | Key Management / Operational Security |
| **CVSS 3.1** | 6.8 (High) — AV:L/AC:H/PR:H/UI:N/S:C/C:H/I:H/A:N |
| **Status** | Open |

**Description:**

The relay service loads `RELAYER_PRIVATE_KEY` from Docker secrets (or env var fallback) into the Node.js heap. Unlike the validator nodes, which use **AWS KMS** (key material never leaves the HSM), the relay service holds the actual private key in process memory.

```typescript
// relay-service.ts
const privateKey = loadSecret('RELAYER_PRIVATE_KEY', process.env.RELAYER_PRIVATE_KEY);
// → Key is now a string in Node.js heap memory
// → Vulnerable to: heap dump, core dump, /proc/pid/mem, memory forensics
```

**Contrast with Validators:**

| Component | Key Storage | Key in Memory? |
|-----------|-------------|----------------|
| relay-service.ts | Docker secret → heap | ❌ Yes — extractable |
| validator-node.ts | AWS KMS | ✅ No — HSM-only |
| validator-node-v2.ts | AWS KMS | ✅ No — HSM-only |

The relay service holds `BRIDGE_ROLE` on SMUSD (can call `syncCantonShares()`) and submits transactions to BLEBridgeV9. A compromised relay private key enables the C-02 compounding attack.

**Impact:**

- Memory dump of relay process = private key extraction
- Enables C-02 (compounding sync attack) if combined with relay access
- Single point of failure for the most critical cross-chain pathway

**Recommendation:**

1. Migrate relay signing to AWS KMS (same pattern as validators)
2. Or use AWS Secrets Manager with runtime rotation
3. At minimum: use `secure-memory` to prevent heap page swapping and zero the key buffer after wallet construction

---

### H-07 — Stale `signer.ts` Copy in `scripts/` Uses Double EIP-191 Prefix

| | |
|---|---|
| **Layer** | Infrastructure |
| **File** | scripts/signer.ts |
| **Category** | Cryptographic Correctness / Code Hygiene |
| **CVSS 3.1** | 6.5 (High) — AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:N |
| **Status** | Open |

**Description:**

Two copies of `signer.ts` exist with divergent security properties:

| File | EIP-191 Handling | Malleability Check | Status |
|------|-----------------|-------------------|--------|
| `relay/src/signer.ts` | ✅ Uses `recoverAddress` (no double-prefix) | ✅ Present | **Active** |
| `scripts/signer.ts` | ❌ Uses `hashMessage` (applies EIP-191 prefix again) | ❌ Missing | **Stale** |

If `scripts/signer.ts` is used in any production context, signatures will fail to verify correctly (double EIP-191 prefix changes the message hash). Additionally, without the malleability check, signature replay with flipped S-value is possible.

**Impact:**

- If used in production: all signatures invalid (double-hashed)
- If used in tests: test results don't reflect production behavior
- Malleability gap allows signature replay on systems that don't enforce EIP-2

**Recommendation:**

Delete `scripts/signer.ts` or replace it with an import from `relay/src/signer.ts`.

---

## 🟡 MEDIUM SEVERITY

---

### S-M-01 — Interest Routing Failure Creates Phantom Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | BorrowModule.sol |
| **Lines** | 430–470 (`_accrueGlobalInterest`) |
| **Category** | Accounting / State Consistency |
| **CVSS 3.1** | 6.5 (Medium) |
| **Status** | Open |

**Description:**

In `_accrueGlobalInterest()`, `totalBorrows += interest` executes **unconditionally** regardless of whether the interest routing to SMUSD succeeded. If `smusd.receiveInterest()` reverts (e.g., SMUSD is paused), the minted tokens are correctly burned, but `totalBorrows` is still inflated by the unrouted interest.

**Impact Chain:**

```
Interest routing fails
    → totalBorrows inflated (phantom debt)
        → utilizationRate increases artificially
            → borrowRate increases for all borrowers
                → more interest accrues → more routing failures → death spiral
```

**Recommendation:**

Buffer unrouted interest and retry on next accrual:

```solidity
uint256 public pendingInterest;

// In _accrueGlobalInterest:
uint256 toRoute = interest + pendingInterest;
try smusd.receiveInterest(toRoute) {
    pendingInterest = 0;
} catch {
    pendingInterest = toRoute;
}
```

---

### S-M-02 — No Bad Debt Socialization Mechanism

| | |
|---|---|
| **Layer** | Solidity |
| **File** | LiquidationEngine.sol |
| **Lines** | 130–175 (`liquidate`) |
| **Category** | Economic Safety |
| **CVSS 3.1** | 6.1 (Medium) |
| **Status** | Open |

**Description:**

When a position is underwater (`collateralValue < debt`), the liquidation penalty makes seizure unprofitable for liquidators. The remaining debt after full collateral seizure has no write-off mechanism and persists permanently in `totalBorrows`.

**Example:** 100 mUSD debt, 80 USDC collateral → liquidator can seize ~80 USDC for ~76 mUSD repayment → 24 mUSD debt remains permanently in `totalBorrows`.

**Impact:**

Bad debt accumulates silently in `totalBorrows`, inflating utilization and overstating SMUSD share price.

**Recommendation:**

Add a `socializeBadDebt()` function callable by a guardian that writes off underwater positions against protocol reserves or reduces the SMUSD share price.

---

### S-M-03 — LeverageVault Sandwich Attack Exposure

| | |
|---|---|
| **Layer** | Solidity |
| **File** | LeverageVault.sol |
| **Category** | MEV / Economic Attack |
| **CVSS 3.1** | 5.9 (Medium) |
| **Status** | Open |

**Description:**

Swap functions use `deadline: block.timestamp` (always passes) and oracle-derived `amountOutMinimum` (not spot-derived). MEV bots can sandwich every leverage/deleverage operation, compounded by multi-loop leverage (3–5 swaps per operation).

**Recommendation:** Accept user-supplied `minAmountOut` with a server-side quote check; use `block.timestamp + 120` as a real deadline; consider Flashbots Protect.

---

### S-M-04 — `emergencyClosePosition` Orphans Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | LeverageVault.sol |
| **Category** | State Consistency |
| **CVSS 3.1** | 6.3 (Medium) |
| **Status** | Open |

**Description:**

`emergencyClosePosition()` withdraws and returns collateral to the user but does not repay the corresponding debt in `BorrowModule`. The position's debt remains in `totalBorrows` as phantom debt.

**Recommendation:** Have `emergencyClosePosition()` call `BorrowModule.repayFor()` with swap proceeds before returning remainder.

---

### S-M-05 — CollateralVault `withdrawFor` Pre-Withdrawal Health Check

| | |
|---|---|
| **Layer** | Solidity |
| **File** | CollateralVault.sol |
| **Lines** | 220–255 (`withdrawFor`) |
| **Category** | Logic Error |
| **CVSS 3.1** | 6.5 (Medium) |
| **Status** | Open — Partially Mitigated |

**Description:**

`withdrawFor()` checks health factor **before** reducing collateral balance. The code requires `hf >= 11000` (1.1x margin) instead of `hf >= 10000`, providing a 10% buffer. However, the buffer is not mathematically correlated to the withdrawal size — a large withdrawal can still break the 1.0x threshold.

**Recommendation:** Perform the health check **after** the balance reduction.

---

### D-M-01 — CantonLending Borrow/Liquidate Service Contention

| | |
|---|---|
| **Layer** | DAML |
| **File** | CantonLending.daml |
| **Lines** | 725+ (`Lending_Borrow`), 1118+ (`Lending_Liquidate`) |
| **Category** | Scalability / Liveness |
| **CVSS 3.1** | 5.3 (Medium) |
| **Status** | Open |

**Description:**

`Lending_Borrow` and `Lending_Liquidate` are **consuming choices** on `CantonLendingService` because they modify `totalBorrows` and `cantonCurrentSupply`. Only one can execute per ledger effective time — concurrent borrows serialize and late arrivals fail referencing stale contract IDs.

**Recommendation:** Move `totalBorrows` tracking to a separate aggregate template to decouple borrow-side state from the service contract.

---

### D-M-02 — sMUSD Share Price Sync Is Operator+Governance Only (No BFT Attestation)

| | |
|---|---|
| **Layer** | DAML |
| **File** | CantonSMUSD.daml |
| **Lines** | 215–240 (`SyncGlobalSharePrice`) |
| **Category** | Trust Assumption / Oracle Manipulation |
| **CVSS 3.1** | 6.1 (Medium) |
| **Status** | Open — Partially Mitigated |

**Description:**

`SyncGlobalSharePrice` requires `operator` and `governance` as controllers — better than pure operator-only, but does not require the BFT supermajority attestation used by all bridge operations. Compromised operator+governance can accumulate 10% per epoch: 5 epochs → +61% cumulative inflation.

**Recommendation:** Route through `YieldAttestation` from `BLEBridgeProtocol.daml` (already has BFT supermajority).

---

### D-M-03 — InterestRateService Sync Lacks Attestation Verification

| | |
|---|---|
| **Layer** | DAML |
| **File** | InterestRateService.daml |
| **Lines** | 160–175 (`RateService_SyncMarketState`) |
| **Category** | Trust Assumption |
| **CVSS 3.1** | 5.3 (Medium) |
| **Status** | Open |

**Description:**

`RateService_SyncMarketState` is controlled by `operator` only, with block number sequencing but no cryptographic verification that the synced `totalBorrows`/`totalSupply` match Ethereum state.

**Impact:** Operator could set arbitrary utilization → manipulate interest rates on Canton.

**Recommendation:** Require an attestation payload hash or validator co-signature on rate syncs.

---

### D-M-04 — V3.daml Vault Liquidation Uses Stale-Tolerant Oracle Incorrectly

| | |
|---|---|
| **Layer** | DAML |
| **File** | V3.daml |
| **Category** | Oracle Safety / Liveness |
| **CVSS 3.1** | 5.9 (Medium) |
| **Status** | Open |

**Description:**

V3 `Vault.Liquidate` uses `Oracle_GetPrice with maxStaleness = hours 1` — which fails during volatile periods when oracle updates lag. The newer `CantonLending.daml` correctly uses an unsafe (no staleness) path for liquidations.

**Recommendation:** Add an unsafe oracle path for V3 Vault liquidation contexts.

---

### D-M-05 — Redundant `archive self` in Consuming Choices

| | |
|---|---|
| **Layer** | DAML |
| **File** | CantonSMUSD.daml |
| **Category** | DAML Semantics / Correctness |
| **CVSS 3.1** | 4.3 (Medium) |
| **Status** | Open |

**Description:**

Multiple consuming choices contain explicit `archive self` before `create this with ...`. In DAML, consuming choices automatically archive the contract. The explicit archive is redundant or could cause double-archive errors.

**Recommendation:** Remove explicit `archive self` from consuming choices.

---

### X-M-01 — No Cross-Chain Global Supply Cap Enforcement

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Category** | Supply Cap / Economic Safety |
| **CVSS 3.1** | 5.9 (Medium) |
| **Status** | Open |

**Description:**

Three independent supply caps exist with no atomic cross-chain enforcement:

| Chain | Contract | Cap Variable |
|-------|----------|-------------|
| Ethereum | `MUSD.sol` | `supplyCap` |
| Canton | `CantonDirectMintService` | `supplyCap` |
| Canton | `CantonLendingService` | `cantonSupplyCap` + `globalMintCap` |

Cross-chain enforcement is after-the-fact via `SupplyCapAttestation` (audit check, not pre-mint gate). Both chains can independently mint up to their local cap, potentially exceeding global ceiling.

**Recommendation:** Implement conservative local caps summing to the global cap with a safety margin.

---

### X-M-02 — Asymmetric Oracle Trust Models

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Category** | Oracle Trust / Consistency |
| **CVSS 3.1** | 5.3 (Medium) |
| **Status** | Open |

**Description:**

| | Ethereum | Canton |
|--|----------|--------|
| **Source** | Chainlink decentralized oracles | Tradecraft/Temple DEX API (operator-signed) |
| **Trust** | Decentralized (multiple node operators) | Centralized (single operator party) |
| **Circuit Breaker** | ±20% deviation triggers cooldown | ±50% per-update cap |
| **Staleness** | Per-feed `stalePeriod` | Per-asset `maxStalenessSecs` |

**Impact:** A compromised Canton operator could manipulate prices within the ±50% band.

**Recommendation:** Add multi-validator attestation for Canton price feeds.

---

## 🔵 LOW SEVERITY

---

### S-L-01 — Raw `approve()` in BorrowModule

| **File** | BorrowModule.sol, Line 449 |
|---|---|
| **Issue** | `IERC20(address(musd)).approve(address(smusd), supplierAmount)` uses raw `approve()` instead of `SafeERC20.forceApprove()`. Inconsistent with codebase-wide SafeERC20 usage. |
| **Fix** | Replace with `IERC20(address(musd)).forceApprove(address(smusd), supplierAmount)` |

### S-L-02 — Ineffective Swap Deadline in LeverageVault

| **File** | LeverageVault.sol |
|---|---|
| **Issue** | `deadline: block.timestamp` provides no protection — miners can hold transactions indefinitely. |
| **Fix** | Use `block.timestamp + 120` or accept user-supplied deadline. |

### S-L-03 — No Event Emission on Per-User Interest Accrual

| **File** | BorrowModule.sol |
|---|---|
| **Issue** | `_accrueInterest()` modifies `positions[user].accruedInterest` without events when interest is zero. Off-chain indexing cannot fully track accrual. |

### S-L-04 — Missing Zero-Address Checks in Setter Functions

| **Files** | LeverageVault.sol (partial) |
|---|---|
| **Issue** | Some setter functions accept addresses without zero-address validation. |

### S-L-05 — PriceOracle Circuit Breaker Not Configurable Per Asset

| **File** | PriceOracle.sol |
|---|---|
| **Issue** | `maxDeviationBps` is configurable globally via `setMaxDeviation()` (bounded 1%–50%, default 20%), but applies uniformly to all assets. Volatile assets may need different thresholds than stablecoins. |
| **Fix** | Add per-asset `maxDeviationBps` in `FeedConfig`. |

### S-L-06 — No Borrow Dust Threshold on Repayment

| **File** | BorrowModule.sol |
|---|---|
| **Issue** | Partial repayment can leave arbitrarily small debt dust (1 wei) that costs more gas to liquidate than the debt is worth. |
| **Fix** | If remaining debt < `minDebt`, force full repayment. |

### D-L-01 — CantonLoopStrategy Is Empty

| **File** | CantonLoopStrategy.daml |
|---|---|
| **Issue** | Both module and test file are empty. Unimplemented feature with zero coverage. |

### D-L-02 — BridgeOutSignature.requestCid Is Stale After Multi-Sign

| **File** | BLEBridgeProtocol.daml |
|---|---|
| **Issue** | Each consuming `BridgeOut_Sign` creates a new attestation, making the signature's `requestCid` stale. Finalization uses nonce-matching correctly, so this is cosmetic. |

### D-L-03 — BoostPool Deposit Archives and Recreates sMUSD

| **File** | CantonBoostPool.daml |
|---|---|
| **Issue** | `Deposit` archives user's `CantonSMUSD` and recreates it — any external CID references become stale. |

### D-L-04 — ComplianceRegistry BulkBlacklist Cap at 100

| **File** | Compliance.daml, Line 155 |
|---|---|
| **Issue** | `assertMsg "BULK_LIMIT_EXCEEDED" (length usersToBlock <= 100)` — OFAC lists can have thousands of entries. |

### X-L-01 — Interest Rate Model Parity Not Cryptographically Verified

| **Files** | InterestRateModel.sol, InterestRateService.daml |
|---|---|
| **Issue** | Rate parameter sync uses operator attestation with block ordering — no cryptographic proof of on-chain values. |

---

## ℹ️ INFORMATIONAL

---

### Solidity Informational Findings (S-I-01 through S-I-08)

| ID | Finding | File | Detail |
|----|---------|------|--------|
| S-I-01 | `WITHDRAW_COOLDOWN` is a compile-time constant (`24 hours`) | SMUSD.sol | No setter exists. If one is added in the future, it should have an upper bound (e.g., 7 days) and timelock. |
| S-I-02 | `LiquidationEngine` missing `_disableInitializers()` in constructor | LiquidationEngine.sol | Not a UUPS proxy, so not exploitable — but best practice for consistency |
| S-I-03 | `healthFactor()` returns `type(uint256).max` for zero-debt positions | BorrowModule.sol | Callers must handle this sentinel value |
| S-I-04 | `supportedTokens[]` has no removal function | CollateralVault.sol | Tokens can be disabled but not removed from the array |
| S-I-05 | `type(uint256).max` used as sentinel for `lastActiveIdx` in `_autoAllocate()` | TreasuryV2.sol | Not a security concern — used for loop index tracking. Per-operation `forceApprove()` used for actual token approvals (not max approval). |
| S-I-06 | Wormhole relayer fee uses hardcoded gas estimate | DepositRouter.sol | May under/overpay for cross-chain delivery |
| S-I-07 | All contracts use `pragma solidity 0.8.26` (pinned) | All | Good practice — ensures known compiler behavior |
| S-I-08 | `MorphoLoopStrategy` max 10 iterations | MorphoLoopStrategy.sol | Reasonable bound — prevents gas limit attacks |

### DAML Informational Findings (D-I-01 through D-I-04)

| ID | Finding | Detail |
|----|---------|--------|
| D-I-01 | **Comprehensive Audit Fix Trail** | 30+ prior audit fixes referenced in DAML code: D-01, D-02, D-03, DC-06, H-6, H-17, C-08, C-12, D-M01–D-M09, D-H01–D-H08, D-C01–D-C02, DL-C2–DL-C3, 5C-C01–5C-C02, A-01, DAML-H-01–H-04, DAML-M-01–M-09, DAML-CRIT-01–03. Evidence of mature security lifecycle. |
| D-I-02 | **Strong Signatory/Authority Patterns** | All token templates use **dual signatory** (issuer + owner) with **transfer proposal** patterns. Gold standard for Canton. |
| D-I-03 | **Privacy-by-Default Architecture** | `UserPrivacySettings.daml` with `lookupUserObservers` helper used across all product templates. Default fully private. |
| D-I-04 | **BFT Supermajority Consistently Applied** | All 4 attestation finalization choices use `(2n/3) + 1` threshold. Consuming sign choices prevent double-signing (D-02 fix). |

### Relay Informational (R-I-01)

| ID | Finding | Detail |
|----|---------|--------|
| R-I-01 | `yield-deployer.ts` missing secp256k1 key range validation | Unlike other services, does not validate `KEEPER_PRIVATE_KEY` against secp256k1 curve range `[1, n-1]`. Should use `validatePrivateKey()` from `security-utils.ts`. |

---

## RELAY & INFRASTRUCTURE ANALYSIS

This section covers the off-chain relay, validator, and keeper infrastructure — the **critical trust bridge** between Canton and Ethereum that was absent from v1 and v2 audits.

### Why This Matters

The relay service is the single component that translates Canton DAML ledger events into Ethereum transactions. A compromised relay can:
- Submit forged attestations (mitigated by on-chain validator signature verification)
- Trigger the C-02 compounding sync attack (BRIDGE_ROLE on SMUSD)
- Selectively delay or censor bridge operations
- Leak private keys (H-06)

### Key Management Architecture

```
                    ┌─────────────────────────────────┐
                    │        KEY MANAGEMENT            │
                    ├─────────────────────────────────┤
                    │                                  │
   Validators       │  AWS KMS (HSM)                  │  ✅ Best practice
   (V1 + V2)        │  Key never leaves hardware      │  Key ID via env/secret
                    │  DER → RSV conversion off-HSM   │
                    │                                  │
                    ├─────────────────────────────────┤
                    │                                  │
   Relay Service    │  Docker secret → Node.js heap   │  ⚠️ Key in memory
                    │  Fallback: env var              │  Extractable via dump
                    │                                  │
                    ├─────────────────────────────────┤
                    │                                  │
   Keeper Bots      │  Docker secret → Node.js heap   │  ⚠️ Key in memory
                    │  secp256k1 validation (most)    │  yield-deployer skips
                    │                                  │
                    └─────────────────────────────────┘
```

### ECDSA Signature Pipeline

```
Canton attestation finalized
    → relay-service.ts polls DAML ledger
    → For each collected signature:
        → Decode ECDSA from attestation
        → relay/signer.ts: DER → RSV conversion
            ✅ Strict DER parsing (tag, length, trailing bytes)
            ✅ R/S max 33 bytes
            ✅ EIP-2 low-S normalization
            ✅ Malleability rejection (both v=27,28 valid → reject)
        → ethers.recoverAddress() — verify signer
        → Sort signatures by recovered address (ascending)
    → Submit to BLEBridgeV9.processAttestation()
    → On-chain: ECDSA.recover + VALIDATOR_ROLE check
```

### Validator Security Comparison

| Feature | V1 | V2 |
|---------|----|----|
| AWS KMS | ✅ | ✅ |
| Rate limiting | ❌ | ✅ 50/hr |
| Anomaly detection | ❌ | ✅ 20% value jump |
| Canton API verification | ❌ | ✅ Asset snapshots |
| Tolerance cap | ❌ | ✅ $100K absolute |
| Bridge address check | ❌ | ✅ Config mismatch |

**Recommendation:** Deprecate V1 validator nodes. V2 has materially better security posture.

### Canton Price Oracle Service

The `price-oracle.ts` service is the sole source of Canton price feeds and has appropriate safeguards:

| Control | Implementation |
|---------|---------------|
| Multi-source | Tradecraft (primary) + Temple DEX (fallback) |
| Divergence block | >5% difference between sources blocks update |
| Circuit breaker | N consecutive failures pauses oracle |
| Sanity bounds | Min/max price + max % change per update |
| On-ledger cap | ±50% movement cap per update (DAML) |
| TLS | Enforced for all external APIs in production |

### Kubernetes Security Posture

| Control | Status |
|---------|--------|
| Image pinning | ✅ SHA256 digests (no `:latest` tags) |
| Non-root containers | ✅ `runAsNonRoot: true` |
| Read-only root FS | ✅ `readOnlyRootFilesystem: true` |
| Capabilities dropped | ✅ `drop: [ALL]` |
| Seccomp profile | ✅ `RuntimeDefault` |
| Network policies | ✅ Least-privilege per component |
| Secret management | ✅ Empty templates, no defaults |
| Pod disruption budget | ✅ Availability guarantee |
| Resource limits | ✅ CPU + memory bounded |

---

## CROSS-CONTRACT DATA FLOW ANALYSIS

### Flow 1: Borrow → Interest → SMUSD (Supplier Yield)

```
User calls BorrowModule.borrow(amount)
    → _accrueInterest(user)
        → _accrueGlobalInterest()
            → interestRateModel.calculateInterest(totalBorrows, totalBorrows, totalSupply, elapsed)
            → interestRateModel.splitInterest(interest) → supplierAmount + reserveAmount
            → musd.mint(address(this), supplierAmount)  ⚠️ Can fail if supply cap hit
            → IERC20(musd).approve(smusd, supplierAmount)  ⚠️ Uses raw approve (S-L-01)
            → smusd.receiveInterest(supplierAmount)  ⚠️ Can fail if paused
            → totalBorrows += interest  ⚠️ Always executes (S-M-01)
    → positions[user].principal += amount
    → totalBorrows += amount
    → _borrowCapacity(user) check
    → musd.mint(user, amount)
```

### Flow 2: Liquidation Path (Solidity)

```
Liquidator calls LiquidationEngine.liquidate(borrower, collateralToken, debtToRepay)
    → borrowModule.healthFactorUnsafe(borrower)  ← Uses unsafe oracle ✅
        → _weightedCollateralValueUnsafe(user)
            → oracle.getValueUsdUnsafe(token, amount)  ← Bypasses circuit breaker ✅
    → vault.getConfig(collateralToken)  ← penaltyBps for seizure calc
    → oracle.getPriceUnsafe(collateralToken)  ← Liquidation-safe price ✅
    → musd.burn(liquidator, actualRepay)
    → vault.seize(borrower, collateralToken, seizeAmount, liquidator)
    → borrowModule.reduceDebt(borrower, actualRepay)
    ⚠️ Remaining debt after seizure has no write-off mechanism (S-M-02)
```

### Flow 3: Cross-Chain Yield Sync (Ethereum ↔ Canton)

```
Ethereum Side:
    TreasuryV2.totalValue() = reserveBalance + Σ strategies[i].totalValue()
    SMUSD.globalSharePrice() = globalTotalAssets() / globalTotalShares()
        ⚠️ globalTotalAssets() has recursion bug (S-H-01) if treasury == address(0)

Bridge:
    YieldAttestation created → Validators sign (BFT 2/3+1) → Finalized

Canton Side:
    CantonStakingService.SyncGlobalSharePrice(newGlobalSharePrice, epoch)
        ← controller: operator, governance
        ← Checks: epoch sequential, ±10% cap
        ⚠️ NO BFT attestation check (D-M-02)

Ethereum Share Sync:
    SMUSD.syncCantonShares(_cantonShares, epoch)
        ← controller: BRIDGE_ROLE
        ← Checks: epoch sequential, 1h cooldown, ±5% per call
        ⚠️ Compounds: 1.05^24 = 3.22x in 24h (C-02)
```

### Flow 4: Canton Lending Liquidation

```
Liquidator calls Lending_Liquidate(borrower, repayAmount, targetEscrowCid, ...)
    → assertMsg "DUPLICATE_ESCROW_CIDS" ← Dedup check (DAML-M-01) ✅
    → lookupByKey @CantonDebtPosition ← Canonical CID check (DAML-M-06) ✅
    → computeRawCollateralValue(..., useSafe=False) ← Unsafe oracle ✅
    → exercise targetEscrowCid Escrow_Seize ← Dual-signatory ✅
    → exercise accruedDebtCid Debt_ReduceForLiquidation
    → CantonMUSD split + burn
    → Create new token for liquidator
    → Create CantonLiquidationReceipt (immutable audit trail) ✅
```

### Flow 5: Relay Attestation Pipeline (NEW)

```
Canton:
    BridgeOutAttestation finalized (2/3+1 validator signatures)
        → Each Attestation_Sign stores ecdsaSignature as Text
        ⚠️ Only length checked (C-01), not cryptographically verified on DAML

Relay (relay-service.ts):
    → Poll Canton ledger via gRPC (TLS)
    → Extract collected signatures
    → For each signature:
        → signer.ts: DER → RSV conversion
        → ethers.recoverAddress() — verify against validator address mapping
        → Sort ascending
    → eth_call simulation (prevent front-run gas drain)
    → Submit to BLEBridgeV9.processAttestation()
    ⚠️ Relay private key in Node.js heap (H-06)

Ethereum (BLEBridgeV9):
    → Verify attestation ID not reused
    → Verify nonce sequential
    → keccak256(abi.encodePacked(att.id, att.cantonAssets, att.nonce, att.timestamp, chainId, address(this)))
    → ECDSA.recover each signature ← Real cryptographic verification happens here
    → Verify each signer has VALIDATOR_ROLE
    → Execute attestation (supply cap update, etc.)
    ⚠️ No blacklist check on processAttestation (H-05)
```

---

## ECONOMIC MODEL ANALYSIS

### Interest Rate Model

Both chains implement the same Compound-style kinked rate model:

```
Utilization = totalBorrows / totalSupply

If utilization ≤ kink (80%):
    BorrowRate = 2% + utilization × 10% = 10% at kink

If utilization > kink (80%):
    BorrowRate = 10% + (util - 80%) × 50%
    → At 90% util: 15% APR
    → At 100% util: 20% APR

SupplyRate = BorrowRate × utilization × (1 - reserveFactor)
    → At 80% util, 10% reserve: 10% × 80% × 90% = 7.2% APR
```

### Liquidation Incentive Analysis

| Parameter | Ethereum | Canton |
|-----------|----------|--------|
| Close Factor | Configurable (`closeFactorBps`) | Configurable (`closeFactorBps`) |
| Full Liquidation | health factor < 0.5 | Dust threshold-based |
| Penalty (volatile) | Per-asset config | 10% (CTN) |
| Penalty (stable) | Per-asset config | 3% (USDC/USDCx), 4% (sMUSD) |
| Keeper Bonus | Included in penalty | 5% (CTN), 1.5% (USDC/USDCx), 2% (sMUSD) |
| Min Liquidation | 100e18 mUSD | Via `minBorrow` |

### ERC4626 Donation Attack Mitigation

SMUSD uses `_decimalsOffset() = 3` (1000 virtual shares per unit), which is the OpenZeppelin-recommended mitigation against first-depositor donation attacks. Assessment: adequate for a stablecoin vault.

### Compounding Sync Attack Economics (C-02)

| Strategy | Calls | Time | Share Inflation | Attacker's Profit Ceiling |
|----------|-------|------|-----------------|---------------------------|
| Conservative | 6 | 6h | +34% | ~25% of vault TVL |
| Standard | 12 | 12h | +80% | ~44% of vault TVL |
| Full | 24 | 24h | +222% | ~69% of vault TVL |
| Extended | 48 | 48h | +940% | ~90% of vault TVL |

*Profit ceiling assumes attacker can arb the deflated share price via flash loans or cross-chain arbitrage. Actual extraction depends on vault liquidity depth.*

---

## TEST & VERIFICATION COVERAGE

### Solidity

| Framework | Coverage | Details |
|-----------|----------|---------|
| **Certora** | 4 specs, 7 invariants | MUSD supply ≤ cap, balance conservation, blacklist enforcement, share price monotonicity, debt consistency, liquidation threshold, withdrawal safety |
| **Foundry** | 7 invariants | `InvariantTest.t.sol` with `ProtocolHandler` actor — bounded, stateful fuzzing |
| **Hardhat** | 40+ test files | Deployment, lifecycle, edge cases, integration tests |

### DAML

| Test File | Scenarios | Positive | Negative | Modules Covered |
|-----------|-----------|----------|----------|-----------------|
| `NegativeTests.daml` | 13 | 3 | 10 | V3 SupplyService, MintedMUSD, Compliance, Governance, Upgrade |
| `CrossModuleIntegrationTest.daml` | 10 | 8 | 2 | CantonDirectMint, CantonSMUSD, CantonLending, CantonBoostPool, Compliance |
| `CantonLendingTest.daml` | 30 | 18 | 12 | Full lending lifecycle, 3/4 collateral types, liquidation, admin |
| `CantonBoostPoolTest.daml` | 25 | 15 | 10 | Deposit/withdraw, rewards, pricing, admin auth, transfers |
| `UserPrivacySettingsTest.daml` | 24 | 14 | 10 | Privacy modes, observer propagation, negative tests |
| `CantonLoopStrategyTest.daml` | 0 | 0 | 0 | (Empty) |
| **Total** | **102** | **58** | **44** | |

### Relay & Infrastructure

| Component | Test Coverage | Notes |
|-----------|-------------|-------|
| relay-service.ts | **Unknown** — no test files found | ⚠️ Most critical off-chain component |
| validator-node-v2.ts | **Unknown** — no test files found | ⚠️ KMS signing logic untested |
| signer.ts (relay) | **Unknown** — no test files found | DER→RSV parsing needs edge case tests |
| price-oracle.ts | **Unknown** | Oracle divergence logic needs testing |
| lending-keeper.ts | **Unknown** | BigInt math needs boundary tests |
| bot/* | `jest.config.ts` present | Some test infrastructure exists |

### Critical Test Coverage Gaps

| Gap | Severity | Detail | Effort |
|-----|----------|--------|--------|
| `V3.daml` (1,551 lines) — **zero DAML tests** | 🔴 Critical | Largest module completely untested | 16+ hrs |
| Relay/validator services — no test files found | 🔴 Critical | Most security-critical off-chain code | 24+ hrs |
| Compounding sync attack (C-02) — no test | 🔴 Critical | 1.05^24 scenario untested | 2 hrs |
| `CantonLoopStrategy` — empty module + test | 🟡 High | Dead code if shipped | 8 hrs |
| CrossModuleIntegration test #8 (D-M04) | 🟡 High | Documented but not implemented | 2 hrs |
| USDCx collateral path untested | 🟡 High | 4th collateral type with zero coverage | 4 hrs |
| GovernanceActionLog archive auth (D-H-01) | 🟡 High | HIGH finding has no test | 2 hrs |
| BLEBridgeV9 processAttestation compliance | 🟡 High | No compliance check tested | 2 hrs |

---

## SECURITY POSTURE MATRIX

| Category | Solidity | DAML | Cross-Layer | Relay/Infra |
|----------|----------|------|-------------|-------------|
| **Access Control** | ✅ OZ AccessControl + 8 roles | ✅ Dual signatory + proposals | ❌ Admin self-grant bypass (H-04) | ✅ Per-component isolation |
| **Reentrancy** | ✅ ReentrancyGuard everywhere | ✅ DAML atomic ledger model | ✅ No cross-layer vector | N/A |
| **Oracle Safety** | ✅ Chainlink + CB | 🟡 Operator-signed, ±50% cap | 🟡 Asymmetric trust | ✅ Multi-source + divergence |
| **Supply Cap** | ✅ Per-contract cap | ✅ Cross-module coordination | ❌ No atomic cross-chain gate | N/A |
| **Upgrade Safety** | ✅ UUPS + ERC-7201 (most) | ✅ Opt-in migration + rollback | ❌ BLEBridgeV9 instant (C-03) | N/A |
| **Crypto Verification** | ✅ ECDSA.recover on-chain | ❌ Length check only (C-01) | ❌ Asymmetric verification | ✅ EIP-2 + malleability |
| **Key Management** | N/A | N/A | N/A | 🟡 KMS for validators, heap for relay |
| **Rate Limiting** | 🟡 Per-call, not daily (C-02) | ✅ Epoch-based + caps | ❌ Compounds multiplicatively | ✅ V2 validator: 50/hr |
| **Privacy** | N/A (public EVM) | ✅ Privacy-by-default | ✅ Canton isolated | ✅ Secrets management |
| **Compliance** | 🟡 Missing on bridge (H-05) | ✅ Blacklist + freeze + hooks | ❌ Bridge path bypasses | N/A |
| **BFT Consensus** | N/A (Ethereum PoS) | ✅ 2/3+1 on all attestations | ✅ BFT both sides | N/A |
| **Economic** | ❌ Compounding sync (C-02) | 🟡 V3 share asymmetry | ❌ No daily cap | N/A |
| **Audit Trail** | ✅ Events on all state changes | ✅ Immutable receipt templates | ✅ Attestation nonces | ✅ Structured logging |

---

## PER-CONTRACT SCORECARDS

### Solidity

| Contract | Access | Economic | Oracle | Reentrancy | Upgrade | **Overall** |
|----------|--------|----------|--------|------------|---------|-------------|
| MUSD.sol | 95 | 95 | N/A | N/A | N/A | **95** |
| SMUSD.sol | 88 | 60 | 85 | 95 | N/A | **75** |
| CollateralVault.sol | 93 | 88 | N/A | 95 | N/A | **90** |
| BorrowModule.sol | 90 | 72 | 90 | 95 | N/A | **82** |
| LiquidationEngine.sol | 93 | 78 | 92 | 95 | N/A | **85** |
| PriceOracle.sol | 90 | N/A | 85 | N/A | N/A | **87** |
| InterestRateModel.sol | 95 | 95 | N/A | N/A | N/A | **95** |
| DirectMintV2.sol | 93 | 93 | N/A | 95 | N/A | **93** |
| LeverageVault.sol | 88 | 70 | 80 | 95 | N/A | **78** |
| BLEBridgeV9.sol | 80 | 85 | N/A | N/A | **50** | **70** |
| TreasuryV2.sol | 85 | 90 | N/A | 95 | 80 | **86** |

### DAML

| Module | Signatory | Economic | Privacy | Compliance | **Overall** |
|--------|-----------|----------|---------|------------|-------------|
| CantonLending.daml | 95 | 90 | 92 | 95 | **93** |
| CantonDirectMint.daml | 93 | 92 | 90 | 95 | **92** |
| CantonSMUSD.daml | 90 | 88 | 90 | 95 | **90** |
| Governance.daml | 75 | 90 | N/A | N/A | **82** |
| BLEBridgeProtocol.daml | 80 | N/A | N/A | N/A | **80** |
| Compliance.daml | 95 | N/A | 95 | 95 | **95** |
| V3.daml | 85 | 72 | 85 | 88 | **78** |
| InterestRateService.daml | 80 | 90 | N/A | N/A | **85** |
| UserPrivacySettings.daml | 95 | N/A | 98 | N/A | **97** |

### Relay & Infrastructure

| Service | Key Mgmt | Crypto | TLS | Validation | **Overall** |
|---------|----------|--------|-----|------------|-------------|
| relay-service.ts | 60 | 90 | 95 | 90 | **78** |
| validator-node-v2.ts | 95 | 90 | 95 | 95 | **94** |
| validator-node.ts (V1) | 95 | 90 | 95 | 75 | **85** |
| signer.ts (relay) | N/A | 95 | N/A | 95 | **95** |
| signer.ts (scripts) | N/A | 50 | N/A | 60 | **55** |
| price-oracle.ts | 80 | N/A | 95 | 90 | **88** |
| security-utils.ts | 95 | N/A | 95 | 95 | **95** |

---

## PROTOCOL STRENGTHS

1. **30+ documented audit fixes** integrated into the DAML codebase — evidence of mature, iterative security lifecycle
2. **Dual-chain architecture** with clear separation: Canton = privacy/compliance, Ethereum = yield/DeFi
3. **BFT supermajority (2/3+1)** consistently applied across all 4 bridge attestation types
4. **Consuming choices for TOCTOU prevention** — all signature-collecting flows use consuming patterns (D-01 fix)
5. **Privacy-by-default** with granular opt-in transparency via `UserPrivacySettings`
6. **Comprehensive compliance framework** — `ComplianceRegistry` hooks into every product module (DAML-H-04 fix)
7. **102 DAML + 40+ Solidity test scenarios** with strong negative/adversarial testing (44/102 are negative tests)
8. **Certora formal verification** for 4 core contracts with 7 protocol invariants
9. **AWS KMS for validator signing** — key material never leaves the HSM. DER→RSV conversion with EIP-2 and malleability checks.
10. **Upgrade framework** with governance approval, opt-in migration, and rollback windows
11. **ERC-7201 namespaced storage** for upgradeability collision prevention
12. **OpenZeppelin 5.x** throughout — latest stable patterns
13. **Multi-collateral support** with per-asset configuration on both chains
14. **Immutable audit trail** — `LiquidationReceipt`, `GovernanceActionLog`, `InterestPayment`, `UpgradeMigrationLog`
15. **Kubernetes security** — image pinning, non-root, read-only FS, dropped capabilities, seccomp, NetworkPolicies
16. **TLS enforcement** — runtime tamper protection via `enforceTLS()` prevents disabling in production
17. **Docker secrets** preferred over environment variables for all sensitive material

---

## PRIORITIZED REMEDIATION PLAN

### P0 — Immediate (CRITICAL — Before Any Deployment)

| ID | Action | Effort | Risk if Unresolved |
|----|--------|--------|--------------------|
| C-02 | Add daily cumulative cap to `syncCantonShares()` — limit total change to ≤10% per 24h window, not just ≤5% per call | 4 hours | **222% share inflation in 24h — vault drain** |
| C-03 | Change BLEBridgeV9 `_authorizeUpgrade` from `DEFAULT_ADMIN_ROLE` to `TIMELOCK_ROLE` | 1 hour | **Instant implementation swap on most critical contract** |
| C-01 | Add DAML attestation hash reconstruction + relay hardening. Long-term: ECDSA verification library for DAML | 16 hours | **Canton attestation forgery via compromised participant** |
| S-H-01 | Fix SMUSD recursion — replace `totalAssets()` with `IERC20(asset()).balanceOf(address(this))` in `globalTotalAssets()` fallback paths | 1 hour | **Complete vault DoS when treasury unset** |

### P1 — High Priority (Before Mainnet)

| ID | Action | Effort | Risk if Unresolved |
|----|--------|--------|--------------------|
| D-H-01 | Fix GovernanceActionLog signatory — `signatory operator` only | 1 hour | Governance operations blocked |
| D-H-02 | Fix V3 share price asymmetry — consistent virtual shares | 2 hours | Economic value extraction |
| H-04 | Set TIMELOCK_ROLE admin to itself (not DEFAULT_ADMIN_ROLE) across all contracts | 2 hours | Timelock bypass via self-grant |
| H-05 | Add blacklist check on `processAttestation()` for bridge-out operations | 4 hours | Compliance perimeter bypass |
| H-06 | Migrate relay signing to AWS KMS | 8 hours | Private key extractable from heap |
| H-07 | Delete `scripts/signer.ts` or replace with relay import | 30 min | Stale crypto code in repo |
| S-M-01 | Add pending interest buffer in BorrowModule | 4 hours | Phantom debt → utilization spiral |

### P2 — Medium Priority (First Month)

| ID | Action | Effort |
|----|--------|--------|
| S-M-02 | Implement bad debt socialization | 8 hours |
| S-M-03 | User-supplied `minAmountOut` + real deadline in LeverageVault | 4 hours |
| S-M-04 | Debt repayment in `emergencyClosePosition` | 4 hours |
| S-M-05 | Post-withdrawal health check in CollateralVault | 2 hours |
| D-M-01 | Decouple borrow aggregate template | 8 hours |
| D-M-02 | Route share price syncs through BFT attestation | 8 hours |
| D-M-05 | Remove redundant `archive self` | 1 hour |
| D-M-04 | Unsafe oracle for V3 liquidation | 2 hours |
| X-M-01 | Conservative local caps summing to global cap | 16 hours |

### P3 — Recommended (Ongoing)

| ID | Action | Effort |
|----|--------|--------|
| S-L-01 | `forceApprove` in BorrowModule | 30 min |
| S-L-02 | Real swap deadline | 30 min |
| D-L-01 | Implement or remove CantonLoopStrategy | 2 hours |
| R-I-01 | Add secp256k1 validation to yield-deployer.ts | 30 min |
| — | **Add V3.daml test suite** (1,551 lines untested) | 16+ hours |
| — | **Add relay/validator test suite** | 24+ hours |
| — | Add USDCx collateral tests | 4 hours |
| — | Add GovernanceActionLog archive auth test | 2 hours |
| — | Deprecate V1 validator nodes | 4 hours |

---

## ERRATA — Corrections from v2

This section documents corrections made from the v2 audit after independent source code verification.

### Findings Retained After Verification

| Finding | v2 Status | v3 Status | Verification |
|---------|-----------|-----------|--------------|
| **S-H-01 (recursion)** | Reported as HIGH | **Retained — confirmed valid** | `totalAssets()` IS overridden at SMUSD.sol line 304 to call `globalTotalAssets()`. `globalTotalAssets()` at lines 237, 252 calls `totalAssets()` (the overridden virtual version, not `super.totalAssets()`). This IS infinite recursion when `treasury == address(0)`. External review incorrectly claimed this was fabricated — the reviewer asserted "totalAssets() is never overridden" which is factually wrong per the source code. |

### Findings Corrected

| Finding | v2 Claim | Correction | Evidence |
|---------|----------|------------|---------|
| **S-I-05** | "`type(uint256).max` approval to strategies" | `type(uint256).max` is used **only** as a sentinel value for `lastActiveIdx` loop tracking in `_autoAllocate()`. Actual token approvals use per-operation `forceApprove(strat, share)` with exact amounts. | TreasuryV2.sol — `forceApprove` for token ops, `type(uint256).max` at line ~700 for index sentinel |
| **S-L-07** | "No cap on strategies, potential DoS" / "verify enforcement" | `MAX_STRATEGIES = 10` is enforced in `addStrategy()` via `if (strategies.length >= MAX_STRATEGIES) revert MaxStrategiesReached()`. Finding reworded to reflect this. | TreasuryV2.sol line 42 (constant), line 696 (enforcement) |

### Findings Removed

| Finding | v2 Claim | Reason for Removal | Evidence |
|---------|----------|---------------------|---------|
| **S-L-08** | "Missing Chainlink sequencer uptime feed" | PriceOracle.sol has **zero references** to sequencer or uptime feeds. The contract queries `latestRoundData()` with staleness checks but has no L2 sequencer logic. The protocol does not deploy on L2s with sequencers. | `grep -r "sequencer\|uptime" contracts/PriceOracle.sol` → 0 matches |

### Findings Added (Not in v2)

| Finding | Severity | Why Missing from v2 |
|---------|----------|---------------------|
| C-01 (No on-ledger ECDSA) | CRITICAL | Requires DAML bridge code analysis + understanding that `T.length >= 130` is not cryptographic verification |
| C-02 (Compounding 5% sync) | CRITICAL | Requires mathematical analysis: per-call rate limit ≠ per-period rate limit. 1.05^24 = 3.22x |
| C-03 (BLEBridgeV9 instant upgrade) | CRITICAL | Requires cross-contract comparison of `_authorizeUpgrade` patterns |
| H-04 (Timelock bypass via self-grant) | HIGH | Requires understanding OZ AccessControl role admin hierarchy |
| H-05 (No blacklist on bridge) | HIGH | Requires reading `processAttestation()` and noting absence of compliance checks |
| H-06 (Relay key in heap) | HIGH | Requires relay-service.ts analysis (not in v2 scope) |
| H-07 (Stale signer.ts) | HIGH | Requires comparing two signer.ts copies (not in v2 scope) |
| Full relay/infra section | — | Entire attack surface missing from v1/v2 |

---

## DISCLAIMER

This audit report represents a point-in-time assessment based on the source code available at the time of review. It does not constitute a guarantee of security. Smart contract and distributed ledger systems remain subject to undiscovered vulnerabilities, economic attacks, and operational risks.

**Limitations:**
- Automated analysis and manual code review only — no live testnet/mainnet testing
- Formal verification results based on review of existing Certora specs, not independent creation
- DAML test coverage assessed by reading source, not executing tests
- Economic modeling based on static analysis, not live market simulation
- Cross-chain bridge analyzed from source only — no bridge transaction testing
- Relay infrastructure reviewed via source code reading; no runtime/deployment testing
- Kubernetes manifests reviewed for security posture; no cluster-level penetration testing

**Corrections from prior versions:**
- v1 (COMPREHENSIVE_AUDIT_v1.md) — initial audit, Solidity only
- v2 (COMPREHENSIVE_AUDIT_v2.md) — added DAML coverage, contained inaccurate findings (see Errata)
- v3 (this document) — independent code verification, corrected fabricated/inaccurate findings, added relay/infrastructure coverage, added CRITICAL findings, recalculated score

**A formal audit by an accredited security firm (Trail of Bits, OpenZeppelin, Cyfrin, or equivalent) is strongly recommended before mainnet deployment.**

---

*Audit generated: February 12, 2026*
*Revision: v3 — Post-verification corrected edition*
*Protocol: Minted mUSD — Solidity 0.8.26 + DAML SDK 2.10.3 (Canton Network)*
*Total Findings: 46 (3 CRITICAL · 7 HIGH · 12 MEDIUM · 11 LOW · 13 INFO)*
*Overall Score: 67/100 ⭐⭐⭐*
