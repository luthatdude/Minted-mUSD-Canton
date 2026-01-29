# Minted mUSD Protocol

A cross-chain stablecoin protocol spanning **Canton Network** (DAML) and **Ethereum** (Solidity). mUSD is minted 1:1 against stablecoins. Canton serves as the institutional-grade accounting and settlement layer; Ethereum serves as the yield and DeFi execution layer. All backing reserves flow to Ethereum's Treasury for yield generation — there is no Canton Treasury.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      CANTON NETWORK (DAML)                                         │
│                                                                                                    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │  MintedMUSD       │  │  CantonSMUSD      │  │  Leveraged Vault (CDP) │  │  CantonDirectMint │  │
│  │  (DAML Asset)     │  │  (Yield Vault)    │  │                         │  │                   │  │
│  │                   │  │                   │  │  • AdjustLeverage       │  │  • Deposit stables│  │
│  │  • Split/Merge    │  │  • Deposit        │  │    (atomic loop: deposit│  │  • Mint mUSD      │  │
│  │  • Transfer       │  │  • Withdraw       │  │    → borrow → swap DEX │  │  • Burn mUSD      │  │
│  │  • Blacklist      │  │  • Yield accrual  │  │    → add collateral)   │  │  • Redeem stables │  │
│  │  • BridgeToETH    │  │  • CooldownTicket │  │  • Repay / Withdraw    │  │  • Fees & limits  │  │
│  │                   │  │                   │  │  • Liquidate            │  │  • Auto bridge-out│  │
│  └────────┬──────────┘  └───────────────────┘  └─────────────────────────┘  └───────────────────┘  │
│           │                                                                                        │
│           ▼ bridgeToEthereum()                                          receiveFromEthereum() ▲   │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                           Canton Bridge Module (DAML)                                        │  │
│  │    Burns Canton mUSD → Attestation → Validators sign → Relay to Ethereum                    │  │
│  │    Receives attestation from Ethereum → Validates → Mints Canton mUSD                       │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                ║ ▲
                                    3-of-5      ║ ║      3-of-5
                                  Attestation   ║ ║    Attestation
                                  (burn proof)  ▼ ║   (burn proof)
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      ETHEREUM (Solidity)                                           │
│                                                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                           BLEBridge (Solidity)                                               │  │
│  │    Burns Ethereum mUSD → Attestation → Validators sign → Relay to Canton                    │  │
│  │    Receives attestation from Canton → Validates → Mints Ethereum mUSD                       │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘  │
│           │                                                                         ▲              │
│           ▼ receiveFromCanton()                                      bridgeToCanton() │           │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │  MUSD             │  │  SMUSD            │  │  Leveraged Vaults      │  │  DirectMint       │  │
│  │  (ERC-20)         │  │  (ERC-4626)       │  │                         │  │                   │  │
│  │                   │  │                   │  │  • CollateralVault      │  │  • Deposit USDC   │  │
│  │  • Transfer       │  │  • Deposit        │  │  • BorrowModule        │  │  • Mint mUSD      │  │
│  │  • Approve        │  │  • Withdraw       │  │  • LiquidationEngine   │  │  • Burn mUSD      │  │
│  │  • Blacklist      │  │  • Yield accrual  │  │  • PriceOracle         │  │  • Redeem USDC    │  │
│  └───────────────────┘  └───────────────────┘  └─────────────────────────┘  └────────┬──────────┘  │
│                                                                                      │             │
│                                                                                      ▼             │
│                                                                            ┌───────────────────┐  │
│                                                                            │    Treasury       │  │
│                                                                            │   (USDC Pool)     │  │
│                                                                            │                   │  │
│                                                                            │  • Strategies     │  │
│                                                                            │  • Yield → smUSD  │  │
│                                                                            └───────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘

