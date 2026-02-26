# Release Tracker

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
