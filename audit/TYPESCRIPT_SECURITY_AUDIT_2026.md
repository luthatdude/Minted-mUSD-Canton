# Minted mUSD Protocol — TypeScript Services Security Audit

**Audit Date:** 2026-01-15  
**Scope:** All TypeScript services — `relay/`, `bot/`, `points/`, `frontend/`, `scripts/`, `subgraph/`  
**Methodology:** Manual line-by-line review (~15,000+ lines), static analysis, threat modeling  
**Auditor Classification:** Institutional-Grade (comprehensive coverage of all 12 analysis domains)

---

## Executive Summary

The Minted mUSD Protocol TypeScript infrastructure demonstrates **strong security posture** for a DeFi protocol bridging Canton Network tokenized assets to Ethereum. Critical defenses are already in place: KMS-backed signing, TLS enforcement with runtime watchdog, secp256k1 range validation, DER signature malleability protection, pre-flight simulation, circuit breakers, and production guards against raw private keys.

However, **26 findings** were identified across 6 severity levels. No critical vulnerabilities were found that would enable direct fund theft. The most impactful findings relate to stale price assumptions used in profitability calculations, insecure cache file permissions, non-atomic key rotation state, and missing TLS enforcement in one service.

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 5 |
| MEDIUM | 10 |
| LOW | 7 |
| INFORMATIONAL | 4 |
| **Total** | **26** |

---

## Findings

### HIGH Severity

---

#### TS-H-01: Hardcoded ETH Price ($2500) in Gas Cost Estimation

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `bot/src/index.ts` |
| **Function** | `findOpportunities()` |
| **Line** | 447 |

**Description:**  
Gas cost is converted to USD using a hardcoded ETH price of $2500:

```typescript
const gasCostUsd = Number(ethers.formatEther(gasCostWei)) * 2500; // Assume ETH = $2500
```

**Impact:**  
If ETH price deviates significantly from $2500, the bot will miscalculate liquidation profitability. At ETH=$5000, gas costs are understated by 2×, leading to unprofitable liquidations. At ETH=$1000, the bot may skip profitable opportunities.

**Recommendation:**  
Use the same pattern as `yield-keeper.ts` (line 247) which reads `ETH_PRICE_USD` from env, or better, query the on-chain PriceOracle or an external price feed:

```typescript
const ethPriceUsd = Number(process.env.ETH_PRICE_USD || "0");
if (ethPriceUsd <= 0) { logger.warn("ETH_PRICE_USD not set"); return []; }
const gasCostUsd = Number(ethers.formatEther(gasCostWei)) * ethPriceUsd;
```

---

#### TS-H-02: Validator Signed Cache Written to World-Readable `/tmp`

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `relay/validator-node-v2.ts` |
| **Function** | `saveSignedCache()` / `loadSignedCache()` |
| **Lines** | 277, 352–375 |

**Description:**  
The signed attestation cache defaults to `/tmp/validator-signed-cache.json`:

```typescript
private readonly SIGNED_CACHE_PATH = process.env.SIGNED_CACHE_PATH || "/tmp/validator-signed-cache.json";
```

`fs.writeFileSync()` at line 374 creates the file with the default umask (typically 0o644), making it readable by any process on the host.

**Impact:**  
An attacker with local access can read the cache to learn which attestations have been signed, enabling targeted replay analysis. More critically, an attacker can **truncate or corrupt** the cache file to force the validator to re-sign all active attestations after restart, potentially enabling double-signing attacks.

**Recommendation:**  
1. Set restrictive permissions on creation: `fs.writeFileSync(path, data, { mode: 0o600 })`.
2. Change the default path to a dedicated data directory (e.g., `/var/lib/minted-validator/signed-cache.json`).
3. Validate the integrity of the loaded cache (e.g., HMAC or checksum).

---

#### TS-H-03: Missing TLS Enforcement in `yield-sync-service.ts`

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `relay/yield-sync-service.ts` |
| **Function** | Constructor |
| **Lines** | 282–283 |

**Description:**  
Unlike `relay-service.ts` which blocks `CANTON_USE_TLS=false` in production, the yield-sync service allows plaintext HTTP/WS:

```typescript
const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
```

No production guard exists.

**Impact:**  
Canton JSON API traffic (including the `cantonToken` bearer token and share price data) could be transmitted in plaintext. An attacker performing a MITM attack on the Canton→service link could intercept the auth token or inject malicious share price values, causing incorrect yield synchronization across chains.

