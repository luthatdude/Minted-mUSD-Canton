# 🔒 Bridge Relay Deep Audit — Minted mUSD Protocol

**Auditor:** Lead Auditor Agent (Solidity + DAML + TypeScript + Infrastructure)  
**Date:** 2026-02-18  
**Scope:** Full cross-layer audit of Canton↔Ethereum bridge relay infrastructure  
**Verdict:** ⚠️ **NOT PRODUCTION-READY** — 5 Critical findings require remediation before mainnet

---

## Files Reviewed

### Solidity (634 lines)
- `contracts/BLEBridgeV9.sol` — Ethereum-side bridge contract

### TypeScript Relay (4,362+ lines)
- `relay/relay-service.ts` (2,636 lines) — Bidirectional relay service
- `relay/validator-node-v2.ts` (825 lines) — Validator signing node
- `relay/canton-client.ts` (411 lines) — Canton v2 HTTP JSON API client
- `relay/signer.ts` (256 lines) — DER→RSV signature conversion
- `relay/utils.ts` (334 lines) — Security utilities (TLS, key management)
- `relay/kms-ethereum-signer.ts` (207 lines) — AWS KMS signer
- `relay/graceful-shutdown.ts` (295 lines) — Shutdown orchestration
- `relay/metrics.ts` — Prometheus metrics

### DAML Templates (2,478+ lines)
- `daml/Minted/Protocol/V3.daml` — V3 unified module (AttestationRequest, BridgeService, MintedMUSD, etc.)
- `daml/BLEBridgeProtocol.daml` — Archive/reference module
- `daml/CantonDirectMint.daml` — Direct mint bridge path
- `daml/Compliance.daml` — Compliance registry

### Infrastructure
- `relay/Dockerfile`, `relay/docker-compose.yml`, `relay/.env.development`
- `relay/test/relay-integration.test.ts` — Test coverage

---

## Summary

| Severity | Count |
|----------|-------|
| **CRITICAL** | 5 |
| **HIGH** | 10 |
| **MEDIUM** | 12 |
| **LOW** | 8 |
| **INFO** | 6 |
| **Test Gaps** | 4 |
| **Total** | 45 |

---

## Cross-Layer Verification ✅ (Confirmed Correct)

Before listing findings, these critical cross-layer properties were **verified as consistent**:

| Property | Validator | Relay | Solidity | Status |
|----------|-----------|-------|----------|--------|
| Attestation ID derivation | `solidityPackedKeccak256(nonce, assets, ts, entropy, stateHash, chainId, addr)` | Same | `keccak256(abi.encodePacked(...))` same fields | ✅ Match |
| Signature message hash | `solidityPackedKeccak256(id, assets, nonce, ts, entropy, stateHash, chainId, addr)` | Same | Same encoding | ✅ Match |
| EIP-191 prefix | `ethers.hashMessage()` before KMS sign | `ethers.hashMessage()` for ecrecover pre-verify | `messageHash.toEthSignedMessageHash()` | ✅ Match |
| Timestamp derivation | `expiresAt_unix - 3600` | `expiresAt_unix - ATTESTATION_TTL_SECONDS` (3600) | Validated: `< block.timestamp`, `> lastAttest + 60s`, `< 6h old` | ✅ Match |
| Signature ordering | N/A | `sortSignaturesBySignerAddress()` ascending | `signer <= lastSigner → revert` ascending | ✅ Match |
| Nonce sequencing | Reads from payload | Checks `att.nonce != currentNonce + 1` via staticCall | `att.nonce != currentNonce + 1 → revert` | ✅ Match |

---

## CRITICAL Findings

### CRIT-01: DAML AttestationRequest — Aggregator-Only Signatory Enables Forgery

**Layer:** DAML (`Minted.Protocol.V3`)  
**Impact:** A compromised aggregator/operator can forge attestations without real validator participation, bypassing the multi-sig security model entirely.

The V3 `AttestationRequest` template has `signatory aggregator` only. Validators are merely **observers**. The aggregator can:
1. Create an `AttestationRequest` with pre-populated `collectedSignatures` and `ecdsaSignatures`
2. Skip `Attestation_Sign` entirely
3. Call `Attestation_Complete` immediately (only checks `Set.size collectedSignatures >= requiredSignatures`)

