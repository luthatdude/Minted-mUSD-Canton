# Minted mUSD Protocol — Comprehensive TypeScript Security Audit

**Date:** 2026-02-15  
**Auditor:** Automated Deep-Read Analysis  
**Scope:** All TypeScript/TSX/JS source across `relay/`, `bot/`, `frontend/`, `points/`, `scripts/`, `subgraph/`  
**Files Reviewed:** ~80 source files, ~15,000+ lines of TypeScript  
**Methodology:** Manual line-by-line static analysis against 10 security categories

---

## Executive Summary

The Minted mUSD Canton protocol's TypeScript layer demonstrates **strong security posture overall**, with evidence of extensive prior hardening (many audit-tag comments referencing INFRA-CRIT, BRIDGE-M, TS-H IDs). The codebase consistently enforces KMS signing in production, uses Docker secrets for sensitive values, validates secp256k1 keys, employs BigInt-native financial math, and applies per-transaction bounded approvals. Critical bridge relay infrastructure is particularly well-hardened.

Findings are concentrated in the **MEDIUM** and **LOW** categories — no actively exploitable critical vulnerabilities were identified in the TypeScript layer. The most impactful findings relate to CSP weaknesses in the frontend, a hardcoded ETH price in the liquidation bot, and weak randomness for referral code generation on the client side.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0     |
| HIGH     | 3     |
| MEDIUM   | 7     |
| LOW      | 8     |
| INFO     | 6     |
| **Total**| **24**|

---

## HIGH Severity

### TS-H-01 — Hardcoded ETH Price in Liquidation Bot Gas Estimation

| Field | Value |
|-------|-------|
| **File** | `bot/src/index.ts` ≈ line 470 |
| **Category** | Price Feeds / Hardcoded Values |
| **Description** | The `findOpportunities()` method in the liquidation bot uses a hardcoded `ETH_PRICE_USD = 2500` for gas cost estimation when evaluating whether a liquidation is profitable. If ETH price deviates significantly (e.g., rises to $5,000 or drops to $1,000), the bot will misjudge profitability — either executing unprofitable liquidations or skipping profitable ones. |
| **Impact** | Financial loss to bot operator if ETH price rises (gas costs underestimated); missed liquidations if ETH price drops (gas costs overestimated, leaving protocol positions unhealthy). |
| **Recommendation** | Fetch ETH price from the on-chain PriceOracle or CoinGecko (already used in `oracle-keeper.ts`) at bot startup and refresh periodically. The `oracle-keeper.ts` file already demonstrates the CoinGecko fetch pattern — reuse it. |

### TS-H-02 — CSP `unsafe-inline` for Scripts in Production

| Field | Value |
|-------|-------|
| **File** | `frontend/next.config.js` line 17 |
| **Category** | CSP Headers |
| **Description** | The Content Security Policy in production includes `script-src 'self' 'unsafe-inline'`. While `'unsafe-eval'` is correctly restricted to development only, `'unsafe-inline'` remains in production. This weakens XSS protections by allowing inline `<script>` tags and event handlers to execute. |
| **Impact** | If an attacker can inject HTML into the page (via DOM-based XSS, third-party script compromise, or wallet-injected content), inline scripts will execute without CSP blocking them. For a DeFi frontend handling wallet transactions, this is a significant risk vector. |
| **Recommendation** | Replace `'unsafe-inline'` with nonce-based CSP (`'nonce-<random>'`) generated per-request via Next.js middleware. Next.js 13+ supports `strict-dynamic` and nonce-based CSP natively. For Tailwind's `style-src 'unsafe-inline'` (which is necessary), keep that exception but tighten the script policy. |

### TS-H-03 — Weak Randomness for Client-Side Referral Codes

