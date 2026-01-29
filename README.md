Minted mUSD Protocol
A multi-chain institutional stablecoin protocol that bridges tokenized institutional assets on the Canton Network to a retail-accessible stablecoin on Ethereum. mUSD enables permissionless access to yield backed by institutional-grade collateral without requiring accreditation or KYC.
Overview
mUSD is a stablecoin with a supply ceiling attested by institutional assets on Canton Network. Unlike traditional collateralized stablecoins, mUSD uses a dual-path architecture:

Direct Mint Path: Users deposit USDC 1:1 to mint mUSD (actual backing)
Canton Attestation Path: Institutional assets on Canton set the global supply ceiling (trust signal)

This architecture provides retail users exposure to institutional-grade yield while maintaining regulatory separation—institutions don't custody retail funds, and retail doesn't need accreditation to access institutional assets.
Architecture
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CANTON NETWORK                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  InstitutionalEquityPositions (Goldman, BNY, JPM, DTCC, Broadridge) │    │
│  │  CollateralAttestation → 3-of-5 Validator Signatures                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼ Attestation (sets supply cap)
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ETHEREUM (Solidity)                                │
│                                                                              │
│  ┌────────────────┐        ┌─────────────────────────────────────────────┐  │
│  │  BLEBridgeV9   │───────▶│               MUSD Token                    │  │
│  │  (Supply Cap)  │        │  • ERC-20 with compliance (blacklist)       │  │
│  └────────────────┘        │  • Supply cap from Canton attestation       │  │
│                            │  • Mint/burn via authorized contracts       │  │
│  ┌────────────────┐        └─────────────────────────────────────────────┘  │
│  │   DirectMint   │──────────────────────┬───────────────────────────────── │
│  │  USDC → mUSD   │                      │                                  │
│  │  mUSD → USDC   │                      ▼                                  │
│  └───────┬────────┘        ┌─────────────────────────────────────────────┐  │
│          │                 │                 SMUSD                        │  │
│          ▼                 │  • ERC-4626 yield vault                     │  │
│  ┌────────────────┐        │  • Cooldown protection                      │  │
│  │    Treasury    │        │  • Yield distribution                       │  │
│  │   (USDC Pool)  │        └─────────────────────────────────────────────┘  │
│  └────────────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
Components
Solidity Contracts (Ethereum)
ContractDescriptionMUSD.solERC-20 stablecoin with compliance controls, blacklist, and supply cap enforcementBLEBridgeV8.solMulti-sig bridge that validates Canton attestations and updates supply ceilingSMUSD.solERC-4626 yield-bearing vault with cooldown protection and donation attack mitigationDirectMint.solUser-facing contract for 1:1 USDC ↔ mUSD minting and redemption
DAML Templates (Canton Network)
TemplateDescriptionBLEProtocol.damlEquity position management, attestation requests, and validator workflowMintedMUSD.damlCanton-side mUSD asset with split, merge, transfer, and attestation-gated operations
TypeScript Infrastructure
ComponentDescriptionrelay/Bridge relayer that monitors Canton attestations and submits to Ethereumscripts/signer.tsAWS KMS signature conversion (DER → RSV format for Ethereum)
Key Features
Security

3-of-5 multi-sig validation with sorted-address deduplication
Cross-chain replay protection via address(this) + block.chainid in attestation hash
NAV oracle integration (Chainlink-compatible) with staleness checks
Net rate limiting tracking mints and burns on 24-hour rolling window
110% collateralization ratio enforcement on attestation path
Attestation ID uniqueness preventing replay attacks
ERC-4626 cooldown with transfer propagation

Compliance

Blacklist functionality for sanctioned addresses
Supply cap enforcement based on institutional attestations
Emergency pause functionality
Admin controls for stuck nonce recovery and attestation invalidation

Yield Generation

Treasury USDC deployed to yield strategies (Pendle, Morpho, Spark)
smUSD vault accumulates yield for stakers
Points program for early depositors

User Flows
Direct Mint (Primary Path)
User deposits 100 USDC
        ↓
DirectMint.mint(100)
        ↓
USDC transferred to Treasury
        ↓
mUSD minted to user (minus fee)
Direct Redeem
User holds 100 mUSD
        ↓
DirectMint.redeem(100)
        ↓
mUSD burned
        ↓
USDC returned to user (minus fee)
Staking for Yield
User holds mUSD
        ↓
SMUSD.deposit(mUSD)
        ↓
Receives smUSD (yield-bearing)
        ↓
After cooldown: SMUSD.withdraw()
Canton Attestation (Supply Cap Update)
Institutions have assets on Canton
        ↓
Validators create attestation of total value
        ↓
3-of-5 validators sign
        ↓
BLEBridgeV9.updateSupplyCap()
        ↓
mUSD supply ceiling updated
Setup
Prerequisites

Node.js 18+
npm or yarn
DAML SDK 2.8.0 (for Canton development)

Installation
bashnpm install
Compile Contracts
bashnpx hardhat compile
Run Tests
bash# Solidity tests
npx hardhat test

# DAML tests
daml test
Configuration
SettingValueSolidity Version0.8.20Optimizer Runs200OpenZeppelin^5.0.0Ethers^6.0.0Hardhat^2.19.0DAML SDK2.8.0LF Target2.1
Test Coverage
The test suite (test/BLEProtocol.test.ts) covers 24 integration tests across 6 suites:

Multi-signature attestation validation
Blacklist compliance enforcement
Rate limiting (mint and burn)
ERC-4626 vault operations and cooldown
Emergency functions and admin controls
NAV oracle integration and staleness

Deployment
Contract Deployment Order

MUSD (no dependencies)
Treasury (needs USDC address)
SMUSD (needs MUSD address)
BLEBridgeV9 (needs MUSD address) - UUPS upgradeable
DirectMint (needs USDC, MUSD, Treasury)

Role Assignments
ContractRoleGrant ToMUSDBRIDGE_ROLEDirectMintMUSDCOMPLIANCE_ROLECompliance multisigMUSDCAP_MANAGER_ROLEBLEBridgeV9TreasuryOPERATOR_ROLEDirectMint
Repository Structure
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
Value Proposition
For Retail Users

Access institutional-grade yield without accreditation
1:1 USDC backing with supply ceiling from $6T+ in Canton assets
Earn yield through smUSD staking
No KYC required to hold or trade mUSD

For Institutions

No custody transfer required—assets remain on Canton
Earn fees from attestation services
Expand market reach without compliance burden
Maintain full control of underlying positions

For the Protocol

Bridge $6T in Canton tokenized assets to public DeFi
Revenue from mint/redeem fees and yield spread
Network effects from Canton institutional partnerships

Risk Factors
RiskMitigationCanton attestation manipulation3-of-5 validator threshold, slashing for fraudSmart contract exploitAudited code, rate limiting, emergency pauseRedemption runUSDC reserves in treasury, attestation ceilingYield strategy failureDiversified yield sources, conservative allocationRegulatory actionLegal structure review, compliance controls
Roadmap

 Core contracts (MUSD, SMUSD, BLEBridge)
 Canton DAML templates
 Multi-sig attestation system
 DirectMint contract deployment
 Mainnet deployment
 DEX liquidity (Uniswap, Curve)
 Additional yield strategies
 Cross-chain expansion (Base, Arbitrum)

License
Proprietary
Contact

Website: minted.finance
Twitter: @MintedProtocol
