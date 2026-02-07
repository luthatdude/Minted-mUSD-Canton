# Minted Protocol - Security Audit Scope

**Prepared for:** Softstack  
**Date:** February 7, 2026  
**Prepared by:** Minted Protocol Team

---

## Repository

**GitHub:** https://github.com/luthatdude/Minted-mUSD-Canton  
**Commit:** `cdec82e` (frozen)  
**Branch:** `main`

---

## Project Overview

Minted is a cross-chain stablecoin protocol bridging Canton Network (DAML) and Ethereum (Solidity). mUSD is minted 1:1 against stablecoin reserves, with Canton serving as the institutional-grade settlement layer and Ethereum serving as the DeFi yield layer.

### Key Components
- **mUSD**: 1:1 backed stablecoin (DAML asset on Canton, ERC-20 on Ethereum)
- **sMUSD**: Yield-bearing vault (ERC-4626)
- **Cross-Chain Bridge**: 3-of-5 multi-sig attestation bridge
- **CDP System**: Collateralized borrowing with leverage looping
- **Treasury**: Yield generation via DeFi strategies

---

## Audit Scope

### Solidity Contracts (Priority: Critical)

| Contract | LOC | Description |
|----------|-----|-------------|
| `BLEBridgeV9.sol` | ~475 | Cross-chain bridge with 3-of-5 multi-sig, rate limiting, nonce protection |
| `TreasuryV2.sol` | ~1,000 | Yield strategies, fund allocation, fee accrual |
| `BorrowModule.sol` | ~830 | CDP borrowing, interest accrual, health factor checks |
| `LeverageVault.sol` | ~770 | Leverage looping, atomic position adjustment |
| `PendleStrategyV2.sol` | ~830 | Pendle PT yield strategy with rolling maturity |
| `MorphoLoopStrategy.sol` | ~811 | Morpho leverage looping strategy |
| `PendleMarketSelector.sol` | ~534 | Pendle PT market integration |
| `DepositRouter.sol` | ~422 | Multi-path deposit routing |
| `SMUSD.sol` | ~329 | ERC-4626 yield vault with cooldown mechanism |
| `DirectMintV2.sol` | ~324 | 1:1 mint/redeem against treasury |
| `CollateralVault.sol` | ~299 | Collateral deposits and withdrawals |
| `TreasuryReceiver.sol` | ~295 | Treasury fund receiver |
| `InterestRateModel.sol` | ~276 | Utilization-based interest rate curves |
| `LiquidationEngine.sol` | ~274 | Liquidation logic, bonus calculations |
| `PriceOracle.sol` | ~256 | Chainlink oracle integration with staleness checks |
| `MUSD.sol` | ~104 | Core ERC-20 with blacklist, freeze, pause |
| `IStrategy.sol` | ~40 | Strategy interface definition |

**Total Solidity:** ~7,869 LOC across 17 contracts

### DAML Modules (Priority: Critical)

| Module | LOC | Description |
|--------|-----|-------------|
| `Minted/Protocol/V3.daml` | ~1,545 | Core protocol v3 — unified vault, oracle, liquidation, lending pool |
| `CantonLending.daml` | ~1,235 | Canton-native lending with Temple DEX price feeds, escrow, interest accrual |
| `CantonDirectMint.daml` | ~722 | Direct mint/redeem with rate limiting, compliance hooks |
| `CantonBoostPool.daml` | ~541 | Boost pool deposits, epoch-based rewards, protocol fees |
| `MUSD_Protocol.daml` | ~535 | Protocol coordination |
| `BLEBridgeProtocol.daml` | ~433 | Bridge attestation creation and validation |
| `Governance.daml` | ~399 | Governance proposals and voting |
| `MintedMUSD.daml` | ~331 | Core DAML asset with split/merge/transfer |
| `Upgrade.daml` | ~281 | Contract upgrade mechanisms |
| `CantonSMUSD.daml` | ~280 | Canton yield vault |
| `InterestRateService.daml` | ~210 | Interest rate calculations |
| `BLEProtocol.daml` | ~189 | Bridge protocol helpers |
| `InstitutionalAssetV4.daml` | ~189 | Institutional asset handling |
| `Compliance.daml` | ~156 | Blacklist, freeze, transfer validation |
| `UserPrivacySettings.daml` | ~153 | Per-user privacy toggle (opt-in transparency) |
| `TokenInterface.daml` | ~11 | Interface definitions |

