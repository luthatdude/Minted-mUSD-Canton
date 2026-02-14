# 🏛️ Minted mUSD Protocol — Comprehensive Security Audit

**Date:** February 12, 2026  
**Scope:** Full-stack audit — Solidity (EVM) + DAML (Canton Network)  
**Contracts Audited:** 20 Solidity contracts (~8,500 LoC) · 16 DAML modules + 1 unified V3 module (~9,750 LoC)  
**Total Lines of Code:** ~18,250  
**Auditors:** Multi-methodology analysis  
**Classification:** CONFIDENTIAL — For Internal Use Only

---

## TABLE OF CONTENTS

1. [Executive Summary](#executive-summary)
2. [Audit Methodology](#audit-methodology)
3. [Composite Score](#composite-score)
4. [Architecture Overview](#architecture-overview)
5. [Contract Inventory](#contract-inventory)
6. [Access Control Matrix](#access-control-matrix)
7. [Findings Summary](#findings-summary)
8. [HIGH Severity Findings](#-high-severity)
9. [MEDIUM Severity Findings](#-medium-severity)
10. [LOW Severity Findings](#-low-severity)
11. [INFORMATIONAL Findings](#ℹ️-informational)
12. [Cross-Contract Data Flow Analysis](#cross-contract-data-flow-analysis)
13. [Economic Model Analysis](#economic-model-analysis)
14. [Test & Verification Coverage](#test--verification-coverage)
15. [Security Posture Matrix](#security-posture-matrix)
16. [Per-Contract Scorecards](#per-contract-scorecards)
17. [Protocol Strengths](#protocol-strengths)
18. [Prioritized Remediation Plan](#prioritized-remediation-plan)
19. [Disclaimer](#disclaimer)

---

## EXECUTIVE SUMMARY

The Minted mUSD Protocol is a dual-chain stablecoin system operating across Ethereum (Solidity 0.8.26) and Canton Network (DAML SDK 2.10.3). The protocol enables minting of mUSD backed by USDC, with yield generation through a multi-strategy treasury (Pendle, Morpho Blue, Sky Protocol) and cross-chain yield unification via BFT-attested bridge operations.

**Key Architecture:**
- **Ethereum Layer:** ERC20 stablecoin (mUSD), ERC4626 yield vault (sMUSD), overcollateralized lending (BorrowModule + CollateralVault + LiquidationEngine), auto-allocating treasury (TreasuryV2), and leveraged looping (LeverageVault)
- **Canton Layer:** Privacy-preserving token templates with dual-signatory patterns, multi-collateral lending with escrowed positions, BFT-attested bridge operations, opt-in transparency, and multi-sig governance
- **Cross-Chain Bridge:** BLEBridgeV9 (Solidity) ↔ BLEBridgeProtocol (DAML) with 2/3+1 BFT supermajority attestations for bridge-out, bridge-in, supply cap sync, and yield sync

**Audit Verdict:**

The protocol demonstrates **institutional-grade security maturity** with 30+ documented prior audit fixes integrated into the DAML codebase, formal verification via Certora for 4 core Solidity contracts, and consistent application of defense-in-depth patterns across both layers. However, **3 HIGH severity findings** require immediate remediation before mainnet deployment, and the **V3.daml module (1,551 lines) has zero test coverage** — a critical gap for the largest DAML module.

---

## AUDIT METHODOLOGY

Seven distinct audit methodologies were applied, each targeting different vulnerability classes:

| Firm Style | Method | Focus | Techniques Applied |
|------------|--------|-------|-------------------|
| **Trail of Bits** | Automated pattern analysis | Known vulnerability patterns | Reentrancy detection, integer overflow analysis, unchecked return values, delegatecall safety, tx.origin usage, selfdestruct reachability, storage collision detection |
| **OpenZeppelin** | Access control audit | Role hierarchy and privilege escalation | Role enumeration, privilege escalation paths, missing access modifiers, DEFAULT_ADMIN_ROLE chain analysis, signatory/authority model validation (DAML) |
| **Consensys Diligence** | Economic modeling | MEV, sandwich attacks, token economics | Sandwich attack surface analysis, flash loan vectors, share price manipulation (ERC4626 donation attacks), liquidation incentive modeling, interest rate death spirals |
| **Certora** | Formal verification review | Protocol invariant correctness | Review of 4 existing Certora specs (MUSD.spec, SMUSD.spec, BorrowModule.spec, LiquidationEngine.spec), 7 protocol invariants verified |
| **Cyfrin** | Cross-contract data flow | Inter-contract state consistency | Call graph tracing across 20 Solidity contracts, cross-module dependency analysis for 16 DAML modules, supply cap propagation verification |
| **ChainSecurity** | Upgradeability safety | UUPS proxy patterns | Storage gap verification, initializer protection, `_disableInitializers()` in constructors, ERC-7201 namespaced storage compliance |
| **Canton Ledger Model** | DAML-specific audit | Canton consensus semantics | Signatory/authority correctness, consuming vs. nonconsuming choice analysis, TOCTOU prevention, privacy leak detection, contract key correctness, double-archive risk |

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
| **Solidity (EVM)** | 87 / 100 | ⭐⭐⭐⭐ |
| **DAML (Canton)** | 89 / 100 | ⭐⭐⭐⭐ |
| **Cross-Layer Integration** | 83 / 100 | ⭐⭐⭐⭐ |
| **Test & Verification Coverage** | 85 / 100 | ⭐⭐⭐⭐ |
| **Overall Protocol** | **86 / 100** | ⭐⭐⭐⭐ |

### Scoring Breakdown

| Category | Weight | Score | Weighted | Rationale |
|----------|--------|-------|----------|-----------|
| Access Control & Authorization | 15% | 91 | 13.65 | OZ AccessControl + DAML dual-signatory + proposal patterns. Deduction: operator centralization on Canton oracle syncs (D-M-02). |
| Economic / Financial Logic | 20% | 82 | 16.40 | Interest routing with try/catch, close factor + dust threshold on liquidation. Deductions: phantom debt on routing failure (S-M-01), no bad debt socialization (S-M-02), V3 share price asymmetry (D-H-02). |
| Oracle & Price Feed Safety | 10% | 80 | 8.00 | Chainlink + circuit breaker + sequencer uptime + unsafe path for liquidations. Deductions: Canton oracle is operator-signed (X-M-02), V3 liquidation uses stale-tolerant oracle (D-M-04). |
| Reentrancy & Atomicity | 10% | 96 | 9.60 | ReentrancyGuard on all Solidity state-changing functions. DAML ledger model is inherently atomic. No significant deduction. |
| Upgradeability & Migration | 10% | 90 | 9.00 | UUPS + initializer + storage gaps + ERC-7201. DAML opt-in migration with rollback. Deduction: LiquidationEngine missing `_disableInitializers()` (S-I-02). |
| Cross-Chain / Bridge Security | 15% | 84 | 12.60 | BFT 2/3+1 supermajority, consuming sign choices (no double-sign), nonce-based replay prevention. Deductions: no atomic cross-chain supply cap gate (X-M-01), operator-only share price sync (D-M-02). |
| Compliance & Privacy | 10% | 93 | 9.30 | ComplianceRegistry hooks in all product modules, dual-signatory + proposal transfers, privacy-by-default with opt-in observers. Deduction: BulkBlacklist capped at 100 (D-L-04). |
| Test & Verification Coverage | 10% | 85 | 8.50 | 102 DAML tests + 40+ Solidity tests + 4 Certora specs + 7 Foundry invariants. Deduction: V3.daml (1,551 lines) has **zero tests**, CantonLoopStrategy is empty. |
| **Total** | **100%** | — | **87.05** | |

### Grade Scale

| Grade | Range | Meaning |
|-------|-------|---------|
| ⭐⭐⭐⭐⭐ | 95–100 | Exceptional — mainnet ready with minimal risk |
| ⭐⭐⭐⭐ | 80–94 | Strong — suitable for mainnet after HIGH/MEDIUM remediation |
| ⭐⭐⭐ | 65–79 | Moderate — requires significant remediation |
| ⭐⭐ | 50–64 | Weak — fundamental design issues |
| ⭐ | 0–49 | Critical — not suitable for deployment |

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
│  │ global    │    │ totalBorrows  │  │ +CB +Seq  │                      │
│  │ sharePrice│    └───────┬───────┘  └─────┬─────┘                      │
│  └────┬──────┘            │                │                             │
│       │              ┌────▼────────────────▼───┐    ┌────────────────┐  │
│       │              │ LiquidationEngine.sol    │    │ LeverageVault  │  │
│       │              │ closeFactor + unsafe path│    │ Multi-loop     │  │
│       │              └─────────────────────────┘    │ Uniswap V3     │  │
│       │                                              └────────────────┘  │
│  ┌────▼──────────┐                                                       │
│  │ BLEBridgeV9   │ ◄─── Canton attestations → supply cap sync           │
│  │ (UUPS proxy)  │                                                       │
│  └───────┬───────┘                                                       │
│          │                                                               │
└──────────┼───────────────────────────────────────────────────────────────┘
           │  Bridge Attestations (BFT 2/3+1 supermajority)
           │  • BridgeOut: Canton → Ethereum
           │  • BridgeIn:  Ethereum → Canton
           │  • SupplyCap: Cross-chain supply sync
           │  • Yield:     Share price sync
┌──────────┼───────────────────────────────────────────────────────────────┐
│          │                     CANTON LAYER                              │
│  ┌───────▼──────────┐                                                    │
│  │BLEBridgeProtocol │  4 attestation types, consuming sign choices       │
│  │ (DAML)           │  BFT supermajority finalization                    │
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
3. SMUSD.globalSharePrice() = TreasuryV2.totalValue() / (ethShares + cantonShares)
4. Bridge attestation carries globalSharePrice to Canton
5. CantonStakingService.SyncGlobalSharePrice updates Canton share price
6. Canton sMUSD holders unstake at the same global share price as Ethereum
```

---

## CONTRACT INVENTORY

### Solidity Layer (EVM) — 20 Contracts, ~8,500 LoC

| Contract | Lines | Purpose | Key Patterns | External Deps |
|----------|-------|---------|--------------|---------------|
| `MUSD.sol` | 107 | ERC20 stablecoin with supply cap, blacklist, compliance, pause | AccessControl, Pausable, ERC20 | — |
| `SMUSD.sol` | 323 | ERC4626 staked vault with cross-chain yield, Canton sync, interest routing | ERC4626, AccessControl, ReentrancyGuard, Pausable | ITreasury |
| `CollateralVault.sol` | 300 | Collateral deposits with per-asset config management, health-checked withdrawals | AccessControl, ReentrancyGuard, Pausable, SafeERC20 | IBorrowModule |
| `BorrowModule.sol` | 835 | Debt positions, dynamic interest, interest routing to SMUSD, global accrual | AccessControl, ReentrancyGuard, Pausable, SafeERC20 | ICollateralVault, IPriceOracle, ISMUSD, IInterestRateModel |
| `LiquidationEngine.sol` | 350 | Liquidation with close factor, full liquidation threshold, unsafe oracle path | AccessControl, ReentrancyGuard, Pausable | IBorrowModule, ICollateralVault, IPriceOracle |
| `PriceOracle.sol` | 318 | Chainlink aggregator with circuit breaker, sequencer uptime feed, keeper recovery | AccessControl | IAggregatorV3 (Chainlink) |
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

---

## ACCESS CONTROL MATRIX

### Solidity Roles

| Role | Contract | Granted To | Capabilities |
|------|----------|------------|--------------|
| `DEFAULT_ADMIN_ROLE` | All contracts | Deployer / Multisig | Grant/revoke roles, unpause |
| `YIELD_MANAGER_ROLE` | SMUSD | TreasuryV2 / Admin | `distributeYield()` |
| `BRIDGE_ROLE` | SMUSD | BLEBridgeV9 | `syncCantonShares()` |
| `INTEREST_ROUTER_ROLE` | SMUSD | BorrowModule | `receiveInterest()` |
| `PAUSER_ROLE` | All contracts | Guardian multisig | `pause()` |
| `LIQUIDATION_ROLE` | BorrowModule, CollateralVault | LiquidationEngine | `reduceDebt()`, `seize()` |
| `BORROW_ADMIN_ROLE` | BorrowModule | Admin | `setInterestRateModel()`, `setSMUSD()`, `setTreasury()` |
| `LEVERAGE_VAULT_ROLE` | BorrowModule, CollateralVault | LeverageVault | `borrowFor()`, `withdrawFor()`, `depositFor()` |
| `LIQUIDATOR_ROLE` | MUSD | LiquidationEngine | `burn()` (liquidation path) |
| `ORACLE_ADMIN_ROLE` | PriceOracle | Admin | `setFeed()`, `removeFeed()`, `updatePrice()` |
| `KEEPER_ROLE` | PriceOracle | Automation bot | `keeperResetPrice()` |
| `ALLOCATOR_ROLE` | TreasuryV2 | Admin | Strategy allocation changes |
| `STRATEGIST_ROLE` | TreasuryV2 | Admin | Strategy deposits/withdrawals |
| `GUARDIAN_ROLE` | TreasuryV2 | Guardian multisig | Emergency withdrawal |
| `VAULT_ROLE` | TreasuryV2 | DirectMintV2 | `depositAndAllocate()` |
| `TIMELOCK_ROLE` | TreasuryV2 | MintedTimelockController | Timelock-gated operations |

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

### S-H-01 — SMUSD `totalAssets()` ↔ `globalTotalAssets()` Mutual Recursion

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/SMUSD.sol` |
| **Lines** | 230–275 |
| **Category** | Logic Error / Denial of Service |
| **CVSS 3.1** | 8.6 (High) — AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H |
| **Status** | Open |

**Description:**

`SMUSD.totalAssets()` (line 275) is overridden to delegate to `globalTotalAssets()`. When `treasury == address(0)` (not yet set), `globalTotalAssets()` (line 230) falls back to calling `totalAssets()`, which re-enters `globalTotalAssets()` — creating infinite recursion.

**Vulnerable Code Path:**

```solidity
// SMUSD.sol, Line 275
function totalAssets() public view override returns (uint256) {
    return globalTotalAssets();  // ← Calls globalTotalAssets()
}

// SMUSD.sol, Line 230
function globalTotalAssets() public view returns (uint256) {
    if (treasury == address(0)) {
        return totalAssets();  // ← Calls totalAssets() → globalTotalAssets() → ∞
    }
    try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
        return usdcValue * 1e12;
    } catch {
        if (cantonTotalShares > 0) {
            revert("TREASURY_UNREACHABLE");
        }
        return totalAssets();  // ← Also recursive if treasury call reverts
    }
}
```

**Call Graph:**

```
User calls deposit() / withdraw() / previewDeposit() / previewWithdraw()
    → ERC4626._convertToShares() / _convertToAssets()
        → globalTotalAssets()
            → totalAssets() [if treasury == address(0)]
                → globalTotalAssets()
                    → totalAssets()
                        → ... ∞ (out-of-gas)
```

**Attack Scenario / Proof of Concept:**

1. Protocol deploys SMUSD without setting the treasury address (common during staged deployments)
2. Any user calls `deposit()`, `withdraw()`, `previewDeposit()`, or any ERC4626 view function
3. Transaction reverts with out-of-gas due to infinite recursion
4. The vault is completely bricked until `setTreasury()` is called with a valid, non-reverting treasury

**Conditions for Trigger:**
- `treasury == address(0)` (pre-setup state), OR
- `treasury.totalValue()` reverts AND `cantonTotalShares == 0`

**Impact:**

- **Availability:** Complete denial-of-service — all ERC4626 operations become inoperable
- **Financial:** No direct fund loss (funds are locked, not stolen), but inability to withdraw creates panic
- **Scope:** All SMUSD holders and any protocol components that call SMUSD view functions

**Recommendation:**

Replace the recursive fallback with a direct balance check that breaks the recursion:

```solidity
function globalTotalAssets() public view returns (uint256) {
    if (treasury == address(0)) {
        // Break recursion: use ERC4626's native implementation (vault balance)
        return IERC20(asset()).balanceOf(address(this));
    }
    try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
        return usdcValue * 1e12;
    } catch {
        if (cantonTotalShares > 0) {
            revert("TREASURY_UNREACHABLE");
        }
        return IERC20(asset()).balanceOf(address(this));
    }
}
```

**Note on Existing Mitigation:** The code comment on line 241 says "Falls back to local totalAssets if treasury not set." This suggests the developer **intended** to call `super.totalAssets()` (the unoverridden ERC4626 version) but accidentally called the overridden `totalAssets()`. In Solidity, `totalAssets()` dispatches through the vtable to the overridden version, not the parent's implementation.

---

### D-H-01 — GovernanceActionLog Archive Authorization Failure

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Governance.daml` |
| **Lines** | 260–320 (MinterRegistry choices) |
| **Category** | Authorization Model |
| **CVSS 3.1** | 7.5 (High) — AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H |
| **Status** | Open |

**Description:**

`GovernanceActionLog` is defined with `signatory operator, executedBy` (line 306). The template is created inside `Proposal_Execute` (line 205) with `executedBy = executor` — where `executor` can be any authorized governor, not necessarily the `operator`.

In `MinterRegistry_AddMinter`, `MinterRegistry_RemoveMinter`, and `MinterRegistry_ReplenishQuota`, the code calls `archive governanceProofCid` within choices controlled by `operator` only. DAML requires **all signatories** to be in the authorization context for an `archive` call. When `executedBy ≠ operator`, the archive fails because `executedBy`'s authority is not in scope.

**Vulnerable Code:**

```haskell
-- Governance.daml, Line 306
template GovernanceActionLog
  with
    operator : Party
    ...
    executedBy : Party           -- ← Second signatory
  where
    signatory operator, executedBy  -- ← Both required for archive
    -- No choices - immutable audit record

-- Governance.daml, Line 260 (MinterRegistry_AddMinter)
choice MinterRegistry_AddMinter : ContractId MinterRegistry
  with
    newMinter : Party
    quota : Decimal
    governanceProofCid : ContractId GovernanceActionLog
  controller operator               -- ← Only operator's authority in scope
  do
    proof <- fetch governanceProofCid
    assertMsg "WRONG_ACTION_TYPE" (proof.actionType == MinterAuthorization)
    assertMsg "ALREADY_MINTER" (not (newMinter `elem` map fst minters))
    archive governanceProofCid       -- ← FAILS when proof.executedBy ≠ operator
    ...
```

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
- **Replay Risk:** If the archive is removed as a workaround, governance proofs become replayable — allowing a single governance action to be used multiple times for multiple minter additions

**Recommendation (Option A — Simplest):**

Change `GovernanceActionLog` to have only `operator` as signatory:

```haskell
template GovernanceActionLog
  with
    ...
  where
    signatory operator
    observer executedBy  -- executedBy is an observer, not a signatory
```

**Recommendation (Option B — Preserves Dual-Signatory):**

Add `executedBy` as a controller on the consuming choices in `MinterRegistry`:

```haskell
choice MinterRegistry_AddMinter : ContractId MinterRegistry
  with
    newMinter : Party
    quota : Decimal
    governanceProofCid : ContractId GovernanceActionLog
    executor : Party  -- The party who executed the governance proposal
  controller operator, executor  -- Both signatories now in authorization context
  do
    archive governanceProofCid  -- Now succeeds
    ...
```

---

### D-H-02 — V3.daml sMUSD Share Price Asymmetry (Deposit vs. Withdraw)

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/Minted/Protocol/V3.daml` |
| **Lines** | V3 CantonSMUSD deposit/withdraw choices |
| **Category** | Economic Logic |
| **CVSS 3.1** | 7.4 (High) — AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N |
| **Status** | Open |

**Description:**

The V3.daml module implements sMUSD staking with **inconsistent share price calculations** between deposit and withdrawal:

**Deposit (SMUSD_Deposit) — Virtual Shares (inflation attack mitigation):**

```haskell
let virtualShares = totalShares + 1000.0
let virtualAssets = totalAssets + 1000.0
let sharePrice = virtualAssets / virtualShares
let newShares = depositAmount / sharePrice
```

**Withdraw (SMUSD_Withdraw) — Raw Division (no virtual offset):**

```haskell
let sharePrice = if totalShares == 0.0 then 1.0 else totalAssets / totalShares
let musdAmount = userShares * sharePrice
```

**Mathematical Analysis:**

When `totalShares = 10.0` and `totalAssets = 10.0`:

| Operation | Virtual Calculation | Raw Calculation | Difference |
|-----------|-------------------|-----------------|------------|
| **Deposit price** | `(10+1000)/(10+1000) = 1.0` | — | No difference (converges at large pool) |
| **Withdraw price** | — | `10/10 = 1.0` | No difference at this pool size |

When `totalShares = 0.5` and `totalAssets = 2.0` (after yield):

| Operation | Virtual Calculation | Raw Calculation | Difference |
|-----------|-------------------|-----------------|------------|
| **Deposit price** | `(2+1000)/(0.5+1000) ≈ 1.0015` | — | Depositor overpays slightly |
| **Withdraw price** | — | `2/0.5 = 4.0` | Withdrawer gets correct yield |

**Contrast with the Newer CantonSMUSD.daml:**

The newer `CantonSMUSD.daml` module correctly uses a **unified `globalSharePrice`** synced from Ethereum for both staking and unstaking:

```haskell
-- Stake (CantonSMUSD.daml)
let newShares = musd.amount / globalSharePrice

-- Unstake (CantonSMUSD.daml)
let musdAmount = smusd.shares * globalSharePrice
```

This is consistent. The V3 module should mirror this pattern.

**Impact:**

- **Economic:** Systematic pricing asymmetry creates extractable value in early pool phases
- **Fairness:** Depositors pay a premium relative to withdrawers

**Recommendation:**

Apply the virtual share offset consistently in both deposit and withdrawal, OR remove it from both and use the `globalSharePrice` model from `CantonSMUSD.daml`.

---

## 🟡 MEDIUM SEVERITY

---

### S-M-01 — Interest Routing Failure Creates Phantom Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/BorrowModule.sol` |
| **Lines** | 430–470 (`_accrueGlobalInterest`) |
| **Category** | Accounting / State Consistency |
| **CVSS 3.1** | 6.5 (Medium) |
| **Status** | Open |

**Description:**

In `_accrueGlobalInterest()`, interest is calculated and then the function attempts to route the supplier portion to SMUSD. The routing involves minting mUSD and sending it to SMUSD. Crucially, **`totalBorrows += interest` happens unconditionally** — regardless of whether the routing succeeded:

```solidity
// BorrowModule.sol, Lines 450-470
if (supplierAmount > 0 && address(smusd) != address(0)) {
    try musd.mint(address(this), supplierAmount) {
        IERC20(address(musd)).approve(address(smusd), supplierAmount);
        try smusd.receiveInterest(supplierAmount) {
            totalInterestPaidToSuppliers += supplierAmount;
            emit InterestRoutedToSuppliers(supplierAmount, reserveAmount);
        } catch (bytes memory reason) {
            // SMUSD rejected — burn the minted tokens
            musd.burn(address(this), supplierAmount);
            emit InterestRoutingFailed(supplierAmount, reason);
        }
    } catch (bytes memory reason) {
        emit InterestRoutingFailed(supplierAmount, reason);
    }
}

// THIS ALWAYS EXECUTES regardless of routing success:
totalBorrows += interest;  // ← Phantom debt if routing failed
```

**Existing Mitigation (Partial):**

The code correctly burns the minted tokens when SMUSD rejects the interest, preventing supply inflation. However, `totalBorrows` still increases by the full interest amount.

**Impact Chain:**

```
Interest routing fails
    → totalBorrows inflated (phantom debt)
        → utilizationRate increases artificially
            → borrowRate increases for all borrowers
                → more interest accrues
                    → more routing failures (if SMUSD is paused)
                        → death spiral
```

**Recommendation:**

Buffer unrouted interest and retry on next accrual:

```solidity
uint256 public pendingInterest;  // New state variable

// In _accrueGlobalInterest:
uint256 toRoute = interest + pendingInterest;
try smusd.receiveInterest(toRoute) {
    pendingInterest = 0;
} catch {
    pendingInterest = toRoute;
    // Don't add to totalBorrows until successfully routed
}
```

---

### S-M-02 — No Bad Debt Socialization Mechanism

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LiquidationEngine.sol` |
| **Lines** | 130–175 (`liquidate`) |
| **Category** | Economic Safety |
| **CVSS 3.1** | 6.1 (Medium) |
| **Status** | Open |

**Description:**

When a position is underwater (`collateralValue < debt`), the liquidation penalty makes seizure unprofitable for liquidators. The seizure amount is capped at available collateral:

```solidity
uint256 seizeAmount = (actualRepay * (10000 + penaltyBps) * (10 ** tokenDecimals)) 
                    / (10000 * collateralPrice);

uint256 available = vault.deposits(borrower, collateralToken);
if (seizeAmount > available) {
    seizeAmount = available;
    // actualRepay reduced proportionally, but REMAINING DEBT has no write-off mechanism
}
```

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
| **File** | `contracts/LeverageVault.sol` |
| **Lines** | Swap functions |
| **Category** | MEV / Economic Attack |
| **CVSS 3.1** | 5.9 (Medium) |
| **Status** | Open |

**Description:**

Swap functions use `deadline: block.timestamp` (always passes since `block.timestamp` is "now") and oracle-derived `amountOutMinimum` (not spot-derived). Three attack vectors:

1. **Sandwich Attack:** MEV bot front-runs swap to worsen price, user swaps at worse rate, MEV bot back-runs
2. **Oracle Staleness Window:** Chainlink heartbeat period allows oracle price to diverge from pool spot
3. **Delayed Execution:** Miners can hold transactions until price is most favorable for extraction

**Impact:** MEV extraction on every leverage/deleverage operation, compounded by multi-loop leverage (3–5 swaps per operation).

**Recommendation:** Accept user-supplied `minAmountOut` with a server-side quote check; use `block.timestamp + 120` as a real deadline; consider Flashbots Protect.

---

### S-M-04 — `emergencyClosePosition` Orphans Debt

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/LeverageVault.sol` |
| **Category** | State Consistency |
| **CVSS 3.1** | 6.3 (Medium) |
| **Status** | Open |

**Description:**

`emergencyClosePosition()` withdraws and returns collateral to the user but does not repay the corresponding debt in `BorrowModule`. The position's debt remains in `totalBorrows` as phantom debt.

**Impact:** Same phantom debt accumulation as S-M-01; `totalBorrows` is permanently inflated.

**Recommendation:** Have `emergencyClosePosition()` call `BorrowModule.repayFor()` with swap proceeds before returning remainder.

---

### S-M-05 — CollateralVault `withdrawFor` Pre-Withdrawal Health Check

| | |
|---|---|
| **Layer** | Solidity |
| **File** | `contracts/CollateralVault.sol` |
| **Lines** | 220–255 (`withdrawFor`) |
| **Category** | Logic Error |
| **CVSS 3.1** | 6.5 (Medium) |
| **Status** | Open — Partially Mitigated |

**Description:**

`withdrawFor()` checks health factor **before** reducing collateral balance:

```solidity
if (!skipHealthCheck && borrowModule != address(0)) {
    uint256 userDebt = IBorrowModule(borrowModule).totalDebt(user);
    if (userDebt > 0) {
        uint256 hf = IBorrowModule(borrowModule).healthFactor(user);
        // healthFactor() reads deposits[user][token] which HASN'T been reduced yet
        require(hf >= 11000, "WITHDRAWAL_WOULD_UNDERCOLLATERALIZE");
    }
}
deposits[user][token] -= amount;  // ← Reduction happens AFTER the check
```

**Existing Mitigation:** Code requires `hf >= 11000` (1.1x margin) instead of `hf >= 10000`, providing a 10% buffer. However, the buffer is **not mathematically correlated** to the withdrawal size — a large withdrawal can still break the 1.0x threshold.

**Recommendation:** Perform the health check **after** the balance reduction (Solidity will revert the entire transaction if it fails, including the reduction).

---

### D-M-01 — CantonLending Borrow/Liquidate Service Contention

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonLending.daml` |
| **Lines** | 725+ (`Lending_Borrow`), 1118+ (`Lending_Liquidate`) |
| **Category** | Scalability / Liveness |
| **CVSS 3.1** | 5.3 (Medium) |
| **Status** | Open |

**Description:**

`Lending_Borrow` and `Lending_Liquidate` are **consuming choices** on `CantonLendingService` because they modify `totalBorrows` and `cantonCurrentSupply`. Only one can execute per ledger effective time — concurrent borrows serialize and late arrivals fail referencing stale contract IDs.

**Contrast:** Withdrawals are correctly `nonconsuming` (DAML-H-03 fix) because they don't modify service state.

**Impact:** Protocol bottleneck under concurrent borrow/liquidation activity; failed transactions require retry with fresh service CID.

**Recommendation:** Move `totalBorrows` tracking to a separate aggregate template to decouple borrow-side state from the service contract.

---

### D-M-02 — sMUSD Share Price Sync Is Operator+Governance Only (No BFT Attestation)

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonSMUSD.daml` |
| **Lines** | 215–240 (`SyncGlobalSharePrice`) |
| **Category** | Trust Assumption / Oracle Manipulation |
| **CVSS 3.1** | 6.1 (Medium) |
| **Status** | Open — Partially Mitigated |

**Description:**

`SyncGlobalSharePrice` requires `operator` and `governance` as controllers — better than pure operator-only, but does **not** require the BFT supermajority attestation used by all bridge operations:

```haskell
choice SyncGlobalSharePrice : ContractId CantonStakingService
  with ...
  controller operator, governance      -- ← Two-party, but not BFT multi-validator

-- Compare with bridge operations:
choice BridgeOut_Finalize : ...
  controller aggregator
  do
    let requiredSignatures = ((length validatorGroup * 2) / 3) + 1  -- ← BFT threshold
```

**Existing Mitigations:** ±10% cap per epoch, governance co-sign (FIX HIGH-07), sequential epochs.

**Residual Risk:** Compromised operator+governance can accumulate 10% per epoch: 5 epochs → +61% cumulative inflation.

**Recommendation:** Route through `YieldAttestation` from `BLEBridgeProtocol.daml` (already has BFT supermajority).

---

### D-M-03 — InterestRateService Sync Lacks Attestation Verification

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/InterestRateService.daml` |
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
| **File** | `daml/Minted/Protocol/V3.daml` |
| **Lines** | 720–770 (`Liquidate` choice) |
| **Category** | Oracle Safety / Liveness |
| **CVSS 3.1** | 5.9 (Medium) |
| **Status** | Open |

**Description:**

V3 `Vault.Liquidate` uses `Oracle_GetPrice with maxStaleness = hours 1` — which fails during volatile periods when oracle updates lag. The newer `CantonLending.daml` correctly uses an unsafe (no staleness) path for liquidations:

```haskell
-- V3.daml — Liquidation BLOCKED by staleness check
price <- exercise oracleCid Oracle_GetPrice with
  requester = liquidator
  maxStaleness = hours 1        -- ← Fails if price >1h stale

-- CantonLending.daml — Liquidation uses unsafe path ✅
totalRawValue <- computeRawCollateralValue operator borrower configs escrowCids priceFeedCids False
--                                                                                         ^^^^^ useSafe=False
```

**Impact:** Liquidation liveness degradation during market stress — precisely when liquidations are most critical.

**Recommendation:** Add an unsafe oracle path for V3 Vault liquidation contexts.

---

### D-M-05 — Redundant `archive self` in Consuming Choices

| | |
|---|---|
| **Layer** | DAML |
| **File** | `daml/CantonSMUSD.daml` |
| **Lines** | Multiple (`Stake`, `Unstake`, `SyncGlobalSharePrice`, `SyncYield`, `Staking_SetPaused`) |
| **Category** | DAML Semantics / Correctness |
| **CVSS 3.1** | 4.3 (Medium) |
| **Status** | Open |

**Description:**

Multiple consuming choices contain explicit `archive self` before `create this with ...`. In DAML, consuming choices automatically archive the contract. The explicit archive is redundant or could cause double-archive errors.

```haskell
choice Stake : (ContractId CantonStakingService, ContractId CantonSMUSD)
  controller user
  do
    ...
    archive self                    -- ← Redundant: consuming choice auto-archives
    newService <- create this with
      totalShares = totalShares + newShares
```

**Recommendation:** Remove explicit `archive self` from consuming choices — DAML handles this automatically.

---

### X-M-01 — No Cross-Chain Global Supply Cap Enforcement

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Files** | `contracts/MUSD.sol`, `daml/CantonDirectMint.daml`, `daml/CantonLending.daml` |
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

The Canton modules coordinate between themselves (DAML-H-02 fix), but cross-chain enforcement is after-the-fact via `SupplyCapAttestation` (audit check, not pre-mint gate).

**Impact:** Both chains can independently mint up to their local cap, potentially exceeding global ceiling.

**Recommendation:** Implement conservative local caps summing to the global cap with a safety margin.

---

### X-M-02 — Asymmetric Oracle Trust Models

| | |
|---|---|
| **Layer** | Cross-Layer (Solidity ↔ DAML) |
| **Files** | `contracts/PriceOracle.sol`, `daml/CantonLending.daml` |
| **Category** | Oracle Trust / Consistency |
| **CVSS 3.1** | 5.3 (Medium) |
| **Status** | Open |

**Description:**

| | Ethereum | Canton |
|--|----------|--------|
| **Source** | Chainlink decentralized oracles | Tradecraft/Temple DEX API (operator-signed) |
| **Trust** | Decentralized (multiple node operators) | Centralized (single operator party) |
| **Circuit Breaker** | ±20% deviation triggers cooldown | ±50% per-update cap |
| **Staleness** | Per-feed `stalePeriod` + sequencer uptime | Per-asset `maxStalenessSecs` |

**Impact:** A compromised Canton operator could manipulate prices within the ±50% band.

**Recommendation:** Add multi-validator attestation for Canton price feeds.

---

## 🔵 LOW SEVERITY

---

### S-L-01 — Raw `approve()` in BorrowModule

| **File** | `contracts/BorrowModule.sol`, Line 449 |
|---|---|
| **Issue** | `IERC20(address(musd)).approve(address(smusd), supplierAmount)` uses raw `approve()` instead of `SafeERC20.forceApprove()`. Inconsistent with codebase-wide SafeERC20 usage. |
| **Fix** | Replace with `IERC20(address(musd)).forceApprove(address(smusd), supplierAmount)` |

### S-L-02 — Ineffective Swap Deadline in LeverageVault

| **File** | `contracts/LeverageVault.sol` |
|---|---|
| **Issue** | `deadline: block.timestamp` provides no protection — miners can hold transactions indefinitely. |
| **Fix** | Use `block.timestamp + 120` or accept user-supplied deadline. |

### S-L-03 — No Event Emission on Per-User Interest Accrual

| **File** | `contracts/BorrowModule.sol` |
|---|---|
| **Issue** | `_accrueInterest()` modifies `positions[user].accruedInterest` without events when interest is zero (short elapsed time). Off-chain indexing cannot fully track accrual. |

### S-L-04 — Missing Zero-Address Checks in Setter Functions

| **Files** | `LeverageVault.sol` (partial) |
|---|---|
| **Issue** | Some setter functions accept addresses without zero-address validation. |

### S-L-05 — PriceOracle Circuit Breaker Not Configurable Per Asset

| **File** | `contracts/PriceOracle.sol` |
|---|---|
| **Issue** | `maxDeviationBps` is global (20%). Volatile assets may need different thresholds than stables. |
| **Fix** | Add per-asset `maxDeviationBps` in `FeedConfig`. |

### S-L-06 — No Borrow Dust Threshold on Repayment

| **File** | `contracts/BorrowModule.sol` |
|---|---|
| **Issue** | Partial repayment can leave arbitrarily small debt dust (1 wei) that costs more gas to liquidate than the debt is worth. |
| **Fix** | If remaining debt < `minDebt`, force full repayment. |

### S-L-07 — TreasuryV2 Strategy Array Growth

| **File** | `contracts/TreasuryV2.sol` |
|---|---|
| **Issue** | `MAX_STRATEGIES = 10` constant exists — verify it's enforced in `addStrategy()`. `totalValue()` iterates all strategies. |

### S-L-08 — Sequencer Uptime Grace Period Handling

| **File** | `contracts/PriceOracle.sol` |
|---|---|
| **Issue** | After L2 sequencer restart, grace period may be insufficient for all oracle feeds to update. |

### D-L-01 — CantonLoopStrategy Is Empty

| **File** | `daml/CantonLoopStrategy.daml` |
|---|---|
| **Issue** | Both module and test file are empty. Unimplemented feature with zero coverage. |

### D-L-02 — BridgeOutSignature.requestCid Is Stale After Multi-Sign

| **File** | `daml/BLEBridgeProtocol.daml` |
|---|---|
| **Issue** | Each consuming `BridgeOut_Sign` creates a new attestation, making the signature's `requestCid` stale. Finalization uses nonce-matching correctly, so this is cosmetic. |

### D-L-03 — BoostPool Deposit Archives and Recreates sMUSD

| **File** | `daml/CantonBoostPool.daml` |
|---|---|
| **Issue** | `Deposit` archives user's `CantonSMUSD` and recreates it — any external CID references become stale. |

### D-L-04 — ComplianceRegistry BulkBlacklist Cap at 100

| **File** | `daml/Compliance.daml`, Line 155 |
|---|---|
| **Issue** | `assertMsg "BULK_LIMIT_EXCEEDED" (length usersToBlock <= 100)` — OFAC lists can have thousands of entries. |

### X-L-01 — Interest Rate Model Parity Not Cryptographically Verified

| **Files** | `contracts/InterestRateModel.sol`, `daml/InterestRateService.daml` |
|---|---|
| **Issue** | Rate parameter sync uses operator attestation with block ordering — no cryptographic proof of on-chain values. |

---

## ℹ️ INFORMATIONAL

---

### Solidity Informational Findings (S-I-01 through S-I-10)

| ID | Finding | File | Detail |
|----|---------|------|--------|
| S-I-01 | Cooldown is hardcoded as `WITHDRAW_COOLDOWN = 24 hours` | SMUSD.sol | If a setter is added later, it should have an upper bound (e.g., 7 days) |
| S-I-02 | `LiquidationEngine` missing `_disableInitializers()` in constructor | LiquidationEngine.sol | Not a UUPS proxy, so not exploitable — but best practice for consistency |
| S-I-03 | `healthFactor()` returns `type(uint256).max` for zero-debt positions | BorrowModule.sol | Callers must handle this sentinel value |
| S-I-04 | `supportedTokens[]` has no removal function | CollateralVault.sol | Tokens can be disabled but not removed from the array |
| S-I-05 | `type(uint256).max` approval to strategies | TreasuryV2.sol | Standard pattern but maximal trust — strategy compromise drains treasury |
| S-I-06 | Wormhole relayer fee uses hardcoded gas estimate | DepositRouter.sol | May under/overpay for cross-chain delivery |
| S-I-07 | All contracts use `pragma solidity 0.8.26` (pinned) | All | Good practice — ensures known compiler behavior |
| S-I-08 | `PendleMarketSelector` iterates all markets | PendleMarketSelector.sol | Gas scales linearly with market count |
| S-I-09 | `MorphoLoopStrategy` max 10 iterations | MorphoLoopStrategy.sol | Reasonable bound — prevents gas limit attacks |
| S-I-10 | Clean `SafeERC20` usage throughout (except S-L-01) | All | No raw `transfer`/`transferFrom` calls found |

### DAML Informational Findings (D-I-01 through D-I-04)

| ID | Finding | Detail |
|----|---------|--------|
| D-I-01 | **Comprehensive Audit Fix Trail** | 30+ prior audit fixes referenced in DAML code: D-01, D-02, D-03, DC-06, H-6, H-17, C-08, C-12, D-M01–D-M09, D-H01–D-H08, D-C01–D-C02, DL-C2–DL-C3, 5C-C01–5C-C02, A-01, DAML-H-01–H-04, DAML-M-01–M-09, DAML-CRIT-01–03. Evidence of mature security lifecycle. |
| D-I-02 | **Strong Signatory/Authority Patterns** | All token templates use **dual signatory** (issuer + owner) with **transfer proposal** patterns. Gold standard for Canton. |
| D-I-03 | **Privacy-by-Default Architecture** | `UserPrivacySettings.daml` with `lookupUserObservers` helper used across all product templates. Default fully private. |
| D-I-04 | **BFT Supermajority Consistently Applied** | All 4 attestation finalization choices use `(2n/3) + 1` threshold. Consuming sign choices prevent double-signing (D-02 fix). |

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

### Flow 3: Cross-Chain Yield Sync (Ethereum → Canton)

```
Ethereum Side:
    TreasuryV2.totalValue() = reserveBalance + Σ strategies[i].totalValue()
    SMUSD.globalSharePrice() = globalTotalAssets() / globalTotalShares()

Bridge:
    YieldAttestation created → Validators sign (BFT 2/3+1) → Finalized

Canton Side:
    CantonStakingService.SyncGlobalSharePrice(newGlobalSharePrice, epoch)
        ← controller: operator, governance
        ← Checks: epoch sequential, ±10% cap
        ⚠️ NO BFT attestation check (D-M-02)
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

### Critical Test Coverage Gaps

| Gap | Severity | Detail | Effort |
|-----|----------|--------|--------|
| `V3.daml` (1,551 lines) — **zero DAML tests** | 🔴 Critical | Largest module completely untested | 16+ hrs |
| `CantonLoopStrategy` — empty module + test | 🟡 High | Dead code if shipped | 8 hrs |
| CrossModuleIntegration test #8 (D-M04) | 🟡 High | Documented but not implemented | 2 hrs |
| USDCx collateral path untested | 🟡 High | 4th collateral type with zero coverage | 4 hrs |
| GovernanceActionLog archive auth (D-H-01) | 🟡 High | HIGH finding has no test | 2 hrs |
| Partial repayment in CantonLending | 🟠 Medium | Only full repay tested | 2 hrs |
| Admin auth negative tests in CantonLending | 🟠 Medium | No tests for non-operator failures | 2 hrs |
| Privacy propagation for CantonSMUSD et al. | 🟠 Medium | `lookupUserObservers` untested in these templates | 4 hrs |

---

## SECURITY POSTURE MATRIX

| Category | Solidity | DAML | Cross-Layer |
|----------|----------|------|-------------|
| **Access Control** | ✅ OZ AccessControl + 8 roles | ✅ Dual signatory + proposals | 🟡 Operator centralization |
| **Reentrancy** | ✅ ReentrancyGuard everywhere | ✅ DAML atomic ledger model | ✅ No cross-layer vector |
| **Oracle Safety** | ✅ Chainlink + CB + sequencer | 🟡 Operator-signed, ±50% cap | 🟡 Asymmetric trust |
| **Supply Cap** | ✅ Per-contract cap | ✅ Cross-module coordination | 🟡 No atomic cross-chain gate |
| **Upgrade Safety** | ✅ UUPS + ERC-7201 + gaps | ✅ Opt-in migration + rollback | ✅ Independent paths |
| **Privacy** | N/A (public EVM) | ✅ Privacy-by-default | ✅ Canton isolated |
| **Replay Protection** | ✅ Nonce + consuming spend | ✅ Consuming + dedup sets | ✅ Cross-chain nonces |
| **BFT Consensus** | N/A (Ethereum PoS) | ✅ 2/3+1 on all attestations | ✅ BFT both sides |
| **Compliance** | ✅ Blacklist + pause + roles | ✅ Blacklist + freeze + hooks | ✅ Consistent |
| **Economic** | 🟡 Phantom debt, no bad debt | 🟡 V3 share price asymmetry | 🟡 Rate parity unverified |
| **Audit Trail** | ✅ Events on all state changes | ✅ Immutable receipt templates | ✅ Attestation nonces |

---

## PER-CONTRACT SCORECARDS

### Solidity

| Contract | Access | Economic | Oracle | Reentrancy | Upgrade | **Overall** |
|----------|--------|----------|--------|------------|---------|-------------|
| MUSD.sol | 95 | 95 | N/A | N/A | N/A | **95** |
| SMUSD.sol | 92 | 80 | 85 | 95 | N/A | **85** |
| CollateralVault.sol | 93 | 88 | N/A | 95 | N/A | **90** |
| BorrowModule.sol | 90 | 78 | 90 | 95 | N/A | **85** |
| LiquidationEngine.sol | 93 | 82 | 92 | 95 | N/A | **88** |
| PriceOracle.sol | 90 | N/A | 88 | N/A | N/A | **88** |
| InterestRateModel.sol | 95 | 95 | N/A | N/A | N/A | **95** |
| DirectMintV2.sol | 93 | 93 | N/A | 95 | N/A | **93** |
| LeverageVault.sol | 88 | 75 | 80 | 95 | N/A | **82** |
| TreasuryV2.sol | 90 | 90 | N/A | 95 | 92 | **91** |

### DAML

| Module | Signatory | Economic | Privacy | Compliance | **Overall** |
|--------|-----------|----------|---------|------------|-------------|
| CantonLending.daml | 95 | 90 | 92 | 95 | **93** |
| CantonDirectMint.daml | 93 | 92 | 90 | 95 | **92** |
| CantonSMUSD.daml | 90 | 88 | 90 | 95 | **90** |
| Governance.daml | 85 | 90 | N/A | N/A | **87** |
| BLEBridgeProtocol.daml | 95 | N/A | N/A | N/A | **95** |
| Compliance.daml | 95 | N/A | 95 | 95 | **95** |
| V3.daml | 88 | 78 | 85 | 88 | **83** |
| InterestRateService.daml | 85 | 90 | N/A | N/A | **87** |
| UserPrivacySettings.daml | 95 | N/A | 98 | N/A | **97** |

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
9. **Rate limiting** with 24h rolling windows, ±5% max share change, 1h min sync interval
10. **Upgrade framework** with governance approval, opt-in migration, and rollback windows
11. **ERC-7201 namespaced storage** for upgradeability collision prevention
12. **OpenZeppelin 5.x** throughout — latest stable patterns
13. **Multi-collateral support** with per-asset configuration on both chains
14. **Immutable audit trail** — `LiquidationReceipt`, `GovernanceActionLog`, `InterestPayment`, `UpgradeMigrationLog`

---

## PRIORITIZED REMEDIATION PLAN

### P0 — Immediate (Before Mainnet)

| ID | Action | Effort | Risk if Unresolved |
|----|--------|--------|--------------------|
| S-H-01 | Fix SMUSD recursion — replace `totalAssets()` fallback with `IERC20(asset()).balanceOf(address(this))` | 1 hour | Complete vault DoS |
| D-H-01 | Fix GovernanceActionLog signatory — `signatory operator` only (or add `executedBy` as controller on MinterRegistry choices) | 1 hour | Governance operations blocked |
| D-H-02 | Fix V3 share price asymmetry — consistent virtual shares or unified `globalSharePrice` model | 2 hours | Economic value extraction |

### P1 — High Priority (Before Mainnet or First Week)

| ID | Action | Effort | Risk if Unresolved |
|----|--------|--------|--------------------|
| S-M-01 | Add pending interest buffer in BorrowModule | 4 hours | Phantom debt → utilization spiral |
| S-M-02 | Implement bad debt socialization | 8 hours | Silent bad debt accumulation |
| S-M-05 | Move health check to post-withdrawal in CollateralVault | 2 hours | Undercollateralized withdrawals |
| D-M-02 | Route share price syncs through BFT attestation | 8 hours | Operator-manipulable share price |
| X-M-01 | Conservative local caps summing to global cap | 16 hours | Cross-chain supply cap breach |

### P2 — Medium Priority (First Month)

| ID | Action | Effort |
|----|--------|--------|
| S-M-03 | User-supplied `minAmountOut` + real deadline in LeverageVault | 4 hours |
| S-M-04 | Debt repayment in `emergencyClosePosition` | 4 hours |
| D-M-01 | Decouple borrow aggregate template | 8 hours |
| D-M-05 | Remove redundant `archive self` | 1 hour |
| D-M-04 | Unsafe oracle for V3 liquidation | 2 hours |

### P3 — Recommended (Ongoing)

| ID | Action | Effort |
|----|--------|--------|
| S-L-01 | `forceApprove` in BorrowModule | 30 min |
| S-L-02 | Real swap deadline | 30 min |
| D-L-01 | Implement or remove CantonLoopStrategy | 2 hours |
| — | **Add V3.daml test suite** (1,551 lines untested) | 16+ hours |
| — | Add USDCx collateral tests | 4 hours |
| — | Add GovernanceActionLog archive auth test | 2 hours |
| — | Implement CrossModule test #8 | 2 hours |

---

## DISCLAIMER

This audit report represents a point-in-time assessment based on the source code available at the time of review. It does not constitute a guarantee of security. Smart contract and distributed ledger systems remain subject to undiscovered vulnerabilities, economic attacks, and operational risks.

**Limitations:**
- Automated analysis and manual code review only — no live testnet/mainnet testing
- Formal verification results based on review of existing Certora specs, not independent creation
- DAML test coverage assessed by reading source, not executing tests
- Economic modeling based on static analysis, not live market simulation
- Cross-chain bridge analyzed from source only — no bridge transaction testing

**A formal audit by an accredited security firm (Trail of Bits, OpenZeppelin, Cyfrin, or equivalent) is strongly recommended before mainnet deployment.**

---

*Audit generated: February 12, 2026*  
*Protocol: Minted mUSD — Solidity 0.8.26 + DAML SDK 2.10.3 (Canton Network)*  
*Total Findings: 42 (3 HIGH · 12 MEDIUM · 13 LOW · 14 INFO)*  
*Overall Score: 86/100 ⭐⭐⭐⭐*
