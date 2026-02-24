# CIP-56 Rollout Build Evidence

**Date:** 2026-02-24
**Commit:** defc4d7d (codex/audit-remediation-2026-02-18)
**Scope:** 14 files, +1159/-29 lines

## Build Matrix Results

| Component | SDK/Tool | Result | Details |
|-----------|----------|--------|---------|
| Main DAR (`daml/`) | SDK 2.10.3 | BUILD OK | `ble-protocol-1.0.0.dar` |
| Main DAR tests | SDK 2.10.3 | 232 ok / 17 failed | 17 failures are **pre-existing** (CantonDirectMintTest unique key violations, unrelated to CIP-56 changes) |
| CIP-56 DAR (`daml-cip56/`) | SDK 3.4.10 | BUILD OK | `ble-protocol-cip56-1.0.0.dar` |
| CIP-56 tests | SDK 3.4.10 | **7/7 ok** | TransferFactory, TransferInstruction (accept/reject/withdraw/update), AllocationFactory (execute/cancel/withdraw) |
| Relay (`relay/`) | TypeScript/tsc | BUILD OK | No errors |
| Frontend (`frontend/`) | Next.js 15 | BUILD OK | All 17 routes compiled |

## Changes in This Commit

### Daml (CRIT-01/02/03 Security Fixes)
- `V3.daml`: SignedAttestation co-signatory hardening (CRIT-01), `archive` -> `exercise Attestation_Complete` (CRIT-02/03)
- `CantonEdgeCasesTest.daml`: Updated 3 test blocks for `SignedAttestation_AddSignature`

### CIP-56 Package (NEW)
- `daml-cip56/CIP56Interfaces.daml`: CIP56MintedMUSD holding, MUSDTransferFactory, MUSDTransferInstruction, MUSDAllocationFactory, MUSDAllocation
- `daml-cip56/CIP56TransferAllocationTest.daml`: 7 comprehensive tests
- `deps/`: 5 splice-api-token DARs

### Relay Dual-Path
- `canton-client.ts`: CIP-56 template IDs in TEMPLATES map
- `relay-service.ts`:
  - Factory detection at startup (cached `cip56TransferFactoryCid`)
  - Dual-path bridge-in: CIP56MintedMUSD + TransferFactory_Transfer when factory exists, legacy CantonMUSD_Transfer fallback
  - CIP-56 orphan recovery scanner
  - CIP-56 duplicate check in bridge-in idempotency

### Frontend
- `canton-command.ts`: CIP-56 template IDs (conditional on `NEXT_PUBLIC_CIP56_PACKAGE_ID`)
- `CantonMint.tsx`: CIP-56 template candidates for wallet discovery

## Pre-existing Failures (17)

All in `CantonDirectMintTest.daml` (11), `CantonEdgeCasesTest.daml` (2), `CantonLendingTest.daml` (3), `CrossModuleIntegrationTest.daml` (1). Root cause: unique key violations in `CantonDirectMintService` template — unrelated to attestation or CIP-56 changes.

## Log Files

- `daml-main-test.log` — Full main DAR test output
- `daml-cip56-test.log` — Full CIP-56 test output
- `relay-build.log` — Relay TypeScript compilation
- `frontend-build.log` — Frontend Next.js build
