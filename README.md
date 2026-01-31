# Minted mUSD Protocol

A cross-chain stablecoin protocol spanning **Canton Network** (DAML) and **Ethereum** (Solidity). mUSD is minted 1:1 against stablecoins. Canton serves as the institutional-grade accounting, compliance, and settlement layer; Ethereum serves as the yield and DeFi execution layer. All backing reserves flow to Ethereum's Treasury for yield generation — there is no Canton Treasury.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      CANTON NETWORK (DAML)                                         │
│                                                                                                    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │  MintedMUSD        │  │  CantonSMUSD      │  │  Leveraged Vault (CDP) │  │  CantonDirectMint │  │
│  │  (DAML Asset)      │  │  (Yield Vault)    │  │                         │  │                   │  │
│  │                    │  │                   │  │  • AdjustLeverage       │  │  • Deposit stables│  │
│  │  • Split/Merge     │  │  • Deposit        │  │    (atomic loop: deposit│  │  • Mint mUSD      │  │
│  │  • Transfer        │  │  • Withdraw       │  │    → borrow → swap DEX │  │  • Burn mUSD      │  │
│  │  • MPA agreement   │  │  • Yield accrual  │  │    → add collateral)   │  │  • Redeem stables │  │
│  │  • BridgeToETH     │  │  • CooldownTicket │  │  • Repay / Withdraw    │  │  • Rate limiting  │  │
│  │                    │  │                   │  │  • Liquidate            │  │  • Compliance hook│  │
│  └────────┬───────────┘  └───────────────────┘  └─────────────────────────┘  └───────────────────┘  │
│           │                                                                                        │
│           ▼ bridgeToEthereum()                                          receiveFromEthereum() ▲   │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                           Canton Bridge Module (DAML)                                        │  │
│  │    Burns Canton mUSD → Attestation → Validators sign → Relay to Ethereum                    │  │
│  │    Receives attestation from Ethereum → Validates → Mints Canton mUSD                       │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  ComplianceRegistry (DAML)                                                                   │  │
│  │  Blacklist / Freeze / ValidateMint / ValidateTransfer / ValidateRedemption                   │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                ║ ▲
                                    3-of-5      ║ ║      3-of-5
                                  Attestation   ║ ║    Attestation
                                  (burn proof)  ▼ ║   (burn proof)
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              RELAY SERVICE (TypeScript)                                            │
│  relay-service.ts → Watches Canton for finalized attestations, submits to BLEBridgeV9             │
│  validator-node-v2.ts → Canton Asset API + AWS KMS signing + collateral ratio checks              │
│  Docker Compose → relay + 3 validators, secrets, health checks, resource limits                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                ║ ▲
                                                ▼ ║
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      ETHEREUM (Solidity)                                           │
│                                                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     BLEBridgeV9 (Solidity) — 24h rate-limited supply cap                     │  │
│  │    Receives attestation from Canton → Validates sigs → Updates supply cap (rate-limited)     │  │
│  │    Emergency controls, collateral ratio enforcement, nonce replay protection                 │  │
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
│                                                                            │  TreasuryV2       │  │
│                                                                            │  (USDC Pool)      │  │
│                                                                            │                   │  │
│                                                                            │  • Strategies     │  │
│                                                                            │  • Yield → smUSD  │  │
│                                                                            │  • PendleSelector │  │
│                                                                            └───────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘

Global Supply = Canton mUSD + Ethereum mUSD (conserved across bridge operations)
```

## Infrastructure

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│   Internet   │────▶│  NGINX Proxy │────▶│   Canton Participant     │────▶│   PostgreSQL    │
│              │     │  (TLS + Rate │     │   (Ledger + JSON API)    │     │   (StatefulSet) │
│              │     │   Limiting)  │     │                          │     │                 │
└──────────────┘     └──────────────┘     └──────────────────────────┘     └─────────────────┘
                     2 replicas            1 replica (stateful)             1 replica + PVC
                     10r/s read            gRPC health probes              Encrypted storage
                     2r/s write            Non-root, read-only rootfs
                     TLS 1.2/1.3           Admin API localhost-only
```

All components deployed via Kubernetes manifests in `k8s/` with:
- Pod Security Standards (restricted)
- NetworkPolicy (default-deny + explicit allow)
- PodDisruptionBudgets
- Pinned image versions (no `:latest`)