Global Supply = Canton mUSD + Ethereum mUSD (conserved across bridge operations)
```

## Frontend Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Next.js 14 / React 18 / TypeScript               │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  Layout → Navbar → ChainToggle (Ethereum ↔ Canton)              │    │
│  └──────────────────────┬───────────────────────────────────────────┘    │
│                         │                                                │
│            ┌────────────┴────────────┐                                   │
│            ▼                         ▼                                   │
│  ┌─────────────────────┐  ┌─────────────────────────┐                   │
│  │  Ethereum Mode      │  │  Canton Mode             │                  │
│  │  (ethers.js)        │  │  (Daml JSON API)         │                  │
│  │                     │  │                           │                  │
│  │  DashboardPage      │  │  CantonDashboard          │                  │
│  │  MintPage           │  │  CantonMint               │                  │
│  │  StakePage          │  │  CantonStake              │                  │
│  │  BorrowPage         │  │  CantonBorrow             │                  │
│  │  LiquidationsPage   │  │  CantonLiquidations       │                  │
│  │  BridgePage         │  │  CantonBridge             │                  │
│  │  AdminPage          │  │  CantonAdmin              │                  │
│  └─────────────────────┘  └─────────────────────────┘                   │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Hooks                                                             │  │
│  │  useWallet   → MetaMask provider / signer                         │  │
│  │  useContract → ethers.js Contract instances (10 ABIs)             │  │
│  │  useCanton   → Daml JSON API query / exercise / create            │  │
│  │  useChain    → Ethereum / Canton toggle state                     │  │
│  │  useTx       → Transaction loading / hash / error / success       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Shared Components                                                 │  │
│  │  StatCard  → Reusable protocol stat display                       │  │
│  │  TxButton  → Transaction button with loading spinner              │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Lib                                                               │  │
│  │  config.ts → Contract addresses, Canton host/port/token           │  │
│  │  format.ts → USD, token, bps, health factor formatting            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Design Decision: No Canton Treasury

Canton Network is built for institutional settlement, privacy, and compliance — not DeFi yield. There is no Aave, Morpho, Pendle, or Curve on Canton. The tokenized assets on Canton are institutional instruments held in permissioned sub-networks, not open lending pools.

All backing stables flow to Ethereum's Treasury, where they are deployed to yield strategies. Canton is a **pure accounting layer**:

- `CantonDirectMint` mints mUSD and immediately creates a `BridgeOutRequest` to move backing stables to ETH Treasury
- `CantonDirectMint` redeem burns mUSD and creates a `BridgeInRequest` to pull stables back from ETH
- `CantonSMUSD` syncs its exchange rate from Ethereum via `SMUSD_SyncYield` attestations
- No stables are held idle on Canton

## Canton Templates (DAML)

All 14 templates are in `daml/Minted/Protocol/V3.daml` (1122 lines).

### Core Asset Layer

| Template | Key | Choices | Description |
|----------|-----|---------|-------------|
| `Asset` | — | `Asset_Transfer`, `Asset_Split`, `Asset_Merge` | Generic UTXO token. Split produces two contracts, merge archives the other. |
| `MintedMUSD` | — | `MUSD_Transfer`, `MUSD_Split`, `MUSD_Merge`, `MUSD_BridgeToEthereum`, `MUSD_SetBlacklist` | mUSD-specific asset with compliance (blacklist checked on every operation) and bridge-to-ETH consuming choice that creates an `AttestationRequest`. |
| `PriceOracle` | `(provider, symbol)` | — | Provider-signed price feed. Keyed for unique lookup by provider and symbol pair. |
| `LiquidityPool` | — | `Swap_mUSD_For_Collateral`, `Swap_Collateral_For_mUSD` | On-chain DEX for atomic leverage operations in vaults. |

### Mint / Redeem

| Template | Choices | Description |
|----------|---------|-------------|
| `CantonDirectMint` | `CantonMint_Mint`, `CantonMint_Redeem`, `CantonMint_UpdateConfig` | Deposit Canton stables → mint mUSD + auto `BridgeOutRequest` to ETH Treasury. Redeem burns mUSD + creates `BridgeInRequest`. Tracks `totalMinted` and `totalBridgedOut`. |
| `MintServiceConfig` | (data type) | Fee bps (mint/redeem), min/max amounts, pause flag. |

### Staking (Yield Vault)

| Template | Choices | Description |
|----------|---------|-------------|
| `CantonSMUSD` | `SMUSD_Deposit`, `SMUSD_Withdraw`, `SMUSD_SyncYield`, `SMUSD_UpdateConfig` | Deposit mUSD → smUSD shares at current exchange rate. Withdraw after cooldown. Yield synced from ETH via provider attestation. Share price = `totalAssets / totalShares`. |
| `CooldownTicket` | — | Tracks deposit time and enforces cooldown period before withdrawal. Partial burns reissue a remainder ticket. |
| `SmUSDConfig` | (data type) | Cooldown seconds, max total deposits cap. |

### Leveraged Vaults (CDP)

| Template | Choices | Description |
|----------|---------|-------------|
| `Vault` | `AdjustLeverage`, `Vault_Repay`, `Vault_WithdrawCollateral`, `Liquidate` | Collateralized debt position. Atomic leverage: deposit collateral + borrow mUSD + swap via DEX in one transaction. Interest accrual is continuous. Liquidation enforces close factor, penalty split (keeper bonus + protocol fee), and dust threshold. |
| `VaultConfig` | (data type) | Liquidation threshold, interest rate bps, penalty bps, bonus bps, close factor bps, dust threshold. |
| `VaultManager` | `OpenVault`, `UpdateDefaultConfig`, `UpdateVaultConfig` | Factory for creating vaults with default config. Admin can update defaults and per-vault configs. |
| `LiquidationReceipt` | — | Immutable audit trail per liquidation: debt repaid, collateral seized, penalty, keeper bonus, protocol fee, health before/after, full vs partial. |
| `LiquidationOrder` | `ClaimOrder`, `CompleteOrder`, `CancelOrder` | Keeper coordination. Status: `Pending → Claimed → Executed` (or `Cancelled`). |

### Bridge Protocol

| Template | Choices | Description |
|----------|---------|-------------|
| `BridgeService` | `Bridge_ReceiveFromEthereum`, `Bridge_AssignNonce`, `Bridge_CompleteBridgeOut`, `Bridge_Pause`, `Bridge_Unpause`, `Bridge_UpdateValidators` | Coordinates all bridge operations. Mints `MintedMUSD` on Canton when receiving from ETH (after attestation validation). Tracks nonces, `totalBridgedIn`, `totalBridgedOut`. |
| `AttestationRequest` | `Attestation_Sign`, `Attestation_Complete`, `Attestation_Cancel` | Multi-party validation. Validators sign independently; auto-promotes to `BridgeSigned` at threshold (e.g. 3-of-5). Unique request ID, nonce, chain ID for replay protection. |
| `BridgeOutRequest` | `BridgeOut_SetTarget`, `BridgeOut_AssignNonce`, `BridgeOut_Complete`, `BridgeOut_Cancel` | Canton → ETH transfer. User sets ETH address, provider assigns nonce, completes after ETH confirms. |
| `BridgeInRequest` | `BridgeIn_Complete`, `BridgeIn_Cancel` | ETH → Canton transfer. Provider completes by minting Canton-side stables. |

### Compliance

| Feature | Implementation |
|---------|---------------|
| Blacklist | `MintedMUSD.blacklisted` flag, checked on transfer / split / merge / bridge |
| Pause | `CantonDirectMint.config.paused`, `BridgeService.paused` |
| Supply tracking | `CantonDirectMint.totalMinted`, `CantonDirectMint.totalBridgedOut`, `BridgeService.totalBridgedIn/Out` |

## Ethereum Contracts (Solidity)

Contract source is maintained separately. ABIs are in `src/abis/` (10 files).

| Contract | Type | Description |
|----------|------|-------------|
| `MUSD` | ERC-20 | Role-based mint/burn, supply cap, blacklist |
| `SMUSD` | ERC-4626 | Yield vault with cooldown, base rate, max deposits |
| `DirectMint` | — | 1:1 USDC ↔ mUSD with configurable fees, limits, pause |
| `Treasury` | — | USDC reserve pool, strategy deployment, return recording |
| `BLEBridgeV9` | — | Canton attestation bridge, multi-sig, supply cap, emergency controls |
| `CollateralVault` | — | Multi-token collateral with per-token factors and thresholds |
| `BorrowModule` | — | mUSD borrowing against collateral, interest accrual, health factor |
| `LiquidationEngine` | — | Liquidation with close factor and collateral seizure |
| `PriceOracle` | — | Chainlink-compatible feeds with staleness checks |
| `ERC20` | — | Standard token interface for generic interactions |

## User Flows

### Mint on Canton (stables → ETH Treasury)

```
User deposits 100 Canton USDC
  → CantonDirectMint.CantonMint_Mint()
  → Fee deducted (e.g. 0.30%)
  → 99.70 mUSD minted to user on Canton
  → BridgeOutRequest created (100 USDC → ETH Treasury)
  → Relay picks up request, bridges stables to Ethereum
  → ETH Treasury receives USDC, deploys to yield strategies