The archived `BLEBridgeProtocol` module had `ValidatorSelfAttestation` (with `signatory validator`) that prevented this — V3 dropped this protection.

**Note:** The Ethereum-side on-chain signature verification (`ECDSA.recover` + `VALIDATOR_ROLE` check) provides defense-in-depth. The aggregator would need actual validator ECDSA private keys to forge signatures that pass on-chain. However, the DAML-side security model is broken — an aggregator can create Canton-side records that appear legitimately attested without any validator actually participating.

**Recommendation:**
- Port the `ValidatorSelfAttestation` pattern from `BLEBridgeProtocol` into V3
- Make validators co-signatories after signing
- Add `ensure Set.null collectedSignatures` to prevent pre-populated signatures at creation

---

### CRIT-02: DAML BridgeInRequest — Operator Unilateral Completion, No Attestation Required

**Layer:** DAML (`Minted.Protocol.V3`)  
**Impact:** Operator can mark inbound bridge requests as "completed" without any proof of Ethereum-side fund transfer.

```
choice BridgeIn_Complete : ContractId BridgeInRequest
  controller operator
  do
    assertMsg "MUST_BE_PENDING" (status == "pending")
    create this with status = "completed"
```

This is asymmetric with `BridgeOut_Complete` which was hardened with AUDIT-H-04 attestation checks. The inbound path has **zero** validation: no attestation CID, no validator signatures, no amount verification.

**Recommendation:** Mirror the AUDIT-H-04 pattern: require an `attestationCid : ContractId AttestationRequest` parameter with direction validation and signature threshold check.

---

### CRIT-03: DAML BridgeOut_Complete — Legacy Path Allows Attestation-Free Completion

**Layer:** DAML (`Minted.Protocol.V3`)  
**Impact:** The AUDIT-H-04 attestation-gating fix is completely bypassable.

```
attestationCid : Optional (ContractId AttestationRequest)
...
case attestationCid of
  Some attCid -> do { ... }
  None -> pure ()  -- Legacy path: no attestation (pre-H-04 upgrade)
```

The operator can pass `None` to complete any bridge-out request without providing attestation proof, completely bypassing the multi-sig security model.

**Recommendation:** Remove the `Optional` wrapper. Make `attestationCid` required. If backward-compat is needed, add a `requireAttestation : Bool` governance flag defaulting to `True`.

---

### CRIT-04: Validator Entropy Falls Back to `ZeroHash` Silently

**Layer:** TypeScript (`relay/validator-node-v2.ts` line ~695)  
**Impact:** Validators sign attestations that will **always revert** on-chain.

```typescript
const entropy = (payload as any).entropy
  ? ((payload as any).entropy.startsWith("0x") ? ... : ...)
  : ethers.ZeroHash;  // ← Falls back silently
```

On-chain: `if (att.entropy == bytes32(0)) revert MissingEntropy();` (BLEBridgeV9.sol line 378).

If the DAML payload doesn't include `entropy`, the validator signs over `bytes32(0)` entropy, producing a signature that will always revert on-chain. This wastes KMS operations and creates dangling Canton exercises. The `(payload as any)` cast bypasses TypeScript's type system, hiding the missing field.

**Recommendation:**
- Add `entropy` and `cantonStateHash` to the `AttestationPayload` interface (remove `as any` casts)
- Reject signing if entropy is zero/missing: `if (!payload.entropy) throw new Error("MISSING_ENTROPY")`
- Same fix for `cantonStateHash` fallback to `ZeroHash`

---

### CRIT-05: DAML Shared Nonce Counter Creates Bridge-In/Bridge-Out Collision

**Layer:** DAML (`Minted.Protocol.V3` — `BridgeService`)  
**Impact:** Legitimate bridge-in operations can permanently fail, causing stuck user funds.

Both `Bridge_AssignNonce` (outbound) and `Bridge_ReceiveFromEthereum` (inbound) increment the same `lastNonce` counter. The inbound path asserts `attestation.payload.nonce == lastNonce + 1` (strict sequential). If an outbound bridge-out assigns nonce N between attestation creation and reception, the inbound bridge-in expecting nonce N will fail with `NONCE_NOT_SEQUENTIAL`.

