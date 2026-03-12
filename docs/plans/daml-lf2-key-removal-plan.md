# DAML LF2 Key-Removal Migration Plan

## Scope

Canton 3.4.x requires DAML LF 2.1-2.2, which removes support for contract keys.
SDK 3.4.10 produces LF 2.x output. The following modules originally contained `key`
declarations and were blocked from LF 2.x compilation until refactored.

## Status: COMPLETE

All contract-key declarations have been removed. Every module compiles under LF 2.x.
The blocklist (`daml/lf2-blocked-modules.txt`) is fully commented out.

## Previously Blocked Modules (all unblocked)

| Module | Original Issue | Resolution |
|--------|---------------|------------|
| CantonLending.daml | `key (operator, borrower)` on EscrowedCollateral/DebtPosition | Replaced with explicit ContractId passing (Optional CID pattern) |
| CantonBoostPool.daml | `key (operator, user)` on BoostPoolDepositRecord | Replaced with `Optional (ContractId BoostPoolDepositRecord) = None` stub |
| CantonLoopStrategy.daml | No key declarations found | Was blocked conservatively; confirmed clean |
| CantonLendingTest.daml | Imported CantonLending | Unblocked — imports LF2-safe module |
| CantonBoostPoolTest.daml | Imported CantonBoostPool | Unblocked — imports LF2-safe module |
| CantonLoopStrategyTest.daml | Imported CantonLoopStrategy | Unblocked — imports LF2-safe module |
| CrossModuleIntegrationTest.daml | Imported blocked modules | Unblocked — imports LF2-safe modules; stale lookupByKey comment removed |
| UserPrivacySettingsTest.daml | Imported blocked modules | Unblocked — imports LF2-safe modules |

Canonical list: `daml/lf2-blocked-modules.txt`

## Migration Checklist

- [x] Audit each `key` declaration — determine if it can be replaced with contract ID lookups
- [x] For CantonLending: replace `key (operator, borrower)` with explicit contract ID passing
- [x] For CantonBoostPool: replace pool key with ACS query pattern
- [x] For CantonLoopStrategy: replace strategy key with ACS query pattern
- [x] Update all test modules to use new lookup patterns
- [x] Update CrossModuleIntegrationTest for new API surface
- [x] Run `daml build` with blocked modules included (full compile)
- [x] Run `daml test` across all test modules
- [x] Remove modules from `daml/lf2-blocked-modules.txt`
- [x] Update CI to use direct `daml build` instead of `daml-build-lf2.sh`

## Change Log

When modifying any blocked module, add an entry here explaining what changed and why.
The CI changed-files policy (`scripts/daml-lf2-changed-files-policy.sh`) enforces that
this plan is updated alongside any blocked module changes.

| Date | Module | Change | Author |
|------|--------|--------|--------|
| 2026-02-26 | (all) | Initial containment — modules blocked from LF2 compile surface | ops |
| 2026-03-01 | CantonBoostPool.daml | Verified zero key/lookupByKey/fetchByKey declarations — already LF2 safe | protocol |
| 2026-03-01 | CantonLoopStrategy.daml | Verified zero key declarations — already LF2 safe | protocol |
| 2026-03-01 | (all 7 blocked) | All modules unblocked — blocklist cleared, guard passes with 0 active blocks | protocol |
| 2026-03-01 | CrossModuleIntegrationTest.daml | Removed stale `lookupByKey` reference from comment (line 577) | protocol |
| 2026-03-12 | CI | Replaced `daml-build-lf2.sh` wrapper with direct `daml build` in ci.yml | protocol |