| Field | Value |
|-------|-------|
| **File** | `frontend/src/hooks/useReferral.ts` line 79 |
| **Category** | Cryptographic Practices |
| **Description** | The `generateCodeString()` function uses `Math.random()` to generate referral codes in the format `MNTD-XXXXXX`. `Math.random()` is not cryptographically secure — its output is predictable. An attacker who knows the browser's PRNG state could predict future codes. |
| **Impact** | Referral code squatting — an attacker could pre-generate valid codes before legitimate users, potentially claiming referral rewards. Note: the on-chain registration uses `keccak256(code)` which is fine, but the code string itself is predictable. The server-side `points/src/referral.ts` correctly uses `crypto.randomBytes()`. |
| **Recommendation** | Replace `Math.random()` with `crypto.getRandomValues()`: ```ts const arr = new Uint8Array(6); crypto.getRandomValues(arr); code += chars[arr[i] % chars.length];``` |

---

## MEDIUM Severity

### TS-M-01 — Canton API URL Defaults to HTTP (Not HTTPS)

| Field | Value |
|-------|-------|
| **File** | `points/src/config.ts` (CANTON_API_URL default) |
| **Category** | HTTPS / TLS Enforcement |
| **Description** | The points service's `CANTON_API_URL` defaults to an HTTP URL rather than HTTPS. While the relay services enforce TLS via `enforceTLSSecurity()`, the points service does not apply the same pattern. In production, this could result in unencrypted communication with the Canton API if the environment variable is not explicitly set. |
| **Impact** | Man-in-the-middle interception of Canton API responses — an attacker on the network path could tamper with asset verification data used for points calculations. |
| **Recommendation** | Default to `https://` in the config. Add a startup check: if `NODE_ENV === 'production'` and the URL scheme is `http://`, either throw or log a CRITICAL warning. Import `requireHTTPS()` from the relay `utils.ts` pattern. |

### TS-M-02 — Canton Token Stored in React Ref (Accessible via DevTools)

| Field | Value |
|-------|-------|
| **File** | `frontend/src/hooks/useCanton.ts` line 57 |
| **Category** | Auth Patterns / Secret Handling |
| **Description** | The Canton ledger bearer token is stored in a `useRef<string>("")`. While the comment says "Token stored securely in ref, not exposed in config", React refs are fully accessible via browser DevTools (`$r._reactInternalFiber...`). This is better than exposing in global config, but the token is still readable by any injected script. |
| **Impact** | If combined with XSS (see TS-H-02), an attacker could extract the Canton bearer token and impersonate the user on the Canton ledger. |
| **Recommendation** | Consider using `sessionStorage` with encryption (e.g., WebCrypto AES-GCM with a per-session key) or a `HttpOnly` cookie proxy pattern where the token never reaches JavaScript. At minimum, clear the token on tab visibility change (`document.visibilitychange → hidden`). |

### TS-M-03 — No CORS Configuration on Yield API Server

| Field | Value |
|-------|-------|
| **File** | `bot/src/yield-api.ts` |
| **Category** | Auth / Access Control |
| **Description** | The yield API Express server (`YieldScannerAPI`) does not configure CORS headers. While currently read-only, if the API gains stateful endpoints (e.g., POST to trigger scans), it would be vulnerable to CSRF. Even for GET endpoints, the absence of CORS means any website can fetch yield data and potentially correlate it with user activity. |
| **Impact** | Low immediate risk for read-only endpoints, but architectural debt. Any future authenticated or state-changing endpoints would be vulnerable. |
| **Recommendation** | Add explicit CORS configuration with `cors({ origin: [allowed-origins] })`. For the health endpoint, restrict to internal monitoring IPs. |

### TS-M-04 — Hardcoded Sepolia Addresses in Deployment Scripts

| Field | Value |
|-------|-------|
| **Files** | `scripts/deploy-leverage-vault.ts`, `scripts/deploy-mock-oracles.ts` |
| **Category** | Hardcoded Values |
| **Description** | Multiple deployment scripts contain hardcoded Sepolia testnet contract addresses (e.g., `MUSD: "0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b"`). These scripts use `--network` flags but the addresses are hardcoded, not loaded from a deployment registry. A developer could accidentally run a Sepolia-configured script against mainnet. |
| **Impact** | Failed transactions at best (wrong addresses); at worst, interaction with unintended mainnet contracts if addresses happen to exist. |
| **Recommendation** | Load addresses from `deployments/<network>.json` (pattern already used in `verify-roles.ts` and `migrate-to-multisig.ts`). Add a network guard: `if (network.name !== 'sepolia') throw new Error('This script is testnet-only')`. |

