# Mainnet Test Backlog Mapping

- Created: 2026-02-18
- Scope: Outstanding test classes referenced in:
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:761`
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:1348`
- Objective: Convert each backlog item into concrete test targets, commands, CI gates, and required artifacts.

## Execution Rules

1. Every backlog class must map to a committed test file path.
2. Every backlog class must have a deterministic command.
3. Every backlog class must produce an artifact link in PR/CI.
4. Launch gate passes only when all rows are `Implemented`.

## A. Solidity Backlog Mapping

| Backlog Class | Source | Proposed Test File(s) | Command | Required Artifact | Owner | Status |
|---|---|---|---|---|---|---|
| Fuzzing for arithmetic operations (fee calculations) | `SECURITY_AUDIT.md:761` | `test/fuzz/FeeMath.fuzz.test.ts` | `npx hardhat test test/fuzz/FeeMath.fuzz.test.ts` | `artifacts/test-results/fee-fuzz.log` | Protocol Engineering | Implemented |
| Invariant testing (`totalSupply <= supplyCap`) | `SECURITY_AUDIT.md:762` | `test/invariants/SupplyCap.invariant.test.ts` | `npx hardhat test test/invariants/SupplyCap.invariant.test.ts` | `artifacts/test-results/supply-invariant.log` | Protocol Engineering | Implemented |
| Fork testing against mainnet Chainlink feeds | `SECURITY_AUDIT.md:763` | `test/fork/PriceOracle.mainnetFork.test.ts` | `MAINNET_FORK_RPC_URL=<rpc> npx hardhat test test/fork/PriceOracle.mainnetFork.test.ts` | `artifacts/test-results/oracle-mainnet-fork.log` | Protocol Engineering | Implemented (requires `MAINNET_FORK_RPC_URL` in CI) |
| Gas benchmarking for loop-heavy functions | `SECURITY_AUDIT.md:764` | `test/gas/LoopFunctions.gas.test.ts` | `REPORT_GAS=true npx hardhat test test/gas/LoopFunctions.gas.test.ts` | `artifacts/test-results/gas-benchmark.log` | Protocol Engineering | Implemented |
| Upgrade testing for UUPS contracts | `SECURITY_AUDIT.md:765` | `test/upgrade/UUPSRegression.test.ts` | `npx hardhat test test/upgrade/UUPSRegression.test.ts` | `artifacts/test-results/uups-upgrade.log` | Protocol Engineering | Implemented |

## B. Canton Backlog Mapping

| Backlog Class | Source | Proposed Test File(s) | Command | Required Artifact | Owner | Status |
|---|---|---|---|---|---|---|
| Quorum boundary: exactly quorum vs quorum-1 signatures | `SECURITY_AUDIT.md:1348` | `daml/CantonEdgeCasesTest.daml` (script: `test_bridgeQuorumBoundary`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_bridgeQuorumBoundary` | `artifacts/test-results/canton-quorum-boundary.log` | Protocol Engineering (DAML) | Implemented |
| Rate limit window reset edge cases | `SECURITY_AUDIT.md:1349` | `daml/CantonEdgeCasesTest.daml` (script: `test_rateLimitWindowReset`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_rateLimitWindowReset` | `artifacts/test-results/canton-rate-limit-reset.log` | Protocol Engineering (DAML) | Implemented |
| Concurrent attestations with overlapping validator groups | `SECURITY_AUDIT.md:1350` | `daml/CantonEdgeCasesTest.daml` (script: `test_concurrentOverlappingAttestations`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_concurrentOverlappingAttestations` | `artifacts/test-results/canton-overlap-attestations.log` | Protocol Engineering (DAML) | Implemented |
| ComplianceRegistry integration with all minting paths | `SECURITY_AUDIT.md:1351` | `daml/CantonEdgeCasesTest.daml` (script: `test_complianceAllMintPaths`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_complianceAllMintPaths` | `artifacts/test-results/canton-compliance-mint-paths.log` | Protocol Engineering (DAML) | Implemented |
| Cross-module precision consistency (`Decimal` vs `Numeric 18`) | `SECURITY_AUDIT.md:1352` | `daml/CantonEdgeCasesTest.daml` (script: `test_precisionConsistency`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_precisionConsistency` | `artifacts/test-results/canton-precision-consistency.log` | Protocol Engineering (DAML) | Implemented |
| Negative/zero amount rejection across templates | `SECURITY_AUDIT.md:1353` | `daml/CantonEdgeCasesTest.daml` (script: `test_rejectZeroOrNegative`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_rejectZeroOrNegative` | `artifacts/test-results/canton-amount-rejection.log` | Protocol Engineering (DAML) | Implemented |
| Emergency transfer audit trail verification | `SECURITY_AUDIT.md:1354` | `daml/CantonEdgeCasesTest.daml` (script: `test_emergencyTransferAuditTrail`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_emergencyTransferAuditTrail` | `artifacts/test-results/canton-emergency-audit-trail.log` | Protocol Engineering (DAML) | Implemented |
| `YieldAttestation` epoch-gap behavior | `SECURITY_AUDIT.md:1355` | `daml/CantonEdgeCasesTest.daml` (script: `test_yieldAttestationEpochGap`) | `cd daml && daml test --files CantonEdgeCasesTest.daml --test-pattern test_yieldAttestationEpochGap` | `artifacts/test-results/canton-yield-epoch-gap.log` | Protocol Engineering (DAML) | Implemented |

## C. CI Integration Checklist

| CI Gate | Required Checks | Pass Condition |
|---|---|---|
| `solidity-extended` | fuzz, invariants, fork-oracle, gas, UUPS | All five commands pass and artifacts uploaded |
| `daml-extended` | 8 edge-case scenarios above | All 8 scenario commands pass and per-scenario evidence uploaded |
| `launch-readiness-tests` | aggregate summary | No backlog row remains `Planned`/`In Progress` |

## D. Artifact Evidence Template

Use one row per completed class in PR description or release checklist:

| Class | File(s) | Command | Result | Artifact Link | Reviewer |
|---|---|---|---|---|---|
| `TBD` | `TBD` | `TBD` | `PASS/FAIL` | `TBD` | `TBD` |