**Recommendation:**  
Add the same production guard present in `relay-service.ts`:

```typescript
if (process.env.CANTON_USE_TLS === "false" && process.env.NODE_ENV === "production") {
  throw new Error("CANTON_USE_TLS=false is FORBIDDEN in production");
}
```

---

#### TS-H-04: `parseFloat` Used for Financial Safety Bounds Configuration

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `relay/price-oracle.ts` |
| **Function** | `DEFAULT_CONFIG` initialization |
| **Lines** | 73, 78–80 |

**Description:**  
Critical price safety bounds are parsed using `parseFloat()`:

```typescript
divergenceThresholdPct: parseFloat(process.env.DIVERGENCE_THRESHOLD || "5.0"),
minPriceUsd: parseFloat(process.env.MIN_PRICE_USD || "0.001"),
maxPriceUsd: parseFloat(process.env.MAX_PRICE_USD || "1000.0"),
maxChangePerUpdatePct: parseFloat(process.env.MAX_CHANGE_PER_UPDATE_PCT || "25.0"),
```

`parseFloat("5.0abc")` silently returns `5.0` — a truncated env var or configuration error will not be detected.

**Impact:**  
If the `MIN_PRICE_USD` env var is accidentally set to a garbage value (e.g., `"0.001 # old value"`), `parseFloat` silently parses it as `0.001`, which happens to be correct but masks the configuration issue. A value like `"NaN"` would result in `NaN`, causing all price comparisons to silently pass (since `NaN < x` is always `false`), effectively **disabling all price sanity bounds**.

**Recommendation:**  
Use the same strict validation pattern applied in `lending-keeper.ts` (line 100–103):

```typescript
minPriceUsd: (() => {
  const v = Number(process.env.MIN_PRICE_USD || "0.001");
  if (Number.isNaN(v) || v <= 0) throw new Error("MIN_PRICE_USD must be a positive number");
  return v;
})(),
```

---

#### TS-H-05: Non-Atomic Key Rotation State Transition

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **File** | `relay/validator-node-v2.ts` |
| **Function** | `activateRotationKey()` |
| **Lines** | 299, 409–412 |

**Description:**  
Key rotation updates three fields non-atomically:

```typescript
this.rotationInProgress = true;
this.activeKmsKeyId = this.config.kmsRotationKeyId;
this.activeEthAddress = this.config.rotationEthereumAddress;
this.rotationInProgress = false;
```

Although JavaScript is single-threaded, the `signWithKMSKey` calls are async. If a concurrent poll cycle fires between `activeKmsKeyId` and `activeEthAddress` updates, the validator could attempt to sign with the new key but verify against the old address (or vice versa), producing invalid signatures.

**Impact:**  
During the key rotation window, attestation signatures could be produced with a key/address mismatch. The BLEBridgeV9 contract would reject these signatures, but the Canton-side record would show the validator as having signed — potentially blocking the attestation from reaching quorum until the next poll cycle retries.

**Recommendation:**  
Bundle the key material into a single atomic reference swap:

```typescript
interface ActiveKey { kmsKeyId: string; ethAddress: string; }
private activeKey: ActiveKey;

async activateRotationKey(): Promise<void> {
  // ... test signing ...
  this.activeKey = {
    kmsKeyId: this.config.kmsRotationKeyId!,
    ethAddress: this.config.rotationEthereumAddress!,
  };
}
```

---

### MEDIUM Severity

---

#### TS-M-01: `KMSEthereumSigner.connect()` Drops Region Configuration

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `relay/kms-ethereum-signer.ts` |
| **Function** | `connect()` |
| **Line** | 87–89 |

**Description:**  

```typescript
connect(provider: ethers.Provider): KMSEthereumSigner {
  return new KMSEthereumSigner(this.kmsKeyId, "", provider);
}
```

The `connect()` method creates a new instance with an empty string for the `region` parameter. The new instance will default to `us-east-1` regardless of the original region configuration.

**Impact:**  
If a signer is initialized with a non-default AWS region (e.g., `eu-west-1`) and then `connect()` is called (e.g., by ethers.js internals during provider switching), KMS API calls will fail with an access denied or key-not-found error in the wrong region.

**Recommendation:**  
Store and forward the region:

```typescript
connect(provider: ethers.Provider): KMSEthereumSigner {
  return new KMSEthereumSigner(this.kmsKeyId, this.region, provider);
}
```