## Solidity Contracts

15 contracts in `contracts/` compiled with Solidity 0.8.26.

| Contract | Type | Description |
|----------|------|-------------|
| `MUSD` | ERC-20 | Role-based mint/burn, supply cap, blacklist |
| `SMUSD` | ERC-4626 | Yield vault with cooldown, base rate, max deposits |
| `DirectMint` | Minting | 1:1 USDC ↔ mUSD with configurable fees, limits, pause |
| `DirectMintV2` | Minting | Upgraded DirectMint |
| `BLEBridgeV8` | Bridge | Canton attestation bridge with daily mint limit (predecessor) |
| `BLEBridgeV9` | Bridge | Refactored: attestations update supply cap (rate-limited), multi-sig, emergency controls |
| `Treasury` | Reserve | USDC reserve pool, strategy deployment, return recording |
| `TreasuryV2` | Reserve | Enhanced treasury with yield strategies and PendleMarketSelector |
| `CollateralVault` | CDP | Multi-token collateral with per-token factors and thresholds |
| `BorrowModule` | CDP | mUSD borrowing against collateral, interest accrual, health factor |
| `LiquidationEngine` | CDP | Liquidation with close factor and collateral seizure |
| `PriceOracle` | Oracle | Chainlink-compatible feeds with staleness checks |
| `PendleMarketSelector` | Yield | Market selection for TreasuryV2 yield strategies |
| `MockERC20` / `MockAggregatorV3` / `MockStrategy` | Testing | Mock contracts for Hardhat tests |

### BLEBridgeV9 Rate Limiting

24h rolling window on supply cap increases. Cap decreases (from reduced attestations) offset increases within the same window:

```
dailyCapIncreaseLimit = 50,000,000 (configurable)
netCapIncrease = dailyCapIncreased - dailyCapDecreased
require(netCapIncrease < dailyCapIncreaseLimit)
Window resets after 24h (block.timestamp >= lastRateLimitReset + 1 days)
```

View functions: `getNetDailyCapIncrease()`, `getRemainingDailyCapLimit()`

## Canton Templates (DAML)

### Core Assets

| Template | File | Description |
|----------|------|-------------|
| `MUSD` | `MintedProtocolV2Fixed.daml` | mUSD token with `agreement` clause embedding MPA hash + URI. Split/Merge/Transfer/Burn. |
| `CantonMUSD` | `CantonDirectMint.daml` | Canton-side mUSD with MPA agreement clause. Transfer/Split/Merge/Burn. |
| `CantonUSDC` | `CantonDirectMint.daml` | USDC deposit representation on Canton. |
| `Collateral` | `MintedProtocolV2Fixed.daml` | Generic collateral token with transfer-via-proposal pattern. |
| `USDC` | `MintedProtocolV2Fixed.daml` | USDC token with transfer-via-proposal pattern. |

### Mint / Redeem

| Template | File | Key Features |
|----------|------|-------------|
| `DirectMintService` | `MintedProtocolV2Fixed.daml` | Mint/Redeem with fees, supply cap, 24h rate limiting, MPA propagation. |
| `CantonDirectMintService` | `CantonDirectMint.daml` | Canton mint + auto BridgeOutRequest. 24h rate limiting, compliance hooks, MPA propagation. |

Rate limiting on both services:
```
dailyMintLimit, dailyMinted, dailyBurned, lastRateLimitReset
Net calculation: burns offset mints within the same 24h window
Window auto-resets after 24 hours
```

### Compliance

| Template | File | Description |
|----------|------|-------------|
| `ComplianceRegistry` | `Compliance.daml` | Blacklist (Set-based O(log n)), freeze, bulk import (max 100), audit reasons. |

Choices: `BlacklistUser`, `RemoveFromBlacklist`, `FreezeUser`, `UnfreezeUser`, `ValidateMint`, `ValidateTransfer`, `ValidateRedemption`, `IsCompliant`, `BulkBlacklist`

Integration: `CantonDirectMintService` holds an optional `complianceRegistryCid`. When set, `DirectMint_Mint` validates the minter and `DirectMint_Redeem` validates the redeemer before processing. Frozen parties can receive but cannot send.

### Staking