**Total DAML (production):** ~7,210 LOC across 16 modules

### DAML Test Modules (Priority: Medium)

| Module | LOC | Description |
|--------|-----|-------------|
| `CantonBoostPoolTest.daml` | ~1,016 | Boost pool deep tests |
| `CantonLendingTest.daml` | ~900 | Lending module tests |
| `UserPrivacySettingsTest.daml` | ~633 | Privacy settings tests |
| `NegativeTests.daml` | ~488 | Security negative-path scenarios |

**Total DAML Tests:** ~3,037 LOC across 4 modules

### Relay Service (Priority: Critical)

The relay service is the off-chain bridge coordinator and is **critical to bridge security**. Compromise of the relay could lead to unauthorized minting.

| File | LOC | Description |
|------|-----|-------------|
| `relay-service.ts` | ~839 | Canton event watching, Ethereum transaction submission, attestation handling |
| `lending-keeper.ts` | ~715 | Canton lending liquidation keeper, health factor monitoring, auto-liquidation |
| `validator-node-v2.ts` | ~639 | Canton Asset API integration, AWS KMS signing, collateral ratio validation |
| `price-oracle.ts` | ~609 | Canton price feed relay, Chainlink→Canton bridge, sanity checks, circuit breaker |
| `validator-node.ts` | ~534 | Legacy validator (reference) |
| `yield-sync-service.ts` | ~512 | Yield synchronization between Canton and Ethereum |
| `yield-keeper.ts` | ~355 | Automated yield harvesting and distribution |
| `signer.ts` | ~255 | Signature aggregation, 3-of-5 threshold logic, sorted address deduplication |
| `utils.ts` | ~81 | Shared utilities |

**Total Relay:** ~4,539 LOC across 9 files

#### Relay Security Concerns (Critical)
- **AWS KMS key access** - Validator keys stored in KMS, review access patterns
- **Signature aggregation** - Verify 3-of-5 threshold cannot be bypassed
- **Event validation** - Ensure Canton events are properly verified before signing
- **Race conditions** - Multiple validators processing same attestation
- **Nonce synchronization** - Off-chain nonce tracking vs on-chain state
- **Collateral ratio checks** - Validator-side enforcement before signing
- **Error handling** - Graceful failure without partial state corruption
- **Price oracle relay** - Sanity checks, circuit breaker, bounds violation recovery
- **Lending keeper** - Health factor monitoring, TLS enforcement, auto-liquidation safety

### Test Mocks (Priority: Low)

| File | LOC | Description |
|------|-----|-------------|
| `contracts/mocks/*.sol` | ~809 | Mock contracts for testing (MockERC20, MockAggregatorV3, MockStrategy) |

### Test Suite (Priority: Medium)

| File | LOC | Description |
|------|-----|-------------|
| `test/*.ts` | ~5,918 | Hardhat test files covering all contracts |

### Deployment Scripts (Priority: Medium)

| File | LOC | Description |
|------|-----|-------------|
| `scripts/*.ts` | ~2,158 | Deployment and migration scripts |

### Kubernetes Infrastructure (Priority: Medium)

| Directory | LOC | Description |
|-----------|-----|-------------|
| `k8s/base/*` | ~200 | Namespace, Postgres configs |
| `k8s/canton/*` | ~1,082 | Participant node, secrets, network policies, RBAC |

**Total Additional:** ~13,204 LOC

---

## Out of Scope

- `frontend/*` — React frontend (UI only, no security-critical logic)
- `contracts/mocks/*` — Test mock contracts (MockERC20, MockAggregatorV3, MockStrategy)
- `archive/*` — Archived predecessor contracts (BLEBridgeV8.sol, Treasury.sol, DirectMint.sol)
- `node_modules/*` — Third-party dependencies
- `test/*` — Hardhat test suite (reference for understanding intent, not audited for correctness)
- `scripts/*` — Deployment and migration scripts
- `daml/*Test*.daml` — DAML test scenario files

---

## Key Security Concerns

### Bridge Security (Critical)
1. **Multi-sig validation** - 3-of-5 signature verification, sorted address deduplication
2. **Replay protection** - `address(this)` + `block.chainid` in attestation hash
3. **Nonce ordering** - Sequential nonce prevents out-of-order/duplicate attestations
4. **Rate limiting** - 24-hour rolling window on net mint/burn
5. **Supply cap enforcement** - Cannot exceed cap even with valid attestations

