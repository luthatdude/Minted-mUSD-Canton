# Minted mUSD Protocol — Comprehensive TypeScript Security Audit

**Audit Date:** 2025-01-27  
**Auditor:** Automated Security Review (Claude Opus 4.6)  
**Scope:** All TypeScript services — `relay/`, `bot/`, `points/`, `frontend/`, `scripts/`  
**Version:** Commit at time of audit  

---

## Executive Summary

This audit covers all TypeScript off-chain infrastructure in the Minted mUSD Protocol, spanning five major components: the relay bridge service (Canton↔Ethereum attestation bridge, validator, price oracle, lending keeper, yield keeper, yield sync), the liquidation bot suite (liquidation engine, oracle keeper, Flashbots MEV protection, yield API), the points engine, the Next.js frontend, and deployment/migration scripts.

The codebase demonstrates **strong security posture** for an off-chain DeFi infrastructure, with institutional-grade patterns including AWS KMS HSM-backed signing, Docker-secrets-based credential management, mandatory TLS enforcement with watchdog intervals, pre-flight transaction simulation, MEV protection via Flashbots, and comprehensive anomaly detection. However, several issues were identified that should be addressed before production hardening.

**Overall Score: 7.5 / 10**

---

## Key Strengths

1. **AWS KMS Integration** — Private keys never touch process memory in production; HSM-backed signing with DER-to-RSV conversion (`signer.ts`) includes full bounds checking, EIP-2 S-value normalization, and trailing-byte rejection.
2. **Docker Secrets Pattern** — All services use `readSecret("/run/secrets/...")` instead of environment variables for sensitive credentials; fallback to `process.env` only in non-production.
3. **TLS Enforcement** — `enforceTLSSecurity()` in `relay/utils.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED=1` and verifies it on a watchdog interval, killing the process if tampered with.
4. **Transaction Simulation** — Both the relay-service and liquidation bot simulate transactions via `eth_call` / `staticCall` before sending, preventing wasted gas on revert.
5. **BigInt Arithmetic** — Critical financial calculations in `bot/src/calculator.ts` and `relay/lending-keeper.ts` use native `BigInt` with explicit fixed-point scaling rather than floating-point.
6. **MEV Protection** — The liquidation bot routes transactions through Flashbots bundles, preventing sandwich attacks and front-running.
7. **Anomaly Detection** — Validator-node-v2 implements value-jump detection (`MAX_VALUE_JUMP_BPS`), signing rate limits (`MAX_SIGNS_PER_WINDOW`), and template allowlists.
8. **Dependency Hygiene** — `package.json` includes explicit `overrides` for known CVE-affected transitive dependencies (`fast-xml-parser`, `axios`, `qs`, `tough-cookie`).

---

## Findings

### High Severity

---

#### TS-H-01: `yield-api.ts` Uses `dotenv` — Violates Project-Wide Secret Management Pattern

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `bot/src/yield-api.ts` |
| **Line** | 1–3 |
| **Category** | Secret Management |

**Description:**  
The yield-api service imports and calls `dotenv.config()`, loading credentials from a `.env` file on disk. Every other service in the project uses Docker secrets via `readSecret("/run/secrets/...")` or guarded `process.env` reads. The `.env` file pattern creates a persistent plaintext credential artifact on the filesystem.

```typescript
import * as dotenv from "dotenv";
dotenv.config();
```

**Impact:**  
A `.env` file on the host or in the container image embeds credentials in plaintext, surviving container restarts and potentially being included in image layers, backups, or log scrapes. This breaks the otherwise consistent Docker-secrets-based secret management model.

**Recommendation:**  
Remove the `dotenv` import and migrate to the same `readSecret()` pattern used in all other services. Add a CI lint rule to detect `dotenv` imports across the codebase.

---

#### TS-H-02: Insecure Default RPC URL in `bot/src/config.ts`

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `bot/src/config.ts` |
| **Line** | 4 |
| **Category** | Transport Security |

**Description:**  
The bot configuration defaults the RPC URL to `http://localhost:8545` when `RPC_URL` is not set:

```typescript
export const RPC_URL = process.env.RPC_URL || "http://localhost:8545";
```

In containerized deployments where `RPC_URL` may be accidentally unset, this silently falls back to an unencrypted HTTP endpoint. Combined with Docker network configurations, this could route traffic to an unintended node.

**Impact:**  
Transactions and private key-derived signatures could be transmitted over cleartext HTTP. An attacker with network access could intercept raw transactions.

