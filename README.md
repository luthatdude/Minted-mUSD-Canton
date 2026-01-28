# Minted mUSD - BLE Protocol

A multi-chain stablecoin protocol bridging institutional equity positions on the Canton Network (Daml) to ERC-20 tokens on Ethereum via a multi-signature validator bridge.

## Architecture

```
Canton Network (Daml)          Ethereum (Solidity)
┌─────────────────┐           ┌─────────────────┐
│ EquityPosition  │──────────▶│  BLEBridgeV8    │
│ AttestRequest   │  3-of-5   │  (UUPS Proxy)   │
│ FinalAttestation│  multisig │       │          │
└─────────────────┘           │       ▼          │
                              │     MUSD         │
                              │   (ERC-20)       │
                              │       │          │
                              │       ▼          │
                              │    SMUSD         │
                              │  (ERC-4626)      │
                              └─────────────────┘
```

## Components

| Component | Language | Description |
|-----------|----------|-------------|
| `daml/BLEProtocol.daml` | Daml | Canton Network equity positions and attestation workflow |
| `daml/MintedMUSD.daml` | Daml | Canton-side mUSD asset with split, merge, transfer, and attestation-gated minting |
| `contracts/MUSD.sol` | Solidity | ERC-20 stablecoin with compliance (blacklist, supply cap) |
| `contracts/BLEBridgeV8.sol` | Solidity | Multi-sig bridge with NAV oracle, rate limiting, nonce ordering |
| `contracts/SMUSD.sol` | Solidity | ERC-4626 yield vault with cooldown protection |
| `scripts/signer.ts` | TypeScript | AWS KMS DER-to-RSV signature conversion |
| `test/BLEProtocol.test.ts` | TypeScript | 24 integration tests across 6 suites |

## Security Features

- **3-of-5 multi-sig validation** with sorted-address deduplication
- **Cross-chain replay protection** via `address(this)` + `block.chainid` in hash
- **NAV oracle integration** (Chainlink-compatible) with staleness checks
- **Net rate limiting** tracking both mints and burns on 24-hour rolling window
- **110% collateralization ratio** enforcement
- **Attestation ID uniqueness** preventing replay attacks
- **ERC-4626 cooldown** with transfer propagation and donation attack mitigation
- **Emergency admin functions** for stuck nonce recovery and attestation invalidation

## Setup

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Configuration

- **Solidity:** 0.8.20, optimizer 200 runs
- **Dependencies:** OpenZeppelin Contracts ^5.0.0, Ethers ^6.0.0, Hardhat ^2.19.0
- **Daml SDK:** 2.8.0, LF target 2.1

## Testing

```bash
# Run Solidity tests
npx hardhat test

# Run Daml tests
daml test
```

Test coverage includes: multi-sig attestation, blacklist compliance, rate limiting, vault cooldown, emergency functions, NAV oracle validation, mUSD asset operations (split/merge/redeem), attestation-gated minting, and transfer proposals.

## License

Proprietary
