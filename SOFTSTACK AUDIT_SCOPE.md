# Minted Protocol - Security Audit Scope

**Prepared for:** Softstack  
**Date:** February 5, 2026  
**Prepared by:** Minted Protocol Team

---

## Repository

**GitHub:** https://github.com/luthatdude/Minted-mUSD-Canton  
**Commit:** `fb20130e8403fc9fadea100bb8b738119a3fcaf9`  
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
| `BLEBridgeV9.sol` | ~500 | Cross-chain bridge with 3-of-5 multi-sig, rate limiting, nonce protection |
| `TreasuryV2.sol` | ~950 | Yield strategies, fund allocation, fee accrual |
| `BorrowModule.sol` | ~700 | CDP borrowing, interest accrual, health factor checks |
| `LeverageVault.sol` | ~800 | Leverage looping, atomic position adjustment |
| `SMUSD.sol` | ~350 | ERC-4626 yield vault with cooldown mechanism |
| `DirectMintV2.sol` | ~350 | 1:1 mint/redeem against treasury |
| `LiquidationEngine.sol` | ~300 | Liquidation logic, bonus calculations |
| `InterestRateModel.sol` | ~280 | Utilization-based interest rate curves |
| `CollateralVault.sol` | ~280 | Collateral deposits and withdrawals |
| `DepositRouter.sol` | ~330 | Multi-path deposit routing |
| `TreasuryReceiver.sol` | ~250 | Treasury fund receiver |
| `PendleMarketSelector.sol` | ~550 | Pendle PT market integration |
| `MUSD.sol` | ~100 | Core ERC-20 with blacklist, freeze, pause |
| `PriceOracle.sol` | ~150 | Chainlink oracle integration with staleness checks |

**Total Solidity:** ~5,515 LOC across 14 contracts

### DAML Modules (Priority: Critical)

| Module | LOC | Description |
|--------|-----|-------------|
| `CantonDirectMint.daml` | ~650 | Direct mint/redeem with rate limiting, compliance hooks |
| `BLEBridgeProtocol.daml` | ~430 | Bridge attestation creation and validation |
| `MintedMUSD.daml` | ~320 | Core DAML asset with split/merge/transfer |
| `MUSD_Protocol.daml` | ~500 | Protocol coordination |
| `CantonSMUSD.daml` | ~220 | Canton yield vault |
| `Compliance.daml` | ~150 | Blacklist, freeze, transfer validation |
| `InterestRateService.daml` | ~220 | Interest rate calculations |
| `Governance.daml` | ~370 | Governance proposals and voting |
| `Upgrade.daml` | ~270 | Contract upgrade mechanisms |
| `InstitutionalAssetV4.daml` | ~200 | Institutional asset handling |
| `BLEProtocol.daml` | ~180 | Bridge protocol helpers |
| `NegativeTests.daml` | ~380 | Security test scenarios |
| `TokenInterface.daml` | ~10 | Interface definitions |

**Total DAML:** ~4,121 LOC across 13 modules

### Relay Service (Priority: Critical)

The relay service is the off-chain bridge coordinator and is **critical to bridge security**. Compromise of the relay could lead to unauthorized minting.

| File | LOC | Description |
|------|-----|-------------|
| `relay-service.ts` | ~685 | Canton event watching, Ethereum transaction submission, attestation handling |
| `validator-node-v2.ts` | ~630 | Canton Asset API integration, AWS KMS signing, collateral ratio validation |
| `validator-node.ts` | ~454 | Legacy validator (reference) |
| `signer.ts` | ~235 | Signature aggregation, 3-of-5 threshold logic, sorted address deduplication |
| `yield-sync-service.ts` | ~738 | Yield synchronization between Canton and Ethereum |
| `yield-keeper.ts` | ~355 | Automated yield harvesting and distribution |
| `utils.ts` | ~24 | Shared utilities |

**Total Relay:** ~3,121 LOC across 7 files

#### Relay Security Concerns (Critical)
- **AWS KMS key access** - Validator keys stored in KMS, review access patterns
- **Signature aggregation** - Verify 3-of-5 threshold cannot be bypassed
- **Event validation** - Ensure Canton events are properly verified before signing
- **Race conditions** - Multiple validators processing same attestation
- **Nonce synchronization** - Off-chain nonce tracking vs on-chain state
- **Collateral ratio checks** - Validator-side enforcement before signing
- **Error handling** - Graceful failure without partial state corruption

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

**Total Additional:** ~10,167 LOC

---

## Out of Scope

- `frontend/*` - React frontend (UI only, no security-critical logic)

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

**Expected result:** 436 tests passing

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
| Integration | 25 | ✅ Pass |
| **Total** | **436** | ✅ Pass |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    CANTON NETWORK (DAML)                     │
│  MintedMUSD ─── CantonSMUSD ─── CantonDirectMint            │
│       │                              │                       │
│       └──────── BridgeProtocol ──────┘                       │
└─────────────────────────┬───────────────────────────────────┘
                          │ 3-of-5 Attestation
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    RELAY SERVICE                             │
│  validator-node-v2.ts ─── AWS KMS ─── relay-service.ts      │
└─────────────────────────┬───────────────────────────────────┘
                          │ Multi-sig Submission
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    ETHEREUM (Solidity)                       │
│  MUSD ─── SMUSD ─── DirectMintV2 ─── BLEBridgeV9            │
│                          │                                   │
│  CollateralVault ─── BorrowModule ─── LiquidationEngine     │
│                          │                                   │
│              TreasuryV2 ─── PendleMarketSelector            │
└─────────────────────────────────────────────────────────────┘
```

---

## Contact

**Luis Cuello** - Founder & CEO  
Email: [INSERT EMAIL]  
Telegram: [INSERT HANDLE]

**Mark Napolitano** - CTO  
Email: [INSERT EMAIL]  
Telegram: [INSERT HANDLE]

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

*Document generated: February 5, 2026*