**Recommendation:** Use separate nonce counters (`lastBridgeInNonce`, `lastBridgeOutNonce`) or switch to a monotonically-increasing check (`nonce > lastNonce`) instead of strict sequential.

---

## HIGH Findings

### HIGH-01: Relay TEMPLATES References Non-Existent DAML Template

**Layer:** TypeScript (`relay/canton-client.ts`)  
**Impact:** Phantom template query returns empty results; attestation fetching may silently fail.

```typescript
ValidatorSignature: { moduleName: "Minted.Protocol.V3", entityName: "ValidatorSignature" }
```

**No `ValidatorSignature` template exists in `Minted.Protocol.V3`.** V3 stores signatures inline in `AttestationRequest.ecdsaSignatures`. The relay queries this phantom template, always getting empty results.

**Recommendation:** Remove `ValidatorSignature` from TEMPLATES. Refactor any code path that queries it to read from `AttestationRequest.ecdsaSignatures` directly.

---

### HIGH-02: Validator Signed-Cache Eviction Enables Double-Signing

**Layer:** TypeScript (`relay/validator-node-v2.ts`)  
**Impact:** KMS quota waste; potential DoS vector.

The `signedAttestations` Set has a 10,000 entry cap. At overflow, the oldest 10% are evicted. If an old attestation contract is still active on Canton and its ID was evicted, the validator re-signs it. Canton may reject (`VALIDATOR_ALREADY_SIGNED`), but each attempt consumes a KMS signing operation.

**Recommendation:** Use an LRU cache with persistence, or verify against Canton ledger state before re-signing.

---

### HIGH-03: Validator Rate Limit Resets on Restart

**Layer:** TypeScript (`relay/validator-node-v2.ts`)  
**Impact:** Attacker who can crash the container bypasses signing rate limits.

```typescript
private signingTimestamps: number[] = [];  // In-memory only
```

A container restart resets the counter to zero, allowing `MAX_SIGNS_PER_WINDOW` signatures immediately.

**Recommendation:** Persist signing timestamps to file or Redis. The on-chain `dailyCapIncreaseLimit` provides a backstop, but the validator-side limit should be durable.

---

### HIGH-04: Validator Value-Jump Bypass on First Attestation After Restart

**Layer:** TypeScript (`relay/validator-node-v2.ts` line ~466)  
**Impact:** Attacker can restart validator and submit inflated first attestation.

```typescript
if (this.lastSignedTotalValue > 0n) {
  // ... check jump
}
// First attestation always passes — lastSignedTotalValue starts at 0n
```

**Recommendation:** Initialize `lastSignedTotalValue` from on-chain `attestedCantonAssets` at startup.

---

### HIGH-05: DAML No Expiry Validation at Attestation Creation

**Layer:** DAML (`Minted.Protocol.V3`)  
**Impact:** Already-expired attestations created on ledger waste validator resources.

No `ensure` clause checks `expiresAt > now()` at creation time. Validators discover expiry only after fetching the contract, wasting network and KMS resources.

**Recommendation:** Add creation-time validation in `MUSD_BridgeToEthereum`.

---

### HIGH-06: DAML Compliance Check Is Optional on Bridge-In

**Layer:** DAML (`Minted.Protocol.V3` — `Bridge_ReceiveFromEthereum`)  
**Impact:** Sanctioned/blacklisted parties could receive mUSD via bridge-in.

```
complianceRegistryCid : Optional (ContractId ComplianceRegistry)
...
None -> pure ()  -- Legacy path: no compliance registry
```

**Recommendation:** Make `complianceRegistryCid` non-optional, or add a governance flag requiring compliance checks post-upgrade.

---

### HIGH-07: Solidity `_containsPartyDelimiter` Gas Griefing + No Length Cap

**Layer:** Solidity (`BLEBridgeV9.sol` line ~470)  
**Impact:** Gas waste from arbitrarily long strings; weak validation.

The function iterates byte-by-byte with no maximum length. Any string containing `::` passes (e.g., `"x::y"`). No length cap means excessively long `cantonRecipient` strings waste gas and inflate event data.