```

### Redeem on Canton (pull stables from ETH)

```
User burns 100 Canton mUSD
  → CantonDirectMint.CantonMint_Redeem()
  → Fee deducted
  → BridgeInRequest created (pull USDC from ETH Treasury)
  → Relay bridges stables back to Canton
  → User receives Canton USDC
```

### Bridge: Canton → Ethereum

```
User holds MintedMUSD on Canton
  → MUSD_BridgeToEthereum(ethAddress, chainId, validators, requiredSigs)
  → Canton mUSD burned (consuming choice)
  → AttestationRequest created
  → 3 of 5 validators call Attestation_Sign
  → Status auto-promotes to BridgeSigned at threshold
  → Relay submits attestation to BLEBridgeV9.processAttestation()
  → Ethereum mUSD minted to user's ETH wallet
```

### Bridge: Ethereum → Canton

```
User burns mUSD on Ethereum via BLEBridge
  → Validators create AttestationRequest on Canton (EthereumToCanton)
  → 3 of 5 sign
  → Provider calls BridgeService.Bridge_ReceiveFromEthereum()
  → Validates: attestation signed, correct direction, sequential nonce
  → MintedMUSD created on Canton for recipient
```

### Stake for Yield (Canton)

```
User deposits mUSD into CantonSMUSD
  → SMUSD_Deposit: mUSD burned, smUSD shares issued, CooldownTicket created
  → Yield synced from ETH: provider calls SMUSD_SyncYield(newTotalAssets)
  → Share price increases as totalAssets grows
  → After cooldown: SMUSD_Withdraw burns shares, returns mUSD at new rate
