# Minted mUSD Protocol — Institutional Security Audit Report

**Date:** 2026-02-14
**Auditors:** 5-agent team (Solidity, DAML, TypeScript, Infrastructure, Cross-Chain Bridge)
**Scope:** Full codebase — 26 Solidity contracts, 18 DAML modules, 28 TypeScript files, K8s/CI/CD infra, end-to-end bridge flows
**Purpose:** Pre-handoff institutional-grade assessment for formal audit engagement

---

## Composite Score: 59 / 100

| Domain | Findings | Crit | High | Med | Low | Info | Score | Verdict |
|--------|----------|------|------|-----|-----|------|-------|---------|
| **Solidity** | 21 | 0 | 0 | 5 | 8 | 8 | **87/100** | Conditionally Ready |
| **DAML** | 29 | 3 | 6 | 9 | 6 | 5 | **62/100** | Not Ready |
| **TypeScript** | 15 | 0 | 0 | 4 | 6 | 5 | **82/100** | Conditionally Ready |
| **Infrastructure** | 28 | 0 | 4 | 13 | 8 | 3 | **74/100** | Conditionally Ready |
| **Bridge (Cross-Layer)** | 23 | 3 | 4 | 7 | 5 | 4 | **28/100** | Not Ready |
| **TOTAL** | **116** | **6** | **14** | **38** | **33** | **25** | | |

*Composite weighted: Solidity 25%, DAML 20%, TypeScript 15%, Infra 15%, Bridge 25%*

---

## Severity Distribution

| Severity | Count |
|----------|-------|
| CRITICAL | 6 |
| HIGH | 14 |
| MEDIUM | 38 |
| LOW | 33 |
| INFORMATIONAL | 25 |
| **TOTAL** | **116** |

---

## CRITICAL Findings (6) — Must Fix Before Handoff

### Bridge Critical (3) — Canton-to-Ethereum Flow Is Non-Functional

| ID | Title | Root Cause |
|----|-------|------------|
| **BRIDGE-C-01** | ValidatorSignature template missing from V3 — relay cannot fetch ECDSA signatures | V3 DAML stores only Party IDs in `collectedSignatures : Set.Set Party`, discards ECDSA bytes |
| **BRIDGE-C-02** | Choice name mismatch — validators call `"ProvideSignature"` but V3 defines `"Attestation_Sign"` | V3 refactor renamed choice, relay/validator code not updated |
| **BRIDGE-C-03** | V3 AttestationPayload missing `entropy` and `cantonStateHash` required by BLEBridgeV9 | DAML payload schema diverged from Solidity Attestation struct |

**Root cause analysis:** All three share a single root cause — the V3 DAML module was refactored without propagating changes to the TypeScript relay and validator services. The three layers (DAML, TypeScript, Solidity) have never been integration-tested end-to-end.

### DAML Critical (3)

| ID | Title | Impact |
|----|-------|--------|
| **DAML-C-01** | V3 CantonDirectMint archives dual-signatory tokens without full authorization context | Runtime failure if operator != issuer, bricking all mint operations |
| **DAML-C-02** | Bridge_ReceiveFromEthereum mints mUSD without supply cap check | Unbounded minting via bridge-in bypasses MUSDSupplyService |
| **DAML-C-03** | CantonLending/LoopStrategy archive tokens assuming operator == issuer without validation | All deposit operations fail if invariant is violated |

---

## HIGH Findings (14)

### Solidity (0 High)
No high-severity findings. Significant improvement from prior audit.

### DAML (6 High)

| ID | Title |
|----|-------|
| DAML-H-01 | MUSDSupplyService never decremented on Vault_Repay or Liquidation — supply cap will eventually brick lending |
| DAML-H-02 | Vault Liquidation conflates accrued interest into principal — silent switch to compound interest |
| DAML-H-03 | CantonSMUSD Withdrawal mints mUSD without supply cap check |
| DAML-H-04 | CantonStakingService SyncYield (legacy) has no share price movement bounds |
| DAML-H-05 | CantonLending Borrow skips global supply cap when DirectMint not deployed |
| DAML-H-06 | CantonBoostPool Deposit archives and recreates sMUSD, breaking external references |

### Infrastructure (4 High)