**Recommendation:** Add `require(bytes(cantonRecipient).length <= 512, "recipient too long")`.

---

### HIGH-08: Solidity `setCollateralRatio` Bypasses Daily Cap Rate Limit

**Layer:** Solidity (`BLEBridgeV9.sol` line ~248)  
**Impact:** A compromised timelock controller can inflate supply cap without hitting rate limits.

```solidity
_updateSupplyCap(attestedCantonAssets, true);  // skipRateLimit = true
```

While constrained by 1-day cooldown and 10% max change, ratio decreases produce rate-limit-exempt cap increases.

**Recommendation:** Document explicitly. Consider whether ratio-change cap increases should count toward `dailyCapIncreased`.

---

### HIGH-09: DAML `MUSD_BridgeToEthereum` Sets `globalCantonAssets = amount`

**Layer:** DAML (`Minted.Protocol.V3`)  
**Impact:** If used for attestation, supply cap would be set to user's individual bridge amount instead of actual global assets.

The DAML choice sets the attestation's `globalCantonAssets` to the user's bridge amount, not the actual system-wide total. This field is read by the relay and passed to `BLEBridgeV9.processAttestation()` as `cantonAssets`, which updates the supply cap.

**Note:** The validator's `verifyAgainstCanton()` should catch this discrepancy (it compares against Canton's actual total). But this is a defense-in-depth gap.

**Recommendation:** Source `globalCantonAssets` from a system-level service contract, not user input.

---

### HIGH-10: Relay `AttestationPayload` Interface Has Phantom `positionCids` Field

**Layer:** TypeScript (`relay/relay-service.ts`)  
**Impact:** Stale interface indicates incomplete migration from archive module.

The relay's `AttestationPayload` interface includes `positionCids: string[]` which doesn't exist in V3's DAML template. This is a leftover from the archived `BLEBridgeProtocol.BridgeOutAttestation`.

**Recommendation:** Remove `positionCids` from the relay interface. Audit all `AttestationPayload` fields against the V3 DAML template.

---

## MEDIUM Findings

### MED-01: Duplicate Total-Value Check in Validator (Dead Code)

**Layer:** TypeScript (`relay/validator-node-v2.ts` lines ~527-544)  
**Description:** Two identical `if (totalDiff > tolerance)` blocks — copy-paste error. Second is unreachable.  
**Recommendation:** Remove the duplicate block.

---

### MED-02: Solidity `bridgeOutMinAmount` Defaults to 0

**Layer:** Solidity (`BLEBridgeV9.sol`)  
**Description:** Not set in `initialize()`. Until admin calls `setBridgeOutMinAmount()`, any amount ≥ 1 wei can be bridged, creating dust entries.  
**Recommendation:** Set a default (e.g., `1e18` = 1 mUSD) in `initialize()`.

---

### MED-03: Grafana Default Credentials in Docker Compose

**Layer:** Infrastructure (`relay/docker-compose.yml`)  
**Description:** `GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-changeme}`. Default `admin:changeme`.  
**Recommendation:** Remove default fallback. Require explicit password.

---

### MED-04: Validator Uses Only First Template from Allowlist

**Layer:** TypeScript (`relay/validator-node-v2.ts`)  
**Description:** `this.config.allowedTemplates[0]` — ignores all templates after index 0.  
**Recommendation:** Iterate over all allowed templates or remove multi-template support.

---

### MED-05: DAML Status Fields Are Free Text, Not Sum Types

**Layer:** DAML (`Minted.Protocol.V3`)  
**Description:** `status : Text` compared via string equality. Invalid status strings (e.g., typos) create permanently stuck contracts.  
**Recommendation:** Use `data BridgeStatus = Pending | Bridged | Cancelled | Completed`.

---

### MED-06: DAML BridgeOutRequest/BridgeInRequest — No `ensure` Amount Validation

**Layer:** DAML (`Minted.Protocol.V3`)  
**Description:** No `ensure amount > 0.0` on either template. Zero/negative amounts can be created.  
**Recommendation:** Add `ensure amount > 0.0 && status == "pending"`.

---

### MED-07: DAML `CantonMint_Mint` Hardcodes `requiredSignatures = 1`

