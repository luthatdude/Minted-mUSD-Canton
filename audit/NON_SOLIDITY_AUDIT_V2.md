# Minted mUSD Protocol — Non-Solidity Security Audit V2

**Date:** 2025-01-XX  
**Scope:** All non-Solidity code in the Minted-mUSD-Canton repository  
**Auditor:** Automated deep-analysis (institutional-grade)  
**Severity Scale:** CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL

---

## Executive Summary

This audit covers **all non-Solidity code** across the Minted mUSD Protocol: TypeScript relay infrastructure (10 files, ~5,500 LOC), bot services (8 files, ~2,200 LOC), DAML smart contracts (20+ files, ~5,500 LOC), Kubernetes manifests, CI/CD pipeline, Docker configuration, and deployment scripts.

The codebase demonstrates **exceptionally strong security posture** — evidenced by systematic FIX references addressing prior audit findings (INFRA-H-01 through H-06, DAML-CRIT-01, DAML-H-01 through H-04, etc.), Docker secrets for credentials, KMS-based signing, BFT supermajority verification, HTTPS enforcement, and comprehensive input validation.

However, **13 findings** remain:

| Severity | Count | Summary |
|----------|-------|---------|
| CRITICAL | 1 | Build-breaking syntax error in oracle-keeper.ts |
| HIGH | 3 | KMS region loss on reconnect, legacy message hash divergence, TLS setter drops valid values |
| MEDIUM | 5 | Raw private keys (no KMS), RPC URL logging, hardcoded ETH price, governance bypass in legacy DAML choice, USDCx transfer missing compliance check |
| LOW | 1 | Dockerfile healthcheck hostname inconsistency |
| INFO | 3 | Empty files, placeholder code, empty DAML module |

---

## Scope

### Files Audited (Complete Read)

**Relay Infrastructure (relay/)**
- `relay-service.ts` (998 lines) — Canton→Ethereum bridge relay
- `validator-node-v2.ts` (760 lines) — V2 validator with Canton asset API
- `validator-node.ts` (546 lines) — Legacy validator
- `utils.ts` (~140 lines) — Shared security utilities
- `kms-ethereum-signer.ts` (203 lines) — AWS KMS signer
- `signer.ts` (256 lines) — DER-to-RSV signature conversion
- `yield-keeper.ts` (365 lines) — Treasury auto-deploy keeper
- `price-oracle.ts` (651 lines) — Dual-source price feed
- `lending-keeper.ts` (779 lines) — Canton lending liquidation keeper
- `yield-sync-service.ts` (542 lines) — Cross-chain share price sync
- `docker-compose.yml` (306 lines) — Production orchestration
- `Dockerfile` (53 lines) — Multi-stage build
- `package.json` — Dependencies

**Bot Services (bot/src/)**
- `oracle-keeper.ts` (425 lines) — Circuit breaker reset keeper
- `index.ts` (597 lines) — Liquidation bot with Flashbots
- `flashbots.ts` (453 lines) — MEV-protected execution
- `monitor.ts` (226 lines) — Position health monitor
- `yield-scanner.ts` (~100 lines) — Yield opportunity scanner
- `pendle-sniper.ts`, `pool-alerts.ts`, `yield-api.ts` — Empty files

**DAML Smart Contracts (daml/)**
- `BLEBridgeProtocol.daml` (521 lines)
- `CantonLending.daml` (1464 lines)
- `CantonDirectMint.daml` (773 lines)
- `CantonSMUSD.daml` (~300 lines)
- `CantonBoostPool.daml` (544 lines)
- `Governance.daml` (434 lines)
- `Compliance.daml` (~160 lines)
- `UserPrivacySettings.daml` (~200 lines)
- `InstitutionalAssetV4.daml` (~300 lines)
- `InterestRateService.daml` (211 lines)
- `MintedMUSD.daml` (334 lines)
- `CantonLoopStrategy.daml` (empty)

**Infrastructure**
- `.github/workflows/ci.yml` (394 lines)
- `k8s/canton/secrets.yaml`, `participant-deployment.yaml` (292 lines), `network-policy.yaml` (200 lines)
- `hardhat.config.ts`, `foundry.toml`
- `scripts/deploy-testnet.ts` (284 lines), `scripts/migrate-to-multisig.ts` (302 lines), `scripts/deploy-sepolia.sh`, `scripts/deploy-gke.sh`
- Root `package.json`, `relay/package.json`

