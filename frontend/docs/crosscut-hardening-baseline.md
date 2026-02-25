# Cross-Cutting API Hardening Baseline

Generated: 2026-02-25
Branch: `codex/crosscut-hardening-api-phase5-2026-02-25`

## Endpoint Inventory

| Endpoint | Method | Env Validation | Auth/Session | Fallback Classifier | Number Parsing | Idempotency |
|---|---|---|---|---|---|---|
| canton-balances | GET | Yes (party+pkg) | None — trusts query.party | None | parseFloat | None (read-only) |
| canton-bridge-preflight | GET | Yes (party+pkg) | None — trusts query.party | None | parseFloat | None (read-only) |
| canton-command | POST | Partial (party only) | None — trusts body.party | None | None | None (random commandId) |
| canton-convert | POST | Yes (party+pkg+cip56) | None — trusts body.party | None | parseFloat + 0.000001 eps | Yes — unbounded Map, no TTL |
| canton-ops-health | GET | Yes (party+pkg) | None — trusts query.party | None | parseFloat | None (read-only) |
| canton-refresh-prices | POST | Yes (party+pkg) | None — no party binding | None | None | None (DAML-side guard) |
| canton-cip56-redeem | POST | Yes (party+pkg+cip56) | None — trusts body.party | None | parseFloat + 0.000001 eps | Yes — unbounded Map, no TTL |
| canton-cip56-repay | POST | Yes (party+pkg+cip56) | None — trusts body.party | None | parseFloat + 0.000001 eps | Yes — unbounded Map, no TTL |
| canton-cip56-stake | POST | Yes (party+pkg+cip56) | None — trusts body.party | None | parseFloat + 0.000001 eps | Yes — unbounded Map, no TTL |

## Environment Variables Used

All endpoints share a common set:

| Variable | Endpoints | Validated | Pattern |
|---|---|---|---|
| CANTON_API_URL | All | No — fallback to host:port | URL string |
| CANTON_HOST | All | No — default "localhost" | Hostname |
| CANTON_PORT | All | No — default "7575" | Port number |
| CANTON_TOKEN | All | No — defaults to "" | Bearer token |
| CANTON_PARTY | All | Yes — regex validated | `[A-Za-z0-9._:-]+::1220[0-9a-f]{64}` |
| CANTON_PACKAGE_ID / NEXT_PUBLIC_DAML_PACKAGE_ID | All | Yes — 64-char hex | `[0-9a-f]{64}` |
| CIP56_PACKAGE_ID / NEXT_PUBLIC_CIP56_PACKAGE_ID | preflight, convert, ops-health, cip56-* | Partial — only in cip56 endpoints | `[0-9a-f]{64}` |
| CANTON_USER | command, convert, refresh-prices, cip56-* | No — default "administrator" | String |
| CANTON_RECIPIENT_PARTY_ALIASES | balances, command | No — JSON parse with fallback | JSON object |
| CANTON_ALLOW_OPERATOR_FALLBACK | command | No — "true"/"false" | Boolean string |
| CANTON_OPERATOR_INVENTORY_FLOOR | ops-health | No — parseInt with fallback | Integer |

## Risk Assessment

### High Risk
1. **Unbounded idempotency maps** — 4 endpoints (convert, redeem, repay, stake) use `new Map()` with no TTL or size limit. Memory leak under sustained traffic.
2. **No auth binding** — All POST endpoints trust `req.body.party` without validating against any session or auth token. Any caller can submit commands as any party.
3. **parseFloat precision** — `0.000001` epsilon comparisons can drift under accumulation. DAML uses 10-decimal Decimal type.

### Medium Risk
4. **Env vars validated per-endpoint** — Each file duplicates `CANTON_PARTY_PATTERN`, `PKG_ID_PATTERN`, `validateRequiredConfig()`. Drift risk if patterns diverge.
5. **No canonical fallback classification** — Frontend components (CantonBorrow, CantonStake, CantonBridge) each implement their own 409/5xx gating logic inline.
6. **cantonRequest duplicated** — 8 copies of the same fetch wrapper, some with 15s timeout, some with 30s.

### Low Risk
7. **CANTON_TOKEN not validated** — Empty string accepted silently; Canton API will reject with 401.
8. **No rate limiting** — API endpoints have no request-level throttling.

## Shared Utilities Created

Location: `frontend/src/lib/api-hardening/`

| Module | Purpose | Replaces |
|---|---|---|
| env.ts | Typed env getters with strict validation | Per-file `process.env` + regex |
| fallback.ts | Canonical fallback classifier | Inline status code checks |
| decimal.ts | Safe compare/sum with epsilon | Ad-hoc `parseFloat` + `0.000001` |
| idempotency.ts | Bounded in-memory store (TTL + max) | Unbounded `new Map()` |
| auth.ts | Method + request shape guards | Per-file `req.method !== "POST"` |

## Migration Status

| Endpoint | Phase | Status |
|---|---|---|
| canton-cip56-redeem | Part 1 (reference) | Migrated |
| canton-cip56-repay | Part 2 | Pending |
| canton-cip56-stake | Part 2 | Pending |
| canton-convert | Part 2 | Pending |
| canton-command | Part 2 | Pending |
| canton-balances | Deferred | Low priority (read-only) |
| canton-bridge-preflight | Deferred | Low priority (read-only) |
| canton-ops-health | Deferred | Low priority (read-only) |
| canton-refresh-prices | Deferred | Low priority (operator-only) |

## Deferred Items

1. **Full session-based auth** — Stack does not currently have session middleware. Auth utility provides shape guards + explicit TODO markers.
2. **External idempotency store** — Redis/Postgres would be ideal for production. Current PR uses bounded in-memory store with TTL as safe incremental improvement.
3. **Zod schema validation** — Would be ideal for env + request body validation. Avoided to keep dependency footprint zero in this PR.