| ID | Title |
|----|-------|
| INFRA-H-01 | Canton image digests are placeholders — cannot deploy |
| INFRA-H-02 | Mythril symbolic analysis is continue-on-error — security findings advisory only |
| INFRA-H-03 | Certora formal verification is continue-on-error — invariant violations advisory only |
| INFRA-H-04 | No cross-region or offsite backup replication — total data loss risk |

### Bridge (4 High)

| ID | Title |
|----|-------|
| BRIDGE-H-01 | BFT formula ignores stored requiredSignatures field, threshold asymmetry with Solidity |
| BRIDGE-H-02 | User-supplied nonce in MUSD_BridgeToEthereum allows collision and permanent fund loss |
| BRIDGE-H-03 | Relay does not exercise Attestation_Complete — stale DAML state and retry storms |
| BRIDGE-H-04 | V1/V2 validator hash scheme incompatibility silently reduces effective security |

---

## MEDIUM Findings Summary (38)

| Domain | Count | Key Themes |
|--------|-------|------------|
| Solidity (5) | 5 | TIMELOCK_ROLE self-admin gaps on MorphoLoopStrategy + PendleMarketSelector, inconsistent unpause access control, TreasuryReceiver router auth not timelocked, SMUSDPriceAdapter admin functions not timelocked |
| DAML (9) | 9 | Bridge-in attestation lacks self-attestation, Loop_Close negative exit fees, WithdrawSMUSD hardcodes entrySharePrice, AdjustLeverage skips interest accrual, BoostPool missing pause/governance checks, emergency price update bypass, deprecated BLEProtocol still deployable, dual template ecosystems |
| TypeScript (4) | 4 | parseFloat() on Canton ledger financial values, KMS production guard inconsistency, Number(gasPrice) truncation, Number(deployable)/1e6 precision |
| Infrastructure (13) | 13 | PostgreSQL SSL mode require (not verify-full), no server-side TLS, local-only backups, NGINX probe IP restriction, no connection pooling, non-functional monitoring (wrong label selectors + missing postgres-exporter), coverage continue-on-error, Slither detector exclusions, single-replica PostgreSQL, no incident runbook, no key rotation policy, self-signed shared-key certs |
| Bridge (7) | 7 | Relay threshold uses party count not ECDSA count, no bridge pause check on outbound, unbounded signature array, permissionless processAttestation, fragile timestamp derivation, dual rate limiting conflict, divergent payload schemas |

---

## Domain Deep-Dive Scores

### Solidity: 87/100 — CONDITIONALLY READY

| Category | Score | Notes |
|----------|-------|-------|
| Access Control | 80/100 | 5 MEDIUM findings all around TIMELOCK_ROLE self-admin gaps — 8/10 upgradeable contracts allow DEFAULT_ADMIN to bypass 48h timelock |
| Token/Financial Safety | 92/100 | Exemplary: per-operation approvals, SafeERC20, supply caps, correct decimal handling |
| Reentrancy & CEI | 97/100 | Consistent nonReentrant + CEI on all state-changing functions. repay() intentionally omits whenNotPaused |
| Bridge & Cross-chain | 82/100 | Sound Wormhole integration, rate-limited Canton sync. Router auth not timelocked |
| DeFi Protection | 90/100 | 6-layer donation attack defense, oracle circuit breaker, interest routing resilience, bad debt socialization |
| Code Quality | 91/100 | Clean NatSpec, custom errors, storage gaps, ERC-7201 namespaced storage |

**Conditions for READY:**
1. Add `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` to all 8 upgradeable contracts missing it
2. Gate TreasuryReceiver `authorizeRouter()`/`revokeRouter()` with `onlyTimelock`
3. Gate SMUSDPriceAdapter admin functions with timelock

### DAML: 62/100 — NOT READY

| Category | Score | Notes |
|----------|-------|-------|
| Authorization | 12/20 | Raw archive calls assume operator==issuer without validation (CRIT-01, CRIT-03) |
| Financial Logic | 11/20 | Supply cap bypass paths (bridge-in, smUSD withdrawal), interest conflation in liquidation |
| Bridge Security | 15/20 | BFT formula correct but ignores stored requiredSignatures; no pause check on outbound |
| Template Design | 10/15 | Good ensure clauses and propose-accept, but dual template ecosystems create confusion |
| Vault/Lending | 9/15 | Supply service never decremented, borrow skips cap when DirectMint absent |
| Governance | 8/10 | Multi-sig with timelocks, ConsumeProof replay prevention, scoped actions |