### TS-M-05 — In-Memory Rate Limiting Reset on Service Restart

| Field | Value |
|-------|-------|
| **File** | `relay/lending-keeper.ts`, `relay/validator-node-v2.ts` |
| **Category** | Race Conditions / Rate Limiting |
| **Description** | Rate limiting counters (e.g., `MAX_SIGNS_PER_WINDOW` in validator, liquidation rate limits in lending keeper) are stored in-memory. If a service crashes and restarts, all counters reset to zero, allowing a burst of operations that should have been throttled. In a Kubernetes environment with rolling restarts, this creates periodic windows of unlimited throughput. |
| **Impact** | Validator could sign more attestations than intended per window after restart; lending keeper could execute more liquidations than rate limits allow. |
| **Recommendation** | Persist rate limit state to Redis or a local file that survives restarts. Alternatively, use a sliding window based on block timestamps (which are externally verifiable) rather than wall-clock time. |

### TS-M-06 — Unbounded Event Query in Frontend Referral Hook

| Field | Value |
|-------|-------|
| **File** | `frontend/src/hooks/useReferral.ts` line ~180 |
| **Category** | Input Validation / DoS |
| **Description** | The `refresh()` function queries `CodeCreated` events with `queryFilter(filter, -100000)` — scanning the last 100,000 blocks. On Ethereum mainnet, this covers ~14 days. For a user with many referral codes, or on chains with faster block times, this query can be extremely slow or fail entirely due to RPC provider limits. |
| **Impact** | Frontend degradation — the referral dashboard hangs or errors for active referrers. RPC rate limit exhaustion. |
| **Recommendation** | Use pagination (`fromBlock/toBlock` windows) or index referral codes via a subgraph/backend API rather than raw event scanning. Add a `try/catch` timeout wrapper (already partially implemented). |

### TS-M-07 — Multi-Chain Deposit Approval Race Condition

| Field | Value |
|-------|-------|
| **File** | `frontend/src/hooks/useMultiChainDeposit.tsx` lines 290-302 |
| **Category** | Race Conditions |
| **Description** | The deposit flow checks `allowance < amount`, then approves the exact `amount`, then calls `router.deposit(amount)`. If a user initiates two deposits rapidly, the second `approve` transaction could overwrite the first approval before the first deposit consumes it, leading to a failed deposit. |
| **Impact** | Failed transactions and user confusion. No fund loss (reverts), but poor UX. |
| **Recommendation** | Use the approve-reset pattern (approve to 0 first, then approve to amount) which is already implemented in `MintPage.tsx`, or use `increaseAllowance`. Also disable the deposit button while a transaction is pending (partially implemented via `isLoading` state). |

---

## LOW Severity

### TS-L-01 — Deprecated V1 Validator Still in Codebase

| Field | Value |
|-------|-------|
| **File** | `relay/validator-node.ts` (604 lines) |
| **Category** | Code Hygiene |
| **Description** | The V1 validator uses a 7-parameter hash incompatible with V2's 8-parameter hash. While it's hard-disabled unless `ALLOW_V1_VALIDATOR=true` and exits in production, its presence creates confusion and a risk of accidental activation. |
| **Recommendation** | Move to `archive/` directory or delete entirely. Add a code comment in V2 referencing the V1 deprecation reason. |

### TS-L-02 — Empty `defi-llama-indexer.ts` File

| Field | Value |
|-------|-------|
| **File** | `bot/src/defi-llama-indexer.ts` |
| **Category** | Code Hygiene |
| **Description** | Committed empty file. Appears to be a placeholder that was never implemented. |
| **Recommendation** | Remove the file or add a TODO comment explaining its purpose. |

### TS-L-03 — Generous 50MB Response Size Limit in Yield API

| Field | Value |
|-------|-------|
| **File** | `frontend/src/pages/api/yields.ts` line ~170 |
| **Category** | Input Validation |
| **Description** | The DeFi Llama API response is accepted up to 50MB before rejection. The actual response is typically ~2-5MB. A compromised or misbehaving upstream could serve a large payload causing memory pressure. |
| **Recommendation** | Reduce limit to 10MB (5x normal response) and add streaming JSON parsing with `json-stream` or process in chunks. |

