# DAML LF2 Key-Removal Migration Plan

## Scope

Canton 3.4.x requires DAML LF 2.1-2.2, which removes support for contract keys.
SDK 3.4.10 produces LF 2.x output. The following modules contain `key` declarations
and cannot compile under LF 2.x without refactoring.

## Current Blocked Modules

| Module | Key Declarations | Role |
|--------|-----------------|------|
| CantonLending.daml | Yes | Lending protocol core |
| CantonBoostPool.daml | Yes | Boost pool logic |
| CantonLoopStrategy.daml | Yes | Loop strategy logic |
| CantonLendingTest.daml | Imports CantonLending | Test module |
| CantonBoostPoolTest.daml | Imports CantonBoostPool | Test module |
| CantonLoopStrategyTest.daml | Imports CantonLoopStrategy | Test module |
| CrossModuleIntegrationTest.daml | Imports blocked modules | Integration test |
| UserPrivacySettingsTest.daml | Imports blocked modules | Test module |

Canonical list: `daml/lf2-blocked-modules.txt`

## Migration Checklist

- [ ] Audit each `key` declaration — determine if it can be replaced with contract ID lookups
- [ ] For CantonLending: replace `key (operator, borrower)` with explicit contract ID passing
- [ ] For CantonBoostPool: replace pool key with ACS query pattern
- [ ] For CantonLoopStrategy: replace strategy key with ACS query pattern
- [ ] Update all test modules to use new lookup patterns
- [ ] Update CrossModuleIntegrationTest for new API surface
- [ ] Run `daml build` with blocked modules included (full compile)
- [ ] Run `daml test` across all test modules
- [ ] Remove modules from `daml/lf2-blocked-modules.txt`
- [ ] Update CI to use direct `daml build` instead of `daml-build-lf2.sh`

## Change Log

When modifying any blocked module, add an entry here explaining what changed and why.
The CI changed-files policy (`scripts/daml-lf2-changed-files-policy.sh`) enforces that
this plan is updated alongside any blocked module changes.

| Date | Module | Change | Author |
|------|--------|--------|--------|
| 2026-02-26 | (all) | Initial containment — modules blocked from LF2 compile surface | ops |
