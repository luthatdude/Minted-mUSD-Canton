# Compliance Framework — Minted mUSD Protocol

> **Owner:** Compliance Officer / Legal  
> **Classification:** Confidential  
> **Last updated:** 2026-02-14  
> **Applicable jurisdictions:** United States (primary), with provisions for international expansion

---

## Table of Contents

1. [Overview](#1-overview)
2. [KYC/AML Program](#2-kycaml-program)
3. [Sanctions Screening (OFAC)](#3-sanctions-screening-ofac)
4. [Transaction Monitoring](#4-transaction-monitoring)
5. [Regulatory Reporting](#5-regulatory-reporting)
6. [Audit Trail & Recordkeeping](#6-audit-trail--recordkeeping)
7. [Institutional Counterparty Onboarding](#7-institutional-counterparty-onboarding)
8. [Technical Implementation](#8-technical-implementation)
9. [Roles & Responsibilities](#9-roles--responsibilities)
10. [Incident Response — Compliance](#10-incident-response--compliance)

---

## 1. Overview

Minted mUSD is an institutional-grade stablecoin protocol operating across Canton Network (DAML) and Ethereum. This document defines the compliance framework governing KYC/AML, sanctions screening, transaction monitoring, and regulatory reporting.

### Regulatory Framework

| Regulation | Applicability | Summary |
|-----------|---------------|---------|
| Bank Secrecy Act (BSA) | US operations | AML program, CTR/SAR filing, recordkeeping |
| USA PATRIOT Act §311–326 | US operations | Enhanced CDD, information sharing |
| OFAC Sanctions | Global | SDN/consolidated screening, blocking requirements |
| FinCEN Travel Rule | Transfers >$3,000 | Originator/beneficiary information sharing |
| MiCA (EU) | Future EU expansion | CASP licensing, reserve requirements |
| FATF Recommendations | Global baseline | Risk-based approach, VASP requirements |

### Risk Classification

| Risk Level | Definition | Example |
|-----------|-----------|---------|
| Low | Regulated institutional counterparty, known jurisdiction | US-regulated bank, SEC-registered fund |
| Medium | Non-US regulated entity, moderate-risk jurisdiction | EU-licensed CASP, Singapore MAS-regulated entity |
| High | PEP, high-risk jurisdiction, complex ownership | Shell company structures, FATF grey-list countries |
| Prohibited | Sanctioned, designated, embargoed | OFAC SDN, sanctioned countries |

---

## 2. KYC/AML Program

### 2.1 Customer Identification Program (CIP)

All participants must complete identity verification before interacting with the protocol.

#### Individual Requirements

| Document | Required | Purpose |
|---------|---------|---------|
| Government-issued photo ID | ✅ | Identity verification |
| Proof of address (<3 months) | ✅ | Address verification |
| Source of funds declaration | ✅ | AML risk assessment |
| Tax identification number | ✅ (US) / ⬜ (non-US) | Tax reporting |

#### Entity Requirements

| Document | Required | Purpose |
|---------|---------|---------|
| Certificate of incorporation | ✅ | Legal existence |
| Articles of association | ✅ | Governance structure |
| Register of directors/UBOs | ✅ | Beneficial ownership (>25%) |
| Board resolution authorizing activity | ✅ | Authority to transact |
| Audited financial statements | ✅ (>$1M activity) | Financial standing |
| AML/KYC policy of counterparty | ✅ (regulated entities) | Compliance reciprocity |

### 2.2 Customer Due Diligence (CDD)

| CDD Level | Trigger | Requirements |
|-----------|--------|-------------|
| Simplified (SDD) | Low-risk regulated entity | Name, registration number, basic ownership |
| Standard (CDD) | Default for all participants | Full CIP + source of funds + ongoing monitoring |
| Enhanced (EDD) | PEPs, high-risk jurisdictions, complex structures | CDD + source of wealth, senior management approval, enhanced monitoring frequency |

### 2.3 Ongoing Monitoring

- **Periodic review:** Low-risk annually, Medium-risk semi-annually, High-risk quarterly
- **Trigger-based review:** Unusual transaction patterns, adverse media, sanctions list updates
- **Automatic rescreening:** All counterparties rescreened against sanctions lists daily

### 2.4 Wallet Binding

Each verified identity is bound to one or more blockchain addresses:

| Chain | Binding Mechanism | Storage |
|-------|------------------|---------|
| Ethereum | Wallet address → KYC record (off-chain DB) | Encrypted database |
| Canton | Party ID → KYC record (off-chain DB) | Encrypted database |

Unverified addresses are blocked from protocol interaction via:
- **Ethereum:** Contract-level blacklist in `MUSD.sol` (address check on transfer)
- **Canton:** `ComplianceRegistry.daml` → `ValidateMint`, `ValidateTransfer`, `ValidateRedemption`

---

## 3. Sanctions Screening (OFAC)

### 3.1 Screening Process

```
New Address/Party Submitted
        │
        ▼
┌───────────────────────┐
│  Screen against:       │
│  • OFAC SDN List       │
│  • OFAC Consolidated   │
│  • EU Sanctions List   │
│  • UN Sanctions List   │
│  • Chainalysis API     │
│    (on-chain risk)     │
└───────────┬────────────┘
            │
      ┌─────┴──────┐
      │             │
   CLEAR         HIT / POSSIBLE MATCH
      │             │
      ▼             ▼
  Approved     Manual Review
                    │
              ┌─────┴──────┐
              │             │
          FALSE POS     TRUE MATCH
              │             │
              ▼             ▼
          Approved     BLOCK + REPORT
                           │
                           ▼
                    File SAR with FinCEN
                    Freeze assets (Canton)
                    Blacklist address (ETH)
```

### 3.2 Screening Frequency

| Event | Screening |
|-------|----------|
| Onboarding | Full screening (all lists) |
| Daily batch | Rescan all active addresses against updated lists |
| Before bridge transfer | Real-time screen of source and destination |
| Before large mint (>$100K) | Real-time screen + EDD trigger |
| Sanctions list update | Full rescan within 24 hours |

### 3.3 Blocking Actions

When a sanctions match is confirmed:

**Ethereum:**
```solidity
// MUSD.sol — admin blacklists the address
musd.addToBlacklist(sanctionedAddress);
// All transfers to/from this address now revert
```

**Canton (DAML):**
```
-- ComplianceRegistry.daml
exercise complianceRegistryCid BlacklistUser with
  userToBlock = sanctionedParty
  reason = "OFAC SDN Match — [List Entry ID]"
```

**Reporting:**
- File Blocking Report with OFAC within 10 business days
- File SAR with FinCEN within 30 calendar days
- Preserve all transaction records for 5 years

---

## 4. Transaction Monitoring

### 4.1 Monitored Activities

| Activity | Threshold | Action |
|---------|----------|--------|
| Single mint | >$10,000 | Flag for review |
| Daily aggregate mint (single user) | >$50,000 | Enhanced review |
| Bridge transfer | >$100,000 | Real-time compliance check |
| Rapid mint-and-redeem | >3 cycles in 24h | Suspicious pattern flag |
| Structuring detection | Multiple txns just under $10K | SAR consideration |
| Dormant account reactivation | >90 days inactive, then large tx | Review |
| Cross-chain round-tripping | Canton→ETH→Canton rapid cycling | Investigate |

### 4.2 Data Sources

| Source | Data | Integration |
|--------|------|------------|
| Ethereum events | Mint, Burn, Transfer, Bridge events | Subgraph / event indexer |
| Canton ledger | DAML exercise events (ACS + transaction stream) | Canton JSON API + relay logs |
| Off-chain KYC database | Customer identity, risk rating | Internal API |
| Chainalysis / Elliptic | On-chain risk scoring | API integration |

### 4.3 Automated Rules Engine

Transaction monitoring rules are applied in real-time via:

1. **Pre-transaction hooks** (Canton): `ComplianceRegistry` validates before each mint/transfer/redeem
2. **Transfer restrictions** (Ethereum): `MUSD._update()` checks blacklist on every transfer
3. **Post-transaction analysis** (off-chain): Batch analysis of all protocol events for pattern detection

---

## 5. Regulatory Reporting

### 5.1 Required Reports

| Report | Authority | Trigger | Timeline |
|--------|----------|---------|----------|
| Suspicious Activity Report (SAR) | FinCEN | Suspicious activity >$5,000 | 30 days from detection |
| Currency Transaction Report (CTR) | FinCEN | Cash transaction >$10,000 | 15 days |
| OFAC Blocking Report | OFAC | Sanctions match | 10 business days |
| Annual BSA Report | FinCEN | Annual requirement | Annually |

### 5.2 SAR Filing Process

```
1. Transaction flagged by monitoring system
2. Compliance analyst reviews within 48 hours
3. If suspicious → Draft SAR narrative
4. Compliance Officer reviews and approves
5. File via FinCEN BSA E-Filing System
6. Retain copy for 5 years
7. Do NOT notify the subject of the SAR
```

### 5.3 Record Retention

| Record Type | Retention Period | Storage |
|------------|-----------------|---------|
| KYC/CIP documents | 5 years after relationship ends | Encrypted document store |
| Transaction records | 5 years | Canton ledger (immutable) + Ethereum chain |
| SARs and CTRs | 5 years from filing | Secure compliance archive |
| Screening results | 5 years | Encrypted database |
| Correspondence | 5 years | Email archive |

---

## 6. Audit Trail & Recordkeeping

### 6.1 Canton Ledger (Immutable Audit Trail)

The Canton ledger provides a built-in audit trail for all protocol actions:

| Action | DAML Template | Audit Data |
|--------|--------------|-----------|
| Mint mUSD | `CantonDirectMintService` | Minter party, amount, timestamp, compliance check result |
| Redeem mUSD | `CantonDirectMintService` | Redeemer party, amount, timestamp |
| Transfer mUSD | `MintedMUSD` | Sender, receiver, amount, timestamp |
| Bridge out | `BridgeOutRequest` | Source party, amount, nonce, validator list |
| Bridge in | `receiveFromEthereum()` | Attestation ID, amount, validators who signed |
| Blacklist | `ComplianceRegistry` | Party blocked, reason, timestamp, regulator |
| Unblock | `ComplianceRegistry` | Party unblocked, reason, timestamp, regulator |
| Freeze | `ComplianceRegistry` | Party frozen, reason, timestamp |

**Key property:** Canton uses consuming choices — each action archives the old contract and creates a new one. This means every state transition is recorded in the ledger's transaction tree and cannot be altered retroactively.

### 6.2 Ethereum Audit Trail

| Event | Contract | Indexed Fields |
|-------|---------|---------------|
| `Transfer` | MUSD | from, to, value |
| `Mint` | DirectMintV2 | minter, amount, fee |
| `Redeem` | DirectMintV2 | redeemer, amount, fee |
| `AttestationSubmitted` | BLEBridgeV9 | attestationId, cantonAssets, newCap |
| `Blacklisted` | MUSD | account |
| `GlobalPauseStateChanged` | GlobalPauseRegistry | paused, caller |

### 6.3 Compliance Database Schema (Off-Chain)

```
customers
├── id (UUID)
├── legal_name
├── entity_type (individual / entity)
├── risk_rating (low / medium / high)
├── kyc_status (pending / approved / rejected / expired)
├── kyc_approved_at
├── kyc_expires_at
├── enhanced_due_diligence (boolean)
├── pep_status (boolean)
└── last_reviewed_at

wallet_bindings
├── customer_id (FK)
├── chain (ethereum / canton)
├── address_or_party_id
├── verified_at
└── status (active / suspended / revoked)

screening_results
├── customer_id (FK)
├── screening_date
├── lists_checked (OFAC, EU, UN, Chainalysis)
├── result (clear / hit / pending_review)
├── match_details (JSON, if hit)
└── reviewer_decision (false_positive / confirmed / pending)

transaction_flags
├── tx_hash_or_event_id
├── chain (ethereum / canton)
├── flag_type (threshold / pattern / sanctions)
├── flagged_at
├── reviewed_by
├── disposition (cleared / escalated / sar_filed)
└── notes
```

---

## 7. Institutional Counterparty Onboarding

### 7.1 Onboarding Workflow

```
1. APPLICATION
   └─ Counterparty submits: entity docs, UBO declarations, AML policy

2. SCREENING
   ├─ Entity + UBOs screened against all sanctions lists
   ├─ Adverse media search
   └─ Jurisdiction risk assessment

3. DUE DILIGENCE
   ├─ Standard CDD (all counterparties)
   ├─ Enhanced EDD if: PEP, high-risk jurisdiction, complex structure
   └─ Financial review if activity >$1M

4. RISK RATING
   └─ Compliance Officer assigns risk rating (low / medium / high)

5. APPROVAL
   ├─ Low/Medium: Compliance Officer approves
   └─ High: Senior Management + Compliance Officer joint approval

6. TECHNICAL SETUP
   ├─ Ethereum: Whitelist wallet address(es)
   ├─ Canton: Create participant party, bind to compliance registry
   └─ Rate limits: Set per-counterparty limits if applicable

7. ONGOING
   └─ Periodic review per risk rating schedule (§2.3)
```

### 7.2 Required Agreements

| Agreement | Purpose | Signatories |
|-----------|--------|-------------|
| Master Participation Agreement (MPA) | Defines mUSD terms, rights, obligations | Protocol + Counterparty |
| Service Agreement | Technical SLAs, support terms | Protocol + Counterparty |
| Data Processing Agreement (DPA) | GDPR/privacy compliance | Protocol + Counterparty |
| AML Information Sharing Agreement | §314(b) voluntary information sharing | Protocol + Counterparty (optional) |

**Note:** The MPA hash + URI is embedded in every `MintedMUSD` token on Canton (field: `mpaAgreement`), ensuring all token holders have constructive notice of the agreement terms.

---

## 8. Technical Implementation

### 8.1 ComplianceRegistry (Canton/DAML)

The `ComplianceRegistry` template in `daml/Compliance.daml` provides on-ledger compliance enforcement:

| Choice | Controller | Purpose |
|--------|-----------|---------|
| `BlacklistUser` | Regulator | Block party from all protocol activity |
| `RemoveFromBlacklist` | Regulator | Unblock party (requires reason for audit trail) |
| `FreezeUser` | Regulator | Freeze party (can receive, cannot send) |
| `UnfreezeUser` | Regulator | Unfreeze party |
| `ValidateMint` | Operator | Pre-mint compliance check (nonconsuming) |
| `ValidateTransfer` | Operator | Pre-transfer compliance check (nonconsuming) |
| `ValidateRedemption` | Operator | Pre-redeem compliance check (nonconsuming) |
| `IsCompliant` | Any caller | Query compliance status |
| `BulkBlacklist` | Regulator | Mass sanctions list import (up to 1000 parties) |

**Integration:** `CantonDirectMintService` holds an optional `complianceRegistryCid`. When set, `DirectMint_Mint` exercises `ValidateMint` and `DirectMint_Redeem` exercises `ValidateRedemption` before processing.

### 8.2 Ethereum Blacklist (MUSD.sol)

The `MUSD` contract has a built-in blacklist:
- `addToBlacklist(address)` — Only `COMPLIANCE_ROLE`
- `removeFromBlacklist(address)` — Only `COMPLIANCE_ROLE`
- `_update()` override checks blacklist on every transfer

### 8.3 Off-Chain Compliance Service

A compliance microservice (not yet deployed) should provide:
- REST API for KYC status queries
- Webhook integration with sanctions screening provider
- Transaction monitoring rules engine
- SAR workflow management
- Integration with Canton JSON API for real-time compliance checks

---

## 9. Roles & Responsibilities

| Role | Responsibilities |
|------|-----------------|
| **Compliance Officer** | Program oversight, SAR review/filing, risk assessment, regulatory liaison |
| **Compliance Analyst** | Transaction monitoring review, KYC processing, screening disposition |
| **Regulator (Canton)** | `ComplianceRegistry` signatory — blacklist/freeze/unfreeze |
| **COMPLIANCE_ROLE (Ethereum)** | `MUSD.sol` blacklist management |
| **External Counsel** | Regulatory interpretation, enforcement response, SAR escalation |
| **Independent Auditor** | Annual BSA/AML program audit |

### Training Requirements

| Personnel | Training | Frequency |
|-----------|---------|-----------|
| All employees | AML/sanctions awareness | Annually |
| Compliance team | Advanced AML, SAR writing, OFAC procedures | Semi-annually |
| Engineering team | Secure handling of PII, compliance integration points | Annually |
| Senior management | BSA/AML program responsibilities, regulatory updates | Annually |

---

## 10. Incident Response — Compliance

### Sanctions Match Detected

| Step | Action | Timeline |
|------|--------|----------|
| 1 | Immediately block address/party | <1 hour |
| 2 | Freeze all associated assets | <1 hour |
| 3 | Notify Compliance Officer | <2 hours |
| 4 | Document all blocked property | <24 hours |
| 5 | File Blocking Report with OFAC | 10 business days |
| 6 | File SAR with FinCEN | 30 calendar days |
| 7 | Engage external counsel if needed | As appropriate |

### Law Enforcement Request

| Step | Action |
|------|--------|
| 1 | Verify authenticity of request (call back to known number) |
| 2 | Forward to external counsel |
| 3 | Respond within timeframe specified (typically 10-30 days) |
| 4 | Provide only data specified in request |
| 5 | Document everything |
| 6 | Do NOT notify subject unless counsel advises otherwise |

### Data Breach (PII Exposure)

| Step | Action | Timeline |
|------|--------|----------|
| 1 | Contain breach (revoke access, rotate credentials) | Immediate |
| 2 | Assess scope (which records, which customers) | <24 hours |
| 3 | Notify affected individuals | Per applicable law (typically 72h) |
| 4 | Notify regulators | Per applicable law |
| 5 | Engage forensic investigator | <48 hours |
| 6 | Implement remediation | ASAP |

---

## Appendix A: Sanctions Lists & Screening Providers

| List / Provider | Update Frequency | URL |
|----------------|-----------------|-----|
| OFAC SDN List | As updated (~daily) | https://sanctionslist.ofac.treas.gov/ |
| OFAC Consolidated | As updated | https://ofac.treasury.gov/consolidated-sanctions-list |
| EU Consolidated | As updated | https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions |
| UN Security Council | As updated | https://www.un.org/securitycouncil/content/un-sc-consolidated-list |
| Chainalysis Sanctions API | Real-time | (Requires commercial license) |

## Appendix B: Regulatory Contact Information

| Agency | Contact | Purpose |
|--------|---------|---------|
| FinCEN | BSA E-Filing (https://bsaefiling.fincen.treas.gov/) | SAR/CTR filing |
| OFAC | OFAC Hotline: 1-800-540-6322 | Sanctions questions, blocking reports |
| FBI IC3 | https://www.ic3.gov/ | Cyber crime reporting |
| State regulators | Varies by state | Money transmitter licensing |