| Template | File | Description |
|----------|------|-------------|
| `StakingService` | `MintedProtocolV2Fixed.daml` | Stake mUSD → StakedMUSD with interest accrual. Unstake tracks supply cap via IssuerRole. |
| `CantonStakingService` | `CantonSMUSD.daml` | Canton yield vault. Share-price model (totalAssets/totalShares). Yield synced from ETH. |
| `CantonSMUSD` | `CantonSMUSD.daml` | Individual smUSD share position. |

### Vaults (CDP)

| Template | File | Description |
|----------|------|-------------|
| `Vault` | `MintedProtocolV2Fixed.daml` | CDP with interest accrual, oracle-checked collateral, MPA propagation to borrowed MUSD. |
| `LiquidationEngine` | `MintedProtocolV2Fixed.daml` | Liquidation with close factor, penalty, partial/full modes. |
| `LiquidityPool` | `MintedProtocolV2Fixed.daml` | DEX for atomic leverage (swap mUSD for collateral). |
| `LeverageManager` | `MintedProtocolV2Fixed.daml` | Multi-loop leverage: borrow → swap → deposit (max 10 loops). |

### Bridge Protocol

| Template | File | Description |
|----------|------|-------------|
| `AttestationRequest` | `MintedProtocolV2Fixed.daml` | Multi-party validation with signature tracking, supermajority quorum, expiry. |
| `ValidatorSignature` | `MintedProtocolV2Fixed.daml` | Individual validator ECDSA signature. |
| `IssuerRole` | `MintedProtocolV2Fixed.daml` | Supply-cap-tracked minting via attestation or direct. MPA fields. |
| `BridgeOutRequest` | `CantonDirectMint.daml` | Canton → Ethereum bridge request with validator list and nonce. |
| `RedemptionRequest` | `CantonDirectMint.daml` | Pending redemption awaiting USDC bridge-in from Ethereum. |

### Price Oracle

| Template | File | Description |
|----------|------|-------------|
| `PriceOracle` | `MintedProtocolV2Fixed.daml` | Price feed with staleness enforcement via ledger time. |
| `InstitutionalEquityPosition` | `MintedProtocolV2Fixed.daml` | Bank-signed equity positions for attestation collateral checks. |

### Master Participation Agreement (MPA)

Every minted mUSD/CantonMUSD token carries:
- `agreementHash`: SHA-256 hex digest (64 chars) of the MPA PDF
- `agreementUri`: URI to the legal terms document
- DAML `agreement` clause: embedded in ledger audit trail

The `ensure` clause validates hash length and non-empty URI. MPA fields propagate through `DirectMintService`, `CantonDirectMintService`, `StakingService`, `CantonStakingService`, `Vault`, and `IssuerRole`.

## Relay Service

Production-hardened TypeScript bridge infrastructure in `relay/`.

| File | Lines | Description |
|------|-------|-------------|
| `relay-service.ts` | ~600 | Watches Canton ledger for finalized attestations, submits to BLEBridgeV9 on Ethereum. DER→RSV signature conversion, duplicate tracking, bounded cache. |
| `validator-node-v2.ts` | ~400 | Canton Asset API integration, AWS KMS signing, collateral ratio validation (110% default). |
| `validator-node.ts` | ~300 | Base validator implementation. |
| `signer.ts` | ~200 | DER-to-RSV ECDSA signature conversion with 40+ security fixes. |

Docker deployment (`docker-compose.yml`):
- Relay + 3 validator nodes
- Docker secrets for private keys and AWS credentials
- Network isolation (internal + external bridges)
- Resource limits (512M relay, 512M per validator)
- Read-only rootfs, non-root user, health checks

## Frontend

Next.js 14 / TypeScript / Tailwind CSS with dual-chain toggle in `frontend/`.

| Page | Ethereum Mode | Canton Mode |
|------|---------------|-------------|
| Dashboard | mUSD supply, treasury balance, vault stats, bridge health | Asset counts, service status, vault count |
| Mint/Redeem | USDC ↔ mUSD via DirectMint contract | CantonDirectMint exercise via Daml JSON API |
| Stake | smUSD ERC-4626 deposit/redeem with cooldown | CantonSMUSD deposit/withdraw |
| Borrow | Collateral deposit, borrow/repay, health factor | Vault CDP with oracle price feeds |
| Liquidations | Check liquidatability, estimate seizure, execute | Browse vaults by health ratio |
| Bridge | BLEBridgeV9 attestation events and health | Lock/attest/claim workflow |
| Admin | All contract admin panels (6 subsections) | IssuerRole, Oracle, service configuration |