### TS-L-04 — Subgraph Reuses Entity Type for Different Purpose

| Field | Value |
|-------|-------|
| **File** | `subgraph/src/ble-bridge.ts` `handleAttestationInvalidated()` |
| **Category** | Data Integrity |
| **Description** | Attestation invalidation events are stored as `EmergencyCapReduction` entities with the `reason` field prefixed with "Attestation invalidated:". The `oldCap`/`newCap` fields are set to `event.block.number` instead of actual cap values, which is semantically incorrect. |
| **Recommendation** | Create a dedicated `AttestationInvalidation` entity type in the subgraph schema. |

### TS-L-05 — Deployer Used as Fee Recipient Placeholder

| Field | Value |
|-------|-------|
| **File** | `scripts/deploy-testnet.ts` lines 36-38 |
| **Category** | Configuration |
| **Description** | `FEE_RECIPIENT` and `SWAP_ROUTER` are set to `deployer.address` as placeholders. While marked with comments, this pattern could persist into staging if the script is reused. |
| **Recommendation** | Add validation that halts the script if `FEE_RECIPIENT === deployer.address` on non-local networks. |

### TS-L-06 — Canton Frontend Protocol Not Enforced to HTTPS

| Field | Value |
|-------|-------|
| **File** | `frontend/src/lib/config.ts` (`CANTON_CONFIG`) |
| **Category** | HTTPS/TLS |
| **Description** | `CANTON_CONFIG.protocol` defaults to `'https'` but can be overridden by environment variable. There is no validation that production builds use HTTPS. |
| **Recommendation** | Add build-time check in `next.config.js` that verifies Canton protocol is HTTPS when `NODE_ENV === 'production'`. |

### TS-L-07 — Points Server Lacks Rate Limiting

| Field | Value |
|-------|-------|
| **File** | `points/src/server.ts` |
| **Category** | DoS Protection |
| **Description** | The points API server does not implement rate limiting. Endpoints like `/api/points/:address`, `/api/referral/link`, and `/api/transparency/snapshot` could be abused with high-frequency requests. |
| **Recommendation** | Add `express-rate-limit` middleware with per-IP limits (e.g., 100 req/min for reads, 10 req/min for writes). |

### TS-L-08 — Loop Wallet Provider Network Parameter Not Validated

| Field | Value |
|-------|-------|
| **File** | `frontend/src/hooks/useLoopWallet.tsx` line 88 |
| **Category** | Input Validation |
| **Description** | The `LoopWalletProvider` accepts a `network` prop with type `'devnet' | 'testnet' | 'mainnet' | 'local'` but defaults to `'devnet'`. If production deployment forgets to set this prop, users would connect to devnet. |
| **Recommendation** | Add a runtime check: `if (process.env.NODE_ENV === 'production' && network !== 'mainnet') console.error(...)`. |

---

## INFO (Positive Findings)

### TS-I-01 — Exemplary KMS Key Management
All production services (`relay-service`, `validator-node-v2`, `lending-keeper`, `yield-keeper`, `yield-sync-service`, bot `index.ts`, `oracle-keeper`, `reconciliation-keeper`) enforce AWS KMS signing in production with `REQUIRE_KMS=true` and reject raw private keys via `isValidSecp256k1PrivateKey()` + key zeroing after use.

### TS-I-02 — Robust DER-to-RSV Signature Handling
`relay/signer.ts` and `scripts/signer.ts` implement comprehensive DER parsing with: bounds checking, multi-byte length encoding support, R/S component length validation (≤33 bytes), trailing byte rejection, S-value normalization to lower curve half (EIP-2), and recovery ID brute-force with signer verification.

### TS-I-03 — Per-Transaction Bounded Approvals in Frontend
Frontend pages (`MintPage`, `BorrowPage`, `StakePage`, `LeveragePage`, `LiquidationsPage`) all use exact-amount approvals with allowance pre-checks. The bot (`index.ts`) uses a 1M mUSD cap rather than `MaxUint256`. The `MintPage` additionally implements the approve-to-zero-first pattern.

