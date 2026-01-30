# Minted mUSD Canton Protocol - Institutional-Grade Security Audit

**Audit Date:** 2026-01-30
**Repository:** https://github.com/luthatdude/Minted-mUSD-Canton
**Auditor:** Automated Institutional Audit (Claude Opus 4.5)
**Scope:** Full-stack audit - Solidity, Daml, TypeScript, Infrastructure, CI/CD

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Inventory & Statistics](#3-inventory--statistics)
4. [Solidity Smart Contract Findings](#4-solidity-smart-contract-findings)
5. [Daml Smart Contract Findings](#5-daml-smart-contract-findings)
6. [Frontend & TypeScript Findings](#6-frontend--typescript-findings)
7. [Relay/Bridge Service Findings](#7-relaybridge-service-findings)
8. [Dependencies & Supply Chain](#8-dependencies--supply-chain)
9. [Infrastructure & Deployment](#9-infrastructure--deployment)
10. [CI/CD Pipeline](#10-cicd-pipeline)
11. [Consolidated Findings Matrix](#11-consolidated-findings-matrix)
12. [Remediation Roadmap](#12-remediation-roadmap)
13. [Conclusion](#13-conclusion)

---

## 1. Executive Summary

The Minted mUSD Protocol is a dual-chain institutional stablecoin system spanning Canton Network (Daml) for compliance/accounting and Ethereum (Solidity) for DeFi/yield execution, bridged by a multi-signature relay service with AWS KMS signing.

### Risk Rating: **MEDIUM** (LOW after critical remediations)

| Severity | Count | Category |
|----------|-------|----------|
| **CRITICAL** | 8 | Smart contract logic, compliance bypass, token exposure |
| **HIGH** | 14 | Authorization, rate limits, dependencies, centralization |
| **MEDIUM** | 16 | Design issues, edge cases, test gaps |
| **LOW** | 10 | Hardcoded values, minor enhancements |
| **INFO** | 5 | Best practice recommendations |

### Key Strengths
- 98 security fixes already applied across Daml contracts (D-01, D-02, D-03 series)
- 30+ documented security fixes in relay/bridge code (FIX H-*, M-*, T-* series)
- Multi-layer rate limiting (NGINX, smart contracts, services)
- Docker secrets management with env var fallback
- Kubernetes Pod Security Standards (restricted)
- Default-deny NetworkPolicy
- Comprehensive CI/CD with Slither, Trivy, kubeconform, npm audit
- 80+ automated tests (60 Hardhat + 20 Daml)

### Key Weaknesses
- Critical compliance bypass (frozen parties can mint)
- Operator centralization (blocks redemptions)
- Frontend Canton token exposure via NEXT_PUBLIC_ prefix
- Outdated dependencies with known CVEs (Next.js, AWS SDK, ws)
- Nonconsuming archive bugs in MUSD_Protocol.daml
- Missing rate limits on vault borrowing

---

## 2. Architecture Overview

```
+-------------------------------------------------------------------+
|                    CANTON NETWORK (DAML)                           |
|                                                                   |
|  CantonDirectMintService -> CantonMUSD (1:1 USDC)               |
|  CantonStakingService   -> CantonSMUSD (yield shares)            |
|  ComplianceRegistry     -> Blacklist/Freeze enforcement          |
|  Vault CDPs             -> Collateral, Borrow, Liquidate         |
|  BridgeOutRequest       -> Triggers cross-chain movement         |
+-------------------------------------------------------------------+
                         |                    ^
            3-of-5 Attestation          Yield/Supply Sync
                         v                    |
+-------------------------------------------------------------------+
|             RELAY SERVICE (TypeScript + Docker)                    |
|                                                                   |
|  relay-service.ts     : Canton watcher -> ETH submitter          |
|  validator-node-v2.ts : Canton Asset API -> AWS KMS signing      |
|  signer.ts            : DER -> RSV conversion (40+ fixes)        |
+-------------------------------------------------------------------+
                         |                    ^
                         v                    |
+-------------------------------------------------------------------+
|                   ETHEREUM (Solidity 0.8.26)                      |
|                                                                   |
|  BLEBridgeV9      : Supply cap model, 24h rate limiting         |
|  MUSD (ERC-20)    : Role-based mint/burn, blacklist              |
|  SMUSD (ERC-4626) : Staking vault with cooldown                 |
|  DirectMint       : 1:1 USDC <-> mUSD conversion                |
|  Treasury/V2      : Reserve pool with yield strategies           |
|  CollateralVault  : Multi-token collateral management            |
|  BorrowModule     : mUSD borrowing with interest                 |
|  LiquidationEngine: Close factor liquidation                     |
|  PriceOracle      : Chainlink feeds with staleness checks        |
+-------------------------------------------------------------------+

Global Invariant: Canton mUSD + Ethereum mUSD = Total Supply (conserved)
```

### Rate Limiting Defense-in-Depth

| Layer | Mechanism | Default Limit |
|-------|-----------|---------------|
| NGINX | Per-IP + global circuit breaker | 10r/s read, 2r/s write; 500r/s global |
| BLEBridgeV9 | 24h rolling window supply cap | dailyCapIncreaseLimit (50M default) |
| CantonDirectMintService | 24h rolling window net mint | dailyMintLimit |
| DirectMintService | 24h rolling window net mint | dailyMintLimit |

---

## 3. Inventory & Statistics

| Category | Count |
|----------|-------|
| Solidity Contracts | 17 (13 core + 3 mocks + 1 interface) |
| Daml Templates | 17 files, 60+ templates |
| Frontend Pages | 7 |
| Frontend Components | 14 (7 core + 7 Canton) |
| Frontend Hooks | 5 |
| Contract ABIs | 10 |
| Relay Service Files | 5 source + 5 config |
| Hardhat Tests | 60 (27 bridge + 33 treasury) |
| Daml Tests | 20 (11 protocol + 9 direct mint) |
| K8s Manifests | 9 |
| CI/CD Jobs | 7 |
| **Total Source Files** | **127+** |
| **Estimated Lines of Code** | **10,000+** |

### Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Smart Contracts | Solidity | 0.8.26 |
| Ledger Contracts | Daml | SDK 2.10.3 |
| Frontend | Next.js / React / Tailwind | 14.1.0 / 18.2.0 / 3.4.0 |
| Bridge/Relay | TypeScript / Node.js | 5.3.3 / 20.x |
| Web3 | ethers.js | 6.9.0 |
| Cloud Signing | AWS KMS | SDK 3.398.0 |
| Container | Docker / Docker Compose | Alpine-based |
| Orchestration | Kubernetes | 1.24+ |
| Database | PostgreSQL | 16.4 |
| API Gateway | NGINX | TLS 1.2/1.3 |
| Security Scanning | Slither, Trivy, npm audit | CI/CD integrated |

---

## 4. Solidity Smart Contract Findings

### 4.1 Contracts Analyzed

| Contract | Lines | Purpose |
|----------|-------|---------|
| MUSD.sol | ~70 | ERC-20 with role-based mint/burn, supply cap, blacklist |
| SMUSD.sol | ~100 | ERC-4626 vault with cooldown and yield accrual |
| DirectMint.sol / V2 | ~150 | 1:1 USDC-mUSD with fees, limits, pause |
| BLEBridgeV8.sol | ~300 | Deprecated bridge (daily mint limit) |
| BLEBridgeV9.sol | ~400 | Current bridge (supply cap model, 24h rate limit, multi-sig) |
| Treasury.sol / V2 | ~200 | Reserve pool with strategy deployment |
| CollateralVault.sol | ~200 | Multi-token collateral with per-token factors |
| BorrowModule.sol | ~200 | mUSD borrowing with interest accrual |
| LiquidationEngine.sol | ~200 | Close factor liquidation with penalties |
| PriceOracle.sol | ~150 | Chainlink feeds with staleness checks |
| PendleMarketSelector.sol | ~150 | Yield strategy selection |

### 4.2 Security Posture

**Strengths:**
- Solidity 0.8.26 (built-in overflow protection)
- OpenZeppelin v5.0.0 (latest security patterns)
- ReentrancyGuardUpgradeable on vulnerable functions
- Role-based access control (BRIDGE_ROLE, CAP_MANAGER_ROLE, EMERGENCY_ROLE)
- Slither static analysis in CI/CD with SARIF reporting
- 60 Hardhat tests covering bridge, treasury, and edge cases

**Findings:**

| ID | Severity | Finding | Contract |
|----|----------|---------|----------|
| SOL-01 | HIGH | BLEBridgeV9 storage layout INCOMPATIBLE with V8; migration contract required | BLEBridgeV9.sol |
| SOL-02 | MEDIUM | Optimizer runs=200 may not be optimal for frequently-called functions | hardhat.config.ts |
| SOL-03 | LOW | No formal verification or symbolic execution evidence | All contracts |

---

## 5. Daml Smart Contract Findings

### 5.1 CRITICAL Findings

| ID | File | Line | Finding | Impact |
|----|------|------|---------|--------|
| DAML-C01 | Compliance.daml | 102 | **Frozen parties can mint** - ValidateMint does not check frozen set | AML/compliance bypass |
| DAML-C02 | MUSD_Protocol.daml | 247, 265 | **Nonconsuming choices call archive** - Stake/Unstake are nonconsuming but try to archive contracts; will fail at runtime | Protocol broken |
| DAML-C03 | CantonDirectMint.daml | 476 | **Operator blocks redemptions** - Redemption_Fulfill requires operator+user dual signature; user cannot exit without operator | Funds locked |
| DAML-C04 | CantonSMUSD.daml | 183 | **Yield manipulation** - SyncYield allows operator to arbitrarily increase totalAssets with no oracle validation | Operator enrichment |
| DAML-C05 | MintedProtocol.daml | 37 | **Direct asset transfer** - Asset_Transfer changes owner directly without proposal pattern; allows unsolicited assignment | Airdrop attacks |
| DAML-C06 | SafeAsset.daml | 52 | **Archive choice missing** - Tries to exercise non-existent Archive choice; file does not compile | Build failure |
| DAML-C07 | MintedProtocolV2Fixed.daml | 612 | **No rate limit on vault borrow** - Vault_Borrow has no per-user rate limiting; combined with leverage loops, enables rapid supply inflation | Supply inflation |

### 5.2 HIGH Findings

| ID | File | Line | Finding | Impact |
|----|------|------|---------|--------|
| DAML-H01 | BLEBridgeProtocol.daml | - | Unbounded signature collection in Finalize choices; no max array size | DoS via memory |
| DAML-H02 | CantonDirectMint.daml | 321 | Operator can manipulate lastRateLimitReset to bypass rate limits | Rate limit bypass |
| DAML-H03 | CantonDirectMint.daml | 303 | Compliance check silently skipped when complianceRegistryCid=None | Compliance bypass |
| DAML-H04 | BLEProtocol.daml | 133 | Supermajority formula impossible for 1-2 validators: `(2+1)/2+1=3` sigs needed from 2 validators | Protocol deadlock |
| DAML-H05 | Compliance.daml | 99 | ValidateMint requires BOTH regulator AND operator (deadlock if either offline) | Compliance deadlock |
| DAML-H06 | MintedMUSD.daml | - | No contract key on IssuerRole allows multiple instances bypassing supply cap | Supply cap bypass |
| DAML-H07 | MintedMUSD.daml | 80 | RedemptionRequest deadlock - user cannot cancel if provider offline | Funds locked |
| DAML-H08 | BLEBridgeProtocol.daml | - | Nonce not globally unique; replay possible across attestation types | Bridge replay |

### 5.3 MEDIUM Findings

| ID | File | Finding |
|----|------|---------|
| DAML-M01 | BLEBridgeProtocol.daml | TOCTOU: Positions not locked during attestation (mitigated by final re-check) |
| DAML-M02 | Compliance.daml | No blacklist expiry; permanent bans without review mechanism |
| DAML-M03 | SecureAsset.daml, MintedMUSD.daml | Observer reset on transfer loses audit trail |
| DAML-M04 | InstitutionalAssetV4.daml | Emergency transfer bypasses asset locks |
| DAML-M05 | CantonDirectMint.daml | Fee accumulation unbounded (no withdrawal/cap) |
| DAML-M06 | MintedProtocolV2Fixed.daml | Oracle staleness only checked at read; may stale between check and liquidation |
| DAML-M07 | BLEProtocol.daml | No mechanism to update validator group after creation |
| DAML-M08 | MUSD_Protocol.daml | Max yield hardcoded at 50% annual / 200% total; no governance |
| DAML-M09 | MintedProtocolV2Fixed.daml | Liquidator incentive misalignment with close factor |

### 5.4 Authorization & Access Control Matrix

| Template | Choice | Controller | Centralization Risk |
|----------|--------|-----------|---------------------|
| CantonDirectMintService | DirectMint_Mint | user | LOW |
| CantonDirectMintService | DirectMint_Redeem | user | LOW |
| RedemptionRequest | Redemption_Fulfill | operator | **HIGH** - blocks user exit |
| ComplianceRegistry | ValidateMint | regulator+operator | **MEDIUM** - dual-sig required |
| CantonStakingService | SyncYield | operator | **HIGH** - unvalidated yield |
| IssuerRole | IssuerRole_Mint | issuer | MEDIUM |
| Vault | Vault_Liquidate | liquidator | LOW |
| AttestationRequest | ProvideSignature | validator | LOW |
| AttestationRequest | FinalizeAttestation | aggregator | MEDIUM |

### 5.5 Test Coverage Gaps

Missing test coverage for:
- Compliance blacklist blocking mint
- Frozen parties attempting to mint
- Rate limit exceeded scenarios
- Supply cap exceeded causing mint failure
- Bridge attestation replay (nonce reuse)
- Vault liquidation with stale oracle price
- Leverage loop reentrancy
- Observer reset on transfer
- Emergency transfer bypassing locks
- Validator group size boundary (>100)
- Supermajority with <3 validators

---

## 6. Frontend & TypeScript Findings

### 6.1 Security Assessment: LOW RISK

**No critical frontend vulnerabilities detected.**

| Check | Status |
|-------|--------|
| XSS (dangerouslySetInnerHTML) | NOT FOUND |
| eval() / Function() | NOT FOUND |
| innerHTML assignment | NOT FOUND |
| document.write() | NOT FOUND |
| Hardcoded secrets | NOT FOUND |
| CSRF applicability | N/A (Web3 architecture) |
| React JSX escaping | Active (default) |

### 6.2 Findings

| ID | Severity | Finding | File |
|----|----------|---------|------|
| FE-01 | **CRITICAL** | `NEXT_PUBLIC_CANTON_TOKEN` exposed in client-side JavaScript; visible in browser DevTools | frontend/src/lib/config.ts:19 |
| FE-02 | MEDIUM | Borrower address input lacks `ethers.isAddress()` validation | LiquidationsPage.tsx:75 |
| FE-03 | MEDIUM | No request timeout on Canton API calls (backend has 30s timeout) | useCanton.ts |
| FE-04 | MEDIUM | No request rate limiting/deduplication for rapid clicks | useCanton.ts |
| FE-05 | LOW | Missing Content Security Policy (CSP) headers | next.config.js |
| FE-06 | LOW | Missing X-Frame-Options, X-Content-Type-Options headers | next.config.js |

### 6.3 Positive Findings

- Proper ethers.js decimal handling (parseUnits/formatUnits)
- React hooks pattern with proper cleanup (useEffect timers)
- Promise.allSettled for partial failure tolerance
- Safe error message extraction (err.reason || err.shortMessage || err.message)
- Token stored in useRef (prevents unnecessary re-renders)
- Memoized contract instances (useMemo)

---

## 7. Relay/Bridge Service Findings

### 7.1 Security Assessment: LOW RISK

**30+ documented security fixes applied.**

| Fix Series | Count | Coverage |
|------------|-------|----------|
| H-* (High) | 16 | TLS, validation, precision, auth, bounds |
| M-* (Medium) | 23 | Signatures, imports, caching, binding |
| T-* (Testing) | 4 | Input validation, buffer safety |
| I-* (Infrastructure) | 1 | Docker secrets |
| 5C-* (5-Star Compliance) | 3 | Health, timeout, heartbeat |

### 7.2 Key Security Features

| Feature | Implementation | Status |
|---------|---------------|--------|
| Secret management | Docker /run/secrets/ with env fallback | Excellent |
| DER signature validation | 40+ checks (tag, length, padding, trailing bytes) | Excellent |
| RSV format validation | Strict v=27/28, hex-only, length checks | Excellent |
| Memory management | Bounded cache (10K) with 10% eviction | Excellent |
| TLS default | HTTPS/WSS by default (opt-out) | Excellent |
| Private key validation | Regex format check before wallet creation | Good |
| Unhandled rejection | process.exit(1) on unhandled promises | Good |

### 7.3 Minor Findings

| ID | Severity | Finding |
|----|----------|---------|
| RLY-01 | LOW | Health server binds to localhost (good) but port 8080 still exposed in Docker |
| RLY-02 | INFO | DER signature format validation could use stricter ASN.1 parsing library |

---

## 8. Dependencies & Supply Chain

### 8.1 Vulnerability Summary

| Package | Location | Current | Severity | CVE/Advisory |
|---------|----------|---------|----------|-------------|
| next | frontend | 14.1.0 | **HIGH** | GHSA-9g9p-9gw9-jx7f (Image Optimizer DoS) |
| next | frontend | 14.1.0 | **HIGH** | GHSA-h25m-26qc-wcjf (RSC deserialization DoS) |
| @aws-sdk/client-kms | relay | 3.398.0 | **HIGH** | Vulnerable @smithy transitive deps |
| ws (via ethers) | relay | 8.x | **HIGH** | DoS via many HTTP headers |
| @aws-sdk/credential-provider-* | relay | 3.363-3.398 | HIGH | Chain of @smithy vulnerabilities |

**Total:** 2 HIGH (frontend) + 11 (relay: 9 LOW + 2 HIGH)

### 8.2 Outdated Dependencies

| Package | Current | Latest | Risk |
|---------|---------|--------|------|
| Next.js | 14.1.0 | 16.x | Known CVEs |
| AWS SDK | 3.398.0 | 3.978.0+ | Known CVEs |
| ethers.js | 6.9.0 | 6.x | ws DoS |

### 8.3 Supply Chain Security

| Check | Status |
|-------|--------|
| package-lock.json present | Yes (root, frontend, relay) |
| npm ci used in CI | Yes |
| npm audit in CI | Yes (continue-on-error) |
| Trivy container scanning | Yes (CRITICAL/HIGH) |
| SBOM generation | Not implemented |
| Dependabot | Not configured |

---

## 9. Infrastructure & Deployment

### 9.1 Docker Security

| Check | Status | Details |
|-------|--------|---------|
| Multi-stage build | Yes | Builder + production stages |
| Non-root user | Yes | appuser:1001 |
| Read-only rootfs | Yes | `read_only: true` in compose |
| Resource limits | Yes | 512M memory, 1.0 CPU |
| No new privileges | Yes | `no-new-privileges: true` |
| Health checks | Yes | HTTP /health every 30s |
| Base image pinning | **NO** | Missing SHA256 digest |
| Cache cleaned | Yes | `npm cache clean --force` |

### 9.2 Kubernetes Security

| Check | Status | Details |
|-------|--------|---------|
| Pod Security Standards | Yes | `restricted` level |
| NetworkPolicy | Yes | Default-deny with explicit allows |
| Non-root containers | Yes | uid: 1000 |
| Read-only rootfs | Yes | securityContext |
| Resource limits | Yes | CPU/memory per pod |
| PodDisruptionBudgets | Yes | minAvailable: 1 |
| TLS termination | Yes | NGINX with TLS 1.2/1.3 |
| Rate limiting | Yes | NGINX per-IP + global |
| Secret templates | Yes | Must be filled at deploy time |
| Sealed secrets | **NO** | Recommended for production |

### 9.3 Network Security

| Component | Port | Exposure | Protection |
|-----------|------|----------|------------|
| Canton Node | 5011/5012 | Internal only | NetworkPolicy |
| PostgreSQL | 5432 | Internal only | NetworkPolicy |
| NGINX | 443/80 | LoadBalancer | TLS, rate limiting |
| JSON API | 7575 | Sidecar only | Localhost binding |
| Health Check | 8080 | Localhost only | Bind 127.0.0.1 |

---

## 10. CI/CD Pipeline

### 10.1 Pipeline Jobs

| Job | Tools | Blocks Deploy | Status |
|-----|-------|--------------|--------|
| Solidity compile + test | Hardhat 2.19.0 | **Yes** | Good |
| Solidity security | Slither 0.4.0 (SARIF) | No (continue-on-error) | Needs hardening |
| Daml build + test | DAML SDK 2.10.3 | **Yes** | Good |
| Relay typecheck | TypeScript 5.3.3 | No (continue-on-error) | Needs hardening |
| Docker build + scan | Trivy 0.28.0 | No (continue-on-error) | Needs hardening |
| K8s validation | kubeconform | No | Good |
| Dependency audit | npm audit + audit-ci | No (continue-on-error) | Needs hardening |

### 10.2 CI/CD Findings

| ID | Severity | Finding |
|----|----------|---------|
| CI-01 | MEDIUM | `continue-on-error: true` on security-critical jobs (audit, docker, slither) |
| CI-02 | MEDIUM | Relay TypeScript errors don't fail the build |
| CI-03 | LOW | No branch protection rules verified |
| CI-04 | LOW | No signed commits required |
| CI-05 | INFO | Consider adding Dependabot, SBOM generation, SLSA provenance |

---

## 11. Consolidated Findings Matrix

### CRITICAL (8 findings)

| ID | Component | Finding | Remediation |
|----|-----------|---------|-------------|
| DAML-C01 | Compliance.daml | Frozen parties can mint | Add frozen check to ValidateMint |
| DAML-C02 | MUSD_Protocol.daml | Nonconsuming archive bug (runtime failure) | Change Stake/Unstake to consuming |
| DAML-C03 | CantonDirectMint.daml | Operator blocks redemptions | Add user-initiated redemption path |
| DAML-C04 | CantonSMUSD.daml | Unvalidated yield manipulation | Validate SyncYield against attestation |
| DAML-C05 | MintedProtocol.daml | Direct asset transfer (no proposal) | Implement proposal pattern |
| DAML-C06 | SafeAsset.daml | Compilation error (missing choice) | Fix archive syntax |
| DAML-C07 | MintedProtocolV2Fixed.daml | No vault borrow rate limit | Add per-user rate limiting |
| FE-01 | config.ts | NEXT_PUBLIC_CANTON_TOKEN exposed | Implement backend proxy |

### HIGH (14 findings)

| ID | Component | Finding |
|----|-----------|---------|
| SOL-01 | BLEBridgeV9.sol | Incompatible storage layout with V8 |
| DAML-H01 | BLEBridgeProtocol.daml | Unbounded signature collection |
| DAML-H02 | CantonDirectMint.daml | Rate limit reset manipulation |
| DAML-H03 | CantonDirectMint.daml | Silent compliance skip |
| DAML-H04 | BLEProtocol.daml | Supermajority impossible for <3 validators |
| DAML-H05 | Compliance.daml | Dual-signature deadlock on validation |
| DAML-H06 | MintedMUSD.daml | Multiple IssuerRole instances |
| DAML-H07 | MintedMUSD.daml | RedemptionRequest deadlock |
| DAML-H08 | BLEBridgeProtocol.daml | Nonce not globally unique |
| DEP-01 | frontend/package.json | Next.js HIGH severity CVEs |
| DEP-02 | relay/package.json | AWS SDK transitive vulns |
| DEP-03 | relay/package.json | ws DoS vulnerability |
| DEP-04 | relay/Dockerfile | Base image not SHA256 pinned |
| CI-01 | ci.yml | Security jobs don't block builds |

### MEDIUM (16 findings)

| ID | Component | Finding |
|----|-----------|---------|
| DAML-M01 | BLEBridgeProtocol.daml | TOCTOU on position locking |
| DAML-M02 | Compliance.daml | No blacklist expiry |
| DAML-M03 | SecureAsset/MintedMUSD | Observer reset loses audit trail |
| DAML-M04 | InstitutionalAssetV4.daml | Emergency transfer bypasses locks |
| DAML-M05 | CantonDirectMint.daml | Unbounded fee accumulation |
| DAML-M06 | MintedProtocolV2Fixed.daml | Oracle staleness gap |
| DAML-M07 | BLEProtocol.daml | No validator group update mechanism |
| DAML-M08 | MUSD_Protocol.daml | Hardcoded yield caps |
| DAML-M09 | MintedProtocolV2Fixed.daml | Liquidator incentive misalignment |
| FE-02 | LiquidationsPage.tsx | Missing address validation |
| FE-03 | useCanton.ts | No request timeout |
| FE-04 | useCanton.ts | No request deduplication |
| FE-05 | next.config.js | Missing CSP headers |
| FE-06 | next.config.js | Missing security headers |
| CI-02 | ci.yml | TypeScript errors ignored |
| SOL-02 | hardhat.config.ts | Optimizer runs not tuned |

---

## 12. Remediation Roadmap

### Phase 1: CRITICAL (Immediate - Before any deployment)

1. **DAML-C01**: Add `assertMsg "MINTER_FROZEN" (not (Set.member minter frozen))` to Compliance.ValidateMint
2. **DAML-C02**: Change Stake/Unstake to consuming choices in MUSD_Protocol.daml
3. **DAML-C03**: Implement timeout-based user-initiated redemption without operator
4. **DAML-C04**: Validate SyncYield amount against YieldAttestation oracle data
5. **DAML-C05**: Replace direct transfer with proposal pattern in MintedProtocol.daml
6. **DAML-C06**: Fix archive syntax in SafeAsset.daml
7. **DAML-C07**: Add per-user daily borrow rate limit to Vault_Borrow
8. **FE-01**: Remove NEXT_PUBLIC_CANTON_TOKEN; implement backend API proxy

### Phase 2: HIGH (Before production deployment)

1. **DEP-01**: Update Next.js to latest patched version
2. **DEP-02**: Update @aws-sdk/client-kms to ^3.600.0+
3. **DEP-03**: Update ws via ethers dependency chain
4. **DEP-04**: Pin Docker base images with SHA256 digest
5. **DAML-H01**: Cap signature collection at 100 in Finalize choices
6. **DAML-H02**: Remove operator control of rate limit reset timestamp
7. **DAML-H03**: Make compliance check mandatory (fail if None)
8. **DAML-H04**: Enforce minimum 3 validators in supermajority calculation
9. **DAML-H05**: Allow regulator-only compliance validation (OR instead of AND)
10. **DAML-H06**: Add contract key to IssuerRole preventing duplicates
11. **DAML-H07**: Add timeout-based cancellation to RedemptionRequest
12. **DAML-H08**: Implement global nonce registry for bridge attestations
13. **SOL-01**: Create V8-to-V9 storage migration contract
14. **CI-01**: Remove continue-on-error from security-critical CI jobs

### Phase 3: MEDIUM (Next sprint)

1. Add security headers to Next.js configuration
2. Add request timeouts and deduplication to frontend Canton calls
3. Add borrower address validation in LiquidationsPage
4. Implement blacklist expiry with periodic review
5. Add observer-append-only pattern for audit trail
6. Implement validator group update mechanism
7. Add oracle heartbeat monitoring
8. Tune optimizer runs for gas efficiency
9. Expand Daml test coverage for identified gaps

### Phase 4: Enhancements (Ongoing)

1. Configure Dependabot for automated dependency updates
2. Implement SBOM generation in CI/CD
3. Add SLSA provenance for build artifacts
4. Implement External Secrets Operator for Kubernetes
5. Add formal verification for critical Solidity functions
6. Add coverage badges and reporting

---

## 13. Conclusion

The Minted mUSD Canton Protocol demonstrates **professional-grade engineering** with extensive security hardening (128+ documented fixes), comprehensive testing (80+ tests), and defense-in-depth architecture spanning smart contracts, relay infrastructure, and deployment.

**The codebase is production-capable after addressing the 8 CRITICAL and 14 HIGH findings identified in this audit.** The majority of findings are in Daml contract logic (authorization patterns, compliance enforcement) and dependency management rather than fundamental architectural flaws.

### Final Rating

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture | **A** | Dual-chain with relay bridge is well-designed |
| Solidity Security | **A-** | OpenZeppelin v5, reentrancy guards, 60 tests |
| Daml Security | **B** | Strong foundations but critical auth/compliance gaps |
| Frontend Security | **B+** | No XSS/CSRF, but token exposure issue |
| Infrastructure | **A** | Pod Security Standards, NetworkPolicy, Docker hardening |
| CI/CD | **B+** | Comprehensive but some jobs don't block deploys |
| Dependencies | **B-** | Known CVEs in Next.js, AWS SDK |
| Testing | **B** | 80+ tests but significant gap coverage |
| Documentation | **A** | 445-line README, inline fix documentation |

**Overall: B+ (upgradeable to A- with Phase 1+2 remediations)**

---

*This audit was conducted through static analysis of all source code, configuration files, deployment manifests, and dependency trees. It does not include dynamic testing, fuzzing, or formal verification. Findings should be validated through additional testing before remediation deployment.*