**Blockers:**
1. Fix 3 CRITICAL archive-authorization issues
2. Route all minting paths through MUSDSupplyService
3. Add SupplyService_VaultBurn for repay/liquidation decrements

### TypeScript: 82/100 — CONDITIONALLY READY

| Category | Score | Notes |
|----------|-------|-------|
| Secrets & Key Mgmt | 18/20 | Docker secrets, KMS integration, key scrubbing. One inconsistent production guard |
| Network Security | 14/15 | TLS enforcement with runtime watchdog on all but 1 service |
| Financial Precision | 20/25 | BigInt dominant but parseFloat on Canton ledger data and Number() on gas prices |
| Bridge Relay | 19/20 | Pre-flight simulation, chain ID validation, signature pre-verification, rate limiting |
| Validator Security | 10/10 | KMS-only signing, anomaly detection, rate limiting, template allowlisting |
| Bot Security | 4/5 | Flashbots MEV protection, bounded approvals. Hardcoded ETH prices |
| Config | 5/5 | Env-based validation, no dotenv, address validation at startup |

**Conditions for READY:**
1. Replace parseFloat() with direct string-to-BigInt parsing in lending-keeper.ts
2. Align KMS production guard (throw, not warn) in kms-ethereum-signer.ts
3. Replace Number(gasPrice) with BigInt comparisons
4. Replace Number(deployable)/1e6 with ethers.formatUnits

### Infrastructure: 74/100 — CONDITIONALLY READY

| Category | Score | Notes |
|----------|-------|-------|
| K8s Security | 22/25 | Best-in-class: restricted PSS, full SecurityContext lockdown, default-deny NetworkPolicy, zero-permission RBAC |
| Database | 13/20 | Encrypted at rest, file-mounted credentials. Missing server TLS, connection pooling, HA |
| Monitoring | 9/15 | 19 alert rules defined but ALL non-functional — label selectors don't match, no postgres-exporter |
| CI/CD | 11/15 | 6-layer security pipeline, SHA-pinned actions. Mythril/Certora advisory-only |
| Disaster Recovery | 9/15 | Daily encrypted backups with integrity check. No offsite replication, single-replica DB |
| Compliance | 10/10 | External Secrets Operator, no hardcoded secrets, WAF integration, shielded GKE nodes |

**Blockers:**
1. Replace Canton image placeholder digests
2. Fix ServiceMonitor label selectors (monitoring is 100% non-functional)
3. Deploy postgres-exporter sidecar
4. Make Mythril/Certora blocking in CI
5. Implement offsite backup replication

### Bridge: 28/100 — NOT READY

| Layer | Score | Status |
|-------|-------|--------|
| Solidity (BLEBridgeV9) | 85/100 | SECURE — well-engineered as standalone |
| DAML (V3 bridge) | 75/100 | AT-RISK — supply cap bypass, no pause check, user-controlled nonce |
| Relay (TypeScript) | 70/100 | SECURE — strong security properties, just incompatible with V3 |
| Cross-layer integration | 5/100 | **BROKEN** — three independently fatal API mismatches |

**End-to-end flow status:**
```
Canton → Ethereum: BROKEN (3 independent critical failures)
  Step 1 (User burns mUSD):     AT-RISK  (no pause check, user nonce)
  Step 2 (Validators sign):     BROKEN   (wrong choice name)
  Step 3 (Relay reads sigs):    BROKEN   (missing template)
  Step 4 (Ethereum submission): BROKEN   (missing entropy/stateHash)

Ethereum → Canton: AT-RISK
  Step 1 (Initiate on ETH):     AT-RISK  (no direct bridgeToCanton function)
  Step 2 (Validators attest):   AT-RISK  (same signing issues)
  Step 3 (Canton receives):     SECURE   (proper pause/BFT/nonce checks)
```

---

## What's Working Well

### Solidity Strengths (87/100)
- Zero critical or high findings — major improvement from prior audits
- Per-operation token approvals throughout (no infinite approvals)
- 6-layer donation attack defense on ERC-4626 vault
- Oracle circuit breaker with safe/unsafe dual path
- Interest routing resilience prevents supply cap from bricking lending
- High-water mark fee accrual prevents double-charging
- Cooldown propagation on transfer prevents withdrawal timing attacks