---

## FINDINGS

---

### CRITICAL-01: Build-Breaking Syntax Error in oracle-keeper.ts

**File:** `bot/src/oracle-keeper.ts` lines 322–329  
**Severity:** CRITICAL  
**Impact:** TypeScript compilation failure — the oracle keeper bot cannot be built or deployed.

**Description:**

The `fetchExternalPrice` method contains literal escaped-quote characters (`\"`) and literal `\n` characters that are NOT inside template literals. These are raw bytes in the `.ts` source file that are invalid TypeScript syntax:

```typescript
// LINE 322-329 (actual file contents):
    if (!url.startsWith(\"https://\")) {
      logger.warn(`${symbol} — external feed URL does not use HTTPS: ${url.substring(0, 50)}`);\n      if (process.env.NODE_ENV === \"production\") {\n        logger.error(`${symbol} — HTTPS required for external feeds in production`);\n        return null;\n      }\n    }\n    try {
```

The `\"` characters are literal backslash-quote bytes — not valid TypeScript outside of JSON strings. The `\n` characters are literal two-character sequences (`\` + `n`) rather than actual newlines.

**Root Cause:** This appears to be the result of an automated edit or LLM-generated patch that was applied with JSON-style escaping instead of raw TypeScript.

**Fix:**
```typescript
    if (!url.startsWith("https://")) {
      logger.warn(`${symbol} — external feed URL does not use HTTPS: ${url.substring(0, 50)}`);
      if (process.env.NODE_ENV === "production") {
        logger.error(`${symbol} — HTTPS required for external feeds in production`);
        return null;
      }
    }
    try {
```

---

### HIGH-01: KMS Signer Loses AWS Region on `connect()`

**File:** `relay/kms-ethereum-signer.ts` line 97  
**Severity:** HIGH  
**Impact:** Any ethers.js code path that calls `signer.connect(newProvider)` will create a new `KMSEthereumSigner` with an empty string for the AWS region. Subsequent KMS API calls (signing, key retrieval) will fail with AWS SDK configuration errors, causing transaction signing to silently break.

**Description:**

```typescript
// LINE 97
connect(provider: ethers.Provider): KMSEthereumSigner {
    return new KMSEthereumSigner(this.kmsKeyId, "", provider);
    //                                          ^^
    //                           Region is hardcoded to empty string
}
```

The `connect()` method is part of the ethers.js `AbstractSigner` interface and is called internally by the library (e.g., when connecting a signer to a different provider). The original region is stored in the `KMSClient` instance but is not preserved when creating a new signer.

**Fix:**
Store the region as a class field and pass it through:
```typescript
private region: string;

// In constructor:
this.region = region;

connect(provider: ethers.Provider): KMSEthereumSigner {
    return new KMSEthereumSigner(this.kmsKeyId, this.region, provider);
}
```

---

### HIGH-02: Legacy Validator Message Hash Diverges from V2

**File:** `relay/validator-node.ts` lines 421–436 vs `relay/validator-node-v2.ts` lines 637–651  
**Severity:** HIGH  
**Impact:** If the legacy validator (`npm run validator:legacy`) is accidentally started alongside V2 validators, their signatures will be incompatible — they will never contribute to the BFT quorum on BLEBridgeV9, potentially blocking attestation finalization.

**Description:**

The legacy validator constructs a 7-parameter message hash:
```typescript
// validator-node.ts line 421 — 7 parameters
ethers.solidityPackedKeccak256(
  ["bytes32", "uint256", "uint256", "uint256", "bytes32", "uint256", "address"],
  [idBytes32, globalCantonAssets, nonce, timestamp, entropy, chainId, bridgeAddress]
);
```

The V2 validator constructs an 8-parameter message hash (includes `cantonStateHash`):
```typescript
// validator-node-v2.ts line 637 — 8 parameters
ethers.solidityPackedKeccak256(
  ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
  [idBytes32, totalCantonValue, nonce, timestamp, entropy, stateHash, chainId, bridgeAddress]
);
```

Key differences:
1. V2 includes an additional `bytes32 stateHash` parameter (cantonStateHash)
2. V1 uses `payload.globalCantonAssets`, V2 uses `payload.totalCantonValue` (different field names)
3. The Solidity-side BLEBridgeV9 contract expects ONE specific hash format — any mismatch means the signature is invalid

**Recommendation:**
Since the legacy validator is already deprecated (invoked via `npm run validator:legacy`), add a startup warning or block it entirely:
```typescript
console.error("[DEPRECATED] validator-node.ts is incompatible with V2 message format.");
console.error("Use validator-node-v2.ts (npm run validator) instead.");
process.exit(1);
```

---

### HIGH-03: TLS Security Setter Silently Drops Valid Values

**File:** `relay/utils.ts` lines 30–38  
**Severity:** HIGH  
**Impact:** The `Object.defineProperty` guard makes `NODE_TLS_REJECT_UNAUTHORIZED` effectively read-only. While this correctly blocks `"0"`, it also silently drops ANY set operation — including legitimate values like `"1"`. Code that sets this property and then checks it will see the getter's cached value, not the value they set. This could mask bugs in dependent libraries.

**Description:**

```typescript
// LINE 30-38
Object.defineProperty(process.env, "NODE_TLS_REJECT_UNAUTHORIZED", {
  get: () => originalValue || "1",
  set: (val: string) => {
    if (val === "0") {
      console.error("[SECURITY] Attempt to disable TLS cert validation blocked at runtime.");
      return;  // Block disable — CORRECT
    }
    // Non-"0" values: NO storage, NO acknowledgment
    // The getter will ALWAYS return `originalValue || "1"` regardless
  },
  configurable: false,
});
```

The intent is to prevent TLS bypass, but the implementation makes the property entirely immutable. If a legitimate library sets it to `"1"` (which should be a no-op), the set appears to succeed (no error thrown) but the getter returns the captured `originalValue`.

**Fix:**
Store the value on valid sets:
```typescript
let currentValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "1";
Object.defineProperty(process.env, "NODE_TLS_REJECT_UNAUTHORIZED", {
  get: () => currentValue,
  set: (val: string) => {
    if (val === "0") {
      console.error("[SECURITY] Attempt to disable TLS cert validation blocked.");
      return;
    }
    currentValue = val; // Store valid values
  },
  configurable: false,
});
```

---

### MEDIUM-01: Yield Keeper and Yield Sync Service Use Raw Private Keys (No KMS)

**Files:**  
- `relay/yield-keeper.ts` line 48: `readSecret("keeper_private_key", "KEEPER_PRIVATE_KEY")`  
- `relay/yield-sync-service.ts` (similar pattern)  

**Severity:** MEDIUM  
**Impact:** These services load raw private keys into memory, inconsistent with the KMS-based approach used by `relay-service.ts` and `validator-node-v2.ts` (FIX H-07). If the host is compromised, the keeper's private key is extractable from process memory.

**Description:**

`yield-keeper.ts` creates a raw `ethers.Wallet`:
```typescript
// LINE 139
this.wallet = new ethers.Wallet(config.keeperPrivateKey, this.provider);
```

Meanwhile, `relay-service.ts` uses `createEthereumSigner()` which supports KMS:
```typescript
// relay-service.ts uses KMS-aware factory
this.wallet = await createEthereumSigner({ kmsKeyId, awsRegion, privateKey }, provider);
```

**Recommendation:**
Migrate `yield-keeper.ts` and `yield-sync-service.ts` to use `createEthereumSigner()` from `kms-ethereum-signer.ts`.

---

### MEDIUM-02: Relay Service Logs RPC URL Containing Potential API Keys

**File:** `relay/relay-service.ts` line 266  
**Severity:** MEDIUM  
**Impact:** The RPC URL (Alchemy, Infura, etc.) typically contains an API key in the URL path. Logging it exposes the key in container logs, log aggregation systems (CloudWatch, Datadog), and crash dumps.

**Description:**

```typescript
// LINE 266
console.log(`[Relay] Ethereum: ${config.ethereumRpcUrl}`);
```

The docker-compose correctly treats `ethereum_rpc_url` as a Docker secret (FIX INFRA-H-03), but the relay then logs it in plaintext at startup.

**Fix:**
Mask the URL in logs:
```typescript
const maskedUrl = config.ethereumRpcUrl.replace(/(https?:\/\/[^/]+\/)[^/]+/, "$1***");
console.log(`[Relay] Ethereum: ${maskedUrl}`);
```

---

### MEDIUM-03: Hardcoded $2,000 ETH Price for Gas Cost Estimation

**File:** `relay/yield-keeper.ts` line 288  
**Severity:** MEDIUM  
**Impact:** Gas profitability calculations are based on a hardcoded ETH price of $2,000. If ETH price rises significantly, the keeper may execute unprofitable transactions. If ETH drops, it may skip profitable deployments.

**Description:**

```typescript
// LINE 288
// Rough ETH price assumption ($2000) - in production, fetch from oracle
const gasCostUsd = gasCostEth * 2000;
```

The comment even acknowledges the issue ("in production, fetch from oracle").

**Recommendation:**
Query the protocol's `PriceOracle` contract for the current ETH/USD price, or use a lightweight external API call (CoinGecko/Chainlink).

---

### MEDIUM-04: CantonSMUSD Legacy `SyncYield` Choice Bypasses Governance Co-Signer

**File:** `daml/CantonSMUSD.daml` lines ~250–265  
**Severity:** MEDIUM  
**Impact:** The `SyncYield` legacy choice is controlled by `operator` alone, while the replacement `SyncGlobalSharePrice` correctly requires `controller operator, governance`. An operator who wants to bypass governance approval can use the legacy path to set an arbitrary share price.

**Description:**

```haskell
-- Modern choice (SECURE — requires governance co-signer):
choice SyncGlobalSharePrice : ContractId CantonStakingService
  ...
  controller operator, governance   -- ✅ FIX HIGH-07

-- Legacy choice (INSECURE — operator-only):
choice SyncYield : ContractId CantonStakingService
  ...
  controller operator               -- ❌ No governance check
```

The `SyncYield` choice also lacks the ±10% share price bounds that `SyncGlobalSharePrice` enforces.

**Recommendation:**
Either remove `SyncYield` entirely or add `governance` as a co-controller with the same bounds checks.

---

### MEDIUM-05: USDCx Transfer Missing Compliance Check

**File:** `daml/CantonDirectMint.daml` lines 138–144  
**Severity:** MEDIUM  
**Impact:** `USDCx_Transfer` does NOT perform a compliance check on the recipient, unlike `CantonUSDC_Transfer` (which has FIX DAML-M-05 compliance validation) and `CantonMUSD_Transfer` (which has FIX D-M08). A blacklisted/frozen party could receive USDCx via transfer.

**Description:**

```haskell
-- CantonUSDC_Transfer (line 62) — HAS compliance check ✅
choice CantonUSDC_Transfer : ContractId CantonUSDCTransferProposal
  with
    newOwner : Party
    complianceRegistryCid : ContractId ComplianceRegistry
  controller owner
  do
    exercise complianceRegistryCid ValidateMint with minter = newOwner  -- ✅
    create CantonUSDCTransferProposal ...

-- USDCx_Transfer (line 138) — MISSING compliance check ❌
choice USDCx_Transfer : ContractId USDCxTransferProposal
  with
    newOwner : Party
  controller owner
  do
    create USDCxTransferProposal ...   -- No compliance validation
```

**Fix:**
Add a `complianceRegistryCid` parameter and exercise `ValidateTransfer` or `ValidateMint` before creating the proposal.

---

### LOW-01: Dockerfile Healthcheck Uses `localhost` While Compose Uses `127.0.0.1`

**File:** `relay/Dockerfile` line 51 vs `relay/docker-compose.yml` line 93  
**Severity:** LOW  
**Impact:** The Dockerfile HEALTHCHECK uses `http://localhost:8080/health` while docker-compose uses `http://127.0.0.1:8080/health`. In Alpine Linux with certain DNS configurations, `localhost` could resolve to `::1` (IPv6) while the server binds only to `127.0.0.1` (IPv4), causing the Dockerfile-level healthcheck to fail.

**Description:**

```dockerfile
# Dockerfile line 51
HEALTHCHECK ... CMD node -e "... http.get('http://localhost:8080/health', ..."
```

```yaml
# docker-compose.yml line 93
healthcheck:
  test: ["CMD", "node", "-e", "... http.get('http://127.0.0.1:8080/health', ..."]
```

**Fix:**
Use `127.0.0.1` consistently in both files.

---

### INFO-01: 21 Empty (0-byte) Files Across Modules

**Severity:** INFORMATIONAL  
**Impact:** No functional impact, but empty files suggest incomplete scaffolding that may confuse developers or be mistaken for functional modules.

**Files (partial list):**
- `bot/src/pendle-sniper.ts` — 0 bytes
- `bot/src/pool-alerts.ts` — 0 bytes (but `pool-alerts.log` shows the service ran — this is a different module)
- `bot/src/yield-api.ts` — 0 bytes
- `daml/CantonLoopStrategy.daml` — 0 bytes
- Multiple empty files in `frontend/src/`, `points/src/`, `subgraph/src/`

**Recommendation:**
Either populate with placeholder implementations or remove and document as "planned."

---

### INFO-02: Yield Scanner Returns Empty Array (Placeholder)

**File:** `bot/src/yield-scanner.ts`  
**Severity:** INFORMATIONAL  
**Impact:** `scanProtocols()` returns an empty array. Any code depending on yield scanning will silently receive no results.

---

### INFO-03: pool-alerts.log Committed to Repository

**File:** `bot/src/pool-alerts.log`  
**Severity:** INFORMATIONAL  
**Impact:** Log file containing Ethereum contract addresses and operational data is committed to the repository. While not containing secrets, it reveals infrastructure addresses.

**Recommendation:**
Add `*.log` to `.gitignore`.

---

## Positive Security Patterns Observed

The codebase demonstrates institutional-grade security practices that should be preserved:

### Relay Infrastructure
1. **AWS KMS signing** — Private keys never enter Node.js memory (relay-service.ts, validator-node-v2.ts)
2. **Docker secrets** — All credentials (private keys, API keys, tokens) use `/run/secrets/` with env var fallback
3. **TLS enforcement** — `enforceTLSSecurity()` + `requireHTTPS()` applied at module load
4. **secp256k1 validation** — Private key range checking prevents invalid key usage
5. **BFT supermajority** — Relay verifies `(2n/3)+1` validator signatures before submission
6. **Pre-flight simulation** — `eth_call` before `sendTransaction` catches revert reasons
7. **Chain ID verification** — Validates chain ID matches expected network at startup
8. **Bounded caches** — `processedNonces`, `recentEvents` use size limits to prevent memory growth
9. **Key rotation support** — validator-node-v2.ts supports KMS key rotation with `ROTATE_KMS_KEY_ID`
10. **Signature malleability protection** — signer.ts normalizes S-values and checks both recovery IDs

### DAML Smart Contracts
1. **Dual-signatory pattern** — All token templates require both `issuer` and `owner` as signatories
2. **Transfer proposal pattern** — Prevents forced signatory obligations (CantonMUSD, CantonSMUSD, CantonCoin, USDCx)
3. **Consuming choices** — All state-mutating operations properly archive stale contracts
4. **Compliance hooks** — Mandatory `ComplianceRegistry` checks on mint, redeem, transfer, and liquidation
5. **Privacy-preserving** — `UserPrivacySettings` with opt-in observer pattern
6. **Supply cap enforcement** — Cross-module supply coordination between DirectMint + Lending with global cap
7. **Duplicate CID deduplication** — `dedup escrowCids` prevents collateral value inflation (DAML-M-01)
8. **Per-asset staleness** — Each collateral type has its own `maxStalenessSecs` (DAML-M-03)
9. **Cooldown enforcement** — Time-based cooldowns on unstaking (D-M01), supply cap updates (HIGH-02)
10. **Governance action log archival** — GovernanceActionLog CIDs archived after use to prevent replay (DAML-H-01)

### Infrastructure
1. **SHA256-pinned Docker images** — Both Dockerfile and K8s manifests pin to digest
2. **Non-root containers** — `USER appuser`, `runAsNonRoot: true`, `readOnlyRootFilesystem: true`
3. **Network isolation** — K8s default-deny NetworkPolicy, Docker internal network
4. **Resource limits** — Memory and CPU bounds on all containers
5. **CI/CD hardening** — Slither + Mythril + Trivy + npm audit + DAML build/test

### Dependencies
- `relay/package.json` pins reasonable versions and uses `overrides` for known vulnerable transitive deps (`fast-xml-parser`, `@isaacs/brace-expansion`)
- Node.js ≥18 enforced via `engines`
- Production dependencies minimal: ethers, @daml/ledger, @aws-sdk/client-kms

---

## Dependency Audit Summary

### relay/package.json
| Package | Version | Notes |
|---------|---------|-------|
| ethers | ^6.13.0 | ✅ Current |
| @aws-sdk/client-kms | ^3.722.0 | ✅ Current |
| @daml/ledger | 2.8.0 | ⚠️ Pinned — DAML SDK 2.10.3 is used in daml.yaml but ledger SDK is 2.8.0. Version mismatch may cause type incompatibilities |
| cross-spawn | ^7.0.5 | ✅ Updated past CVE-2024-21538 |
| glob | ^11.1.0 | ✅ Current |
| tar | ^7.5.7 | ✅ Current |

### Root package.json
| Package | Version | Notes |
|---------|---------|-------|
| @openzeppelin/contracts | ^5.0.0 | ✅ Current |
| hardhat | ^2.19.0 | ✅ Current |
| dotenv | ^17.2.3 | ⚠️ Used in hardhat.config.ts — ensure `.env` files never contain `NODE_TLS_REJECT_UNAUTHORIZED=0` |

---

## Recommendations Priority Matrix

| Priority | Finding | Effort | Risk if Unpatched |
|----------|---------|--------|-------------------|
| **P0** | CRITICAL-01: Fix oracle-keeper.ts syntax | 5 min | Bot cannot deploy |
| **P0** | HIGH-01: KMS connect() region loss | 10 min | Signing fails on provider reconnect |
| **P1** | HIGH-02: Deprecate/block legacy validator | 15 min | Incompatible signatures |
| **P1** | HIGH-03: Fix TLS setter to store valid values | 10 min | Silent property mutation bugs |
| **P1** | MEDIUM-04: Remove SyncYield or add governance | 15 min | Operator can bypass price bounds |
| **P1** | MEDIUM-05: Add compliance to USDCx_Transfer | 10 min | Blacklisted party receives tokens |
| **P2** | MEDIUM-01: Migrate keepers to KMS | 2 hr | Key extractable from memory |
| **P2** | MEDIUM-02: Mask RPC URL in logs | 5 min | API key in log aggregation |
| **P2** | MEDIUM-03: Fetch live ETH price | 30 min | Inaccurate gas profitability |
| **P3** | LOW-01: Standardize healthcheck hostname | 5 min | Healthcheck may fail on IPv6 |
| **P3** | INFO-01/02/03: Cleanup empty files, scanner | 15 min | Developer confusion |

---

## Files Reviewed — No Issues Found

The following files were reviewed and found to have no security issues:

- `relay/signer.ts` — Robust DER-to-RSV conversion with malleability protection
- `relay/price-oracle.ts` — Dual-source feed with divergence detection, circuit breaker, movement caps
- `relay/lending-keeper.ts` — BigInt precision, slippage checks, fresh CID refetch, rate limiting
- `bot/src/index.ts` — Bounded approvals, Flashbots integration, proper error handling
- `bot/src/flashbots.ts` — Simulation-before-send, MEV protection
- `bot/src/monitor.ts` — View-only, no private key needed
- `daml/Compliance.daml` — Set-based O(log n) lookups, bulk cap at 100 entries
- `daml/Governance.daml` — Multi-sig proposals, timelock enforcement, proof archival
- `daml/InstitutionalAssetV4.daml` — Compliance whitelist, precision validation, emergency transfer with registry check
- `daml/InterestRateService.daml` — Compound-style kinked curve, bounded params, sequential epochs
- `daml/CantonBoostPool.daml` — sMUSD-qualified deposits, escrow escape prevention (D-M04)
- `k8s/canton/secrets.yaml` — Properly templated, no hardcoded credentials
- `k8s/canton/participant-deployment.yaml` — Pinned images, non-root, gRPC probes
- `k8s/canton/network-policy.yaml` — Default-deny, least-privilege
- `.github/workflows/ci.yml` — Comprehensive pipeline with static analysis
- `scripts/migrate-to-multisig.ts` — Proper grant-verify-revoke-verify pattern
- `scripts/deploy-testnet.ts` — Standard Hardhat deployment, no embedded secrets
- `relay/docker-compose.yml` — Secrets-based, resource-limited, network-isolated
- `relay/Dockerfile` — Multi-stage, SHA256-pinned, non-root

---

*End of audit report.*