**Layer:** DAML (`CantonDirectMint.daml`)  
**Description:** Bridge-out requests from direct mint path require only 1 signature regardless of BridgeService threshold.  
**Recommendation:** Fetch `requiredSignatures` from `BridgeService` at mint time.

---

### MED-08: Relay TEMPLATES Contains Stale Module References

**Layer:** TypeScript (`relay/canton-client.ts`)  
**Description:** Some templates reference standalone modules (`CantonDirectMint`, `CantonSMUSD`) while V3 has unified equivalents. Queries may miss contracts.  
**Recommendation:** Document which entries are V3-only vs standalone. Add V3-specific entries.

---

### MED-09: DAML `Attestation_Complete` Returns `()` — No Audit Trail

**Layer:** DAML (`Minted.Protocol.V3`)  
**Description:** Both `Attestation_Complete` and `Attestation_Cancel` return `()` and archive. No distinguishable receipt on ledger.  
**Recommendation:** Return a `CompletedAttestation` receipt contract for audit trail.

---

### MED-10: DAML User-Controlled `entropy` and `cantonStateHash`

**Layer:** DAML (`Minted.Protocol.V3` — `MUSD_BridgeToEthereum`)  
**Description:** These security-critical fields are passed by the user (`owner` controller), not sourced from system services. Weak entropy enables predictable attestation IDs.  
**Recommendation:** Operator/aggregator should supply entropy (from CSPRNG) and cantonStateHash (from ledger API).

---

### MED-11: Solidity `computeAttestationId` Uses `block.chainid` — Not Callable Off-Chain

**Layer:** Solidity (`BLEBridgeV9.sol`)  
**Description:** NatSpec says "Allows off-chain actors to pre-compute" but relies on on-chain values.  
**Recommendation:** The relay correctly supplies these values. Add `chainId()` view function for discoverability.

---

### MED-12: Relay `loadProcessedBridgeOuts` Fallback Marks ALL as Processed

**Layer:** TypeScript (`relay/relay-service.ts`)  
**Description:** If Canton query fails during startup, the fallback marks all bridge-outs as processed to prevent duplicates. This could cause missed relays if the failure was transient.  
**Recommendation:** Fail startup if Canton is unreachable for bridge-out state loading. Don't assume "all processed."

---

## LOW Findings

### LOW-01: Dev Config Contains Plaintext Private Key

**Layer:** Infrastructure (`relay/.env.development`)  
**Description:** `RELAYER_PRIVATE_KEY=f47a...` — Sepolia key, marked as rotated. Dev-only, gitignored.  
**Recommendation:** Rotate immediately. Use KMS even for dev.

---

### LOW-02: `forceUpdateNonce` Can Skip Nonces, Invalidating In-Flight Attestations

**Layer:** Solidity (`BLEBridgeV9.sol`)  
**Description:** Emergency function can jump from nonce 5 to 100, permanently invalidating nonces 6–99. Intentional but destructive.  
**Recommendation:** Document operational procedures. Consider max skip limit.

---

### LOW-03: Canton Token `dummy-no-auth` in Dev Config

**Layer:** Infrastructure (`relay/.env.development`)  
**Description:** Acceptable in development. Risk if accidentally deployed to staging/production.  
**Recommendation:** Add startup guard that rejects `dummy-no-auth` in non-dev environments.

---

### LOW-04: Validator `signedAttestations` Is Memory-Only, No Crash Recovery

**Layer:** TypeScript (`relay/validator-node-v2.ts`)  
**Description:** After crash, validator loses signed-attestation tracking. Canton rejects duplicates, but KMS calls are wasted.  
**Recommendation:** Persist signed attestation IDs to file.

---

### LOW-05: Metrics Endpoint Has No Authentication

**Layer:** TypeScript (`relay/metrics.ts`)  
**Description:** `/health` and `/metrics` endpoints unauthenticated. Bound to `127.0.0.1` by default.  
**Recommendation:** Add basic auth for environments where metrics may be accessible to untrusted networks.

---

### LOW-06: `cross-spawn`, `glob`, `tar` in Production Dependencies