```

### Leveraged Vault

```
VaultManager.OpenVault(owner, token) → empty vault
  → AdjustLeverage: deposit collateral + borrow mUSD + swap via DEX atomically
  → Health check enforced after every adjustment
  → If health < threshold: anyone calls Liquidate
    → Liquidator provides mUSD, receives discounted collateral
    → Penalty split: keeper bonus + protocol fee
    → LiquidationReceipt created (immutable audit trail)
```

## Canton Vault System Detail

### Interest Accrual

```
totalDebt = principalDebt + accruedInterest + calcInterest(now)
calcInterest = principal × rateBps × elapsedSeconds / (10000 × 31536000)
```

### Vault Config

| Parameter | Example | Description |
|-----------|---------|-------------|
| `liquidationThreshold` | 1.5 | 150% min collateral ratio |
| `interestRateBps` | 500 | 5% APR |
| `liquidationPenaltyBps` | 1000 | 10% penalty on seized collateral |
| `liquidationBonusBps` | 500 | 5% keeper bonus from penalty |
| `closeFactorBps` | 5000 | 50% max debt per liquidation |
| `dustThreshold` | 10.0 | Force full liquidation below this |

### Mint Service Config

| Parameter | Example | Description |
|-----------|---------|-------------|
| `mintFeeBps` | 30 | 0.30% mint fee |
| `redeemFeeBps` | 30 | 0.30% redeem fee |
| `minAmount` | 100.0 | Minimum per transaction |
| `maxAmount` | 1000000.0 | Maximum per transaction |
| `paused` | False | Emergency pause |

### smUSD Config

| Parameter | Example | Description |
|-----------|---------|-------------|
| `cooldownSeconds` | 86400 | 24 hour withdrawal cooldown |
| `maxTotalDeposits` | 10000000.0 | Cap on total mUSD staked |

## Frontend

Next.js 14 / TypeScript / Tailwind CSS with dual-chain toggle. Every page renders Ethereum (ethers.js + MetaMask) or Canton (Daml JSON API) mode based on the active chain selection.

### Pages

| Page | Ethereum Mode | Canton Mode |
|------|---------------|-------------|
| Dashboard | mUSD supply, treasury balance, vault stats, bridge health | Asset counts, service status, vault count |
| Mint/Redeem | USDC ↔ mUSD via DirectMint contract | CantonDirectMint exercise via Daml JSON API |
| Stake | smUSD ERC-4626 deposit/redeem with cooldown | CantonSMUSD deposit/withdraw with cooldown ticket |
| Borrow | Collateral deposit, borrow/repay, health factor | Vault CDP with oracle price feeds |
| Liquidations | Check liquidatability, estimate seizure, execute | Browse vaults by health ratio |
| Bridge | BLEBridgeV9 attestation events and health | Lock/attest/claim workflow |
| Admin | All contract admin panels (6 subsections) | IssuerRole, Oracle, service configuration |

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Next.js | 14.1 | React framework with file-based routing |
| React | 18.2 | UI library |
| TypeScript | 5.3 | Static typing |
| Tailwind CSS | 3.4 | Utility-first styling with custom brand palette |
| ethers.js | 6.9 | Ethereum provider, signer, contract interaction |
| recharts | 2.10 | Charts and data visualization |
| lucide-react | 0.312 | Icon library |
| Daml JSON API | — | Canton Network ledger interaction (custom hook) |

## Repository Structure

```
├── daml/
│   └── Minted/Protocol/
│       └── V3.daml                    # All Canton templates (14 templates, 1122 lines)
├── src/
│   ├── abis/                          # Ethereum contract ABIs (10 files)
│   │   ├── BLEBridgeV9.ts
│   │   ├── BorrowModule.ts
│   │   ├── CollateralVault.ts
│   │   ├── DirectMint.ts
│   │   ├── ERC20.ts
│   │   ├── LiquidationEngine.ts
│   │   ├── MUSD.ts
│   │   ├── PriceOracle.ts
│   │   ├── SMUSD.ts
│   │   └── Treasury.ts
│   ├── components/
│   │   ├── canton/                    # Canton-mode UI components (7)
│   │   │   ├── CantonAdmin.tsx
│   │   │   ├── CantonBorrow.tsx
│   │   │   ├── CantonBridge.tsx
│   │   │   ├── CantonDashboard.tsx
│   │   │   ├── CantonLiquidations.tsx
│   │   │   ├── CantonMint.tsx
│   │   │   └── CantonStake.tsx
│   │   ├── ChainToggle.tsx            # Ethereum / Canton switch
│   │   ├── Layout.tsx                 # Main layout wrapper
│   │   ├── Navbar.tsx                 # Navigation with wallet connection
│   │   ├── StatCard.tsx               # Reusable stat display
│   │   └── TxButton.tsx               # Transaction button with loading state
│   ├── hooks/
│   │   ├── useCanton.ts               # Daml JSON API client wrapper
│   │   ├── useChain.ts                # Ethereum / Canton toggle state
│   │   ├── useContract.ts             # ethers.js contract instances
│   │   ├── useTx.ts                   # Transaction state management
│   │   └── useWallet.ts               # MetaMask wallet connection
│   ├── lib/
│   │   ├── config.ts                  # Contract addresses, Canton config
│   │   └── format.ts                  # USD, token, bps, health formatting
│   ├── pages/
│   │   ├── index.tsx                  # Router (Ethereum or Canton based on toggle)
│   │   ├── _app.tsx                   # Next.js app wrapper
│   │   ├── _document.tsx              # HTML document wrapper
│   │   ├── AdminPage.tsx
│   │   ├── BorrowPage.tsx
│   │   ├── BridgePage.tsx
│   │   ├── DashboardPage.tsx
│   │   ├── LiquidationsPage.tsx
│   │   ├── MintPage.tsx
│   │   └── StakePage.tsx
│   ├── styles/
│   │   └── globals.css                # Tailwind CSS with custom brand theme
│   └── global.d.ts                    # TypeScript type declarations
├── .env.example                       # Environment variable template
├── next.config.js                     # Next.js configuration
├── tailwind.config.js                 # Tailwind CSS theme (brand colors 50-950)
├── postcss.config.js                  # PostCSS configuration
├── tsconfig.json                      # TypeScript config (strict, path aliases)
└── package.json                       # Dependencies and scripts
```

## Setup

```bash
npm install
cp .env.example .env.local   # Fill in contract addresses and Canton config
npm run dev                   # http://localhost:3000
```

### Environment Variables

```bash
# Ethereum
NEXT_PUBLIC_CHAIN_ID=1
NEXT_PUBLIC_MUSD_ADDRESS=0x...
NEXT_PUBLIC_SMUSD_ADDRESS=0x...
NEXT_PUBLIC_USDC_ADDRESS=0x...
NEXT_PUBLIC_DIRECT_MINT_ADDRESS=0x...
NEXT_PUBLIC_TREASURY_ADDRESS=0x...
NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=0x...
NEXT_PUBLIC_BORROW_MODULE_ADDRESS=0x...
NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=0x...
NEXT_PUBLIC_BRIDGE_ADDRESS=0x...
NEXT_PUBLIC_PRICE_ORACLE_ADDRESS=0x...