### DeFi Security (High)
6. **Reentrancy** - Strategy interactions, yield claims
7. **Oracle manipulation** - Chainlink staleness, price deviation
8. **Flash loan attacks** - Collateral ratio manipulation
9. **Liquidation edge cases** - Dust positions, bad debt
10. **Interest rate manipulation** - Utilization rate gaming

### Access Control (High)
11. **Role separation** - Admin, minter, pauser, strategy roles
12. **Timelock bypass** - Emergency functions
13. **Upgrade safety** - State migration

### Canton-Specific (High)
14. **Atomic commit integrity** - No partial execution
15. **Party authorization** - Correct signatories
16. **Choice controller** - Who can exercise choices
17. **Template visibility** - Proper data hiding

---

## Build & Test Instructions

### Solidity

```bash
cd /path/to/Minted-mUSD-Canton
npm install
npx hardhat compile
npx hardhat test
```

**Expected result:** 678 tests passing

### DAML

```bash
cd daml/
daml build
daml test
```

---

## Test Coverage

| Suite | Tests | Status |
|-------|-------|--------|
| MUSD | 15 | ✅ Pass |
| DirectMintV2 | 28 | ✅ Pass |
| SMUSD | 42 | ✅ Pass |
| BLEBridgeV9 | 67 | ✅ Pass |
| TreasuryV2 | 89 | ✅ Pass |
| BorrowModule | 54 | ✅ Pass |
| LeverageVault | 48 | ✅ Pass |
| LiquidationEngine | 36 | ✅ Pass |
| InterestRateModel | 22 | ✅ Pass |
| CollateralVault | 18 | ✅ Pass |
| PriceOracle | 12 | ✅ Pass |
| TreasuryReceiver | 23 | ✅ Pass |
| Integration | 25 | ✅ Pass |
| DeepAuditV2 | 125 | ✅ Pass |
| Relay (Jest) | 29 | ✅ Pass |
| DAML | 96 | ✅ Pass |
| **Total** | **678 + 29 + 96** | ✅ Pass |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    CANTON NETWORK (DAML)                     │
│  MintedMUSD ─── CantonSMUSD ─── CantonDirectMint            │
│       │              │               │                       │
│  CantonLending   CantonBoostPool   V3.daml                  │
│       │                              │                       │
│       └──────── BridgeProtocol ──────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │ 3-of-5 Attestation
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    RELAY SERVICE                             │
│  validator-node-v2.ts ─── AWS KMS ─── relay-service.ts      │
│  price-oracle.ts ─── lending-keeper.ts ─── yield-keeper.ts  │
└─────────────────────────┬───────────────────────────────────┘
                          │ Multi-sig Submission
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    ETHEREUM (Solidity)                       │
│  MUSD ─── SMUSD ─── DirectMintV2 ─── BLEBridgeV9            │
│                          │                                   │
│  CollateralVault ─── BorrowModule ─── LiquidationEngine     │
│                          │                                   │
│       TreasuryV2 ─── PendleStrategyV2 / MorphoLoopStrategy  │
│                          │                                   │
│              PriceOracle ─── PendleMarketSelector           │
└─────────────────────────────────────────────────────────────┘
```

---

## Contact

**Luis Cuello** - Founder & CEO  
Email: Luis@minted.app
Telegram: @trenchweb3

**Mark Napolitano** - CTO  
Email: Mark@dapp.com
Telegram: @defi_mark

---

## Deliverables Expected

1. **Security Assessment Report** - Findings categorized by severity (Critical/High/Medium/Low/Informational)
2. **DAML-Specific Review** - Party authorization, atomic commit, choice controller analysis
3. **Bridge Security Analysis** - Multi-sig, replay protection, rate limiting, **relay service review**
4. **Relay Service Review** - Off-chain validator logic, AWS KMS usage, signature aggregation
5. **Remediation Verification** - Re-review of fixed issues

---

## Timeline

| Phase | Duration |
|-------|----------|
| Initial Review | Week 1-2 |
| Findings Report | End of Week 2 |
| Remediation | Week 3 |
| Final Report | End of Week 3 |

**Total Duration: 3 weeks**

---

*Document updated: February 7, 2026*
