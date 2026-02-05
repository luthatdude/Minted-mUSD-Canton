# Minted mUSD Protocol - Threat Model

**Document Version:** 1.0  
**Last Updated:** February 2, 2026  
**Prepared For:** CredShield Security Audit  
**Scope:** Solidity contracts + DAML templates

---

## 1. System Overview

Minted mUSD is a cross-chain stablecoin protocol with:
- **Canton Network (DAML)**: Institutional accounting, compliance, and settlement
- **Ethereum (Solidity)**: Yield generation, DeFi integrations, and backing custody

### 1.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRUST BOUNDARY 1                                  │
│                      Canton Participant Node                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ CantonMUSD      │  │ CantonSMUSD     │  │ Governance      │             │
│  │ CantonDirectMint│  │ Compliance      │  │ Upgrade         │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                             │
│                    ▼ Attestations (3-of-5 multi-sig) ▼                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │ Validator 1 │ │ Validator 2 │ │ Validator 3 │
            │  (AWS KMS)  │ │  (AWS KMS)  │ │  (AWS KMS)  │
            └─────────────┘ └─────────────┘ └─────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRUST BOUNDARY 2                                  │
│                         Ethereum Mainnet                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ BLEBridgeV9     │  │ TreasuryV2      │  │ MUSD/SMUSD      │             │
│  │ DirectMintV2    │  │ Strategies      │  │ Vaults          │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRUST BOUNDARY 3                                  │
│                       External Protocols                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ Chainlink       │  │ Pendle Finance  │  │ Morpho          │             │
│  │ (Price Oracles) │  │ (PT Strategy)   │  │ (Loop Strategy) │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Categories

### 2.1 Critical Threats (Protocol Survival)

| ID | Threat | Attack Vector | Mitigation |
|----|--------|---------------|------------|
| **T-C01** | Unauthorized minting | Attacker gains MINTER_ROLE on MUSD.sol | AccessControl, multi-sig admin, timelocked role changes |
| **T-C02** | Bridge attestation forgery | Attacker forges validator signatures | 3-of-5 multi-sig, ECDSA verification, nonce replay protection |
| **T-C03** | Supply cap bypass | Attacker inflates supply beyond attestations | `attestedCantonAssets` tracks canonical supply, rate limiting |
| **T-C04** | Treasury drain | Attacker withdraws backing USDC | AccessControl (ADMIN_ROLE), strategy whitelist, withdrawal limits |
| **T-C05** | Oracle manipulation | Attacker feeds false prices | Chainlink with staleness checks, deviation bounds, multi-source |
| **T-C06** | Private key compromise (Admin) | Attacker gains protocol admin key | Hardware wallet, multi-sig, timelocked admin actions |

### 2.2 High Threats (Significant Loss)

| ID | Threat | Attack Vector | Mitigation |
|----|--------|---------------|------------|
| **T-H01** | Validator collusion | 3+ validators collude to sign false attestations | Geographically distributed, independent custody (AWS KMS) |
| **T-H02** | Liquidation frontrunning | MEV bot liquidates before user can repay | Private mempool option, health factor buffer |
| **T-H03** | Rate limit circumvention | Attacker bypasses 24h limits | On-chain enforcement, cap decreases tracked |
| **T-H04** | Strategy loss | Yield strategy loses principal | Max allocation limits, strategy audits, withdrawal locks |
| **T-H05** | Governance takeover | Attacker gains governance control on Canton | M-of-N approval, timelock, emergency pause |
| **T-H06** | Double-spend on bridge | Attacker claims mUSD on both chains | Attestation IDs are one-time-use, archived after consumption |

### 2.3 Medium Threats (Limited Loss)

| ID | Threat | Attack Vector | Mitigation |
|----|--------|---------------|------------|
| **T-M01** | Denial of service | Attacker spams bridge/mint | Rate limiting (NGINX, contract-level), gas costs |
| **T-M02** | Stale price exploitation | Oracle price becomes stale | `maxStaleness` parameter, revert on stale data |
| **T-M03** | Blacklist evasion | Blacklisted user creates new address | KYC for institutional users, compliance hooks |
| **T-M04** | Front-running deposits | MEV bot sees pending deposit | Low slippage (1:1 mint), no swap frontrunning |
| **T-M05** | Cooldown bypass | User avoids smUSD withdrawal cooldown | Cooldown enforced on-chain, CooldownTicket on Canton |

### 2.4 Low Threats (Minimal Impact)

| ID | Threat | Attack Vector | Mitigation |
|----|--------|---------------|------------|
| **T-L01** | Griefing via dust | Attacker creates many small positions | Minimum amounts enforced (`ensure amount > 0.01`) |
| **T-L02** | Replay across chains | Attacker replays TX on different chain | ChainID in attestation payload |
| **T-L03** | Upgrade griefing | Attacker delays contract migrations | Migration tickets have expiry, governance override |

---

## 3. Attack Trees

### 3.1 Unauthorized Minting Attack Tree

```
[GOAL] Mint mUSD without backing
    │
    ├── [OR] Gain MINTER_ROLE
    │   ├── [AND] Compromise admin key + Wait for timelock
    │   ├── [AND] Social engineer multi-sig holders (3+ of 5)
    │   └── [AND] Exploit AccessControl bug (mitigated by OZ)
    │
    ├── [OR] Forge bridge attestation
    │   ├── [AND] Compromise 3+ validator keys
    │   ├── [AND] Find ECDSA signature vulnerability
    │   └── [AND] Replay old attestation (mitigated by nonce)
    │
    └── [OR] Exploit DirectMint
        ├── [AND] Deposit fake USDC (mitigated by whitelist)
        └── [AND] Reentrancy on mint (mitigated by nonReentrant)
```