### DAML Strengths
- Propose-accept pattern consistently applied across all 6 token types
- BFT `ceil(2n/3)` supermajority correctly implemented
- ConsumeProof governance replay prevention with module scoping
- Virtual shares prevent first-depositor inflation attacks
- UserPrivacySettings with clean opt-in transparency model

### TypeScript Strengths (82/100)
- KMS-only signing in production (private key never in Node.js memory)
- 20% value-jump anomaly detection breaker on validators
- Per-asset Canton state verification with $100K tolerance cap
- Rate limiting (50 sigs/hour) on validator nodes
- Bridge contract code hash verification
- Pre-flight tx simulation before Ethereum submission

### Infrastructure Strengths (74/100)
- Pod Security Standards at `restricted` enforce level — exemplary
- All 10 GitHub Actions SHA-pinned — no tag mutation risk
- 6-layer security scanning pipeline (Slither, Mythril, Certora, Trivy, gitleaks, npm audit)
- External Secrets Operator with AWS Secrets Manager
- Default-deny NetworkPolicy with per-workload allow rules
- Docker secrets for all credentials, zero in version control

---

## Remediation Roadmap

### Phase 1: Bridge Integration (Weeks 1-3) — BLOCKING
1. Fix BRIDGE-C-01: Store ECDSA signatures in V3 DAML (Map Party Text or ValidatorSignature template)
2. Fix BRIDGE-C-02: Update validator nodes to use `"Attestation_Sign"` choice name
3. Fix BRIDGE-C-03: Add `entropy` + `cantonStateHash` to V3 AttestationPayload
4. Fix BRIDGE-H-02: Replace user-supplied nonce with server-assigned
5. Fix BRIDGE-H-03: Relay must exercise Attestation_Complete after bridging
6. Build end-to-end integration test suite across all 3 layers

### Phase 2: DAML Critical/High (Weeks 2-4)
7. Fix DAML-C-01/C-03: Validate operator==issuer before archive, or use propose-accept
8. Fix DAML-C-02: Route bridge-in minting through MUSDSupplyService
9. Fix DAML-H-01: Add SupplyService_VaultBurn for repay/liquidation
10. Fix DAML-H-02: Split interest from principal after liquidation
11. Fix DAML-H-03: Route smUSD withdrawal minting through supply service

### Phase 3: Solidity + TypeScript (Weeks 2-3)
12. Add `_setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE)` to 8 upgradeable contracts
13. Gate TreasuryReceiver router auth + SMUSDPriceAdapter admin with timelock
14. Fix TypeScript precision issues (parseFloat, Number() conversions)
15. Remove deprecated V1 validator node

### Phase 4: Infrastructure (Weeks 3-5)
16. Replace Canton image placeholder digests
17. Fix ServiceMonitor selectors + deploy postgres-exporter
18. Make Mythril/Certora blocking in CI
19. Implement offsite backup replication to S3/GCS
20. Configure PostgreSQL server-side TLS with verify-full

### Phase 5: Hardening (Weeks 5-7)
21. Fix remaining MEDIUM findings across all domains
22. Incident response runbooks + key rotation policy
23. PostgreSQL HA with automated failover
24. Centralized log aggregation
25. Re-audit targeting composite score 85+

**Estimated total remediation: 6-8 weeks**
**Target composite score for formal audit handoff: 85/100** (currently 59/100)

---

## Audit Methodology

Each domain was audited by a specialized reviewer reading every relevant file in the codebase (not sampling). The reviewers followed standardized checklists covering:

- **Solidity**: OWASP Smart Contract Top 10, ERC compliance, access control, reentrancy, flash loan vectors, oracle manipulation, upgrade safety
- **DAML**: Canton authorization model, signatory analysis, propose-accept compliance, financial precision, bridge attestation lifecycle
- **TypeScript**: Secret management, TLS enforcement, BigInt precision, bridge relay security, validator isolation, MEV protection
- **Infrastructure**: CIS Kubernetes Benchmark, SOC2 controls, backup/DR, CI/CD security gates, supply chain integrity
- **Bridge**: End-to-end flow tracing across all 3 layers, message integrity, threshold security, replay protection, value conservation