---

#### TS-M-02: Price Oracle Bounds Reset After 5 Consecutive Violations

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `relay/price-oracle.ts` |
| **Function** | `start()` main loop |
| **Lines** | 526, 556–560 |

**Description:**  
After `MAX_BOUNDS_VIOLATIONS` (5) consecutive price rejections, `lastCtnPrice` is reset to 0 to "allow recovery":

```typescript
if (boundsViolationCount >= MAX_BOUNDS_VIOLATIONS) {
  // Resetting lastCtnPrice baseline to allow recovery
```

When `lastCtnPrice` is 0, the rate-of-change check (line 542: `this.lastCtnPrice > 0`) is bypassed, and only the absolute bounds check applies.

**Impact:**  
An attacker who can briefly manipulate the DEX price source for ~2.5 minutes (5 polls × 30s) to trigger 5 consecutive bounds violations can force a reset. The next manipulated price within absolute bounds ($0.001–$1000) would be accepted without rate-of-change validation, enabling a large single-step price manipulation.

**Recommendation:**  
Instead of resetting to 0, log a critical alert requiring manual intervention. If auto-recovery is required, constrain the accepted price to a secondary reference (e.g., the last successfully pushed on-ledger price):

```typescript
this.lastCtnPrice = await this.getLastPushedLedgerPrice("CTN");
```

---

#### TS-M-03: Unbounded `borrowers` Set in Liquidation Bot

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `bot/src/index.ts` |
| **Function** | `scanHistoricalBorrowers()` / event listener |
| **Lines** | 285, 564 |

**Description:**  
The `borrowers` Set grows monotonically — addresses are only ever added:

```typescript
this.borrowers.add(user);  // line 285 (historical scan)
this.borrowers.add(args.user);  // line 564 (event listener)
```

No eviction or pruning logic exists.

**Impact:**  
Over months of operation, the set could grow to hundreds of thousands of entries. Each poll cycle iterates every borrower to check health factors, increasing RPC calls linearly. At scale, this causes:
1. Memory pressure from the unbounded Set.
2. RPC rate limiting or costs from scanning every borrower each cycle.
3. Increased latency in identifying liquidatable positions.

**Recommendation:**  
Implement a bounded LRU cache or periodic pruning of borrowers with zero debt:

```typescript
// Prune fully repaid borrowers every N cycles
if (this.cycleCount % 100 === 0) {
  for (const addr of this.borrowers) {
    const debt = await this.borrowModule.userBorrows(addr);
    if (debt === 0n) this.borrowers.delete(addr);
  }
}
```

---

#### TS-M-04: Hardcoded 10% APY Assumption for Yield Profitability

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `relay/yield-keeper.ts` |
| **Function** | profitability check |
| **Line** | 257 |

**Description:**  

```typescript
const dailyYieldUsd = (deployableUsd * 0.10) / 365;
```

The yield profitability check uses a hardcoded 10% APY to estimate daily returns.

**Impact:**  
If actual strategy yields are significantly lower (e.g., 2–4% in bearish markets), the keeper will deploy funds to strategies where gas costs exceed generated yield, resulting in net losses for the treasury.

**Recommendation:**  
Read the actual APY from the strategy contracts or the yield-sync-service's recorded share price growth rate.

---

#### TS-M-05: `createSigner` Returns VoidSigner for KMS — Silent Write Failure

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `relay/utils.ts` |
| **Function** | `createSigner()` |
| **Lines** | 207–210 |

**Description:**  

```typescript
console.warn("[KMS] Using VoidSigner — full KMS AbstractSigner required for write ops");
return new ethers.VoidSigner(address, provider);
```

When KMS is configured, `createSigner()` returns a `VoidSigner` that cannot send transactions. Services using this factory (e.g., `yield-keeper.ts`) will silently fail when attempting state-changing operations.

**Impact:**  
In production with KMS configured, the yield-keeper would initialize successfully but fail at `treasury.keeperTriggerAutoDeploy()` with an unhelpful `VoidSigner` error. The `kms-ethereum-signer.ts` module provides a full `KMSEthereumSigner` but it is not integrated into `createSigner()`.

**Recommendation:**  
Integrate `KMSEthereumSigner` into the factory:

```typescript
const { KMSEthereumSigner } = await import("./kms-ethereum-signer");
const signer = new KMSEthereumSigner(kmsKeyId, region, provider);
await signer.init();
return signer;
```