### TS-I-04 — Comprehensive Migration Safety
`scripts/migrate-v8-to-v9.ts` includes pre-flight safety checks (storage slot verification, deployer role verification, ETH balance check, config sanity validation) before performing the irreversible V8→V9 bridge migration. `scripts/migrate-to-multisig.ts` implements a 3-phase grant→verify→revoke pattern with 10-second countdown before irreversible revocation.

### TS-I-05 — TLS Watchdog in Relay Services
`relay/utils.ts` implements `enforceTLSSecurity()` with a 5-second interval watchdog that re-checks `NODE_TLS_REJECT_UNAUTHORIZED !== '0'`, providing defense-in-depth against runtime TLS downgrades by compromised dependencies.

### TS-I-06 — Storage Layout Validation Script
`scripts/validate-storage-layout.ts` validates all 11 UUPS-upgradeable contracts against `@openzeppelin/upgrades-core` to prevent storage collision — a critical safeguard for proxy-based upgrade patterns.

---

## Security Category Summary

| Category | Assessment |
|----------|-----------|
| **1. Hardcoded Secrets** | ✅ **Strong** — No secrets in source. Docker secrets + KMS throughout. `bot/.env` exists but is empty. |
| **2. Input Validation** | ✅ **Good** — Address validation, amount parsing, DER bounds checks. Minor: 50MB response limit generous. |
| **3. Error Handling** | ✅ **Good** — Consistent try/catch with typed errors. Bot uses winston logging. Frontend has user-friendly error messages. |
| **4. Auth Patterns** | ⚠️ **Adequate** — KMS enforced server-side. Client-side Canton token in ref (TS-M-02). No rate limiting on points API (TS-L-07). |
| **5. Race Conditions** | ⚠️ **Adequate** — In-memory rate limits reset on restart (TS-M-05). Deposit approval race (TS-M-07). Graceful shutdown with drain periods mitigates most concerns. |
| **6. Price Feed Handling** | ⚠️ **Mixed** — Relay oracle has dual-source cross-validation, circuit breaker, rate-of-change checks. But bot has hardcoded ETH price (TS-H-01). |
| **7. Token Approvals** | ✅ **Strong** — Exact-amount approvals throughout frontend. Bot uses bounded cap (1M). Approve-reset pattern in MintPage. |
| **8. CSP Headers** | ⚠️ **Needs Work** — `frame-ancestors 'none'` and `X-Frame-Options DENY` are good. But `unsafe-inline` in production script-src (TS-H-02). |
| **9. HTTPS/TLS Enforcement** | ✅ **Good** — TLS watchdog in relay, HTTPS-default in Canton config. Minor: points service HTTP default (TS-M-01). |
| **10. Cryptographic Practices** | ✅ **Strong** — EIP-2 normalization, secp256k1 validation, `crypto.randomBytes` server-side. Minor: `Math.random` in frontend referral (TS-H-03). |

---

## Overall TypeScript Security Score

# 7.8 / 10

**Rationale:** The codebase demonstrates mature security practices with consistent patterns across all services. The relay/bridge infrastructure — the most security-critical component — is particularly well-hardened. Deductions are for: CSP weakness in production frontend (-0.7), hardcoded ETH price in the liquidation bot (-0.5), weak client-side randomness (-0.3), and the cluster of medium-severity findings around rate limiting, CORS, and Canton token handling (-0.7).

---

## Remediation Priority

1. **Immediate** (before mainnet): TS-H-01 (hardcoded ETH price), TS-H-02 (CSP unsafe-inline)
2. **Short-term** (next sprint): TS-H-03 (Math.random), TS-M-01 (HTTP default), TS-M-02 (Canton token), TS-M-04 (script addresses)
3. **Medium-term** (next release): TS-M-03 (CORS), TS-M-05 (rate limit persistence), TS-M-06 (event query), TS-M-07 (approval race)
4. **Backlog**: All LOW findings

---

*End of TypeScript Security Audit Report*