## Tests

| File | Tests | Coverage |
|------|-------|----------|
| `test/BLEProtocol.test.ts` | 27 | BLEBridgeV9 attestation, multi-sig, supply cap, nonce, emergency, rate limiting |
| `test/TreasuryV2.test.ts` | 33 | Treasury strategies, yield recording, withdrawals, edge cases |
| `daml/Test.daml` | 11 | Canton bridge attestation flow, institutional equity, MintedMUSD operations |
| `daml/CantonDirectMintTest.daml` | 9 | DirectMint, redeem, bridge-out, supply cap sync, staking, yield, end-to-end |

Run tests:
```bash
npx hardhat test           # Solidity
cd daml && daml test       # DAML
```

## Repository Structure

```
├── .github/workflows/
│   └── ci.yml                           # CI: Solidity, DAML, Docker, Slither, Trivy, kubeval
├── contracts/                           # Solidity contracts (15 files)
│   ├── BLEBridgeV8.sol                  # Bridge V8 (predecessor, with daily mint limit)
│   ├── BLEBridgeV9.sol                  # Bridge V9 (supply cap model, 24h rate limiting)
│   ├── MUSD.sol                         # ERC-20 mUSD token
│   ├── SMUSD.sol                        # ERC-4626 staking vault
│   ├── DirectMint.sol / DirectMintV2.sol
│   ├── Treasury.sol / TreasuryV2.sol
│   ├── CollateralVault.sol / BorrowModule.sol / LiquidationEngine.sol
│   ├── PriceOracle.sol / PendleMarketSelector.sol
│   ├── interfaces/IStrategy.sol
│   └── mocks/                           # MockERC20, MockAggregatorV3, MockStrategy
├── daml/                                # Canton DAML templates
│   ├── MintedProtocolV2Fixed.daml       # Audited protocol (MUSD, Vault, Staking, Oracle, Bridge)
│   ├── CantonDirectMint.daml            # Canton mint service + bridge requests
│   ├── CantonSMUSD.daml                 # Canton staking vault (share-price model)
│   ├── Compliance.daml                  # Blacklist/freeze registry with compliance hooks
│   ├── BLEBridgeProtocol.daml           # Bridge protocol types
│   ├── BLEProtocol.daml                 # Bridge protocol
│   ├── MintedMUSD.daml                  # Standalone mUSD asset module
│   ├── CantonDirectMintTest.daml        # Integration tests (9 tests)
│   ├── Test.daml                        # Integration tests (11 tests)
│   └── daml.yaml                        # DAML project config
├── frontend/                            # Next.js 14 / TypeScript / Tailwind
│   ├── src/abis/                        # Ethereum contract ABIs (10 files)
│   ├── src/components/canton/           # Canton-mode UI components (7)
│   ├── src/components/                  # Shared components (ChainToggle, Layout, Navbar, etc.)
│   ├── src/hooks/                       # useCanton, useChain, useContract, useTx, useWallet
│   ├── src/pages/                       # 7 pages + routing
│   └── src/lib/                         # config.ts, format.ts
├── relay/                               # Bridge relay service (TypeScript)
│   ├── relay-service.ts                 # Canton→Ethereum attestation relay
│   ├── validator-node-v2.ts             # Enhanced validator with Canton Asset API
│   ├── validator-node.ts                # Base validator
│   ├── signer.ts                        # DER→RSV signature conversion
│   ├── docker-compose.yml               # Relay + 3 validators orchestration
│   └── Dockerfile                       # Multi-stage production build
├── k8s/                                 # Kubernetes deployment manifests
│   ├── base/
│   │   ├── namespace.yaml               # Namespace with pod-security-standards
│   │   └── postgres-statefulset.yaml    # PostgreSQL 16.4 with encrypted PVC
│   └── canton/
│       ├── participant-deployment.yaml  # Canton + JSON API sidecar
│       ├── participant-config.yaml      # HOCON config + bootstrap script
│       ├── nginx-configmap.yaml         # NGINX reverse proxy config (TLS + rate limiting)
│       ├── nginx-deployment.yaml        # NGINX deployment (2 replicas, LoadBalancer)
│       ├── network-policy.yaml          # Default-deny + explicit allow rules
│       ├── secrets.yaml                 # Template secrets (postgres, TLS)
│       └── pod-disruption-budget.yaml   # PDBs for Canton and PostgreSQL
├── test/                                # Hardhat test suites
│   ├── BLEProtocol.test.ts              # 27 tests
│   └── TreasuryV2.test.ts              # 33 tests
├── hardhat.config.ts
├── package.json
└── tsconfig.json
```