**Layer:** Infrastructure (`relay/package.json`)  
**Description:** Build/dev utilities in prod deps increase attack surface.  
**Recommendation:** Move to `devDependencies` if not used at runtime.

---

### LOW-07: DAML `Attestation_Cancel` Has No Guard or Reason

**Layer:** DAML (`Minted.Protocol.V3`)  
**Description:** Aggregator can cancel any attestation at any time with no condition or audit trail.  
**Recommendation:** Add cancel reason text and cancellation receipt.

---

### LOW-08: Solidity `emergencyReduceCap` Allows Reducing to Exactly `totalSupply()`

**Layer:** Solidity (`BLEBridgeV9.sol`)  
**Description:** Setting `newCap == totalSupply()` means zero remaining mintable. Valid emergency behavior but may surprise operators.  
**Recommendation:** Document this edge case in runbooks.

---

## INFO Findings

### INFO-01: Strong Solidity Signature Verification Design ✅

BLEBridgeV9's signature verification is well-implemented:
- Uses OpenZeppelin `ECDSA.recover` (handles malleable signatures)
- Enforces ascending signer order to prevent duplicates
- Validates each signer has `VALIDATOR_ROLE`
- Includes `block.chainid` and `address(this)` in signed hash (cross-chain replay protection)
- `usedAttestationIds` mapping + strict sequential nonce = double replay protection

### INFO-02: Dockerfile Follows Security Best Practices ✅

- Multi-stage build with minimal production image
- Pinned to SHA256 digest (`node:20-alpine@sha256:...`)
- Non-root user (`appuser:1001`)
- BuildKit secret mounts for npm auth
- `npm cache clean --force` in production stage

### INFO-03: Docker Compose Security Hardening ✅

- `read_only: true` filesystem
- `no-new-privileges: true`
- Resource limits (memory + CPU)
- Secrets mounted from files (not env vars)
- Network isolation (`bridge_internal` + `bridge_external`)
- Management ports bound to `127.0.0.1`

### INFO-04: Unpause Requires 24h Timelock ✅

`requestUnpause()` → 24h delay → `executeUnpause()` prevents immediate recovery after exploit.

### INFO-05: Rate Limit Revert Preserves Attestation ✅

When daily cap limit exhausted, `_handleRateLimitCapIncrease` reverts with `DailyCapLimitExhausted()`. Nonce is NOT consumed — attestation can be retried after window reset.

### INFO-06: TLS Enforcement with Runtime Watchdog ✅

`enforceTLSSecurity()` forces `NODE_TLS_REJECT_UNAUTHORIZED=1` and installs a 5-second watchdog interval to detect runtime tampering.

---

## Test Coverage Gaps 🚨

### GAP-01: ALL Relay Integration Tests Are Stubs — ZERO Functional Coverage

**File:** `relay/test/relay-integration.test.ts`

All 16 test cases are `expect(true).toBe(true)` placeholders. No actual relay logic is tested:
- ❌ Relay service initialization
- ❌ End-to-end attestation relay
- ❌ Duplicate event handling
- ❌ Crash recovery / checkpointing
- ❌ Retry logic
- ❌ Rate limiting
- ❌ Anomaly detection

### GAP-02: No Tests for Validator Node

No test file exists for `validator-node-v2.ts`. Untested critical paths:
- `verifyAgainstCanton()` — the core trust boundary
- `buildMessageHash()` — must match on-chain hash exactly
- `signWithKMS()` — KMS integration
- Rate limiting and value-jump detection

### GAP-03: No Tests for Bridge-Out Path (Solidity)

Missing test scenarios for `bridgeToCanton()`:
- Dust prevention (`bridgeOutMinAmount`)
- Canton recipient format validation
- Gas griefing via long strings
- Nonce monotonicity

### GAP-04: No Tests for Rate Limit Edge Cases (Solidity)

Missing scenarios:
- Rate limit window boundary (exact 24h mark)
- Cap decrease → increase in same window
- `DailyCapLimitExhausted` revert + retry after reset
- `setCollateralRatio` bypassing rate limit

---

## Architecture Assessment

### What Works Well 👍

