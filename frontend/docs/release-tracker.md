# Release Tracker

## 2026-03-01 — LF2 Key-Removal Migration + UX Reliability Hardening

**Release:** Complete LF2 contract key removal, UX reliability fixes, relay hardening
**Branch:** `fix/canton-ux-reliability-hardening`
**Commit:** [`7eef3b63`](https://github.com/luthatdude/Minted-mUSD-Canton/commit/7eef3b63)

### Summary

- Removed all 8 contract key declarations from CantonLending DAML templates (LF2 compliance)
- Added explicit ContractId passing (`existingEscrowCid`, `collateralAggCid`) to lending deposit choices
- Separated lending package ID (`CANTON_LENDING_PACKAGE_ID`) for independent versioning
- Unblocked all 8 modules from `lf2-blocked-modules.txt`; version bump 1.0.0 → 1.1.0
- Sanitized all CantonStake error paths (no raw DAML/gRPC leaks to UI)
- Prevented over-unstake via covering-token fallback
- Bound partial smUSD unstake to split-created CIDs
- Relay: overflow fallback replay for ACS queries
- Relay: RC1 retry condition fix for `COMMAND_PREPROCESSING_FAILED`
- Added LF2 guard scripts and CI job for key-declaration regression prevention

### Validation

| Gate | Result |
|------|--------|
| `daml-lf2-guard.sh` | PASS (0 blocked modules, 0 key declarations) |
| `check-no-operator-alias.sh` | PASS |
| Frontend `tsc --noEmit` | PASS |
| Relay `tsc --noEmit` | PASS |
| Relay tests (jest) | 51/51 PASS |
| DAML full build (CI) | Pending CI run |
| Batch soak audit (Agent C) | GO — 6/6 ops, 6/6 runtime proofs, 2/2 idempotency |

### Post-Merge

- [ ] Deploy ble-protocol 1.1.0 DAR to devnet
- [ ] Update CI to use direct `daml build` instead of `daml-build-lf2.sh`
- [ ] T+1h `ops:check24h`
- [ ] T+24h `ops:check24h`

---

## 2026-02-26 — Canton Party Identity Unification

**Release:** Unified party resolution across all Canton API routes + UI identity transparency
**Branch:** `fix/strict-copy-deck-eth-delta-neutral`

### Summary

- Created shared server-side party resolver (`canton-party-resolver.ts`) used by all Canton API routes
- Extended `guardBodyParty()` to apply alias resolution for POST mutation routes
- Added `effectiveParty` + `aliasApplied` fields to all API responses
- Added UI identity status block showing connected vs effective party on Canton pages
- Deprecated original wallet identity (`...ebad`) — different participant namespace
- Documented canonical party identity policy in devnet-ops-runbook.md

### Validation

| Gate | Result |
|------|--------|
| `tsc --noEmit` | TBD |
| API consistency (3 endpoints, same effectiveParty) | TBD |
| UI identity transparency visible | TBD |
| Regression scans (no stale references) | TBD |

---

## 2026-02-25 — Hybrid Fallback Decommission

**Release:** Remove dead hybrid conversion code paths from CIP-56 components
**PR:** [#161](https://github.com/luthatdude/Minted-mUSD-Canton/pull/161)
**Merge commit:** [`d3659288`](https://github.com/luthatdude/Minted-mUSD-Canton/commit/d3659288)
**Tag:** [`cip56-migration-complete-2026-02-25`](https://github.com/luthatdude/Minted-mUSD-Canton/releases/tag/cip56-migration-complete-2026-02-25)
**Depends on:** [#159](https://github.com/luthatdude/Minted-mUSD-Canton/pull/159), [#160](https://github.com/luthatdude/Minted-mUSD-Canton/pull/160)

### Summary

- Removed hybrid CIP-56→redeemable conversion branches from CantonBridge, CantonBorrow, CantonStake
- Native CIP-56 failures surface directly (no silent fallback)
- Marked `convertCip56ToRedeemable` as `@deprecated`
- Preserved rollback path: `canton-convert.ts` endpoint and `fallback.ts` module retained

### Validation

| Gate | Result |
|------|--------|
| `tsc --noEmit` | PASS |
| `tsc -p tsconfig.scripts.json` | PASS |
| `npm run build` | PASS |
| `ops:doctor` | 12/12 HEALTHY |
| `ops:canary:native` | PASS (redeem succeeded) |
| `ops:canary:force-conversion:no-fallback` | EXPECTED_BLOCKED_BY_POLICY (exit 0) |
| Hybrid callsites in components | 0 matches |

### Post-Merge Stability

- [ ] T+1h `ops:check24h`
- [ ] T+4h `ops:check24h`
- [ ] T+24h `ops:check24h`

---

## 2026-02-25 — CIP-56 Native-First Migration

**Release:** CIP-56 native-first enforcement + hybrid fallback disabled
**PR:** [#159](https://github.com/luthatdude/Minted-mUSD-Canton/pull/159)
**Merge commit:** [`f4f70f10`](https://github.com/luthatdude/Minted-mUSD-Canton/commit/f4f70f10)
**Closeout comment:** [PR #159 final closeout](https://github.com/luthatdude/Minted-mUSD-Canton/pull/159#issuecomment-3963062495)

### Summary

- Enforced CIP-56 native-first flows in Bridge, Borrow, and Stake components
- Disabled hybrid fallback by default (`ENABLE_HYBRID_FALLBACK` not set)
- Added explicit canary policy semantics (`EXPECTED_BLOCKED_BY_POLICY` verdict)
- Added `ops:canary:native` and `ops:canary:force-conversion:no-fallback` scripts
- Cleaned duplicate script files breaking `tsconfig.scripts.json` typecheck

### Validation

| Gate | Result |
|------|--------|
| CI (all checks) | PASS |
| `tsc --noEmit` | PASS |
| `npm run build` | PASS |
| `ops:doctor` | 12/12 HEALTHY |
| `ops:canary:native` | PASS (redeem succeeded) |
| `ops:canary:force-conversion:no-fallback` | EXPECTED_BLOCKED_BY_POLICY (exit 0) |
| Regression scans | PASS (no stale literals, no removed UI sections, no duplicates) |

### Post-Merge Stability

- [ ] T+1h `ops:check24h`
- [ ] T+4h `ops:check24h`
- [ ] T+24h `ops:check24h`
- [ ] T+7d legacy decommission review