**Recommendation:**  
1. Remove the default — require `RPC_URL` to be explicitly set or fail fast.
2. Add an `https://` scheme validation check, or at minimum log a warning if the URL uses `http://`.
3. Consider using the `requireHTTPS()` utility from `relay/utils.ts`.

---

#### TS-H-03: `parseFloat` Used for Price Configuration in `price-oracle.ts`

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File** | `relay/price-oracle.ts` |
| **Lines** | 42–56 |
| **Category** | BigInt / Precision |

**Description:**  
Price bounds and configuration values are parsed with `parseFloat()`:

```typescript
const SANITY_MIN = parseFloat(process.env.PRICE_SANITY_MIN || "0.90");
const SANITY_MAX = parseFloat(process.env.PRICE_SANITY_MAX || "1.10");
```

While the defaults are safe small values, an operator could set `PRICE_SANITY_MAX=1.100000000000000001` and it would silently truncate to `1.1`. More critically, the cross-validation threshold and deviation percentage are also parsed this way.

**Impact:**  
IEEE 754 floating-point cannot represent all decimal fractions exactly. For a price oracle — where the difference between 1.00 and 1.01 represents a 1% deviation that could trigger or suppress circuit breakers — floating-point precision loss is a protocol-level risk.

**Recommendation:**  
Use string-based decimal parsing or scaled integers (multiply by 1e6, store as integer) for all price configuration values. At minimum, validate that parsed values round-trip correctly.

---

### Medium Severity

---

#### TS-M-01: No CSRF / Origin Validation on `yield-api.ts` HTTP Server

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `bot/src/yield-api.ts` |
| **Lines** | 35–50 |
| **Category** | Authentication / Authorization |

**Description:**  
The yield API server has CORS origin configuration but no request authentication mechanism. The server exposes yield pool data and configuration information. While it doesn't expose write operations, the rate limiter only limits by IP, which can be spoofed in some network configurations.

**Impact:**  
An attacker could scrape pool data at high volume or use the API as an amplification vector. In environments where IP-based rate limiting is ineffective (shared NAT, proxies), the server has no defense against abuse.

**Recommendation:**  
Add API key authentication or bearer token validation for non-public endpoints. Consider adding request signing for sensitive data endpoints.

---

#### TS-M-02: Health Server Binds to `0.0.0.0` in `validator-node-v2.ts`

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `relay/validator-node-v2.ts` |
| **Lines** | 770–780 |
| **Category** | Authentication / Authorization |

**Description:**  
While `relay-service.ts` correctly binds its health server to `127.0.0.1`, the validator node's health server binds to `0.0.0.0`, exposing health and metrics endpoints to all network interfaces:

```typescript
healthServer.listen(healthPort, () => { ... });
```

The relay-service explicitly binds to localhost:
```typescript
healthServer.listen(healthPort, "127.0.0.1", () => { ... });
```

**Impact:**  
Health and metrics endpoints exposed to the public network can leak operational information (uptime, signing counts, error rates) useful for timing attacks or operational reconnaissance.

**Recommendation:**  
Add `"127.0.0.1"` as the bind address for the validator health server, matching the relay-service pattern. If external monitoring is required, use a reverse proxy with authentication.

---

#### TS-M-03: `toFixed()` / `fromFixed()` Use `parseFloat` Intermediate

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `relay/lending-keeper.ts` |
| **Lines** | 40–55 |
| **Category** | BigInt / Precision |

**Description:**  
The fixed-point conversion utilities use `parseFloat` as an intermediate step:

```typescript
function toFixed(n: number, decimals: number): bigint {
  return BigInt(Math.round(n * 10 ** decimals));
}
```

When `n` is a large number (e.g., a collateral value of 1,000,000,000.123456), the `parseFloat` representation loses precision beyond ~15 significant digits. The `Math.round(n * 10 ** decimals)` multiplication further compounds the error.

**Impact:**  
For typical DeFi values (< $1B with 6 decimals), the precision loss is negligible. However, edge cases near liquidation thresholds could produce incorrect health factor calculations, causing missed or premature liquidations.

**Recommendation:**  
Accept string inputs and use string-based decimal-to-BigInt conversion (split on `.`, pad/truncate fractional part, concatenate, and convert to `BigInt`). Alternatively, use the `ethers.parseUnits()` utility which handles this correctly.

---

#### TS-M-04: Key Rotation Race Condition in `validator-node-v2.ts`

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `relay/validator-node-v2.ts` |
| **Lines** | 180–210 |
| **Category** | Race Conditions |