## Setup

### Development

```bash
npm install
npx hardhat compile         # Compile Solidity
npx hardhat test            # Run Solidity tests
cd daml && daml build       # Build DAML
cd daml && daml test        # Run DAML tests
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local  # Fill in contract addresses and Canton config
npm run dev                  # http://localhost:3000
```

### Relay Service

```bash
cd relay
npm install
# Create secrets in relay/secrets/
docker compose up            # Start relay + 3 validators
```

### Kubernetes Deployment

```bash
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f k8s/base/
kubectl apply -f k8s/canton/
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

- Node.js 20+
- DAML SDK 2.9.3
- Docker (for relay service)
- kubectl (for K8s deployment)

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):

| Job | Tools | Purpose |
|-----|-------|---------|
| `solidity` | Hardhat | Compile, test, coverage |
| `solidity-security` | Slither | Static analysis, SARIF upload |
| `daml` | DAML SDK | Build and test Canton templates |
| `relay` | TypeScript | Compile check |
| `docker` | Buildx + Trivy | Build relay image, vulnerability scan |
| `k8s-validate` | kubeval | Validate Kubernetes manifests |
| `audit` | npm audit | Dependency vulnerability scan |

## Roadmap

- [x] Canton leveraged vault system (Vault, Liquidation, Oracle, DEX)
- [x] Canton DirectMint (thin layer, auto bridge-out to ETH Treasury)
- [x] Canton smUSD (yield vault synced from ETH attestations)
- [x] Canton bridge protocol (AttestationRequest, ValidatorSignature, 3-of-5 multi-sig)
- [x] MintedMUSD (Canton mUSD with compliance + bridge-to-ETH choice)
- [x] Solidity contracts (MUSD, SMUSD, DirectMint, Treasury, Bridge, Borrow, Liquidation, Oracle)
- [x] Frontend with Ethereum + Canton dual-mode UI
- [x] Relay service (TypeScript bridge infrastructure, Docker orchestration)
- [x] Canton rate limiting (24h rolling window on mint/burn volume — all layers)
- [x] Compliance registry (blacklist, freeze, transaction validation hooks)
- [x] Master Participation Agreement embedded in token templates
- [x] NGINX API gateway with TLS termination and rate limiting
- [x] Kubernetes deployment manifests (Canton, PostgreSQL, NGINX, NetworkPolicy)
- [x] CI/CD pipeline (Solidity, DAML, Docker, Slither, Trivy, kubeval)
- [x] Integration tests (60 Hardhat + 20 DAML tests)
- [ ] Mainnet deployment (deployment scripts, network config, contract verification)
- [ ] Monitoring stack (Prometheus, Grafana dashboards for Canton + Bridge health)

## Security

### Audit Fixes Applied

98 security findings resolved across Solidity and DAML:
- Time manipulation: All user-supplied timestamps replaced with `getTime` (DAML) / `block.timestamp` (Solidity)
- Replay attacks: Attestations archived after use (consuming choices)
- Signature deduplication: Set-based tracking prevents double-signing
- Transfer proposals: Dual-signatory pattern prevents unsolicited asset assignment
- Supply cap enforcement: Tracked in contract state, not caller-supplied
- Storage layout: V8→V9 incompatibility documented, migration contract required

### Rate Limiting (Defense in Depth)

| Layer | Mechanism |
|-------|-----------|
| NGINX | Per-IP (10r/s read, 2r/s write), global circuit breaker (500r/s), connection limit (20/IP) |
| BLEBridgeV9 | 24h rolling window on supply cap increases (`dailyCapIncreaseLimit`) |
| CantonDirectMintService | 24h rolling window on net mint volume (`dailyMintLimit`) |
| DirectMintService | 24h rolling window on net mint volume (`dailyMintLimit`) |

## Creating Repository Archive

To create a clean zip archive of the repository (excluding node_modules, build artifacts, and sensitive files):

```bash
./create-zip.sh
```

This will generate `Minted-mUSD-Canton.zip` containing all source files tracked by git.

## License

Proprietary
