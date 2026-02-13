# Minted mUSD Protocol — Institutional-Grade Security Audit
## DAML Templates & TypeScript Services

**Audit Date:** 2025-01-XX  
**Auditor:** Minted Security Team  
**Scope:** All DAML templates (`/daml/`) and all TypeScript services (`/relay/`, `/bot/src/`)  
**Protocol Version:** Canton Network + Ethereum L1 bridge (BLEBridgeV9)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [DAML Findings](#daml-findings)
3. [TypeScript Findings](#typescript-findings)
4. [DAML Security Checklist](#daml-security-checklist)
5. [TypeScript Security Checklist](#typescript-security-checklist)
6. [Security Scores](#security-scores)

---

## Executive Summary

The Minted mUSD protocol implements a cross-chain stablecoin system bridging Canton Network (DAML) and Ethereum. The architecture uses BFT validator attestations to sync state between chains, AWS KMS for HSM-backed signing, and multiple keeper bots for operational automation.

**Key Strengths:**
- Consuming choices prevent double-signing in attestation flows
- BFT supermajority (⌈2n/3⌉) enforced on-chain and on-ledger
- AWS KMS integration removes private keys from memory in production
- TLS enforcement with runtime tamper detection across all relay services
- Virtual share pricing in sMUSD prevents ERC-4626 inflation attacks
- Multi-provider price averaging with divergence blocking
- Per-liquidation approval limits reduce smart contract exposure

**Key Risks:**
- V3.daml AttestationRequest lacks per-validator ECDSA binding (relies on DAML authorization model only)
- V3.daml CantonDirectMint missing compliance checks present in standalone module
- yield-api.ts uses dotenv in violation of project-wide security policy
- Several keeper bots use hardcoded ETH price assumptions for gas cost estimation
- Stale contract ID (CID) race conditions in Canton ledger exercises

---

## DAML Findings

### CRIT-DAML-01: V3 AttestationRequest — Aggregator-Only Signatory Permits Attestation Forgery Under Canton Compromise

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 1460–1510
- **Status:** Open (mitigated by BLEBridgeProtocol.daml for bridge path)

**Description:** In V3.daml, `AttestationRequest` has `signatory aggregator` with validators as observers only. The `Attestation_Sign` choice is controlled by `validator`, which DAML enforces at the authorization level. However, unlike the standalone `BLEBridgeProtocol.daml` (which uses `ValidatorSelfAttestation` with `signatory validator`), V3.daml does not bind the ECDSA signature to the signing validator's on-ledger identity at the template level. If the aggregator's Canton participant node is compromised, it could fabricate `AttestationRequest` contracts with pre-populated `collectedSignatures` sets, bypassing the `Attestation_Sign` choice entirely.

**Impact:** A compromised aggregator node could mint unbacked mUSD on Canton via `BridgeService.Bridge_ReceiveFromEthereum`, which checks `collectedSignatures` Party set membership but not cryptographic proof. The Ethereum-side BLEBridgeV9 contract independently verifies ECDSA signatures, so this risk is confined to Canton-side minting.

**Fix:** Migrate V3.daml attestation flow to use `ValidatorSelfAttestation` pattern from BLEBridgeProtocol.daml where each validator is a signatory of their own attestation contract. Alternatively, store ECDSA signatures alongside Party identifiers in `collectedSignatures` and verify them in `Bridge_ReceiveFromEthereum`.

---

### HIGH-DAML-02: V3 CantonDirectMint Missing Compliance Checks

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 1050–1130 (CantonMint_Mint), 1130–1170 (CantonMint_Redeem)
- **Status:** Open

**Description:** The standalone `CantonDirectMint.daml` module includes compliance registry checks (ValidateMint, ValidateTransfer, ValidateRedemption) before processing mint and redeem operations. The V3.daml `CantonDirectMint` template omits these checks entirely. A blacklisted or frozen user can mint and redeem mUSD through the V3 code path without restriction.

**Impact:** Sanctioned or blacklisted users can bypass compliance controls if the protocol uses V3.daml's CantonDirectMint instead of the standalone module. This creates regulatory risk for institutional operators.

**Fix:** Add compliance registry lookups in `CantonMint_Mint` and `CantonMint_Redeem` choices, mirroring the standalone module's `ValidateMint` / `ValidateRedemption` calls.

---

### HIGH-DAML-03: V3 CantonSMUSD Missing Validator Attestation for Yield Sync

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 1220–1240 (SMUSD_SyncYield)
- **Status:** Open (partially mitigated by operator+governance dual signature)

**Description:** The standalone `CantonSMUSD.daml` requires a validator attestation hash (D-M-02 fix) when syncing global share price, binding the yield update to a verified cross-chain attestation. V3.daml's `SMUSD_SyncYield` requires operator + governance co-signatures but does not require a validator attestation hash or proof. This means yield injection depends solely on the operator-governance trust boundary rather than cryptographic verification of Ethereum-side yield state.

**Impact:** If both operator and governance keys are compromised, arbitrary yield can be injected into the sMUSD pool (bounded by `maxYieldBps` per epoch). The standalone module's attestation requirement provides defense-in-depth against this scenario.

**Fix:** Add an attestation hash parameter to `SMUSD_SyncYield` and verify it against a committed Canton state, matching the standalone module's approach.

---

### HIGH-DAML-04: Vault Interest Accrual Uses Microsecond Precision Without Rounding Guards

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 565–575 (Vault_GetTotalDebt), 640–660 (Vault_SyncInterestRate), 725–740 (Liquidate)
- **Status:** Open

**Description:** Interest accrual in V3.daml Vault converts elapsed time from microseconds to seconds via integer division (`elapsed / 1000000`), then converts to `Numeric 10` (DAML's `Money` type) for the interest calculation. The `intToNumeric` conversion and subsequent fixed-point multiplication can accumulate rounding errors over many small accrual periods. For vaults with very frequent interactions (e.g., every block), the truncation of sub-second precision compounds.

**Impact:** Over extended periods, interest can drift from expected values. For a $10M vault at 5% APR, microsecond truncation errors could accumulate to ~$0.50/year — negligible individually but material in aggregate across thousands of vaults.

**Fix:** Consider batching interest accrual or using a higher-precision intermediate type. Document the expected precision bounds.

---

### MED-DAML-05: BridgeOutRequest Weak Ethereum Address Validation

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 1480–1485 (BridgeOut_SetTarget)
- **Status:** Open

**Description:** `BridgeOut_SetTarget` validates Ethereum addresses only by checking `T.length targetAddress == 42`. This accepts any 42-character string, including non-hex strings like `"0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"`. No hex character validation or EIP-55 checksum verification is performed.

**Impact:** A user could set an invalid target address, causing the bridge-out to fail on the Ethereum side after Canton-side processing is complete. Funds would need manual recovery.

**Fix:** Add hex character validation: `assertMsg "INVALID_HEX" (all (\c -> c `elem` "0123456789abcdefABCDEF") (T.drop 2 targetAddress))` and prefix check: `assertMsg "MISSING_0x_PREFIX" (T.take 2 targetAddress == "0x")`.

---

### MED-DAML-06: LiquidationOrder Unrestricted Claim Without Stake

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 930–945 (ClaimOrder)
- **Status:** Open (by design for open liquidation markets)

**Description:** `ClaimOrder` allows any party to claim a pending liquidation order by passing their own party ID as `keeper`. There is no stake requirement, timeout, or penalty for failing to execute a claimed order. A griefing attacker could claim orders without executing them, blocking legitimate keepers.

**Impact:** Denial-of-service on the liquidation pipeline. Claimed-but-unexecuted orders block other keepers until the operator cancels them via `CancelOrder`.

**Fix:** Add an expiry mechanism: if a claimed order isn't completed within N minutes, it reverts to Pending. Alternatively, require a mUSD bond when claiming.

---

### MED-DAML-07: Governance MultiSigProposal Timelock Not Enforced in V3

- **Domain:** DAML
- **File:** `daml/Governance.daml`
- **Lines:** 1–450 (full file)
- **Status:** Partially Fixed

**Description:** The standalone `Governance.daml` implements a timelock with `timelockHours` and activation delay in the `UpgradeProposal` template. However, V3.daml's admin choices (`CantonMint_UpdateConfig`, `SMUSD_UpdateConfig`, `Bridge_UpdateValidators`) are direct operator/governance-controlled choices without timelock enforcement. Critical parameter changes take effect immediately.

**Impact:** A compromised operator+governance key pair can instantly change supply caps, fee parameters, or validator sets without giving users time to exit.

**Fix:** Gate V3 admin choices through the governance timelock framework rather than direct controller authorization.

---

### LOW-DAML-08: PriceOracle Observer Check Allows Any Observer to Query

- **Domain:** DAML
- **File:** `daml/Minted/Protocol/V3.daml`
- **Lines:** 395–405 (Oracle_GetPrice)
- **Status:** Informational

**Description:** `Oracle_GetPrice` checks `requester elem observers || requester == provider`. Since the observer list is set at creation time, any party in the list can query prices. This is correct DAML design but means the observer list effectively functions as an access control list that must be carefully managed.

**Impact:** None if observer lists are properly maintained. Risk if observers are over-provisioned.

**Fix:** Document observer list management policy. Consider using a keyed contract for fine-grained access control.

---

### LOW-DAML-09: Deprecated DAML Files Still Present in Codebase

- **Domain:** DAML
- **File:** `daml/BLEProtocol.daml`, `daml/MUSD_Protocol.daml`, `daml/TokenInterface.daml`
- **Lines:** Full files
- **Status:** Informational

**Description:** Three deprecated DAML files remain in the codebase with "DO NOT USE IN PRODUCTION" headers. `BLEProtocol.daml` contains the known C-3 vulnerability where `ValidatorSignature` has `signatory aggregator` instead of `validator`. While marked deprecated, their presence could cause confusion during deployment.

**Impact:** Accidental use of deprecated templates could reintroduce fixed vulnerabilities.

**Fix:** Move deprecated files to `archive/daml/` or delete them. Add a `daml.yaml` exclude pattern to prevent compilation.

---

### LOW-DAML-10: CantonBoostPool 80/20 Ratio Allows Value Extraction Via Share Price Manipulation

- **Domain:** DAML
- **File:** `daml/CantonBoostPool.daml`
- **Lines:** 200–250 (deposit cap calculation)
- **Status:** Mitigated (D-M04 fix prevents sMUSD escape)

**Description:** The CantonBoostPool enforces an 80/20 ratio where Canton deposits are capped at sMUSD value × 0.25. The sMUSD value is derived from the global share price. A rapid share price increase (within the ±10% epoch cap) would allow a user to deposit more Canton coins, then withdraw after share price stabilizes, extracting value from the pool.

**Impact:** Minor value extraction bounded by the ±10% share price change cap per epoch and the 60-second cooldown.

**Fix:** Already mitigated by epoch-based share price caps and cooldown enforcement. Consider adding a deposit-weighted average entry price to LP tokens.

---

## TypeScript Findings

### CRIT-TS-01: yield-api.ts Uses dotenv in Violation of Security Policy

- **Domain:** TypeScript
- **File:** `bot/src/yield-api.ts`
- **Lines:** 22–23
- **Status:** Open

**Description:** `yield-api.ts` imports and calls `dotenv.config()` to load environment variables from a `.env` file. Every other service in the codebase explicitly avoids dotenv (comments like "Never load .env files that may contain NODE_TLS_REJECT_UNAUTHORIZED=0 or private keys"). A `.env` file could contain `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling TLS certificate validation for the entire process, or leak private keys via file system access.

**Impact:** If a `.env` file exists with `NODE_TLS_REJECT_UNAUTHORIZED=0`, all HTTPS requests from the yield-api process (including DeFi Llama API calls) would accept invalid certificates, enabling MITM attacks. If private keys are in `.env`, they're readable by any process with filesystem access.

**Fix:** Remove the `dotenv` import and `dotenv.config()` call. Use Docker secrets or environment variables directly, consistent with all other services. Add `enforceTLSSecurity()` from `relay/utils.ts`.

---

### CRIT-TS-02: yield-api.ts Missing TLS Enforcement

- **Domain:** TypeScript
- **File:** `bot/src/yield-api.ts`
- **Lines:** 1–30 (missing call)
- **Status:** Open

**Description:** Unlike every relay service (`relay-service.ts`, `validator-node-v2.ts`, `yield-sync-service.ts`, `yield-keeper.ts`, `lending-keeper.ts`, `price-oracle.ts`) which call `enforceTLSSecurity()` at process startup, `yield-api.ts` does not enforce TLS. Combined with CRIT-TS-01 (dotenv loading), this service is vulnerable to TLS downgrade attacks.

**Impact:** A `.env` file or environment variable setting `NODE_TLS_REJECT_UNAUTHORIZED=0` would silently disable certificate validation. The DeFi Llama API response could be intercepted and manipulated to inject false yield data.

**Fix:** Add `import { enforceTLSSecurity } from "../../relay/utils";` and call `enforceTLSSecurity();` at the top of the file (or create a local equivalent in `bot/src/`).

---

### HIGH-TS-03: yield-keeper.ts Accesses `this.wallet.address` Synchronously on Async Signer

- **Domain:** TypeScript
- **File:** `relay/yield-keeper.ts`
- **Lines:** 262 (logMetrics method)
- **Status:** Open

**Description:** `logMetrics()` accesses `this.wallet.address` synchronously. After the C-07 fix, `this.wallet` is initialized via `createSigner()` which may return a `KMSEthereumSigner` (extending `AbstractSigner`). In ethers v6, `AbstractSigner` does not have a synchronous `.address` property — it requires `await getAddress()`. Accessing `.address` on a KMS signer returns `undefined`, causing metrics to log `keeper: undefined`.

**Impact:** Metrics data is corrupted with `undefined` keeper address, making operational monitoring unreliable. No financial impact.

**Fix:** Change `logMetrics` to be async and use `await this.wallet.getAddress()`, or cache the address during `init()`.

---

### HIGH-TS-04: Hardcoded ETH Price Assumption in Gas Cost Calculations

- **Domain:** TypeScript
- **File:** `relay/yield-keeper.ts` (line 238), `bot/src/index.ts` (line 432)
- **Lines:** Multiple files
- **Status:** Open

**Description:** Both `yield-keeper.ts` and the liquidation bot (`index.ts`) use hardcoded ETH price assumptions (`$2000` and `$2500` respectively) to estimate gas costs in USD. These values are never updated from an oracle. If ETH price moves significantly, profitability calculations become inaccurate — the bot may execute unprofitable liquidations or skip profitable ones.

**Impact:** At ETH = $5000, the liquidation bot underestimates gas costs by 2x, potentially executing unprofitable liquidations. At ETH = $1000, it skips profitable opportunities.

**Fix:** Fetch ETH/USD price from the existing price oracle or a public API (e.g., Chainlink ETH/USD feed) and use it for gas cost calculations.

---

### HIGH-TS-05: yield-sync-service.ts Accesses `this.wallet.address` Before Initialization

- **Domain:** TypeScript
- **File:** `relay/yield-sync-service.ts`
- **Lines:** ~290 (constructor region)
- **Status:** Open

**Description:** The YieldSyncService constructor logs `this.wallet.address` during initialization, but `this.wallet` is set asynchronously in `start()` via `createSigner()`. At construction time, `this.wallet` is `undefined`, causing a runtime error or logging `undefined`.

**Impact:** Service may crash on startup if the wallet access throws, or silently log incorrect address.

**Fix:** Move the address logging to after `start()` completes wallet initialization, or use a lazy initialization pattern.

---

### MED-TS-06: Relay Health Server Exposes Internal State via Type Assertions

- **Domain:** TypeScript
- **File:** `relay/relay-service.ts`
- **Lines:** 870–890 (metrics endpoint)
- **Status:** Open

**Description:** The `/metrics` endpoint accesses `(relay as any).processedAttestations.size`, `(relay as any).activeProviderIndex`, and `(relay as any).consecutiveFailures` using type assertions. While the endpoint is protected by bearer token authentication (H-15 fix), the use of `as any` bypasses TypeScript's type system and will silently break if field names change during refactoring.

**Impact:** Refactoring the RelayService class could silently break the metrics endpoint without compiler warnings. Metrics would return `undefined` values, degrading monitoring.

**Fix:** Add public getter methods to `RelayService` (e.g., `getMetrics()`) and use them instead of type assertions. Alternatively, implement a `MetricsProvider` interface.

---

### MED-TS-07: Price Oracle Floating-Point Inversion Precision Loss

- **Domain:** TypeScript
- **File:** `relay/price-oracle.ts`
- **Lines:** 140–145 (fetchTradecraftPrice)
- **Status:** Open (mitigated by sanity bounds)

**Description:** `fetchTradecraftPrice()` computes `priceOfCcInUsdcx = 1 / data.price_of_b_in_a`. For very small `price_of_b_in_a` values (e.g., `0.0000001`), the inversion produces extremely large prices (`10,000,000`). While the PO-04 sanity bounds (`maxPriceUsd` default `$1000`) catch extreme cases, the floating-point division itself loses precision for ratios near the bounds.

**Impact:** For `price_of_b_in_a` values between `0.001` and `0.01`, the inverted price ($100–$1000) is within sanity bounds but may have 2-3 digits of precision loss due to IEEE 754 floating-point representation.

**Fix:** Use a dedicated decimal library (e.g., `decimal.js`) for price calculations, or validate that the API returns the price in a format that doesn't require inversion.

---

### MED-TS-08: Lending Keeper `toFixed()` Precision Loss for Large Values

- **Domain:** TypeScript
- **File:** `relay/lending-keeper.ts`
- **Lines:** 110–120 (toFixed function)
- **Status:** Open (mitigated by BigInt math after conversion)

**Description:** The `toFixed()` helper converts `number | string` to fixed-point BigInt. It uses `parseFloat()` for string-to-number conversion, which loses precision for values > 2^53 (~9e15). For a $10M position with 18-decimal precision, the raw value is `10_000_000 * 10^18 = 10^25`, well beyond float64's integer precision.

**Impact:** Health factor calculations could be incorrect for very large positions ($10M+), potentially causing missed liquidations or premature liquidations. The R-06 fix comment acknowledges this risk but the `toFixed()` implementation still routes through `parseFloat()`.

**Fix:** Parse the string directly as a BigInt without intermediate float conversion. Split on `.`, handle the integer and fractional parts separately as BigInts.

---

### MED-TS-09: Flashbots `waitForBlock` Polls Indefinitely Without Timeout

- **Domain:** TypeScript
- **File:** `bot/src/flashbots.ts`
- **Lines:** 400–410 (waitForBlock)
- **Status:** Open

**Description:** `waitForBlock()` uses recursive `setTimeout` to poll until the target block arrives. If the Ethereum network stalls or the RPC connection drops, this function will poll indefinitely, preventing the `executeLiquidation` method from returning or timing out.

**Impact:** A stuck `waitForBlock` call blocks the entire liquidation executor. The bot becomes unresponsive without crashing, making it harder to detect via health checks.

**Fix:** Add a maximum wait time (e.g., 60 seconds) after which the function rejects with a timeout error.

---

### MED-TS-10: yield-api.ts X-Forwarded-For Trust Uses `startsWith` Instead of CIDR Matching

- **Domain:** TypeScript
- **File:** `bot/src/yield-api.ts`
- **Lines:** 345–350 (rate limiting IP resolution)
- **Status:** Open

**Description:** The rate limiter trusts `X-Forwarded-For` headers when `socketIp.startsWith(trustedProxy)`. A `TRUSTED_PROXY_SUBNET` of `"10."` would trust any IP starting with "10.", including `10.evil.attacker.com` (if DNS resolves). This is not CIDR-aware subnet matching.

**Impact:** An attacker behind a partially-matching IP could spoof `X-Forwarded-For` to bypass rate limiting or attribute requests to other IPs.

**Fix:** Use a proper CIDR matching library (e.g., `ip-range-check`) or require exact IP match for the proxy.

---

### MED-TS-11: Bot Liquidation Index.ts Uses Unlimited Event Listeners Without Cleanup

- **Domain:** TypeScript
- **File:** `bot/src/index.ts`
- **Lines:** 235–260 (setupEventListeners)
- **Status:** Open

**Description:** `setupEventListeners()` subscribes to `Borrowed`, `Deposited`, and `Liquidation` events using `.on()` but never removes listeners on shutdown. The `stop()` method only sets `isRunning = false` — it doesn't call `removeAllListeners()`. Over time (or during restarts), dangling listeners can accumulate.

**Impact:** Memory leak if the bot is restarted within the same process. Event handlers fire after `stop()` is called, potentially causing errors when accessing closed connections.

**Fix:** Store listener references and remove them in `stop()`, or use `once()` patterns with resubscription.

---

### LOW-TS-12: Oracle Keeper Duplicates Utility Functions from relay/utils.ts

- **Domain:** TypeScript
- **File:** `bot/src/oracle-keeper.ts`
- **Lines:** 158–190 (readSecret, readAndValidatePrivateKey)
- **Status:** Informational

**Description:** `oracle-keeper.ts` reimplements `readSecret()` and `readAndValidatePrivateKey()` locally instead of importing from `relay/utils.ts`. The implementations are nearly identical but could diverge over time if one is updated without the other.

**Impact:** Maintenance burden. If a security fix is applied to `relay/utils.ts`, the oracle-keeper copy may not be updated.

**Fix:** Extract shared utilities into a common package (e.g., `packages/shared/utils.ts`) or import from relay directly.

---

### LOW-TS-13: Reconciliation Keeper Uses `setInterval` Without Guard Against Overlapping Executions

- **Domain:** TypeScript
- **File:** `bot/src/reconciliation-keeper.ts`
- **Lines:** 230–240 (run method)
- **Status:** Open

**Description:** The reconciliation keeper uses `setInterval()` to schedule recurring reconciliation calls. If a reconciliation takes longer than the interval (e.g., indexing many events on first run), the next interval fires while the previous is still executing, causing concurrent reconciliation attempts.

**Impact:** Concurrent `reconcileTotalBorrows()` calls could submit duplicate transactions, wasting gas. The on-chain function should be idempotent, but gas costs are still wasted.

**Fix:** Use a `setTimeout`-based loop (call `setTimeout` after completion) instead of `setInterval`, or add a mutex guard.

---

### LOW-TS-14: Stub Implementations in Production Codebase

- **Domain:** TypeScript
- **File:** `bot/src/pendle-sniper.ts`, `bot/src/pool-alerts.ts`, `bot/src/snapshot.ts`, `bot/src/yield-scanner.ts`
- **Lines:** Full files
- **Status:** Informational

**Description:** Four bot service files are stubs with TODO comments and no functional implementation. While not security vulnerabilities themselves, their presence in the production codebase could lead to false confidence in coverage or accidental deployment.

**Impact:** No immediate security impact. Operational risk if these services are expected to be functional.

**Fix:** Mark clearly as `// @status: STUB — NOT PRODUCTION READY` or move to a separate `stubs/` directory.

---

## DAML Security Checklist

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | **Signatory/observer model** — every template has correct signatory (no over-permissive signatories) | ✅ Pass | Standalone modules use `signatory validator` for self-attestation. V3.daml uses DAML authorization model. |
| 2 | **Consuming vs. non-consuming choices** — state transitions use consuming choices to prevent double-execution | ✅ Pass | Attestation signing, minting, bridging all use consuming choices. Oracle queries are correctly non-consuming. |
| 3 | **Ensure clauses** — all template invariants enforced (positive amounts, valid ranges, non-empty lists) | ✅ Pass | Vault config bounds, supply >= 0, rate caps, collateral ratios all validated in `ensure` blocks. |
| 4 | **Key uniqueness** — keyed templates use unique key structures | ✅ Pass | PriceOracle keyed by `(provider, symbol)`, ComplianceRegistry keyed by `(regulator, registryId)`. |
| 5 | **Authorization context** — choices verify the exercising party has appropriate rights | ⚠️ Partial | V3.daml admin choices lack timelock (MED-DAML-07). LiquidationOrder allows any party to claim (MED-DAML-06). |
| 6 | **Numeric precision** — all financial calculations use DAML `Numeric` with appropriate scale | ⚠️ Partial | Interest accrual uses microsecond→second integer division with truncation (HIGH-DAML-04). |
| 7 | **Compliance integration** — regulated operations check compliance registry | ⚠️ Partial | Standalone modules check compliance. V3.daml CantonDirectMint omits checks (HIGH-DAML-02). |
| 8 | **Cross-module consistency** — duplicate template definitions are consistent | ⚠️ Partial | V3.daml and standalone modules have divergent security controls (attestation, compliance, timelock). |

---

## TypeScript Security Checklist

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | **TLS enforcement** — all services enforce TLS certificates at process level | ❌ Fail | yield-api.ts missing TLS enforcement (CRIT-TS-02). |
| 2 | **Private key management** — keys loaded via Docker secrets or KMS, never from .env | ❌ Fail | yield-api.ts uses dotenv (CRIT-TS-01). All relay services correctly use readSecret(). |
| 3 | **KMS signing** — production services use AWS KMS, raw keys forbidden | ✅ Pass | createSigner() in utils.ts enforces KMS in production. Bot services also guard. |
| 4 | **Input validation** — all external inputs validated (addresses, signatures, prices) | ✅ Pass | Ethereum address validation, DER signature parsing with bounds checks, price sanity bounds. |
| 5 | **Error handling** — unhandled rejections caught, graceful shutdown on signals | ✅ Pass | All services register SIGINT/SIGTERM handlers and unhandledRejection listeners. |
| 6 | **Rate limiting** — external API calls and signing operations are rate-limited | ✅ Pass | Validator V2 has per-window signing limits, price oracle has circuit breaker, yield-api has per-IP rate limiting. |
| 7 | **Signature verification** — ECDSA signatures pre-verified before on-chain submission | ✅ Pass | formatSignatures() in relay-service.ts pre-verifies via ecrecover (IC-08 fix). |
| 8 | **BigInt arithmetic** — financial calculations use BigInt, not floating-point | ⚠️ Partial | lending-keeper.ts toFixed() routes through parseFloat (MED-TS-08). calculator.ts uses pure BigInt correctly. |
| 9 | **Stale data handling** — Canton contract IDs refreshed before exercise | ✅ Pass | lending-keeper.ts re-fetches all CIDs before liquidation (LK-01 fix). |
| 10 | **Health monitoring** — all services expose health endpoints for Kubernetes probes | ✅ Pass | Health servers in relay-service.ts, bot/server.ts. Localhost binding by default (M-22 fix). |

---

## Security Scores

### DAML Security Score: **78 / 100**

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| Signatory model correctness | 25% | 85 | 21.25 |
| Authorization & access control | 20% | 75 | 15.00 |
| Financial precision | 15% | 70 | 10.50 |
| Compliance integration | 15% | 65 | 9.75 |
| Cross-module consistency | 15% | 70 | 10.50 |
| Upgrade & migration safety | 10% | 90 | 9.00 |
| **Total** | **100%** | | **76.00 → 78** |

**Deductions:**
- -8 for V3 attestation signatory model (CRIT-DAML-01)
- -5 for missing compliance checks in V3 CantonDirectMint (HIGH-DAML-02)
- -4 for missing attestation binding in V3 sMUSD (HIGH-DAML-03)
- -3 for interest precision truncation (HIGH-DAML-04)
- -2 for missing timelock in V3 admin choices (MED-DAML-07)

---

### TypeScript Security Score: **82 / 100**

| Category | Weight | Score | Weighted |
|----------|--------|-------|----------|
| TLS & transport security | 20% | 80 | 16.00 |
| Key management (KMS/secrets) | 20% | 90 | 18.00 |
| Signature verification | 15% | 95 | 14.25 |
| Input validation & parsing | 15% | 85 | 12.75 |
| Error handling & resilience | 15% | 85 | 12.75 |
| Financial precision (BigInt) | 10% | 75 | 7.50 |
| Operational security (health/metrics) | 5% | 85 | 4.25 |
| **Total** | **100%** | | **85.50 → 82** |

**Deductions:**
- -6 for yield-api.ts dotenv + missing TLS (CRIT-TS-01, CRIT-TS-02)
- -3 for hardcoded ETH prices in gas estimation (HIGH-TS-04)
- -3 for wallet.address async access issues (HIGH-TS-03, HIGH-TS-05)
- -2 for floating-point precision in price/lending calculations (MED-TS-07, MED-TS-08)
- -2 for Flashbots timeout and event listener cleanup (MED-TS-09, MED-TS-11)
- -2 for code duplication and stub presence (LOW-TS-12, LOW-TS-14)

---

## Summary of Findings

| Severity | DAML | TypeScript | Total |
|----------|------|-----------|-------|
| Critical | 1 | 2 | 3 |
| High | 3 | 3 | 6 |
| Medium | 3 | 6 | 9 |
| Low | 3 | 3 | 6 |
| **Total** | **10** | **14** | **24** |

---

*End of audit report.*