1. **Signature verification chain** is mathematically consistent across all 3 layers (TypeScript validator → TypeScript relay → Solidity contract)
2. **Defense-in-depth**: Relay pre-verifies signatures via ecrecover before submitting on-chain
3. **Pre-flight simulation** prevents gas waste from front-running
4. **Anomaly detection** auto-pauses on supply cap jumps or consecutive reverts
5. **Infrastructure hardening** (Docker, TLS, KMS) follows industry best practices
6. **Rate limiting** at both validator (per-window) and on-chain (daily cap) levels
7. **Nonce replay protection** at relay level (Set + in-flight dedup) and on-chain (usedAttestationIds)

### What's Broken 👎

1. **DAML trust model is broken** — aggregator can forge attestation records (CRIT-01)
2. **Bridge completion paths are bypassable** — both in (CRIT-02) and out (CRIT-03) can skip attestation checks
3. **Validator produces unusable signatures** when entropy/stateHash missing (CRIT-04)
4. **Shared nonce causes deadlocks** between bridge-in and bridge-out (CRIT-05)
5. **Zero test coverage** on the relay/validator — critical infrastructure is completely untested

---

## Recommendations (Priority Order)

### P0 — Must Fix Before Mainnet

| # | Finding | Effort |
|---|---------|--------|
| 1 | CRIT-01: Add self-attestation or validator co-signatories in V3 DAML | 2-3 days |
| 2 | CRIT-02: Add attestation requirement to `BridgeIn_Complete` | 1 day |
| 3 | CRIT-03: Remove `Optional` from `BridgeOut_Complete.attestationCid` | 0.5 day |
| 4 | CRIT-04: Reject signing when entropy/stateHash missing in validator | 0.5 day |
| 5 | CRIT-05: Separate bridge-in/bridge-out nonce counters in DAML | 1 day |
| 6 | GAP-01/02: Write real integration tests for relay + validator | 3-5 days |

### P1 — Should Fix Before Mainnet

| # | Finding | Effort |
|---|---------|--------|
| 7 | HIGH-01: Remove phantom `ValidatorSignature` from TEMPLATES | 0.5 day |
| 8 | HIGH-02: Use LRU cache for validator signed attestations | 0.5 day |
| 9 | HIGH-03: Persist validator rate limit state | 0.5 day |
| 10 | HIGH-04: Initialize `lastSignedTotalValue` from on-chain at startup | 0.5 day |
| 11 | HIGH-06: Make compliance check non-optional | 0.5 day |
| 12 | HIGH-07: Add `cantonRecipient` length cap (512 bytes) | 0.5 day |
| 13 | HIGH-09: Fix `globalCantonAssets` sourcing in DAML | 1 day |
| 14 | HIGH-10: Clean up stale `positionCids` from relay interface | 0.5 day |

### P2 — Should Fix Post-Launch

| # | Finding | Effort |
|---|---------|--------|
| 15 | MED-01 through MED-12 | 2-3 days total |
| 16 | LOW-01 through LOW-08 | 1-2 days total |

---

## Overall Score

| Category | Score | Notes |
|----------|-------|-------|
| Solidity Contract | **85/100** (B+) | Strong signature verification, good rate limiting. Missing length caps and default init values. |
| TypeScript Relay | **72/100** (B-) | Well-architected with extensive safeguards. Marred by stale interfaces, phantom templates, and zero test coverage. |
| TypeScript Validator | **65/100** (C+) | Core verification logic is sound. Silent fallbacks to zero-hashes are dangerous. No persistence. No tests. |
| DAML Templates | **55/100** (C-) | Broken trust model (aggregator forgery). Bypassable attestation gates. Shared nonce design flaw. |
| Infrastructure | **88/100** (A-) | Excellent Docker/K8s hardening. Minor default credential and dependency issues. |
| Test Coverage | **15/100** (F) | All relay/validator tests are stubs. Zero functional coverage of the most critical component. |
| **Overall** | **63/100** (D+) | **NOT PRODUCTION-READY.** DAML trust model and test coverage must be addressed. |

---

*This audit was produced by analyzing all cross-layer interactions between Solidity, DAML, and TypeScript components. Findings were verified by reading every line of the core relay infrastructure (4,362+ lines of TypeScript, 634 lines of Solidity, 2,478+ lines of DAML).*