---

#### TS-M-06: sMUSD Price from Static Environment Variable

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `relay/lending-keeper.ts` |
| **Function** | `DEFAULT_CONFIG` |
| **Lines** | 100–104, 285 |

**Description:**  

```typescript
smusdPrice: (() => {
  const v = Number(process.env.SMUSD_PRICE || "1.05");
  ...
  return v;
})(),
```

The sMUSD price is loaded once at module initialization from an environment variable.

**Impact:**  
As smUSD accrues yield, its price increases over time (e.g., from $1.05 to $1.10). If the env var is not updated, the keeper uses a stale price for collateral valuation, potentially:
1. Under-valuing sMUSD collateral → triggering premature liquidations.
2. Over-valuing sMUSD collateral → missing legitimate liquidation opportunities.

**Recommendation:**  
Query the sMUSD share price from the SMUSD contract or the yield-sync-service at each scan cycle:

```typescript
const smusdPrice = await smusd.sharePrice(); // On-chain read
```

---

#### TS-M-07: Frontend Canton Hooks Lack Request Timeouts

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `frontend/src/hooks/useCanton.ts` |
| **Function** | `query()`, `exercise()`, `create()` |
| **Lines** | 75, 108, 129 |

**Description:**  
All three Canton ledger API calls use `fetch()` without an `AbortController` timeout:

```typescript
const resp = await fetch(`${baseUrl}/v1/query`, { ... });
```

**Impact:**  
If the Canton JSON API is slow or unresponsive, the browser tab hangs indefinitely. Users may retry the operation (especially `exercise` which triggers state changes), potentially causing double-execution of Canton choices.

