# Minted mUSD Protocol For Canton

A cross-chain stablecoin protocol with full feature parity on Canton Network and Ethereum. mUSD operates natively on both chains with identical utility—mint, burn, stake, earn yield—connected by a trustless bidirectional bridge.

## Overview

mUSD is a **cross-chain native stablecoin** that exists simultaneously on Canton Network (DAML) and Ethereum (Solidity). Unlike wrapped tokens, mUSD has first-class functionality on both chains:

| Feature | Canton | Ethereum |
|---------|--------|----------|
| Mint (deposit stables) | ✅ CantonDirectMint | ✅ DirectMint |
| Burn (redeem stables) | ✅ CantonDirectMint | ✅ DirectMint |
| Transfer | ✅ MintedMUSD | ✅ MUSD (ERC-20) |
| Stake for yield | ✅ CantonSMUSD | ✅ SMUSD (ERC-4626) |
| Bridge to other chain | ✅ bridgeToEthereum() | ✅ bridgeToCanton() |

**Global Supply Conservation**: The total mUSD supply is the sum of Canton mUSD + Ethereum mUSD. Bridge operations burn on one chain and mint on the other, preserving total supply.

**Why Canton + Ethereum?**
- **Canton**: Institutional-grade privacy, compliance, and access to $6T in tokenized assets
- **Ethereum**: DeFi composability, DEX liquidity, and permissionless access
- **Bridge**: Best of both worlds—institutional backing with retail accessibility

## Architecture

mUSD is a **cross-chain native asset** with full feature parity on both Canton Network and Ethereum. Users can mint, burn, stake, and earn yield on either chain, with a trustless bridge enabling seamless movement between them.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CANTON NETWORK (DAML)                               │
│                                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐  │
│  │  MintedMUSD     │    │  CantonSMUSD    │    │  CantonDirectMint           │  │
│  │  (DAML Asset)   │    │  (Yield Vault)  │    │                             │  │
│  │                 │    │                 │    │  • Deposit Canton stables   │  │
│  │  • Split/Merge  │    │  • Deposit      │    │  • Mint mUSD                │  │
│  │  • Transfer     │    │  • Withdraw     │    │  • Burn mUSD                │  │
│  │  • Propose txs  │    │  • Yield accrual│    │  • Redeem stables           │  │
│  └────────┬────────┘    └─────────────────┘    └─────────────────────────────┘  │
│           │                                                                      │
│           ▼ bridgeToEthereum()                          receiveFromEthereum() ▲ │
│  ┌──────────────────────────────────────────────────────────────────────────────┐│
│  │                    Canton Bridge Module (DAML)                               ││
│  │    Burns Canton mUSD → Attestation → Validators sign → Relay to Ethereum    ││
│  │    Receives attestation from Ethereum → Validates → Mints Canton mUSD       ││
│  └──────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
                                        ║ ▲
                            3-of-5      ║ ║      3-of-5
                          Attestation   ║ ║    Attestation
                          (burn proof)  ▼ ║   (burn proof)
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              ETHEREUM (Solidity)                                 │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐│
│  │                    BLEBridge (Solidity)                                      ││
│  │    Burns Ethereum mUSD → Attestation → Validators sign → Relay to Canton    ││
│  │    Receives attestation from Canton → Validates → Mints Ethereum mUSD       ││
│  └──────────────────────────────────────────────────────────────────────────────┘│
│           │                                                         ▲            │
│           ▼ receiveFromCanton()                      bridgeToCanton() │         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐  │
│  │  MUSD           │    │  SMUSD          │    │  DirectMint                 │  │
│  │  (ERC-20)       │    │  (ERC-4626)     │    │                             │  │
│  │                 │    │                 │    │  • Deposit USDC             │  │
│  │  • Transfer     │    │  • Deposit      │    │  • Mint mUSD                │  │
│  │  • Approve      │    │  • Withdraw     │    │  • Burn mUSD                │  │
│  │  • Blacklist    │    │  • Yield accrual│    │  • Redeem USDC              │  │
│  └─────────────────┘    └─────────────────┘    └────────────┬────────────────┘  │
│                                                              │                   │
│                                                              ▼                   │
│                                                    ┌─────────────────┐          │
│                                                    │    Treasury     │          │
│                                                    │   (USDC Pool)   │          │
│                                                    └─────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────────┘