**Description:**  
The `activateRotationKey()` function updates `activeKmsKeyId` and `activeEthAddress` in separate, non-atomic assignments:

```typescript
activeKmsKeyId = rotationKmsKeyId;
// ... potential async operations ...
activeEthAddress = rotationEthAddress;
```

If a signing request arrives between these two assignments, the system would use the new KMS key but the old Ethereum address for verification, causing a signature mismatch.

**Impact:**  
During key rotation (which should be rare), a narrow window exists where attestation signing could fail or produce signatures that don't match the expected signer address. This could cause attestations to be rejected on-chain.

**Recommendation:**  
Bundle the rotation into a single atomic object swap:

```typescript
const signerState = { kmsKeyId: activeKmsKeyId, ethAddress: activeEthAddress };
// Rotate atomically:
signerState = { kmsKeyId: rotationKmsKeyId, ethAddress: rotationEthAddress };
```

Or use a mutex/lock around the rotation and signing paths.

---

#### TS-M-05: No Production Guard on `CANTON_USE_TLS=false` in Validator

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `relay/validator-node-v2.ts` |
| **Lines** | 87–92 |
| **Category** | TLS / Transport Security |

**Description:**  
The relay-service has a production guard that prevents disabling TLS:

```typescript
// relay-service.ts
if (!useTls && process.env.NODE_ENV === "production") {
  throw new Error("TLS must be enabled in production");
}
```

The validator-node-v2.ts lacks this guard, allowing `CANTON_USE_TLS=false` to disable TLS validation of the Canton API even in production deployments.

**Impact:**  
An attacker who can modify the validator's environment variables (or exploit a container misconfiguration) could silently downgrade the Canton API connection to HTTP, enabling man-in-the-middle attacks on attestation data.

**Recommendation:**  
Add the same production guard present in `relay-service.ts`. Copy the pattern:
```typescript
if (!useTls && process.env.NODE_ENV === "production") {
  throw new Error("CANTON_USE_TLS=false is not allowed in production");
}
```

---

#### TS-M-06: `KmsEthereumSigner.connect()` Loses AWS Region

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `relay/kms-ethereum-signer.ts` |
| **Lines** | ~45–55 |
| **Category** | Error Handling |

**Description:**  
The `connect()` method, called when switching providers (e.g., during RPC failover), constructs a new `KmsEthereumSigner` but passes an empty string for the region parameter:

```typescript
connect(provider: ethers.Provider): KmsEthereumSigner {
  return new KmsEthereumSigner(this.keyId, "", provider);
}
```

The region is required for AWS KMS API calls. A signer created via `connect()` would fail on the next signing attempt.

**Impact:**  
If the relay-service's RPC provider fails over and ethers.js internally calls `connect()` to re-bind the signer to a new provider, all subsequent KMS signing operations would fail with an AWS region error, halting attestation processing until manual restart.

**Recommendation:**  
Store the region as an instance property and pass it through in `connect()`:
```typescript
connect(provider: ethers.Provider): KmsEthereumSigner {
  return new KmsEthereumSigner(this.keyId, this.region, provider);
}
```

---

#### TS-M-07: Frontend `AdminPage.tsx` Doesn't Use `validateAmount()` for Numeric Inputs

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File** | `frontend/src/pages/AdminPage.tsx` |
| **Category** | Input Validation |

**Description:**  
The frontend has a `validateAmount()` utility in `lib/config.ts` that validates numeric inputs against bounds and precision requirements. However, the admin page — which handles sensitive operations like setting supply caps, fee parameters, and oracle configurations — does not use this utility for its form inputs.

**Impact:**  
Admin users could submit malformed values (negative numbers, extremely large values, values with excessive decimal places) that would either revert on-chain (wasting gas) or, in edge cases, set unintended protocol parameters.

**Recommendation:**  
Apply `validateAmount()` (or an equivalent admin-specific validator) to all numeric form inputs on the admin page before constructing the transaction.

---

### Low Severity

---

#### TS-L-01: Temple API Credentials in Environment Variables

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `relay/price-oracle.ts` |
| **Lines** | 58–62 |
| **Category** | Secret Management |

**Description:**  
The Temple (fallback price source) API key and secret are read from `process.env.TEMPLE_API_KEY` and `process.env.TEMPLE_API_SECRET` without using the `readSecret()` Docker-secrets pattern used elsewhere.

**Impact:**  
Minor inconsistency in credential management. These are API credentials (not signing keys) and may be considered lower sensitivity, but the inconsistency creates confusion about the intended security model.

