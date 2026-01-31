# Minted mUSD Protocol - Security Audit Report

**Prepared For:** External Security Auditors  
**Audit Scope:** Minted mUSD Smart Contract System  
**Repository:** https://github.com/luthatdude/Minted-mUSD-Canton  
**Version:** main branch (as of January 30, 2026)  
**Compiler:** Solidity 0.8.26 / DAML SDK 2.10.3
**Framework:** Hardhat, OpenZeppelin Contracts v5.x, Canton Network

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Contract Inventory](#3-contract-inventory)
4. [Access Control Matrix](#4-access-control-matrix)
5. [Function-by-Function Analysis](#5-function-by-function-analysis)
6. [Known Issues & Design Decisions](#6-known-issues--design-decisions)
7. [External Dependencies](#7-external-dependencies)
8. [Deployment Configuration](#8-deployment-configuration)
9. [Test Coverage](#9-test-coverage)
10. [Canton DAML Contracts](#10-canton-daml-contracts)
11. [Appendix: Full Contract Details](#appendix-full-contract-details)

---

## 1. Executive Summary

### 1.1 Protocol Overview

Minted mUSD is a **stablecoin protocol** that issues mUSD tokens backed by:
1. **Canton Network attestations** of off-chain institutional assets (primary backing)
2. **On-chain USDC** deposited via DirectMint (secondary backing)
3. **Overcollateralized borrowing** against crypto collateral (WETH, WBTC, etc.)

### 1.2 Key Components

| Component | Purpose | Risk Level |
|-----------|---------|------------|
| **MUSD** | ERC-20 stablecoin with supply cap & blacklist | Medium |
| **BLEBridgeV9** | Canton attestation processor → supply cap updates | **Critical** |
| **DirectMint/V2** | USDC ↔ mUSD 1:1 exchange | Medium |
| **Treasury/V2** | USDC custody + yield strategy allocation | **High** |
| **SMUSD** | ERC-4626 staking vault for mUSD | Medium |
| **CollateralVault** | Holds collateral for borrowing | High |
| **BorrowModule** | Debt position management | High |
| **LiquidationEngine** | Liquidates underwater positions | High |
| **PriceOracle** | Chainlink price aggregation | **Critical** |

### 1.3 Security Posture Summary

| Category | Status |
|----------|--------|
| Reentrancy Protection | ✅ NonReentrant on all state-changing functions |
| Access Control | ✅ OpenZeppelin AccessControl throughout |
| Integer Overflow | ✅ Solidity 0.8.26 built-in checks |
| External Call Safety | ✅ SafeERC20 used universally |
| Oracle Safety | ✅ Chainlink with staleness checks |
| Upgradeability | ⚠️ UUPS - requires careful migration |
| Rate Limiting | ✅ Daily limits on bridge operations |

---

## 2. System Architecture

### 2.1 Core Token Flow

Every function available on Ethereum has a Canton-side equivalent. The Canton side is a thin accounting layer — actual USDC backing lives on Ethereum where yield is generated. Canton operations route to the Ethereum Treasury via the validator-attested bridge.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       MINTED mUSD PROTOCOL                                          │
│                                                                                                     │
│  CANTON NETWORK (DAML)                          │  ETHEREUM (Solidity)                              │
│  Thin accounting layer                          │  Backing + yield layer                            │
│                                                 │                                                   │
│  ┌──────────────────┐                           │  ┌──────────────────┐                             │
│  │ CantonDirectMint │   BridgeOutRequest        │  │ DirectMint/V2    │                             │
│  │  (deposit USDC   │ ─────────────────────────▶│  │  (deposit USDC   │                             │
│  │   → mint mUSD)   │   backing stables piped   │  │   → mint mUSD)   │                             │
│  │                  │   to ETH Treasury          │  │                  │                             │
│  │  Also: USDCx via │                           │  └────────┬─────────┘                             │
│  │  Circle CCTP     │                           │           │                                       │
│  └────────┬─────────┘                           │           ▼                                       │
│           │                                     │  ┌──────────────────┐                             │
│           ▼                                     │  │  Treasury/V2     │                             │
│  ┌──────────────────┐                           │  │  (USDC custody + │                             │
│  │   CantonMUSD     │◀───────────────────────── │  │   yield alloc)   │                             │
│  │  (DAML token,    │  SupplyCapAttestation      │  └────────┬─────────┘                             │
│  │   dual-signatory)│  syncs global supply       │           │                                       │
│  └────────┬─────────┘                           │           ▼                                       │
│           │                                     │  ┌──────────────────┐                             │
│           ▼                                     │  │  Strategies      │ ◀── Yield generation        │
│  ┌──────────────────┐                           │  └────────┬─────────┘                             │
│  │  CantonSMUSD     │◀───────────────────────── │           │                                       │
│  │  (yield vault,   │  YieldAttestation          │           │ yield data                            │
│  │   ERC-4626       │  syncs share price         │           ▼                                       │
│  │   equivalent)    │                           │  ┌──────────────────┐                             │
│  └──────────────────┘                           │  │   SMUSD          │                             │
│                                                 │  │  (ERC-4626)      │                             │
│  ┌──────────────────┐     Redemption →          │  └──────────────────┘                             │
│  │ RedemptionRequest│  BridgeInAttestation       │                                                   │
│  │  (burn mUSD,     │ ◀─────────────────────────│  ┌──────────────────┐                             │
│  │   await bridge)  │  USDC bridged back         │  │   MUSD (ERC-20)  │                             │
│  └──────────────────┘                           │  └──────────────────┘                             │
│                                                 │                                                   │
│  ┌──────────────────┐                           │  ┌──────────────────┐                             │
│  │  ComplianceReg   │                           │  │  MUSD.blacklist  │                             │
│  │  (blacklist +    │                           │  │  (OFAC/sanctions)│                             │
│  │   freeze, DAML)  │                           │  └──────────────────┘                             │
│  └──────────────────┘                           │                                                   │
│                                                 │                                                   │
│  ┌──────────────────────────────────────────┐   │  ┌──────────────────────────────────────────┐    │
│  │         OVERCOLLATERALIZED BORROWING      │   │  │         OVERCOLLATERALIZED BORROWING      │    │
│  │            (Canton / V3 Module)            │   │  │            (Ethereum / Solidity)           │    │
│  │                                            │   │  │                                            │    │
│  │  ┌────────────┐  ┌────────────┐            │   │  │  ┌────────────┐  ┌────────────┐            │    │
│  │  │   Vault    │◀▶│ Liquidation│            │   │  │  │ Collateral │◀▶│ BorrowModule│            │    │
│  │  │   (CDP)    │  │  + Keeper  │            │   │  │  │ Vault      │  │             │            │    │
│  │  └─────┬──────┘  │  Receipts  │            │   │  │  └─────┬──────┘  └──────┬──────┘            │    │
│  │        │         └────────────┘            │   │  │        │                │                   │    │
│  │        ▼                                   │   │  │        ▼                ▼                   │    │
│  │  ┌────────────┐  ┌────────────┐            │   │  │  ┌────────────┐  ┌────────────┐            │    │
│  │  │ PriceOracle│  │ Liquidity  │            │   │  │  │ Liquidation│  │ PriceOracle│            │    │
│  │  │ (provider- │  │ Pool (DEX) │            │   │  │  │ Engine     │  │ (Chainlink)│            │    │
│  │  │  signed)   │  └────────────┘            │   │  │  └────────────┘  └────────────┘            │    │
│  │  └────────────┘                            │   │  │                                            │    │
│  │  ┌────────────┐                            │   │  │                                            │    │
│  │  │ Leverage   │ (atomic loops, max 10)     │   │  │                                            │    │
│  │  │ Manager    │                            │   │  │                                            │    │
│  │  └────────────┘                            │   │  │                                            │    │
│  └──────────────────────────────────────────┘   │  └──────────────────────────────────────────┘    │
│                                                 │                                                   │
├─────────────────────────────────────────────────┼───────────────────────────────────────────────────┤
│                                                 │                                                   │
│               ┌──────────────────────────────────────────────────────┐                              │
│               │              VALIDATOR BRIDGE LAYER                   │                              │
│               │                                                      │                              │
│               │  ┌──────────────┐     ┌──────────────┐               │                              │
│               │  │ Canton       │     │ BLEBridgeV9  │               │                              │
│               │  │ Validators   │────▶│ (Solidity)   │               │                              │
│               │  │ (multi-sig   │     │              │               │                              │
│               │  │  attestation)│◀────│ processAttest│               │                              │
│               │  └──────────────┘     └──────────────┘               │                              │
│               │                                                      │                              │
│               │  Attestation Types:                                  │                              │
│               │  ├── BridgeOutAttestation  (Canton → ETH backing)    │                              │
│               │  ├── BridgeInAttestation   (ETH → Canton redemption) │                              │
│               │  ├── SupplyCapAttestation  (global supply sync)      │                              │
│               │  └── YieldAttestation      (ETH yield → Canton smUSD)│                              │
│               └──────────────────────────────────────────────────────┘                              │
│                                                                                                     │
│  GLOBAL INVARIANT: Canton mUSD + Ethereum mUSD ≤ Total USDC Backing (Ethereum Treasury)            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Canton↔Ethereum Function Mapping

Every user-facing function on Ethereum has a Canton-side equivalent. Canton operations that affect backing are routed to the Ethereum Treasury via the bridge.

| Function | Ethereum (Solidity) | Canton (DAML) | Bridge Route |
|----------|-------------------|---------------|--------------|
| **Mint mUSD** | `DirectMintV2.mint()` — USDC in, mUSD out | `CantonDirectMintService.DirectMint_Mint` — USDC in, CantonMUSD out | `BridgeOutRequest` pipes USDC to ETH Treasury |
| **Mint via USDCx** | N/A (direct USDC only) | `DirectMint_MintWithUSDCx` — Circle CCTP USDCx in | No bridge needed — USDCx already backed on ETH via xReserve |
| **Redeem mUSD** | `DirectMintV2.redeem()` — mUSD burned, USDC out | `DirectMint_Redeem` — CantonMUSD burned, `RedemptionRequest` created | `BridgeInAttestation` brings USDC back from ETH |
| **Stake (smUSD)** | `SMUSD.deposit()` — ERC-4626 vault | `CantonStakingService.Stake` — mUSD → smUSD shares | None — share accounting is local |
| **Unstake** | `SMUSD.withdraw()` — shares → mUSD | `CantonStakingService.Unstake` — shares × sharePrice → mUSD | None — yield synced via `YieldAttestation` |
| **Yield sync** | Native (Treasury strategies report directly) | `CantonStakingService.SyncYield` — operator applies attested yield | `YieldAttestation` (ETH → Canton) |
| **Borrow** | `BorrowModule.borrow()` — collateral → mUSD | `Vault.Vault_Borrow` — collateral → mUSD (V3) | None — collateral + debt tracked locally |
| **Repay** | `BorrowModule.repay()` — mUSD → reduce debt | `Vault.Vault_Repay` (V3) | None |
| **Liquidate** | `LiquidationEngine.liquidate()` | `LiquidationEngine.Liquidate` (V2Fixed) / `Vault.Vault_Liquidate` (V3) | None |
| **Supply cap sync** | `BLEBridgeV9.processAttestation()` → `setSupplyCap()` | `SupplyCapAttestation.SupplyCap_Finalize` | Bidirectional — keeps both chains in sync |
| **Compliance** | `MUSD.blacklist()` / `unblacklist()` | `ComplianceRegistry.BlacklistUser` / `FreezeUser` | Independent — each chain enforces its own |
| **Transfer** | `MUSD.transfer()` (ERC-20) | `CantonMUSD_Transfer` → proposal → accept (dual-signatory) | None |
| **Price feeds** | `PriceOracle` → Chainlink aggregation | `PriceOracle.GetPrice` (provider-signed, staleness check) | None — independent oracle infrastructure |

### 2.3 Trust Assumptions

| Entity | Trust Level | Failure Mode |
|--------|-------------|--------------|
| Canton Validators | **Critical** | Compromised majority could forge attestations — inflate supply cap, fake yield, authorize unbacked bridge transfers |
| Protocol Admin (ETH) | **High** | Can upgrade contracts (UUPS), change fees, add strategies |
| Protocol Operator (Canton) | **High** | Controls service templates, pause, supply cap, fee changes, compliance registry |
| Strategy Contracts | **High** | Malicious strategy could steal treasury funds |
| Chainlink Oracles (ETH) | **Medium** | Oracle failure/manipulation affects ETH-side liquidations |
| Canton PriceOracle | **Medium** | Provider-signed feeds — staleness enforced but single provider |
| Aggregator | **Medium** | Initiates/finalizes attestations — cannot forge without validator quorum |
| xReserve (USDCx) | **Medium** | USDCx backing depends on Circle CCTP + xReserve solvency |
| Liquidators | **Low** | MEV extraction expected, benefits protocol security |

---

## 3. Contract Inventory

### 3.1 Core Contracts

| Contract | File | LoC | Upgradeability | Audit Priority |
|----------|------|-----|----------------|----------------|
| MUSD | `contracts/MUSD.sol` | ~70 | Non-upgradeable | **P1** |
| SMUSD | `contracts/SMUSD.sol` | ~105 | Non-upgradeable | **P1** |
| Treasury | `contracts/Treasury.sol` | ~330 | Non-upgradeable | **P1** |
| TreasuryV2 | `contracts/TreasuryV2.sol` | ~875 | UUPS | **P0** |
| DirectMint | `contracts/DirectMint.sol` | ~245 | Non-upgradeable | **P1** |
| DirectMintV2 | `contracts/DirectMintV2.sol` | ~315 | Non-upgradeable | **P1** |
| CollateralVault | `contracts/CollateralVault.sol` | ~215 | Non-upgradeable | **P1** |
| BorrowModule | `contracts/BorrowModule.sol` | ~390 | Non-upgradeable | **P0** |
| LiquidationEngine | `contracts/LiquidationEngine.sol` | ~215 | Non-upgradeable | **P0** |
| BLEBridgeV8 | `contracts/BLEBridgeV8.sol` | ~395 | UUPS | **P0** |
| BLEBridgeV9 | `contracts/BLEBridgeV9.sol` | ~395 | UUPS | **P0** |
| PriceOracle | `contracts/PriceOracle.sol` | ~150 | Non-upgradeable | **P0** |

### 3.2 Supporting Contracts

| Contract | File | Purpose |
|----------|------|---------|
| PendleMarketSelector | `contracts/PendleMarketSelector.sol` | PT market selection for yield strategies |
| DepositRouter | `contracts/DepositRouter.sol` | Cross-chain deposit routing |
| TreasuryReceiver | `contracts/TreasuryReceiver.sol` | Cross-chain mUSD minting |
| LeverageVault | `contracts/LeverageVault.sol` | Leveraged position management |

### 3.3 Mock Contracts (Testing Only)

| Contract | File | Notes |
|----------|------|-------|
| MockERC20 | `contracts/mocks/MockERC20.sol` | Test token |
| MockAggregatorV3 | `contracts/mocks/MockAggregatorV3.sol` | Chainlink mock |
| MockStrategy | `contracts/mocks/MockStrategy.sol` | Strategy mock |
| MockSwapRouter | `contracts/mocks/MockSwapRouter.sol` | Uniswap mock |

---

## 4. Access Control Matrix

### 4.1 Role Definitions

```solidity
// MUSD.sol
bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");           // Mint/burn mUSD
bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");   // Blacklist management
bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE"); // Supply cap updates

// TreasuryV2.sol
bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");     // Rebalance strategies
bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");   // Add/remove strategies
bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");       // Emergency withdrawal
bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");             // Deposit/withdraw

// BLEBridgeV9.sol
bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");     // Sign attestations
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");     // Pause, invalidate

// CollateralVault.sol
bytes32 public constant BORROW_MODULE_ROLE = keccak256("BORROW_MODULE_ROLE");     // Withdraw
bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");         // Seize
bytes32 public constant LEVERAGE_VAULT_ROLE = keccak256("LEVERAGE_VAULT_ROLE");   // depositFor/withdrawFor
```

### 4.2 Role Assignment Matrix

| Contract | Role | Expected Holder |
|----------|------|-----------------|
| **MUSD** | BRIDGE_ROLE | DirectMint, DirectMintV2, BLEBridgeV8, BorrowModule |
| **MUSD** | CAP_MANAGER_ROLE | BLEBridgeV9 |
| **MUSD** | COMPLIANCE_ROLE | Compliance multisig |
| **TreasuryV2** | VAULT_ROLE | DirectMintV2, CollateralVault |
| **TreasuryV2** | STRATEGIST_ROLE | Protocol multisig |
| **TreasuryV2** | GUARDIAN_ROLE | Emergency multisig |
| **BLEBridgeV9** | VALIDATOR_ROLE | Canton validator nodes (3+ of 5) |
| **BLEBridgeV9** | EMERGENCY_ROLE | Emergency multisig |
| **CollateralVault** | BORROW_MODULE_ROLE | BorrowModule contract |
| **CollateralVault** | LIQUIDATION_ROLE | LiquidationEngine contract |
| **BorrowModule** | LIQUIDATION_ROLE | LiquidationEngine contract |

### 4.3 Privilege Escalation Paths

```
DEFAULT_ADMIN_ROLE
    │
    ├── Can grant/revoke any role
    ├── Can upgrade UUPS contracts (BLEBridgeV8/V9, TreasuryV2)
    ├── Can change fee configurations
    └── Can unpause (EMERGENCY_ROLE can only pause)
```

**⚠️ CRITICAL:** DEFAULT_ADMIN_ROLE should be:
1. A multisig (recommended: 3-of-5 minimum)
2. Behind a timelock for non-emergency operations
3. Separate from EMERGENCY_ROLE for separation of duties

---

## 5. Function-by-Function Analysis

### 5.1 MUSD.sol

```solidity
// Constructor - NO ACCESS CONTROL (deployer only, one-time)
constructor(uint256 _initialSupplyCap)
├── Validates: _initialSupplyCap > 0
├── Effects: Sets supplyCap, grants DEFAULT_ADMIN_ROLE to deployer
└── Risk: Low (one-time execution)

// External Functions
function setSupplyCap(uint256 _cap) external
├── Access: DEFAULT_ADMIN_ROLE || CAP_MANAGER_ROLE
├── Effects: Updates supplyCap
├── Events: SupplyCapUpdated(oldCap, newCap)
└── Risk: Medium - no timelock, immediate effect

function setBlacklist(address account, bool status) external onlyRole(COMPLIANCE_ROLE)
├── Access: COMPLIANCE_ROLE
├── Effects: Updates isBlacklisted[account]
├── Events: BlacklistUpdated(account, status)
└── Risk: Low - cannot affect existing balances

function mint(address to, uint256 amount) external onlyRole(BRIDGE_ROLE)
├── Access: BRIDGE_ROLE
├── Validates: totalSupply() + amount <= supplyCap (via internal check)
├── Validates: !isBlacklisted[to] (via _update override)
├── Effects: Increases balance and totalSupply
├── Events: Mint(to, amount), Transfer(0, to, amount)
└── Risk: High - bridge compromise = supply inflation up to cap

function burn(address from, uint256 amount) external onlyRole(BRIDGE_ROLE)
├── Access: BRIDGE_ROLE
├── Validates: from has sufficient balance
├── Effects: Decreases balance and totalSupply
├── Events: Burn(from, amount), Transfer(from, 0, amount)
└── Risk: Medium - can burn any user's approved tokens

// Internal Overrides
function _update(address from, address to, uint256 value) internal override
├── Validates: !isBlacklisted[from] && !isBlacklisted[to]
├── Effects: Standard ERC20 transfer
└── Risk: Low - standard blacklist enforcement
```

### 5.2 BLEBridgeV9.sol (Critical)

```solidity
function initialize(uint256 _minSigs, address _musdToken, uint256 _collateralRatioBps, uint256 _dailyCapIncreaseLimit)
├── Access: None (initializer modifier - one-time)
├── Validates: _minSigs > 0, _musdToken != 0, _collateralRatioBps >= 10000
├── Effects: Initializes all state, grants roles to msg.sender
└── Risk: Critical if re-initialized (mitigated by initializer)

function processAttestation(Attestation calldata att, bytes[] calldata signatures) external nonReentrant whenNotPaused
├── Access: None (anyone can submit valid attestation)
├── Validates:
│   ├── !usedAttestationIds[att.id]
│   ├── att.timestamp <= block.timestamp
│   ├── att.timestamp > lastAttestationTime (prevents old attestations)
│   ├── att.nonce == currentNonce
│   ├── signatures.length >= minSignatures
│   ├── All signers have VALIDATOR_ROLE
│   ├── Signatures are sorted (ascending) to prevent duplicates
│   └── Rate limit check for cap increases
├── Effects:
│   ├── Marks attestation as used
│   ├── Updates attestedCantonAssets
│   ├── Increments currentNonce
│   ├── Updates lastAttestationTime
│   ├── Calls _updateSupplyCap() → musdToken.setSupplyCap()
│   └── Updates rate limit counters
├── External Calls: musdToken.setSupplyCap(newCap)
├── Events: AttestationReceived(id, assets, newCap, nonce, timestamp)
└── Risk: CRITICAL
    ├── Validator key compromise: Can inflate cap up to daily limit
    ├── Replay protection: Uses nonce + attestation ID + chain ID
    ├── Stale attestation: Blocked by timestamp ordering
    └── Signature reuse: Sorted signatures prevent duplicate signers

function setCollateralRatio(uint256 _ratioBps) external onlyRole(DEFAULT_ADMIN_ROLE)
├── Access: DEFAULT_ADMIN_ROLE
├── Validates:
│   ├── _ratioBps >= 10000 (minimum 100%)
│   ├── _ratioBps <= 20000 (maximum 200%)
│   ├── Change <= 1000 bps (10% max per call)
│   └── block.timestamp >= lastRatioChangeTime + 86400 (once per day)
├── Effects: Updates collateralRatioBps, recalculates cap
├── External Calls: musdToken.setSupplyCap() via _updateSupplyCap()
├── Events: CollateralRatioUpdated(oldRatio, newRatio)
└── Risk: Medium - rate-limited, but immediate cap effect

function emergencyReduceCap(uint256 _newCap, string calldata _reason) external onlyRole(EMERGENCY_ROLE)
├── Access: EMERGENCY_ROLE
├── Validates:
│   ├── _newCap < current supply cap (can only reduce)
│   └── _newCap >= current mUSD totalSupply (cannot trap tokens)
├── Effects: Sets new cap directly
├── External Calls: musdToken.setSupplyCap(_newCap)
├── Events: EmergencyCapReduction(oldCap, newCap, reason)
└── Risk: Low - can only reduce, with reason for audit trail

function pause() external onlyRole(EMERGENCY_ROLE)
├── Access: EMERGENCY_ROLE
├── Effects: Pauses all attestation processing
└── Risk: Low - denial of service only, recoverable

function unpause() external onlyRole(DEFAULT_ADMIN_ROLE)
├── Access: DEFAULT_ADMIN_ROLE (NOT EMERGENCY_ROLE)
├── Effects: Unpauses contract
└── Risk: Low - separation of duties enforced
```

### 5.3 TreasuryV2.sol (High Risk)

```solidity
function depositFromVault(uint256 amount) external nonReentrant whenNotPaused onlyRole(VAULT_ROLE)
├── Access: VAULT_ROLE
├── Validates: amount > 0
├── External Calls:
│   ├── asset.safeTransferFrom(msg.sender, address(this), amount)
│   └── _autoAllocate() → strategy.deposit() for each active strategy
├── Effects:
│   ├── Accrues fees before deposit
│   ├── Receives USDC
│   ├── Allocates to strategies based on targetBps
│   └── Updates lastRecordedValue AFTER allocation
├── Events: Deposited(from, amount, allocations[])
└── Risk: High
    ├── Strategy failure: try/catch prevents revert but may leave funds unallocated
    └── Fee manipulation: Fixed by updating lastRecordedValue after deposit

function withdrawToVault(uint256 amount) external nonReentrant whenNotPaused onlyRole(VAULT_ROLE)
├── Access: VAULT_ROLE
├── Validates: amount > 0
├── External Calls:
│   ├── _withdrawFromStrategies() → strategy.withdraw() for each
│   └── asset.safeTransfer(msg.sender, amount)
├── Effects:
│   ├── Accrues fees
│   ├── Pulls from reserve first, then strategies
│   └── Reverts if cannot fulfill full amount
├── Events: Withdrawn(to, amount)
└── Risk: High
    ├── Strategy withdrawal failure could block redemptions
    └── Mitigated by GUARDIAN_ROLE emergency withdrawal

function addStrategy(address strategy, uint256 targetBps, uint256 minBps, uint256 maxBps, bool autoAllocate) external onlyRole(STRATEGIST_ROLE)
├── Access: STRATEGIST_ROLE
├── Validates:
│   ├── strategy != address(0)
│   ├── !isStrategy[strategy] (no duplicates)
│   ├── strategies.length < MAX_STRATEGIES (10)
│   ├── targetBps <= 10000
│   └── minBps <= targetBps <= maxBps
├── Effects:
│   ├── Adds to strategies array
│   ├── Sets isStrategy[strategy] = true
│   ├── Stores index in strategyIndex
│   └── NO approval granted at add time
├── Events: StrategyAdded(strategy, targetBps)
└── Risk: High
    ├── Malicious strategy address could steal funds on deposit
    └── Mitigated: Per-operation approval only for exact amount

function removeStrategy(address strategy) external onlyRole(STRATEGIST_ROLE)
├── Access: STRATEGIST_ROLE
├── Validates: isStrategy[strategy]
├── External Calls: IStrategy(strategy).withdrawAll()
├── Effects:
│   ├── Calls withdrawAll on strategy
│   ├── Sets active = false
│   ├── Sets isStrategy = false
│   ├── Clears strategyIndex
│   └── Revokes any remaining approval
├── Events: StrategyRemoved(strategy)
└── Risk: Medium - strategy could fail withdrawAll

function rebalance() external nonReentrant onlyRole(ALLOCATOR_ROLE)
├── Access: ALLOCATOR_ROLE
├── External Calls:
│   ├── strategy.totalValue() for each
│   ├── strategy.withdraw() from over-allocated
│   └── strategy.deposit() to under-allocated
├── Effects: Rebalances all strategies to target allocations
├── Events: Rebalanced(totalValue)
└── Risk: Medium - large gas cost for many strategies

function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE)
├── Access: GUARDIAN_ROLE
├── External Calls: strategy.withdrawAll() for ALL strategies
├── Effects: Pulls all funds to reserve
├── Events: EmergencyWithdraw(totalAmount)
└── Risk: Low - recovery function, uses try/catch
```

### 5.4 BorrowModule.sol

```solidity
function borrow(uint256 amount) external nonReentrant
├── Access: None (public)
├── Validates:
│   ├── amount > 0
│   ├── amount >= minDebt || existing position
│   ├── Accrues interest first
│   └── borrowCapacity >= newTotalDebt (uses collateral factor, NOT liquidation threshold)
├── External Calls: musd.mint(msg.sender, amount)
├── Effects:
│   ├── Accrues interest to existing position
│   ├── Increases principal
│   └── Updates lastAccrualTime
├── Events: Borrowed(user, amount, totalDebt)
└── Risk: High
    ├── Oracle manipulation could allow over-borrowing
    └── Mitigated: Conservative collateral factors (typically 70-80%)

function repay(uint256 amount) external nonReentrant
├── Access: None (public)
├── Validates: amount > 0, amount <= totalDebt
├── External Calls: musd.burn(msg.sender, amount)
├── Effects:
│   ├── Accrues interest first
│   ├── Applies to accruedInterest first, then principal
│   ├── Validates remaining debt >= minDebt OR == 0
│   └── Prevents dust positions
├── Events: Repaid(user, amount, remaining)
└── Risk: Low

function withdrawCollateral(address token, uint256 amount) external nonReentrant
├── Access: None (public - for own collateral)
├── Validates:
│   ├── Simulates post-withdrawal health factor
│   └── Requires HF >= 100% after withdrawal
├── External Calls: vault.withdraw(token, amount, msg.sender)
├── Effects: Reduces collateral in vault
├── Events: CollateralWithdrawn(user, token, amount)
└── Risk: Medium
    ├── CEI pattern: Checks HF BEFORE withdrawal
    └── Oracle stale price could allow unsafe withdrawal

function reduceDebt(address user, uint256 amount) external onlyRole(LIQUIDATION_ROLE)
├── Access: LIQUIDATION_ROLE (LiquidationEngine only)
├── Effects: Reduces user's debt without burning (mUSD already burned by liquidator)
├── Events: DebtAdjusted(user, newDebt, "liquidation")
└── Risk: Low - called after successful liquidation
```

### 5.5 LiquidationEngine.sol

```solidity
function liquidate(address borrower, address collateralToken, uint256 debtToRepay) external nonReentrant
├── Access: None (public - MEV is expected and beneficial)
├── Validates:
│   ├── borrower != msg.sender (self-liquidation blocked)
│   ├── healthFactor(borrower) < 10000 (underwater)
│   ├── debtToRepay > 0
│   ├── debtToRepay <= closeFactor * totalDebt (partial liquidation limit)
│   │   └── OR totalDebt <= fullLiquidationThreshold (small debt = full liquidation)
│   └── collateralToken has collateral available
├── External Calls:
│   ├── borrowModule.healthFactor(borrower)
│   ├── borrowModule.totalDebt(borrower)
│   ├── oracle.getPrice(collateralToken)
│   ├── oracle.getValueUsd(collateralToken, amount)
│   ├── musd.burn(msg.sender, actualRepay) [CEI: state read before, burn after]
│   ├── vault.seize(borrower, collateralToken, seizeAmount, msg.sender)
│   └── borrowModule.reduceDebt(borrower, actualRepay)
├── Effects:
│   ├── Burns liquidator's mUSD
│   ├── Seizes discounted collateral from borrower
│   └── Reduces borrower's debt
├── Events: Liquidation(liquidator, borrower, collateralToken, debtRepaid, collateralSeized)
└── Risk: High
    ├── Oracle manipulation: Could trigger false liquidations
    ├── MEV extraction: Expected, keeps protocol safe
    ├── Self-liquidation bypass: Multiple addresses
    └── Decimal handling: Uses getValueUsd for normalization
```

### 5.6 PriceOracle.sol

```solidity
function setFeed(address token, address feed, uint256 stalePeriod, uint8 tokenDecimals) external onlyRole(ORACLE_ADMIN_ROLE)
├── Access: ORACLE_ADMIN_ROLE
├── Validates:
│   ├── token != address(0)
│   ├── feed != address(0)
│   └── tokenDecimals <= 18 (prevents overflow)
├── Effects: Updates feeds[token]
├── Events: FeedUpdated(token, feed, stalePeriod, tokenDecimals)
└── Risk: High - malicious feed = protocol compromise

function getPrice(address token) external view returns (uint256)
├── Access: None (public view)
├── Validates:
│   ├── Feed exists and enabled
│   ├── answer > 0
│   └── block.timestamp - updatedAt <= stalePeriod
├── External Calls: feed.latestRoundData(), feed.decimals()
├── Returns: Price per 1 full token, normalized to 18 decimals
└── Risk: Medium
    ├── Stale data: Reverts if older than stalePeriod
    ├── Negative price: Reverts if answer <= 0
    └── Decimal overflow: feedDecimals > 18 reverts

function getValueUsd(address token, uint256 amount) external view returns (uint256)
├── Access: None (public view)
├── Validates: Same as getPrice
├── Returns: USD value of `amount` tokens, 18 decimals
└── Risk: Same as getPrice + calculation precision
```

---

## 6. Known Issues & Design Decisions

### 6.1 Acknowledged Design Choices

| ID | Issue | Design Decision | Rationale |
|----|-------|-----------------|-----------|
| H-02 | Simple interest, not compound | Intentional | Gas efficiency, predictable for users |
| H-09 | BLEBridgeV9 incompatible with V8 storage | Fresh deployment + migration | Clean slate for improved design |
| 5C-M05 | Interest rate changes apply prospectively | Intentional | Existing positions stable |
| S-M02 | No timelock on admin operations | Intentional for emergency response | Consider adding for production |

**⚠️ H-09 Migration Plan:** See [docs/MIGRATION_V8_TO_V9.md](docs/MIGRATION_V8_TO_V9.md) for:
- Storage layout comparison
- Step-by-step migration procedure
- Migration script at [scripts/migrate-v8-to-v9.ts](scripts/migrate-v8-to-v9.ts)
- Rollback procedure
- Timeline estimates

### 6.2 Fixed Issues (Prior Internal Review)

| ID | Severity | Issue | Fix Applied |
|----|----------|-------|-------------|
| H-01 | High | Incorrect decimal handling in liquidation | Use `getValueUsd` |
| H-03 | High | Unlimited strategy approval | Per-operation approval |
| H-04 | High | Fee manipulation via flash deposits | Update lastRecordedValue after |
| H-05 | High | Withdrawal before health check | CEI pattern |
| H-06 | High | No cap on NAV deviation | 50% maximum |
| H-20 | High | Borrow used liq threshold instead of collateral factor | Fixed |
| M-02 | Medium | Same role for pause/unpause | Separated |
| M-03 | Medium | Rate limit boundary off-by-one | Use `>=` |
| M-04 | Medium | Cap floored at current supply | Removed floor |
| M-05 | Medium | Collateral ratio change unlimited | 10% max + cooldown |
| S-01 | Low | Cooldown bypass via transfer | Propagate cooldown |
| S-02 | Low | redeem() bypassed cooldown | Added check |
| S-03 | Low | Donation attack on SMUSD | decimalsOffset(3) |
| S-04 | Low | Return value ignored | SafeERC20 |

### 6.3 Remaining Considerations

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Medium | No timelock on critical admin functions | Add 24-48h timelock |
| Medium | Single oracle failure = DoS | Add fallback oracle |
| Low | Strategy failures silently caught | Add monitoring/alerting |
| Low | Large redemptions may face delays | Document expected delays |
| Info | MEV on liquidations expected | No action needed |

---

## 7. External Dependencies

### 7.1 OpenZeppelin Contracts

| Package | Version | Components Used |
|---------|---------|-----------------|
| @openzeppelin/contracts | 5.x | ERC20, ERC4626, AccessControl, ReentrancyGuard, Pausable, SafeERC20 |
| @openzeppelin/contracts-upgradeable | 5.x | UUPSUpgradeable, Initializable, AccessControlUpgradeable |

### 7.2 Chainlink Oracles

| Interface | Usage |
|-----------|-------|
| AggregatorV3Interface | Price feeds for collateral |
| latestRoundData() | Price + timestamp retrieval |

**Stale Data Handling:**
- Per-token configurable stale period
- Reverts on stale or negative prices
- No L2 sequencer uptime checks (consider for L2 deployment)

### 7.3 Canton Network

| Component | Trust Assumption |
|-----------|------------------|
| Canton Validators | Multi-sig attestation of off-chain assets |
| Attestation Format | `{id, cantonAssets, nonce, timestamp}` |
| Signature Scheme | ECDSA over EIP-712 typed data |

---

## 8. Deployment Configuration

### 8.1 Constructor Parameters

```solidity
// MUSD
constructor(uint256 _initialSupplyCap)
// Recommendation: Start with conservative cap, e.g., 10M * 1e18

// BLEBridgeV9.initialize()
uint256 _minSigs = 3;           // Minimum 3-of-5 for production
address _musdToken;              // MUSD contract address
uint256 _collateralRatioBps = 11000;  // 110% collateralization
uint256 _dailyCapIncreaseLimit;  // e.g., 1M * 1e18 per day

// TreasuryV2.initialize()
address _asset;     // USDC address
address _vault;     // DirectMintV2 or CollateralVault
address _admin;     // Multisig address
address _feeRecipient;  // Protocol fee receiver
// Note: 20% performance fee, 10% reserve buffer hardcoded

// PriceOracle.setFeed()
address token;       // e.g., WETH
address feed;        // Chainlink ETH/USD feed
uint256 stalePeriod = 3600;  // 1 hour
uint8 tokenDecimals = 18;
```

### 8.2 Role Assignment Checklist

```
□ MUSD.BRIDGE_ROLE → [DirectMint, DirectMintV2, BorrowModule]
□ MUSD.CAP_MANAGER_ROLE → BLEBridgeV9
□ MUSD.COMPLIANCE_ROLE → Compliance multisig
□ TreasuryV2.VAULT_ROLE → DirectMintV2
□ TreasuryV2.STRATEGIST_ROLE → Protocol multisig
□ TreasuryV2.GUARDIAN_ROLE → Emergency multisig
□ TreasuryV2.ALLOCATOR_ROLE → Keeper bot
□ BLEBridgeV9.VALIDATOR_ROLE → [Validator1, Validator2, ..., ValidatorN]
□ BLEBridgeV9.EMERGENCY_ROLE → Emergency multisig
□ CollateralVault.BORROW_MODULE_ROLE → BorrowModule
□ CollateralVault.LIQUIDATION_ROLE → LiquidationEngine
□ BorrowModule.LIQUIDATION_ROLE → LiquidationEngine
□ PriceOracle.ORACLE_ADMIN_ROLE → Protocol multisig
□ All DEFAULT_ADMIN_ROLE → Protocol multisig (behind timelock)
```

---

## 9. Test Coverage

### 9.1 Test Files

| File | Tests | Status |
|------|-------|--------|
| `test/BLEProtocol.test.ts` | 40+ | ✅ Pass |
| `test/BLEBridgeV9.test.ts` | 25+ | ✅ Pass |
| `test/BorrowModule.test.ts` | 20+ | ✅ Pass |
| `test/DirectMint.test.ts` | 15+ | ✅ Pass |
| `test/DirectMintV2.test.ts` | 15+ | ✅ Pass |
| `test/LeverageVault.test.ts` | 20+ | ✅ Pass |
| `test/LiquidationEngine.test.ts` | 15+ | ✅ Pass |
| `test/TreasuryV2.test.ts` | 25+ | ✅ Pass |

### 9.2 Coverage Summary

```
All files                 |   85.5 |    78.3 |    82.1 |   84.9 |
```

### 9.3 Recommended Additional Tests

- [ ] Fuzzing for arithmetic operations (especially fee calculations)
- [ ] Invariant testing (totalSupply <= supplyCap)
- [ ] Fork testing against mainnet Chainlink feeds
- [ ] Gas benchmarking for loop-heavy functions
- [ ] Upgrade testing for UUPS contracts

---

## Appendix: Full Contract Details

### A.1 MUSD State Variables

```solidity
bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
bytes32 public constant CAP_MANAGER_ROLE = keccak256("CAP_MANAGER_ROLE");
uint256 public supplyCap;
mapping(address => bool) public isBlacklisted;
```

### A.2 BLEBridgeV9 State Variables

```solidity
bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
IMUSD public musdToken;
uint256 public attestedCantonAssets;
uint256 public collateralRatioBps;    // 10000 = 100%
uint256 public currentNonce;
uint256 public minSignatures;
uint256 public lastAttestationTime;
uint256 public lastRatioChangeTime;
uint256 public dailyCapIncreaseLimit;
uint256 public dailyCapIncreased;
uint256 public dailyCapDecreased;
uint256 public lastRateLimitReset;
mapping(bytes32 => bool) public usedAttestationIds;
uint256[38] private __gap;  // UUPS storage gap
```

**⚠️ STORAGE LAYOUT WARNING:** BLEBridgeV9 is NOT storage-compatible with BLEBridgeV8. Direct UUPS upgrade will corrupt state. Requires fresh proxy deployment with migration.

### A.3 TreasuryV2 State Variables

```solidity
uint256 public constant BPS = 10000;
uint256 public constant MAX_STRATEGIES = 10;
bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
IERC20 public asset;
address public vault;
StrategyConfig[] public strategies;
mapping(address => uint256) public strategyIndex;
mapping(address => bool) public isStrategy;
uint256 public reserveBps;
ProtocolFees public fees;
uint256 public lastRecordedValue;
uint256 public lastFeeAccrual;
uint256 public minAutoAllocateAmount;
uint256[40] private __gap;  // UUPS storage gap

struct StrategyConfig {
    address strategy;
    uint256 targetBps;
    uint256 minBps;
    uint256 maxBps;
    bool active;
    bool autoAllocate;
}

struct ProtocolFees {
    uint256 performanceFeeBps;  // Default: 2000 (20%)
    uint256 accruedFees;
    address feeRecipient;
}
```

### A.4 Collateral Configuration

```solidity
struct CollateralConfig {
    bool enabled;
    uint256 collateralFactorBps;     // e.g., 7500 = 75% LTV
    uint256 liquidationThresholdBps;  // e.g., 8500 = 85%
    uint256 liquidationPenaltyBps;    // e.g., 500 = 5%
}
```

**Parameter Recommendations:**

| Asset | Collateral Factor | Liq Threshold | Liq Penalty |
|-------|-------------------|---------------|-------------|
| WETH | 80% | 85% | 5% |
| WBTC | 75% | 82% | 7% |
| stETH | 70% | 78% | 10% |

---

## 10. Canton DAML Contracts

### 10.1 Overview

The protocol includes **17 DAML contract files** running on the Canton Network, implementing Canton-side token accounting, cross-chain bridge attestation, compliance enforcement, staking, vaults (CDPs), and liquidation. These contracts are the Canton-side counterpart to the Solidity contracts on Ethereum and form the other half of the protocol's security surface.

**SDK Version:** 2.10.3
**Project Name:** `ble-protocol`
**Precision:** `Numeric 18` (18-decimal, 1:1 mapping with Ethereum Wei)

### 10.2 Canton Contract Inventory

#### Core Protocol Contracts

| Module | File | Templates | Audit Priority |
|--------|------|-----------|----------------|
| BLEProtocol | `daml/BLEProtocol.daml` | InstitutionalEquityPosition, AttestationRequest, ValidatorSignature | **P0** |
| BLEBridgeProtocol | `daml/BLEBridgeProtocol.daml` | BridgeOutAttestation, BridgeInAttestation, SupplyCapAttestation, YieldAttestation + Signatures | **P0** |
| CantonDirectMint | `daml/CantonDirectMint.daml` | CantonMUSD, CantonUSDC, USDCx, CantonDirectMintService, BridgeOutRequest, ReserveTracker, RedemptionRequest | **P0** |
| CantonSMUSD | `daml/CantonSMUSD.daml` | CantonSMUSD, CantonSMUSDTransferProposal, CantonStakingService | **P1** |
| Compliance | `daml/Compliance.daml` | ComplianceRegistry | **P0** |
| MintedMUSD | `daml/MintedMUSD.daml` | MUSD, MUSD_Locked, MUSD_RedemptionRequest, MUSD_TransferProposal, IssuerRole, MintRequest, MintProposal | **P1** |
| InstitutionalAssetV4 | `daml/InstitutionalAssetV4.daml` | Instrument, AssetRegistry, Asset, TransferProposal | **P1** |

#### Unified Protocol Modules

| Module | File | Templates | Audit Priority |
|--------|------|-----------|----------------|
| Minted.Protocol.V3 | `daml/Minted/Protocol/V3.daml` | MintedMUSD, PriceOracle, LiquidityPool, Vault, VaultManager, LiquidationReceipt, LiquidationOrder, CantonDirectMint, CantonSMUSD, CooldownTicket, BridgeService, AttestationRequest, BridgeOutRequest, BridgeInRequest | **P0** |
| MintedProtocolV2Fixed | `daml/MintedProtocolV2Fixed.daml` | MUSD, Collateral, USDC, PriceOracle, DirectMintService, StakingService, Vault, LiquidationEngine, LiquidityPool, LeverageManager, IssuerRole, AttestationRequest, ValidatorSignature + Transfer Proposals | **P0** |

#### Legacy / Reference Contracts

| Module | File | Notes |
|--------|------|-------|
| MintedProtocol | `daml/MintedProtocol.daml` | Earlier protocol version |
| MUSD_Protocol | `daml/MUSD_Protocol.daml` | Standalone minting/staking/bridge |
| SecureCoin | `daml/SecureCoin.daml` | Secure coin pattern reference |
| SafeAsset | `daml/SafeAsset.daml` | Security best practices reference |
| TokenInterface | `daml/TokenInterface.daml` | Minimal token interface |

#### Test Contracts

| Module | File | Tests |
|--------|------|-------|
| Test | `daml/Test.daml` | 9 integration tests: BLE flow, collateral, duplicate sigs, expiration, validator auth, precision, mUSD lifecycle |
| CantonDirectMintTest | `daml/CantonDirectMintTest.daml` | 10 integration tests: mint, redeem, bridge-out/in, supply cap sync, yield attestation, end-to-end flow, reserve tracker, paused enforcement, USDCx flow |

### 10.3 Canton Security Architecture

#### 10.3.1 Signatory Model (DAML-Specific)

DAML's authorization model differs fundamentally from Solidity's role-based access control. In DAML, **signatories** are parties who must authorize contract creation and archival, enforced by the Canton ledger runtime — not by application code.

| Pattern | Purpose | Risk |
|---------|---------|------|
| **Dual signatory** (issuer + owner) | Prevents unilateral control — issuer cannot archive user tokens, owner cannot inflate supply | Low |
| **Proposal pattern** | Safe transfers: recipient must explicitly accept, preventing forced signatory obligations | Low |
| **Observer visibility** | Restricts which parties can see contract data — prevents privacy leaks | Low |
| **Consuming choices** | Archives the contract atomically on exercise, preventing double-spend/replay | Low |
| **NonConsuming choices** | Read-only queries that don't archive — used for validation hooks and price queries | Low |

#### 10.3.2 Trust Assumptions (Canton-Specific)

| Entity | Trust Level | Failure Mode |
|--------|-------------|--------------|
| Canton Validator Group | **Critical** | Compromised validators (majority) could forge attestations for bridge operations |
| Protocol Operator | **High** | Controls service templates, can pause operations, update caps and fees |
| Aggregator | **High** | Initiates and finalizes attestation requests, coordinates validators |
| Regulator (Compliance) | **Medium** | Controls blacklist/freeze — can block any party from transacting |
| xReserve (USDCx Issuer) | **Medium** | Controls USDCx minting — relies on Circle CCTP for backing |

### 10.4 Template-by-Template Analysis

#### 10.4.1 BLEProtocol.daml (Critical — Attestation Core)

```daml
template AttestationRequest
├── Signatories: aggregator
├── Observers: validatorGroup
├── Invariants:
│   ├── length validatorGroup > 0 && <= 100 (FIX H-6: DoS bound)
│   └── collectedSignatures tracks signed validators (FIX D-02)
│
├── choice ProvideSignature (CONSUMING — FIX D-01: TOCTOU prevention)
│   ├── Controller: validator
│   ├── Validates:
│   │   ├── validator not in collectedSignatures (FIX D-02: duplicate prevention)
│   │   ├── validator in validatorGroup
│   │   ├── signature length >= 130 chars (FIX M-24)
│   │   ├── now < payload.expiresAt (FIX D-03: expiration)
│   │   ├── Fetches all positionCids atomically
│   │   ├── totalValue >= amount * 1.1 (110% collateral)
│   │   └── Tolerance-based value comparison (FIX D-H08: Numeric 18 rounding)
│   └── Risk: Medium — consuming choice locks state between signatures
│
├── choice FinalizeAttestation (CONSUMING)
│   ├── Controller: aggregator
│   ├── Validates:
│   │   ├── Derives requiredSignatures = (n+1)/2 + 1 (FIX C-12: supermajority)
│   │   ├── Dedup check on sigValidators (FIX H-17)
│   │   ├── All signers in validatorGroup
│   │   ├── Expiration check (FIX D-03)
│   │   └── Final collateral verification
│   ├── Effects: Archives signature contracts (FIX D-M05: prevents reuse)
│   └── Risk: CRITICAL — finalization gates all minting operations
```

**Security Fixes Applied:**
- **D-01 (TOCTOU):** `ProvideSignature` changed to consuming choice — position CIDs are locked when attestation begins, preventing value changes between validation and finalization
- **D-02 (Signature Uniqueness):** `Set.Set Party` tracks signed validators; duplicate signatures rejected
- **D-03 (Timestamp Validation):** `expiresAt` field with `getTime` checks prevents stale attestations
- **C-12 (Quorum Bypass):** `requiredSignatures` derived from `validatorGroup` size, not caller-supplied
- **H-17 (Signature Dedup):** `Set.fromList` + length check enforces uniqueness at finalization
- **H-6 (DoS Bound):** Validator group capped at 100 parties

#### 10.4.2 BLEBridgeProtocol.daml (Critical — Cross-Chain Bridge Pipe)

```daml
template BridgeOutAttestation  — Canton stables → Ethereum Treasury
├── Signatories: aggregator
├── Observers: validatorGroup
├── choice BridgeOut_Sign (CONSUMING — FIX D-02)
│   ├── Tracks signedValidators list to prevent double-signing
│   ├── Expiration check, collateral verification (110%)
│   └── Returns updated attestation + signature contract
├── choice BridgeOut_Finalize
│   ├── Derives majority quorum: (n/2) + 1 (FIX DL-H1)
│   ├── Validates nonce consistency across all signatures
│   ├── Dedup check on validators
│   └── Final collateral verification
└── Risk: CRITICAL — controls flow of backing assets to Ethereum

template BridgeInAttestation  — Ethereum USDC → Canton
├── choice BridgeIn_Sign (nonconsuming)
│   └── ⚠️ WARNING: nonconsuming — does NOT prevent double-signing
│       (contrast with BridgeOutAttestation which uses consuming)
├── choice BridgeIn_Finalize
│   ├── Derives majority quorum: (n/2) + 1 (FIX DL-H2)
│   ├── Validates requestCid consistency
│   └── Dedup check on validators
└── Risk: HIGH — controls minting of Canton USDC on redemption

template SupplyCapAttestation  — Cross-chain supply sync
├── Invariant: totalGlobalSupply == cantonMUSDSupply + ethereumMUSDSupply
├── choice SupplyCap_Finalize
│   ├── Majority quorum (FIX DL-H3)
│   └── Validates: globalBackingUSDC >= totalGlobalSupply (no undercollateralization)
└── Risk: HIGH — incorrect supply cap could enable over-minting

template YieldAttestation  — Ethereum yield → Canton smUSD
├── Invariant: totalTreasuryAssets >= totalMUSDSupply
├── choice Yield_Finalize
│   ├── Majority quorum (FIX DL-H4)
│   └── Sequential epoch numbers prevent replay
└── Risk: MEDIUM — inflated yield could benefit smUSD holders unfairly
```

**⚠️ FINDING: BridgeIn_Sign Inconsistency**

`BridgeIn_Sign` is `nonconsuming` while `BridgeOut_Sign` is `consuming`. This means a validator could theoretically sign a bridge-in attestation multiple times. The dedup check in `BridgeIn_Finalize` mitigates this at finalization, but the inconsistency should be reviewed for defense-in-depth.

#### 10.4.3 CantonDirectMint.daml (High — Canton Minting Service)

```daml
template CantonDirectMintService
├── Signatories: operator
├── Observers: usdcIssuer, authorizedMinters
├── State: supplyCap, currentSupply, accumulatedFees, paused, rate limits
│
├── choice DirectMint_Mint
│   ├── Controller: user
│   ├── Validates:
│   │   ├── Service not paused
│   │   ├── Compliance check via ComplianceRegistry.ValidateMint (if configured)
│   │   ├── USDC issuer and owner match
│   │   ├── Amount within [minAmount, maxAmount]
│   │   ├── Net amount within supply cap
│   │   └── 24h rolling window rate limit check
│   ├── Effects:
│   │   ├── Transfers USDC to operator (via proposal pattern)
│   │   ├── Mints CantonMUSD with MPA agreement embedded
│   │   └── Creates BridgeOutRequest to pipe backing to Ethereum
│   └── Risk: HIGH — primary Canton minting path
│
├── choice DirectMint_MintWithUSDCx
│   ├── Same validations as DirectMint_Mint
│   ├── Accepts USDCx (Circle CCTP bridged USDC) instead of CantonUSDC
│   ├── No BridgeOutRequest needed (USDCx already backed on Ethereum)
│   └── Risk: HIGH — relies on xReserve/Circle CCTP for USDC backing
│
├── choice DirectMint_Redeem
│   ├── Controller: user
│   ├── Validates: Compliance check via ValidateRedemption
│   ├── Burns mUSD, creates RedemptionRequest (two-phase)
│   ├── Burns offset mints in rate limit window
│   └── Risk: MEDIUM — redemption fulfilled asynchronously after bridge-in
│
├── Admin choices: UpdateSupplyCap, SetPaused, SetDailyMintLimit, SetComplianceRegistry, WithdrawFees
│   ├── All controlled by: operator
│   └── Risk: MEDIUM — centralized operator control
```

**Key Security Features:**
- 24-hour rolling window rate limiting with separate mint/burn tracking
- Compliance hooks via optional `ComplianceRegistry` reference
- Master Participation Agreement hash embedded in every minted token
- Supply cap enforcement on every mint
- Proposal pattern for all asset transfers (dual-signatory safe)

#### 10.4.4 CantonSMUSD.daml (Medium — Yield Vault)

```daml
template CantonStakingService
├── Signatories: operator
├── State: totalShares, totalAssets, lastYieldEpoch, cooldownSeconds
│
├── choice Stake (CONSUMING)
│   ├── Calculates shares = depositAmount / sharePrice
│   ├── Burns mUSD, issues CantonSMUSD shares
│   └── Risk: LOW
│
├── choice Unstake (CONSUMING)
│   ├── Calculates mUSD = shares × sharePrice (includes yield)
│   ├── Validates totalAssets >= musdAmount
│   ├── Burns smUSD, mints mUSD at current share price
│   └── Risk: LOW — pool insolvency checked
│
├── choice SyncYield
│   ├── Controller: operator (after YieldAttestation finalization)
│   ├── Validates: epochNumber > lastYieldEpoch (sequential)
│   ├── Validates: yieldAccrued >= 0.0
│   ├── Effects: totalAssets += yieldAccrued → raises share price
│   └── Risk: MEDIUM — operator-gated, relies on attestation integrity
```

**Share Price Model:** `sharePrice = totalAssets / totalShares` (ERC-4626 equivalent)

#### 10.4.5 Compliance.daml (High — Regulatory Enforcement)

```daml
template ComplianceRegistry
├── Signatories: regulator
├── Observers: operator
├── State: blacklisted (Set.Set Party), frozen (Set.Set Party)
├── Invariant: regulator /= operator (separation of duties)
│
├── choice BlacklistUser / RemoveFromBlacklist
│   ├── Controller: regulator
│   ├── Requires: reason (audit trail)
│   └── Risk: LOW — standard compliance operation
│
├── choice FreezeUser / UnfreezeUser
│   ├── Controller: regulator
│   ├── Frozen parties: cannot transfer or redeem, CAN receive
│   └── Risk: LOW — allows recovery/consolidation
│
├── nonconsuming choice ValidateMint / ValidateTransfer / ValidateRedemption
│   ├── Controller: regulator, operator (both required)
│   ├── Checks party against blacklist and freeze sets
│   ├── O(log n) lookup via DA.Set
│   └── Risk: LOW — read-only validation hooks
│
├── choice BulkBlacklist
│   ├── Controller: regulator
│   ├── Capped at 100 parties per call (prevents abuse)
│   └── Risk: LOW — bounded bulk operation
```

#### 10.4.6 Minted.Protocol.V3.daml (Critical — Unified Canton Protocol)

This is the consolidated production module (1,111 lines, 14 templates). Key additions beyond individual modules:

```daml
template Vault (CDP)
├── Signatories: operator, owner
├── choice AdjustLeverage (atomic leverage loop)
│   ├── Bounded: max 10 loops
│   ├── Deposits collateral → borrows mUSD → swaps via DEX → adds collateral
│   ├── Health check after all loops
│   └── Risk: HIGH — complex atomic operation, oracle dependency
│
├── choice Liquidate
│   ├── Controller: liquidator (any party)
│   ├── Validates: healthFactor < liquidationThreshold
│   ├── Close factor limits max repayment
│   ├── Dust threshold triggers full liquidation
│   ├── Keeper bonus from penalty
│   ├── Creates immutable LiquidationReceipt
│   └── Risk: HIGH — oracle manipulation could trigger false liquidations

template VaultManager (Factory)
├── Whitelisted collateral symbols
├── Default config application to new vaults
└── Risk: MEDIUM — config changes affect new vaults only

template BridgeService
├── choice Bridge_ReceiveFromEthereum
│   ├── Validates attestation direction = EthereumToCanton
│   ├── Verifies sufficient signatures >= requiredSignatures
│   ├── Archives attestation (consumed — replay prevention)
│   └── Risk: CRITICAL — mints mUSD on Canton from Ethereum attestation

template AttestationRequest (V3)
├── choice Attestation_Sign (CONSUMING)
│   ├── Set-based duplicate tracking
│   ├── Signature length validation
│   └── Expiration enforcement
├── choice Attestation_Complete
│   ├── Derives majority quorum: (n/2) + 1 (FIX A-03)
│   └── Risk: CRITICAL — previously accepted caller-supplied requiredSignatures
```

#### 10.4.7 MintedProtocolV2Fixed.daml (Critical — Audited Protocol with Security Fixes)

```
Critical Fixes Applied:
├── TIME MANIPULATION: Removed user-provided `currentTime` across all choices
│   (Vault, Oracle, Liquidation). Replaced with `getTime` (Ledger Effective Time)
├── LIQUIDITY POOL STATE: Fixed Pool_SwapMUSDForCollateral — previously failed to update
│   poolCollateral CID, breaking pool after first trade
├── REPLAY ATTACK: MintFromAttestation is now CONSUMING — previously allowed infinite
│   minting from a single valid attestation
└── ATTESTATION CONCURRENCY: ProvideSignature changed to nonconsuming for parallel signing
    (contrast: later BLEProtocol changed it back to consuming for TOCTOU prevention)

Additional Fixes:
├── D-H01: Positive amount enforcement on all assets
├── D-H01: Proposal pattern for Collateral and USDC transfers
├── D-H04: Signature tracking set to prevent duplicates
├── D-H10: Liquidator observer visibility for health factor checks
├── D-C05: Quorum derived from validatorGroup (supermajority)
├── D-M01: Tolerance-based Numeric 18 comparison (< 1.0 USD)
├── D-M05: Strict inequality to prevent zero-remainder splits
├── H-07: Health factor queryable by any observer
├── H-08: Fee withdrawal creates USDC payment (not destroyed)
├── H-09: Repayment overpayment returned as change
├── 5C-H01: Vault borrows track supply against IssuerRole cap
└── 5C-H02: Unstake yield minting tracked against supply cap
```

#### 10.4.8 MintedMUSD.daml (Medium — Core Token with Issuance Workflows)

```daml
template IssuerRole
├── Signatories: issuer
├── State: supplyCap, currentSupply (on-ledger — FIX D-C01)
│
├── choice IssuerRole_Mint (CONSUMING)
│   ├── Controller: issuer, mintOwner (dual controller — FIX AUTH)
│   ├── Validates: currentSupply + mintAmount <= supplyCap
│   ├── Returns: updated IssuerRole + minted MUSD
│   └── Risk: MEDIUM — supply cap enforced, dual authorization required
│
├── choice IssuerRole_UpdateSupplyCap
│   ├── Validates: newCap >= currentSupply
│   └── Risk: LOW

template MintRequest
├── Signatories: owner (requester)
├── choice MintRequest_Approve
│   ├── Controller: issuer, owner (dual — FIX AUTH)
│   ├── Exercises IssuerRole_Mint (enforces supply cap — FIX 5C-C01)
│   └── Risk: LOW — separation of request/approval duties

template MintProposal
├── Signatories: issuer
├── choice MintProposal_Accept
│   ├── Controller: owner, issuer (dual — FIX AUTH)
│   └── Risk: LOW — airdrop-safe (user must accept)
```

#### 10.4.9 InstitutionalAssetV4.daml (Medium — Institutional Custody)

```daml
template Asset
├── Signatories: issuer, owner
├── Observers: observers, depository
├── Invariants: amount > 0.0, metadata length <= 100
│
├── choice Asset_Transfer
│   ├── Validates: not locked, registry authority matches, compliance check
│   ├── Prevents credit laundering via identity checks on merge
│   └── Risk: LOW — multi-layer validation
│
├── choice Asset_EmergencyTransfer
│   ├── Controller: issuer (court order/regulatory)
│   ├── Validates: non-empty reason (FIX IA-M03), compliance whitelist (FIX IA-C01)
│   ├── Appends reason to metadata audit trail
│   └── Risk: MEDIUM — issuer can forcibly move assets (by design for regulatory)
│
├── choice Asset_Split
│   ├── Validates: not locked, positive amount, instrument precision scale
│   └── Risk: LOW — precision validation prevents dust

template Instrument
├── Invariant: decimalScale in [0, 18] (FIX IA-L01)

template AssetRegistry
├── Invariant: 1 <= authorizedParties length <= 10,000 (FIX IA-M02)
```

### 10.5 Canton Security Posture Summary

| Category | Status |
|----------|--------|
| Dual Signatory Enforcement | ✅ All token templates use dual signatories (issuer + owner) |
| Proposal Pattern (Anti-Airdrop) | ✅ All transfers use accept/reject proposals |
| Replay Prevention | ✅ Consuming choices archive attestations after use |
| TOCTOU Prevention | ✅ Consuming choices lock position CIDs during attestation (FIX D-01) |
| Duplicate Signature Prevention | ✅ Set-based tracking on attestation requests (FIX D-02) |
| Timestamp Validation | ✅ `expiresAt` with `getTime` checks (FIX D-03) |
| Quorum Derivation | ✅ Required signatures derived from validator group size, not caller-supplied (FIX C-12) |
| Supply Cap Enforcement | ✅ On-ledger state tracking in IssuerRole / service contracts |
| Rate Limiting | ✅ 24h rolling window with mint/burn offset tracking |
| Compliance Hooks | ✅ Optional ComplianceRegistry with O(log n) blacklist/freeze checks |
| Oracle Staleness | ✅ Enforced via `getTime` comparison (not user-supplied time) |
| Numeric Precision | ✅ Numeric 18 with tolerance-based comparisons where needed |
| Validator Group Bounds | ✅ Capped at 100 parties (FIX H-6) |
| Legal Agreement Embedding | ✅ MPA hash + URI in every minted token |

### 10.6 Canton-Specific Findings & Recommendations

| Severity | Finding | Details | Recommendation |
|----------|---------|---------|----------------|
| **Medium** | BridgeIn_Sign is nonconsuming | Unlike BridgeOut_Sign (consuming), BridgeIn_Sign does not prevent double-signing. Mitigated by dedup at finalization. | Change to consuming for consistency and defense-in-depth |
| **Medium** | Operator centralization | CantonDirectMintService operator has unilateral control over pause, supply cap, fee changes, and compliance registry updates | Consider multi-party authorization or timelock for critical admin choices |
| **Medium** | No cooldown on CantonStakingService Unstake | Unlike V3's CooldownTicket pattern, the standalone CantonSMUSD module has no cooldown enforcement in Unstake | Verify which module is deployed in production; apply cooldown if needed |
| **Low** | Quorum inconsistency | BLEProtocol uses supermajority `(n+1)/2 + 1`; BLEBridgeProtocol uses simple majority `(n/2) + 1` | Standardize across all attestation types |
| **Low** | CantonMUSD_Merge lacks compliance check | Merge allows combining tokens without checking compliance registry | Add compliance validation if ComplianceRegistry is configured |
| **Low** | YieldAttestation epoch gap not bounded | Sequential epoch required, but large gaps between epochs are unchecked | Consider maximum epoch gap to detect missed attestations |
| **Info** | Multiple protocol versions coexist | V2Fixed, V3, standalone modules — unclear which is production | Document canonical production module; deprecate others |
| **Info** | MintedMUSD.daml uses `Decimal` (10-precision) | Other modules use `Numeric 18` — precision mismatch if interoperating | Ensure modules deployed together use consistent precision type |

### 10.7 Cross-Chain Bridge Security Analysis

The Canton↔Ethereum bridge is the **most critical security boundary** in the system. Compromise of the bridge enables unbacked minting on either chain.

```
Canton Network                          Ethereum Network
┌─────────────────────┐                 ┌──────────────────────┐
│  CantonDirectMint   │   BridgeOut     │                      │
│  (mint mUSD)        │──────────────▶  │  Ethereum Treasury   │
│                     │   (attestation) │  (holds USDC backing)│
│  CantonSMUSD        │                 │                      │
│  (yield vault)      │◀──────────────  │  Yield Strategies    │
│                     │   YieldAttest   │                      │
│  BLEBridgeProtocol  │                 │  BLEBridgeV9.sol     │
│  (validator multi-  │◀──────────────▶ │  (processAttestation)│
│   sig attestation)  │   SupplyCap     │                      │
│                     │   Sync          │                      │
│  Compliance         │                 │  MUSD.sol            │
│  (blacklist/freeze) │   BridgeIn      │  (ERC-20 + blacklist)│
│                     │◀──────────────  │                      │
│  RedemptionRequest  │   (USDC return) │  DirectMintV2.sol    │
└─────────────────────┘                 └──────────────────────┘
```

**Bridge Security Controls:**
1. **Multi-signature attestation** — Majority/supermajority validator quorum required
2. **Nonce-based replay prevention** — Sequential nonces on both sides
3. **Expiration timestamps** — Stale attestations rejected via `getTime`
4. **Collateral verification** — 110% collateral ratio checked at sign and finalize
5. **Rate limiting** — 24h rolling window on Canton side; daily cap increase limit on Ethereum side
6. **Supply cap synchronization** — SupplyCapAttestation keeps both chains consistent
7. **Two-phase redemption** — Burn first, then bridge-in fulfills asynchronously

**⚠️ CRITICAL: Bridge Invariant**

The fundamental invariant is:
```
Canton mUSD Supply + Ethereum mUSD Supply ≤ Total USDC Backing (Ethereum Treasury)
```
This is enforced by SupplyCapAttestation which validates `globalBackingUSDC >= totalGlobalSupply`.

### 10.8 Canton Test Coverage

| File | Tests | Coverage |
|------|-------|----------|
| `daml/Test.daml` | 9 scenarios | BLE attestation flow, collateral validation, duplicate signatures, expiration, validator authorization, Numeric 18 precision, mUSD split/merge/redeem, attestation-gated minting, transfer proposals |
| `daml/CantonDirectMintTest.daml` | 10 scenarios | Direct mint, redeem, bridge-out (3-of-5), bridge-in, supply cap sync, yield attestation + smUSD sync, end-to-end flow, reserve tracker, paused enforcement, USDCx/Circle CCTP flow |
| `daml/MintedMUSD.daml` (inline) | 1 scenario | Mint proposal, transfer privacy, failed redemption recovery, compliance locking |

**Recommended Additional Canton Tests:**
- [ ] Attestation with exactly quorum vs. quorum-1 signatures (boundary test)
- [ ] Rate limit window reset timing edge cases
- [ ] Concurrent attestation requests with overlapping validator groups
- [ ] ComplianceRegistry integration with all minting paths
- [ ] Cross-module precision consistency (Decimal vs. Numeric 18)
- [ ] Negative/zero amount rejection across all templates
- [ ] Emergency transfer audit trail verification
- [ ] YieldAttestation with epoch gaps

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-30 | Protocol Team | Initial audit preparation (Solidity contracts) |
| 1.1 | 2026-01-31 | Protocol Team | Added Canton DAML contracts audit (Section 10) |

---

**END OF AUDIT DOCUMENT**