Global Supply = Canton mUSD + Ethereum mUSD (conserved across bridge operations)
```

## Components

### Solidity Contracts (Ethereum)

| Contract | Description |
|----------|-------------|
| `MUSD.sol` | ERC-20 stablecoin with compliance controls, blacklist, and supply cap enforcement |
| `BLEBridgeV8.sol` | Bidirectional bridge: validates Canton attestations to mint, burns Ethereum mUSD to bridge out |
| `SMUSD.sol` | ERC-4626 yield-bearing vault with cooldown protection and donation attack mitigation |
| `DirectMint.sol` | User-facing contract for 1:1 USDC ↔ mUSD minting and redemption |

### DAML Templates (Canton Network)

| Template | Description |
|----------|-------------|
| `BLEProtocol.daml` | Bridge module, attestation requests, and validator workflow |
| `MintedMUSD.daml` | Canton-side mUSD asset with split, merge, transfer, and bridge operations |
| `CantonSMUSD.daml` | Canton-side yield vault (mirrors Ethereum SMUSD functionality) |
| `CantonDirectMint.daml` | Canton-side mint/redeem against Canton stablecoin reserves |

### TypeScript Infrastructure

| Component | Description |
|-----------|-------------|
| `relay/` | Bidirectional bridge relayer that monitors both chains and submits attestations |
| `scripts/signer.ts` | AWS KMS signature conversion (DER → RSV format for Ethereum) |

## Key Features

### Cross-Chain Parity
- **Full feature parity** on both Canton and Ethereum
- **Bidirectional bridge** with burn-and-mint mechanism
- **Global supply conservation** across both chains
- **Unified yield strategies** regardless of chain

### Security
- **3-of-5 multi-sig validation** for all bridge operations
- **Cross-chain replay protection** via `address(this)` + `block.chainid` in attestation hash
- **NAV oracle integration** (Chainlink-compatible) with staleness checks
- **Net rate limiting** tracking mints and burns on 24-hour rolling window
- **Attestation ID uniqueness** preventing replay attacks
- **ERC-4626 cooldown** with transfer propagation

### Compliance
- Blacklist functionality for sanctioned addresses
- Supply cap enforcement (global across both chains)
- Emergency pause functionality on both chains
- Admin controls for stuck nonce recovery and attestation invalidation

### Yield Generation
- Treasury reserves deployed to yield strategies (Pendle, Morpho, Spark)
- smUSD vault accumulates yield for stakers on both chains
- Yield synchronized across chains via bridge attestations

## User Flows

### Direct Mint on Ethereum
```
User deposits 100 USDC
        ↓
DirectMint.mint(100)
        ↓
USDC transferred to Treasury
        ↓
mUSD minted to user (minus fee)
```

### Direct Mint on Canton
```
User deposits 100 Canton stables
        ↓
CantonDirectMint.mint(100)
        ↓
Stables transferred to Canton Treasury
        ↓
Canton mUSD minted to user (minus fee)
```

### Bridge: Ethereum → Canton
```
User holds mUSD on Ethereum
        ↓
BLEBridge.bridgeToCanton(amount, cantonParty)
        ↓
Ethereum mUSD burned
        ↓
Validators sign burn attestation
        ↓
Relay submits to Canton
        ↓
Canton mUSD minted to user's Canton wallet
```

### Bridge: Canton → Ethereum
```
User holds mUSD on Canton
        ↓
CantonBridge.bridgeToEthereum(amount, ethAddress)
        ↓
Canton mUSD burned
        ↓
Validators sign burn attestation
        ↓
Relay submits to Ethereum
        ↓
Ethereum mUSD minted to user's wallet
```

### Staking for Yield (Both Chains)
```
User holds mUSD (either chain)
        ↓
SMUSD.deposit(mUSD) / CantonSMUSD.deposit(mUSD)
        ↓
Receives smUSD (yield-bearing)
        ↓
Yield accrues from treasury strategies
        ↓