**Recommendation:**  
Migrate to `readSecret()` for consistency, or document the intentional exception.

---

#### TS-L-02: Missing Graceful Shutdown Handlers in Several Services

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `relay/price-oracle.ts`, `relay/yield-keeper.ts` |
| **Category** | Process Lifecycle |

**Description:**  
While the relay-service and validator-node have comprehensive SIGTERM/SIGINT handlers that flush pending operations and close connections, the price oracle and yield keeper services lack graceful shutdown handlers. If killed during a transaction submission, the process could leave pending nonce locks or partial state.

**Impact:**  
In containerized environments with rolling deployments, ungraceful shutdowns can cause nonce gaps (requiring manual nonce management) or duplicate transaction submissions on restart.

**Recommendation:**  
Add SIGTERM handlers that:
1. Set a `shuttingDown` flag to prevent new operations
2. Wait for in-flight transactions to complete (with timeout)
3. Close provider connections
4. Exit cleanly

---

#### TS-L-03: Potential Event Listener Leak in Liquidation Bot

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `bot/src/index.ts` |
| **Lines** | ~380–420 |
| **Category** | Process Lifecycle |

**Description:**  
The liquidation bot subscribes to contract events (e.g., `LiquidationCall`, `HealthFactorChanged`) but does not explicitly remove listeners on shutdown or error recovery. In long-running processes, if the event subscription is re-established after a provider reconnect without removing the old listener, duplicate event handlers accumulate.

**Impact:**  
Over time, duplicate listeners would process the same event multiple times, potentially triggering duplicate liquidation attempts (which would revert on-chain but waste gas).

**Recommendation:**  
Track event listeners and remove them before re-subscribing. Use `contract.removeAllListeners()` during cleanup or provider reconnection.

---

#### TS-L-04: Points Service Allows HTTP Canton API URL

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `points/src/config.ts` |
| **Lines** | ~10–15 |
| **Category** | TLS / Transport Security |

**Description:**  
The points service configuration accepts `CANTON_API_URL` from environment without validating the scheme is HTTPS. While the relay services enforce TLS, the points service (which reads Canton state for point calculations) does not.

**Impact:**  
If misconfigured with an HTTP URL, Canton API calls (which may include ledger state and user balances) would be transmitted in cleartext.

**Recommendation:**  
Add `requireHTTPS()` validation from `relay/utils.ts`, or import and reuse the utility.

---

#### TS-L-05: Path Traversal Check in Points `transparency.ts` is Incomplete

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `points/src/transparency.ts` |
| **Lines** | ~85–95 |
| **Category** | Input Validation |

**Description:**  
The transparency module checks for `..` in filenames but does not validate the `outputDir` constructor parameter itself. If `outputDir` is set from an environment variable, a malicious value could point to an arbitrary filesystem location.

**Impact:**  
Transparency reports could be written to unintended filesystem locations, potentially overwriting critical files if the process runs with elevated permissions.

**Recommendation:**  
Validate that `outputDir` resolves to an expected base directory using `path.resolve()` and prefix checking.

---

#### TS-L-06: `waitForBlock()` in Flashbots Has No Timeout

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File** | `bot/src/flashbots.ts` |
| **Lines** | ~300–330 |
| **Category** | Process Lifecycle |

**Description:**  
The `waitForBlock()` helper polls for a new block number but has no maximum timeout:

```typescript
while (true) {
  const current = await provider.getBlockNumber();
  if (current > targetBlock) return current;
  await sleep(1000);
}
```

If the RPC provider stops returning new blocks (e.g., node sync issue), this loop runs indefinitely.

**Impact:**  
The liquidation bot would hang silently, appearing healthy to monitoring but not processing any liquidations. In a time-sensitive DeFi context, this could allow unhealthy positions to persist.

**Recommendation:**  
Add a maximum iteration count or wall-clock timeout (e.g., 5 minutes), after which the function throws an error that triggers the bot's reconnection logic.

---

### Informational

---

#### TS-I-01: Code Duplication Between `bot/src/index.ts` and `relay/utils.ts`

| Field | Value |
|-------|-------|
| **Severity** | Informational |
| **File** | `bot/src/index.ts` |
| **Category** | Code Quality |

**Description:**  
The liquidation bot re-implements `readSecret()`, `readAndValidatePrivateKey()`, and `isValidSecp256k1PrivateKey()` locally instead of importing from a shared package. The bot's version notably **omits** the environment variable zeroing (`delete process.env[key]`) that the relay version performs after reading.