### 3.2 Treasury Drain Attack Tree

```
[GOAL] Withdraw USDC from Treasury without authorization
    │
    ├── [OR] Gain ADMIN_ROLE
    │   ├── [AND] Compromise admin key + Wait for timelock
    │   └── [AND] Exploit proxy upgrade (mitigated by UUPS)
    │
    ├── [OR] Exploit strategy
    │   ├── [AND] Deploy malicious strategy + Get whitelisted
    │   ├── [AND] Exploit Pendle/Morpho integration
    │   └── [AND] Flash loan attack on strategy
    │
    └── [OR] Exploit redemption
        ├── [AND] Forge mUSD balance (mitigated by burn-before-transfer)
        └── [AND] Reentrancy on redeem (mitigated by nonReentrant)
```

---

## 4. Security Assumptions

### 4.1 Trusted Components

| Component | Assumption | Verification |
|-----------|------------|--------------|
| Canton Ledger | Byzantine fault tolerant, finality guaranteed | Canton Network SLA |
| Ethereum | Chain finality after 2 epochs (~13 min) | Wait for finality before bridging |
| Chainlink | Price feeds are accurate within deviation bounds | Multi-source validation |
| AWS KMS | Validator keys cannot be extracted | AWS SOC2 compliance |
| OpenZeppelin | Audited library code is correct | OZ audit reports |
| Solidity 0.8.26 | Overflow/underflow protection | Compiler guarantees |

### 4.2 Operational Assumptions

| Assumption | Rationale |
|------------|-----------|
| Admin keys are stored in hardware wallets | Standard practice for high-value protocols |
| Validators operate independently | No single entity controls 3+ validators |
| Canton participant node is secured | mTLS, network isolation, audit logging |
| Monitoring alerts are actionable | 24/7 on-call for critical events |

---

## 5. Defense in Depth Layers

```
Layer 1: Access Control
├── OpenZeppelin AccessControl on all contracts
├── DAML signatory model (dual-signatory for transfers)
├── M-of-N governance for admin actions
└── Timelocked role changes

Layer 2: Rate Limiting
├── NGINX: 10r/s read, 2r/s write per IP
├── BLEBridgeV9: 24h rolling cap increase limit
├── DirectMintV2: 24h net mint volume limit
└── CantonDirectMint: 24h rate limiting

Layer 3: Validation
├── Chainlink oracle with staleness checks
├── Collateral ratio enforcement (110% minimum)
├── Supply cap tracking (attestedCantonAssets)
└── Compliance registry (blacklist/freeze)

Layer 4: Monitoring
├── On-chain events for all state changes
├── Bridge health monitoring (collateral ratio)
├── Validator signature logging
└── Strategy performance tracking

Layer 5: Emergency Response
├── Pausable on all critical contracts
├── Emergency bridge shutdown
├── Governance emergency rollback
└── Strategy withdrawal locks
```

---

## 6. Incident Response

### 6.1 Severity Classification

| Severity | Criteria | Response Time |
|----------|----------|---------------|
| **Critical** | Active exploit, funds at risk | Immediate (< 1 hour) |
| **High** | Vulnerability discovered, no active exploit | < 4 hours |
| **Medium** | Non-exploitable issue, requires fix | < 24 hours |
| **Low** | Minor issue, no security impact | < 1 week |

### 6.2 Emergency Actions

```
┌─────────────────────────────────────────────────────────────┐
│                    EMERGENCY PLAYBOOK                       │
├─────────────────────────────────────────────────────────────┤
│ 1. PAUSE: Call pause() on affected contracts               │
│ 2. ASSESS: Identify scope and attack vector                 │
│ 3. COMMUNICATE: Notify users via status page                │
│ 4. REMEDIATE: Deploy fix or workaround                      │
│ 5. RESUME: Unpause after verification                       │
│ 6. POST-MORTEM: Document and publish incident report        │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Audit Scope Boundaries

### 7.1 In Scope

| Component | Files | LOC |
|-----------|-------|-----|
| Solidity Contracts | `contracts/*.sol` (excluding mocks) | ~5,500 |
| DAML Templates | `daml/*.daml` (excluding archived) | ~5,400 |
| Relay Service | `relay/*.ts` | ~1,500 |

### 7.2 Out of Scope

| Component | Reason |
|-----------|--------|
| Frontend | UI-only, no value transfer logic |
| Kubernetes manifests | Infrastructure, not business logic |
| Mock contracts | Test utilities only |
| Archived files | Deprecated, not deployed |

---

## 8. Known Risks Accepted

| Risk | Reason for Acceptance | Mitigation |
|------|----------------------|------------|
| Validator collusion (< 3) | Impractical with geographic distribution | Monitoring, reputation bonds |
| Chainlink downtime | External dependency | Fallback oracle, staleness revert |
| Ethereum reorganization | Standard blockchain risk | Wait for finality |
| Canton network outage | External dependency | Graceful degradation, Ethereum-only mode |

---

## Appendix: STRIDE Analysis

| Threat Type | Examples in Protocol | Primary Mitigation |
|-------------|---------------------|-------------------|
| **S**poofing | Forge validator signature | ECDSA verification, multi-sig |
| **T**ampering | Modify attestation payload | Hash verification, nonce |
| **R**epudiation | Deny signing attestation | On-chain signature logging |
| **I**nformation Disclosure | Reveal holder balances | Canton privacy model |
| **D**enial of Service | Spam bridge requests | Rate limiting, gas costs |
| **E**levation of Privilege | Gain admin role | AccessControl, timelock |