After cooldown: withdraw with accumulated yield
```

### Redemption (Either Chain)
```
User holds mUSD
        ↓
DirectMint.redeem(amount) or CantonDirectMint.redeem(amount)
        ↓
mUSD burned
        ↓
USDC/stables returned to user (minus fee)
```

## Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- DAML SDK 2.8.0 (for Canton development)

### Installation
```bash
npm install
```

### Compile Contracts
```bash
npx hardhat compile
```

### Run Tests
```bash
# Solidity tests
npx hardhat test

# DAML tests
daml test
```

## Configuration

| Setting | Value |
|---------|-------|
| Solidity Version | 0.8.20 |
| Optimizer Runs | 200 |
| OpenZeppelin | ^5.0.0 |
| Ethers | ^6.0.0 |
| Hardhat | ^2.19.0 |
| DAML SDK | 2.8.0 |
| LF Target | 2.1 |

## Test Coverage

The test suite (`test/BLEProtocol.test.ts`) covers 24 integration tests across 6 suites:

- Multi-signature attestation validation
- Blacklist compliance enforcement
- Rate limiting (mint and burn)
- ERC-4626 vault operations and cooldown
- Emergency functions and admin controls
- NAV oracle integration and staleness

## Deployment

### Contract Deployment Order
1. MUSD (no dependencies)
2. Treasury (needs USDC address)
3. SMUSD (needs MUSD address)
4. BLEBridgeV9 (needs MUSD address) - UUPS upgradeable
5. DirectMint (needs USDC, MUSD, Treasury)

### Role Assignments

| Contract | Role | Grant To |
|----------|------|----------|
| MUSD | `BRIDGE_ROLE` | DirectMint |
| MUSD | `COMPLIANCE_ROLE` | Compliance multisig |
| MUSD | `CAP_MANAGER_ROLE` | BLEBridgeV9 |
| Treasury | `OPERATOR_ROLE` | DirectMint |

## Repository Structure

```
├── contracts/           # Solidity smart contracts
│   ├── MUSD.sol        # ERC-20 stablecoin
│   ├── SMUSD.sol       # ERC-4626 yield vault
│   └── BLEBridgeV8.sol # Canton attestation bridge
├── daml/               # DAML templates for Canton
│   ├── BLEProtocol.daml
│   └── MintedMUSD.daml
├── relay/              # TypeScript bridge infrastructure
├── scripts/            # Deployment and utility scripts
│   └── signer.ts       # AWS KMS signature conversion
├── test/               # Integration tests
├── hardhat.config.ts
└── package.json
```

## Value Proposition

### For Retail Users
- Access institutional-grade yield without accreditation
- 1:1 USDC backing with supply ceiling from $6T+ in Canton assets
- Earn yield through smUSD staking
- No KYC required to hold or trade mUSD

### For Institutions
- No custody transfer required—assets remain on Canton
- Earn fees from attestation services
- Expand market reach without compliance burden
- Maintain full control of underlying positions

### For the Protocol
- Bridge $6T in Canton tokenized assets to public DeFi
- Revenue from mint/redeem fees and yield spread
- Network effects from Canton institutional partnerships

## Risk Factors

| Risk | Mitigation |
|------|------------|
| Canton attestation manipulation | 3-of-5 validator threshold, slashing for fraud |
| Smart contract exploit | Audited code, rate limiting, emergency pause |
| Redemption run | USDC reserves in treasury, attestation ceiling |
| Yield strategy failure | Diversified yield sources, conservative allocation |
| Regulatory action | Legal structure review, compliance controls |

## Roadmap

- [x] Core contracts (MUSD, SMUSD, BLEBridge)
- [x] Canton DAML templates
- [x] Multi-sig attestation system
- [ ] DirectMint contract deployment
- [ ] Mainnet deployment
- [ ] DEX liquidity (Uniswap, Curve)
- [ ] Additional yield strategies
- [ ] Cross-chain expansion (Base, Arbitrum)

## License

Proprietary

## Contact

- Website: [minted.finance](https://minted.finance)
- Twitter: [@MintedProtocol](https://twitter.com/MintedProtocol)