**Impact:**  
The missing env-var zeroing means the private key remains accessible via `process.env` for the entire process lifetime in the bot, whereas the relay clears it immediately after reading.

**Recommendation:**  
Extract shared security utilities into a common package (e.g., `@minted/security-utils`) and import in both services. Ensure the env-var zeroing behavior is consistent.

---

#### TS-I-02: Duplicate `signer.ts` in `scripts/`

| Field | Value |
|-------|-------|
| **Severity** | Informational |
| **File** | `scripts/signer.ts` |
| **Category** | Code Quality |

**Description:**  
`scripts/signer.ts` is a near-exact duplicate of `relay/signer.ts`. If a security fix is applied to one copy, it may not be applied to the other.

**Recommendation:**  
Import from a single canonical location or symlink the file.

---

## Dependency Assessment

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `ethers` | ^6.13.0 | Low | Well-maintained, latest v6 |
| `@aws-sdk/client-kms` | ^3.722.0 | Low | Official AWS SDK |
| `@daml/ledger` | 2.10.3 | Medium | Niche package, fewer security audits |
| `winston` | ^3.17.0 | Low | Standard logging library |
| `express` | (via yield-api) | Low | Well-maintained, but ensure latest patch |
| `axios` | overridden | Low | CVE override in place |
| `fast-xml-parser` | overridden | Low | CVE override in place |
| `next` | ^15.1.0 | Low | Recent version, actively patched |
| `wagmi` / `viem` | ^2.x | Low | Standard Web3 frontend libraries |
| `dotenv` | (yield-api only) | **High** | Should be removed per TS-H-01 |

---

## Summary by Category

| Category | Findings | Highest Severity |
|----------|----------|-----------------|
| Secret Management | 2 (TS-H-01, TS-L-01) | High |
| Input Validation | 2 (TS-M-07, TS-L-05) | Medium |
| Error Handling | 1 (TS-M-06) | Medium |
| TLS / Transport Security | 2 (TS-H-02, TS-M-05) | High |
| BigInt / Precision | 2 (TS-H-03, TS-M-03) | High |
| Race Conditions | 1 (TS-M-04) | Medium |
| Dependencies | 0 | — |
| Authentication / Authorization | 2 (TS-M-01, TS-M-02) | Medium |
| Logging / Information Disclosure | 0 | — |
| Process Lifecycle | 3 (TS-L-02, TS-L-03, TS-L-06) | Low |
| Code Quality | 2 (TS-I-01, TS-I-02) | Informational |

---

## Risk Matrix

| Severity | Count | Findings |
|----------|-------|----------|
| **High** | 3 | TS-H-01, TS-H-02, TS-H-03 |
| **Medium** | 7 | TS-M-01 through TS-M-07 |
| **Low** | 6 | TS-L-01 through TS-L-06 |
| **Informational** | 2 | TS-I-01, TS-I-02 |
| **Total** | **18** | |

---

## Overall Assessment

**Score: 7.5 / 10**

### Strengths
- Institutional-grade KMS integration with proper DER signature handling
- Consistent Docker-secrets pattern across nearly all services
- TLS enforcement with runtime watchdog is an excellent defense-in-depth measure
- Pre-flight simulation prevents gas waste on reverts
- Flashbots MEV protection for liquidation transactions
- Anomaly detection (value jumps, rate limiting) in the validator
- Dependency CVE overrides show proactive vulnerability management

### Weaknesses
- One service (`yield-api`) breaks the secret management pattern with `dotenv`
- Floating-point precision issues in price oracle and lending keeper configurations
- Key rotation in the validator has a non-atomic race condition
- Inconsistent TLS enforcement between relay-service and validator-node
- `KmsEthereumSigner.connect()` is broken — would fail on provider failover
- Several services lack graceful shutdown handlers
- Code duplication between bot and relay for security-critical utilities

### Priority Remediation Order
1. **TS-M-06** (KMS connect region loss) — Silent failure on provider failover
2. **TS-H-01** (dotenv removal) — Breaks security model
3. **TS-H-02** (insecure default RPC) — Remove default, fail fast
4. **TS-M-05** (validator TLS guard) — Parity with relay-service
5. **TS-H-03 / TS-M-03** (parseFloat precision) — Migrate to string-based parsing
6. **TS-M-04** (key rotation atomicity) — Low probability but high impact
7. Remaining medium and low findings

---

*End of TypeScript Security Audit Report*
