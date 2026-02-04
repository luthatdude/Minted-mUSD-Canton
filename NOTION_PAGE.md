# Canton and Minted

**Bridging the gap between DeFi composability and privacy-first technology.**

> GitHub: [luthatdude/Minted-mUSD-Canton](https://github.com/luthatdude/Minted-mUSD-Canton)

---

## The Problem

Canton Network is home to **$6T+ in tokenized institutional assets**. DTCC settling Treasuries, Broadridge processing $8T/month in repo, Goldman and BlackRock tokenizing funds. The most sophisticated financial infrastructure in crypto.

**But it's a walled garden.**

| Challenge | Impact |
|-----------|--------|
| **Low liquidity** | Institutions hold, they don't trade |
| **No composability** | Canton assets can't plug into DeFi. Porting AAVE/Morpho would require major rebuilds |
| **Limited retail access** | Permissioned by design |

Meanwhile, DeFi has **$100B+ in TVL**, infinite composability, and 24/7 markets—but no connection to real institutional capital.

**Two worlds. Zero bridge.**

---

## The Solution

**mUSD is the liquidity layer between Canton's institutional infrastructure and Ethereum's DeFi ecosystem.**

Canton or Institutions can provide **anonymous aggregated attestation**. The attestation proves reserves exist; it doesn't create a redemption claim against those institutions or assets.

mUSD mints on Ethereum. DeFi gets institutional-grade backing. Institutions get liquidity without custody risk.

**One asset. Two chains. Full composability.**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CANTON NETWORK (DAML)                               │
│                                                                              │
│   MintedMUSD       CantonSMUSD       Leveraged Vaults      CantonDirectMint  │
│   (DAML Asset)     (Yield Vault)     (CDP + DEX)           (Mint/Redeem)     │
│                                                                              │
│                         Canton Bridge Module                                 │
│        Burns Canton mUSD → Attestation → Validators sign → Relay            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ║
                        3-of-5 Multi-Sig Attestation
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        RELAY SERVICE (TypeScript)                            │
│       validator-node-v2.ts → AWS KMS signing + collateral ratio checks       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ETHEREUM (Solidity)                                 │
│                                                                              │
│   BLEBridgeV9      MUSD           SMUSD          DirectMintV2    TreasuryV2  │
│   (Attestations)   (ERC-20)       (ERC-4626)     (1:1 Mint)      (Yield)     │
│                                                                              │
│                         Yield Strategies                                     │
│                   PendleStrategyV2  |  MorphoLoopStrategy                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### 1. Institutional Attestation Flow

1. **Canton institutions attest** to their holdings (e.g., $500M in tokenized assets)
2. **3-of-5 validators** sign the attestation using AWS KMS
3. **Relay service** submits signed attestation to Ethereum
4. **BLEBridgeV9** verifies signatures and updates mUSD supply cap (rate-limited)
5. **mUSD becomes mintable** on Ethereum against USDC backing

### 2. User Minting Flow

```
User deposits USDC → DirectMintV2 → TreasuryV2 → mUSD minted 1:1
```

- USDC flows directly to TreasuryV2 for yield generation
- mUSD minted to user (minus configurable fee)
- Rate limits and supply caps enforced

### 3. Yield Generation

```
TreasuryV2
    ├── PendleStrategyV2 → PT Markets (~5-8% APY)
    └── MorphoLoopStrategy → Leveraged Lending (~11.5% APY)
            ↓
    Yield accrues to smUSD holders
```

---

## Solidity Contracts

| Contract | Purpose |
|----------|---------|
| **MUSD.sol** | ERC-20 stablecoin with role-based mint/burn, supply cap, blacklist |
| **SMUSD.sol** | ERC-4626 yield vault with cooldown and max deposits |
| **BLEBridgeV9.sol** | Canton attestation bridge with 24h rate-limited supply cap updates |
| **DirectMintV2.sol** | 1:1 USDC ↔ mUSD with fees, limits, pause |
| **TreasuryV2.sol** | USDC reserve pool with pluggable yield strategies |
| **CollateralVault.sol** | Multi-token collateral for CDP positions |
| **BorrowModule.sol** | mUSD borrowing with interest accrual |
| **LiquidationEngine.sol** | Liquidation with close factor and seizure |
| **PriceOracle.sol** | Chainlink-compatible feeds with staleness checks |
| **PendleStrategyV2.sol** | Auto-rollover PT market strategy |
| **MorphoLoopStrategy.sol** | 3.3x leveraged USDC lending |

### Rate Limiting (BLEBridgeV9)

```solidity
dailyCapIncreaseLimit = $50M (configurable)
netCapIncrease = dailyCapIncreased - dailyCapDecreased
require(netCapIncrease < dailyCapIncreaseLimit)
// Window resets after 24h
```

---

## DAML Templates (Canton)

| Template | Purpose |
|----------|---------|
| **MintedMUSD** | Canton mUSD token with MPA agreement, Split/Merge/Transfer |
| **CantonSMUSD** | Yield vault synced from Ethereum attestations |
| **Vault** | CDP with atomic leverage loops (borrow → swap → deposit) |
| **MUSDSupplyService** | Supply cap tracking with governance-controlled large mint approvals |
| **AttestationRequest** | Multi-party validation with supermajority quorum (67%) |
| **BridgeService** | Coordinates Canton ↔ Ethereum transfers |
| **ComplianceRegistry** | Blacklist/freeze with audit trail |
| **PriceOracle** | Provider-signed price feeds with staleness checks |

### Atomic Leverage (Vault.AdjustLeverage)

```
deposit collateral → borrow mUSD → swap via DEX → add collateral
(max 10 loops per transaction)
```

---

## Security Model

### Defense in Depth

| Layer | Controls |
|-------|----------|
| **Access Control** | OpenZeppelin AccessControl, DAML dual-signatory, M-of-N governance |
| **Rate Limiting** | 24h rolling windows on mints and supply cap increases |
| **Validation** | Chainlink oracles with staleness checks, 110%+ collateral ratio |
| **Monitoring** | On-chain events, bridge health monitoring |
| **Emergency** | Pausable contracts, emergency bridge shutdown |

### Trust Boundaries

```
Canton Participant → Validators (3-of-5) → Ethereum Contracts → External Protocols
```

### Cryptographic Assumptions

| Assumption | Impact if Broken |
|------------|------------------|
| ECDSA signatures unforgeable | Attestation forgery |
| SHA-256 collision-resistant | Agreement hash spoofing |
| Solidity 0.8.26 overflow protection | Integer overflow attacks |

---

## Key Invariants

### Solidity

1. `MUSD.totalSupply() <= attestedCantonAssets + directMintBacking`
2. `collateralValue >= debtValue * minHealthFactor`
3. `Treasury.totalValue() >= DirectMint.totalDeposited()`

### DAML

1. All `MintedMUSD` transfers require `issuer` + `owner` signatures
2. All token amounts satisfy `ensure amount > 0.0`
3. `currentSupply <= supplyCap` in MUSDSupplyService

---

## Infrastructure

```
Internet → NGINX Proxy → Canton Participant → PostgreSQL
           (TLS + Rate    (Ledger + JSON      (Encrypted
            Limiting)      API)                Storage)
```

- Kubernetes manifests with Pod Security Standards
- NetworkPolicy (default-deny)
- Pinned image versions

---

## Test Coverage

- **10 Solidity test suites** covering MUSD, Bridge, Treasury, Vaults, Liquidation
- **DAML scenario tests** for all templates
- **Slither** static analysis configured
- **Coverage reports** generated via Hardhat

---

## Yield Strategies

### PendleStrategyV2

- Auto-selects highest APY Pendle PT market
- Monitors expiry and triggers rollover before maturity
- Redeems matured PT → underlying → re-deposits

### MorphoLoopStrategy

```
Base Supply Rate:  ~5.9%
Borrow Rate:       ~4.5%
Leverage:          3.33x (at 70% LTV)
Net APY:           ~11.5%
```

Max 5 loops to prevent gas exhaustion, health factor monitoring, emergency deleverage.

---

## Links

- **GitHub**: [luthatdude/Minted-mUSD-Canton](https://github.com/luthatdude/Minted-mUSD-Canton)
- **Security Audit**: CredShield (Feb 2026)
- **Threat Model**: See `THREAT_MODEL.md`
- **Architecture Diagrams**: See `docs/DIAGRAMS.md`

---

## Summary

mUSD bridges **$6T+ of Canton institutional assets** with **$100B+ of Ethereum DeFi liquidity**.

| Canton | mUSD Bridge | Ethereum |
|--------|-------------|----------|
| Institutional accounting | 3-of-5 attestations | DeFi composability |
| Privacy-preserving | Rate-limited | Yield generation |
| Compliance-first | Dual supply tracking | 24/7 markets |

**Institutions get liquidity. DeFi gets institutional backing. Everyone wins.**