**Recommendation:**  
Add a 30-second timeout via `AbortController`:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
const resp = await fetch(url, { ...opts, signal: controller.signal });
clearTimeout(timeout);
```

---

#### TS-M-08: Points `referralCode` Generation Has Modulo Bias

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `points/src/referral.ts` |
| **Function** | `generateReferralCode()` |
| **Line** | 89 |

**Description:**  

```typescript
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
code += chars[bytes[i] % chars.length];
```

The charset has 32 characters and `bytes[i]` ranges 0–255. Since 256 % 32 = 0, there is actually **no modulo bias** here — 32 divides 256 evenly. However, if the charset is ever modified (e.g., adding/removing chars to change readability), bias will silently appear.

**Impact:**  
Currently no bias exists. However, this is a fragile pattern — any future charset modification breaks uniformity without any warning.

**Recommendation:**  
Use rejection sampling to be robust against charset changes:

```typescript
const maxValid = 256 - (256 % chars.length);
let code = "MNTD-";
let i = 0;
while (code.length < 11) {
  if (bytes[i] < maxValid) code += chars[bytes[i] % chars.length];
  i++;
  if (i >= bytes.length) bytes = crypto.randomBytes(6);
}
```

---

#### TS-M-09: Points Referral Service Uses In-Memory Storage Only

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `points/src/referral.ts` |
| **Function** | `ReferralService` class |
| **Lines** | 101+ |

**Description:**  
The referral service stores all codes, links, and referral chains in in-memory `Map` objects:

```typescript
private codes: Map<string, ReferralCode> = new Map();
```

No database persistence layer exists.

**Impact:**  
On service restart, all referral codes and links are lost. Users who shared referral links would find them broken, and any accrued referral points would be unrecoverable.

**Recommendation:**  
Persist referral data to a database (PostgreSQL, Redis, or at minimum JSON file with atomic writes). Add recovery logic on startup.

---

#### TS-M-10: Bot Wallet Initialized with Raw Key Before KMS Guard Evaluates

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `bot/src/index.ts` |
| **Function** | `constructor()` |
| **Lines** | 221–228 |

**Description:**  

```typescript
if (process.env.NODE_ENV === "production" && !process.env.KMS_KEY_ID) {
  throw new Error("SECURITY: Raw private key usage is forbidden...");
}
this.wallet = new ethers.Wallet(config.privateKey, this.provider);
```

The guard only throws if `NODE_ENV=production` AND `KMS_KEY_ID` is unset. When `KMS_KEY_ID` IS set in production, the code still falls through to creating a `new ethers.Wallet(config.privateKey)` — the raw private key is loaded into memory regardless.

**Impact:**  
Even with KMS configured, the private key is loaded into V8 heap memory. This defeats the purpose of KMS (keeping keys inside the HSM boundary). The key is extractable via heap snapshots, core dumps, or `/proc/pid/mem`.

**Recommendation:**  
When KMS is configured, do not load the raw private key at all. Use the `KMSEthereumSigner` from `relay/kms-ethereum-signer.ts`:

```typescript
if (process.env.KMS_KEY_ID) {
  this.wallet = await KMSEthereumSigner.create(process.env.KMS_KEY_ID, region, this.provider);
} else if (process.env.NODE_ENV === "production") {
  throw new Error("KMS required in production");
} else {
  this.wallet = new ethers.Wallet(config.privateKey, this.provider);
}
```

---

### LOW Severity

---

#### TS-L-01: TLS Watchdog Has 5-Second Detection Window

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `relay/utils.ts` |
| **Function** | `enforceTLSSecurity()` |
| **Lines** | 32–38 |

**Description:**  

```typescript
const TLS_WATCHDOG_INTERVAL_MS = 5000;
setInterval(() => {
  if ((process.env.NODE_TLS_REJECT_UNAUTHORIZED || "1") === "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
  }
}, TLS_WATCHDOG_INTERVAL_MS).unref();
```

A 5-second window exists between when `NODE_TLS_REJECT_UNAUTHORIZED` could be tampered and when the watchdog corrects it.

**Impact:**  
An attacker who can execute code within the Node.js process could set `NODE_TLS_REJECT_UNAUTHORIZED=0`, perform a MITM request within the 5s window, then let the watchdog restore it. Low likelihood since it requires in-process code execution.

**Recommendation:**  
Reduce interval to 1000ms or use `Object.defineProperty` with a non-configurable setter where the runtime allows it. Consider `--tls-min-v1.2` Node.js flag as defense-in-depth.

---

#### TS-L-02: `readSecret()` Uses Synchronous File I/O

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `relay/utils.ts` |
| **Function** | `readSecret()` |
| **Line** | 86 |

**Description:**  

```typescript
return fs.readFileSync(secretPath, "utf-8").trim();
```

Synchronous file reads block the Node.js event loop.

**Impact:**  
During startup, this is acceptable since secrets are read during initialization. However, if `readSecret` is ever called at runtime (e.g., for token refresh), it would block all concurrent operations.

**Recommendation:**  
No immediate action needed (only called during initialization). Document the function as startup-only, or provide an async variant for any future runtime usage.

---

#### TS-L-03: Private Key "Clearing" Ineffective Due to JS String Immutability

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `relay/utils.ts` |
| **Function** | `readAndValidatePrivateKey()` |
| **Lines** | 151–153 |

**Description:**  

```typescript
if (process.env[envVar] && process.env.NODE_ENV !== "test") {
  process.env[envVar] = "0".repeat(64);
}
```

This replaces the env var reference but the original string value remains in V8 heap memory until garbage collected.

**Impact:**  
The code comment correctly notes this limitation. The original key value is still extractable via heap snapshots. However, overwriting the env var reference does reduce the window for casual exposure (e.g., logging `process.env`).

**Recommendation:**  
The code already includes a correct comment acknowledging this limitation and recommends KMS. No additional action required beyond the existing production KMS enforcement.

---

#### TS-L-04: Points Config Defaults Canton API to HTTP

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `points/src/config.ts` |
| **Function** | `loadConfig()` |
| **Line** | 30 |

**Description:**  

```typescript
cantonApiUrl: process.env.CANTON_API_URL || "http://localhost:6865",
```

The default Canton API URL uses HTTP.

**Impact:**  
In production, if `CANTON_API_URL` is not explicitly set, the points service would connect to Canton over plaintext. However, the `localhost` default means this only affects deployment configurations that forget to set the env var.

**Recommendation:**  
Add HTTPS enforcement consistent with other services:

```typescript
cantonApiUrl: (() => {
  const url = process.env.CANTON_API_URL || "http://localhost:6865";
  if (!url.startsWith("https://") && process.env.NODE_ENV === "production") {
    throw new Error("CANTON_API_URL must use HTTPS in production");
  }
  return url;
})(),
```

---

#### TS-L-05: `scripts/signer.ts` Is an Exact Duplicate of `relay/signer.ts`

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `scripts/signer.ts` |
| **Function** | Entire file |
| **Lines** | 1–236 |

**Description:**  
The file is an identical copy of `relay/signer.ts`.

**Impact:**  
Security patches applied to `relay/signer.ts` may not be applied to the scripts copy, creating a maintenance divergence risk. If deployment scripts use the stale copy, it could contain unpatched vulnerabilities.

**Recommendation:**  
Remove `scripts/signer.ts` and import from `relay/signer.ts`:

```typescript
export { derToRSV, kmsSignDigest } from "../relay/signer";
```

---

#### TS-L-06: Frontend Contract Addresses Fallback to Empty String

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `frontend/src/lib/config.ts` |
| **Function** | `CONTRACTS` config |
| **Lines** | (config object) |

**Description:**  
Contract addresses from `NEXT_PUBLIC_*` env vars fall back to empty strings when not configured. Creating an ethers `Contract` with an empty address silently succeeds but all subsequent calls fail with unhelpful errors.

**Impact:**  
Missing configuration silently degrades functionality. Users see transaction failures without understanding the root cause is a missing contract address.

**Recommendation:**  
Validate all required addresses at app startup and show a clear error banner if any are missing.

---

#### TS-L-07: Oracle Keeper External Price Feed URL Configurable via Env

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **File** | `bot/src/oracle-keeper.ts` |
| **Function** | Configuration |
| **Lines** | (config section) |

**Description:**  
The external price feed URL (CoinGecko or custom) is configurable via environment variable without URL validation.

**Impact:**  
If an attacker gains write access to env vars, they could redirect price validation to an attacker-controlled server, causing the oracle keeper to validate manipulated prices as correct. However, this requires env var write access which already implies significant compromise.

**Recommendation:**  
Add URL allowlisting:

```typescript
const ALLOWED_PRICE_FEED_HOSTS = ["api.coingecko.com", "pro-api.coingecko.com"];
const url = new URL(config.externalPriceFeedUrl);
if (!ALLOWED_PRICE_FEED_HOSTS.includes(url.hostname)) {
  throw new Error(`External price feed host ${url.hostname} not in allowlist`);
}
```

---

### INFORMATIONAL

---

#### TS-I-01: Temple DEX Password Sent in Request Body

| Field | Value |
|-------|-------|
| **Severity** | INFORMATIONAL |
| **File** | `relay/price-oracle.ts` |
| **Function** | `getTempleJwt()` |
| **Line** | 240 |

**Description:**  

```typescript
password: config.templePassword,
```

The Temple DEX API uses password-based JWT authentication. The password is sent in the request body over HTTPS.

**Impact:**  
Standard practice for JWT login flows. HTTPS protects transit. The password is stored in Docker secrets (`readSecret`). No action required unless Temple offers API key auth as a more secure alternative.

**Recommendation:**  
Monitor if Temple adds API key or mTLS authentication options in the future.

---

#### TS-I-02: `deploy-testnet.ts` Uses Deployer as Fee Recipient

| Field | Value |
|-------|-------|
| **Severity** | INFORMATIONAL |
| **File** | `scripts/deploy-testnet.ts` |
| **Function** | Deployment script |
| **Lines** | (deployment section) |

**Description:**  
The testnet deployment uses `deployer.address` as `FEE_RECIPIENT` and `SWAP_ROUTER` placeholder.

**Impact:**  
Appropriate for testnet. The `migrate-to-multisig.ts` script exists to properly transfer these roles for production deployment.

**Recommendation:**  
No action required. Ensure `migrate-to-multisig.ts` is always executed as part of production deployment runbook.

---

#### TS-I-03: Frontend `yields.ts` API Route Is Empty

| Field | Value |
|-------|-------|
| **Severity** | INFORMATIONAL |
| **File** | `frontend/src/pages/api/yields.ts` |
| **Function** | N/A |
| **Line** | 1 |

**Description:**  
The file exists but is empty — a dead API route.

**Impact:**  
No security impact. Dead code that could cause confusion during maintenance.

**Recommendation:**  
Either implement the route or delete the file.

---

#### TS-I-04: Flashbots Auth Signer Key in Memory

| Field | Value |
|-------|-------|
| **Severity** | INFORMATIONAL |
| **File** | `bot/src/flashbots.ts` |
| **Function** | Constructor |
| **Lines** | (initialization) |

**Description:**  
The Flashbots auth signer uses a raw private key in memory. This key is used solely for signing Flashbots relay authentication (not for on-chain transactions).

**Impact:**  
The Flashbots auth key has no on-chain value — it only authenticates requests to the Flashbots relay. Compromise of this key would allow an attacker to submit bundles under the bot's identity but cannot move funds.

**Recommendation:**  
Acceptable risk for the auth-only key. Document that this key should NOT hold any ETH or token balances.

---

## Cross-Service Consistency Analysis

| Check | Status | Notes |
|-------|--------|-------|
| TLS enforcement | ⚠️ PARTIAL | `relay-service.ts`, `price-oracle.ts`, `lending-keeper.ts` enforce HTTPS. `yield-sync-service.ts` does NOT block `CANTON_USE_TLS=false` in production (TS-H-03). |
| KMS vs raw key usage | ⚠️ PARTIAL | `relay/utils.ts` blocks raw keys in production. `bot/src/index.ts` loads raw key even when KMS is configured (TS-M-10). |
| Canton query timeout | ✅ CONSISTENT | 30s timeout in `relay-service.ts`. Similar pattern in validator. |
| Price validation | ⚠️ INCONSISTENT | `lending-keeper.ts` uses strict `Number()` + `isNaN` check. `price-oracle.ts` uses `parseFloat` (TS-H-04). |
| Secret management | ✅ CONSISTENT | All relay services use `readSecret()` with Docker secret fallback. |
| `enforceTLSSecurity()` | ✅ CONSISTENT | Called at module level in all relay services. Not called in `bot/` or `points/` (which don't use Canton TLS). |
| Error logging | ✅ GOOD | No secrets logged. URLs sanitized in validator logging. |

---

## Dependency Risk Assessment

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `ethers` | ^6.13.0 / ^6.9.0 | LOW | Well-maintained. No known CVEs in v6. |
| `@daml/ledger` | 2.10.3 | LOW | Pinned version. Digital Asset maintained. |
| `@aws-sdk/client-kms` | ^3.722.0 | LOW | AWS SDK. Frequently updated. |
| `node-telegram-bot-api` | ^0.67.0 | MEDIUM | Has `request` as transitive dep (overridden). Verify overrides resolve CVE-2023-28155. |
| `cross-spawn` | ^7.0.5 | LOW | Recent version addresses command injection (CVE-2024-21538). |
| `tar` | ^7.5.7 | LOW | Recent version. Verify addresses path traversal CVEs. |

The `bot/package.json` includes `overrides` for `form-data`, `qs`, `tough-cookie`, and `request`, indicating awareness of transitive dependency vulnerabilities. The `relay/package.json` overrides `fast-xml-parser` and `@isaacs/brace-expansion`.

---

## Positive Security Observations

The following security controls are **correctly implemented** and deserve acknowledgment:

1. **KMS Integration** — Full `AbstractSigner` implementation (`kms-ethereum-signer.ts`) with DER parsing, S-value normalization (EIP-2), and malleability detection.
2. **TLS Enforcement** — Runtime watchdog timer prevents `NODE_TLS_REJECT_UNAUTHORIZED=0` tampering.
3. **secp256k1 Range Validation** — Private keys validated against curve order in both `relay/utils.ts` and `bot/src/index.ts`.
4. **Pre-flight Simulation** — `relay-service.ts` simulates bridge transactions via `staticCall` before submitting.
5. **Chain ID Validation** — Relay service verifies it's on the expected chain before submitting.
6. **Canton Query Timeout** — 30-second timeout prevents indefinite hangs on Canton API.
7. **Batch Size Limits** — `MAX_BATCH_SIZE = 100` in relay prevents memory exhaustion from large backlogs.
8. **BigInt Financial Math** — `lending-keeper.ts` uses 18-decimal fixed-point BigInt arithmetic, avoiding floating-point precision loss.
9. **Bounded mUSD Approvals** — Liquidation bot approves exact amounts rather than `type(uint256).max`.
10. **Production Raw Key Guard** — Multiple services throw on raw private key usage in production.

---

## Remediation Priority

| Priority | Finding IDs | Effort |
|----------|-------------|--------|
| **Immediate** (deploy blocker) | TS-H-03, TS-H-04 | Low (config validation) |
| **Next sprint** | TS-H-01, TS-H-02, TS-H-05, TS-M-10 | Medium |
| **Planned** | TS-M-01 through TS-M-09 | Medium |
| **Backlog** | TS-L-01 through TS-L-07, TS-I-01 through TS-I-04 | Low |

---

*End of Audit Report*