# Canton
NEXT_PUBLIC_CANTON_LEDGER_HOST=localhost
NEXT_PUBLIC_CANTON_LEDGER_PORT=6865
NEXT_PUBLIC_CANTON_TOKEN=<JWT_TOKEN>
```

### Prerequisites

- Node.js 18+
- DAML SDK 2.8.0 (for Canton development)

## What's Not Built Yet

| Component | Description |
|-----------|-------------|
| Relay service | TypeScript bridge relayer monitoring both chains |
| Canton rate limiting | 24h rolling window on mint/burn volume |
| Solidity source | `.sol` files (ABIs only in this repo) |
| Integration tests | Hardhat + DAML test suites |

## Roadmap

- [x] Canton leveraged vault system (Vault, Liquidation, Oracle, DEX)
- [x] Canton DirectMint (thin layer, auto bridge-out to ETH Treasury)
- [x] Canton smUSD (yield vault synced from ETH attestations)
- [x] Canton bridge protocol (BridgeService, AttestationRequest, 3-of-5 multi-sig)
- [x] MintedMUSD (Canton mUSD with compliance + bridge-to-ETH choice)
- [x] Ethereum contract ABIs (MUSD, SMUSD, DirectMint, Treasury, Bridge, Borrow, Liquidation, Oracle)
- [x] Frontend with Ethereum + Canton dual-mode UI
- [ ] Relay service (TypeScript bridge infrastructure)
- [ ] Canton rate limiting (24h rolling window)
- [ ] Solidity source contracts in this repo
- [ ] Integration tests (Hardhat + DAML test)
- [ ] Mainnet deployment

## License

Proprietary
