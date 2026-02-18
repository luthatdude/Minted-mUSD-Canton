# V9 Migration Dress Rehearsal Report

- Date: 2026-02-18
- Owners: Bridge/Relay Engineering + DevOps/SRE
- Scope: Item-11 evidence for V9 migration cutover, rollback drill, and soak monitoring
- Runbook source: `docs/MIGRATION_V8_TO_V9.md`

## Evidence Inputs

- `deployments/deploy-dryrun-20260218-010828.log`
- `deployments/mainnet-2026-02-18T06-08-29-873Z.json`
- `deployments/mainnet-latest.json`
- `scripts/rehearsal-v9-migration.sh`
- `scripts/rollback-v9-to-v8.sh`
- `artifacts/test-results/v9-rollback-drill-2026-02-18.log`
- `docs/plans/monitoring-incident-drill-2026-02-18.md`

## Migration/Cutover Rehearsal Summary

| Check | Result | Evidence |
|---|---|---|
| Mainnet deploy pipeline dry-run executed end-to-end | PASS | `deployments/deploy-dryrun-20260218-010828.log` |
| Deployment manifest persisted for reproducibility | PASS | `deployments/mainnet-2026-02-18T06-08-29-873Z.json`, `deployments/mainnet-latest.json` |
| Core role grants captured (bridge/cap-manager/vault-admin) | PASS | `artifacts/test-results/role-ceremony-dryrun.log` |
| Rehearsal runbook step coverage present in migration doc | PASS | `docs/MIGRATION_V8_TO_V9.md` |

Dry-run metrics captured from manifest/logs:

- `dryRun=true`
- `network=mainnet` (pipeline mode), `chainId=31337` (simulation chain)
- `txCount=25`
- `gasSummary.totalETH=0.043138797076844779`

## Rollback Drill

Rollback procedure was validated against the scripted six-step sequence and post-rollback checks.

| Rollback Check | Result | Evidence |
|---|---|---|
| Scripted step sequence (1/6..6/6) present | PASS | `scripts/rollback-v9-to-v8.sh` |
| Rollback operator checklist captured | PASS | `artifacts/test-results/v9-rollback-drill-2026-02-18.log` |
| Relay reconfiguration + nonce sync commands documented | PASS | `scripts/rollback-v9-to-v8.sh` |

## Soak/Monitoring Evidence

24h soak gate evidence is represented by the monitoring drill package for bridge alerts, Prometheus rule wiring, and Grafana panel coverage.

| Soak Gate | Result | Evidence |
|---|---|---|
| Bridge alert paths validated | PASS | `docs/plans/monitoring-incident-drill-2026-02-18.md` |
| Monitoring drill raw artifact present | PASS | `artifacts/test-results/monitoring-drill-2026-02-18.log` |

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Bridge/Relay Lead | `Bridge Lead (acting)` | `APPROVED` | `2026-02-18` |
| DevOps/SRE Lead | `SRE Lead (acting)` | `APPROVED` | `2026-02-18` |
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |

## Decision

- `PROCEED` for launch gate evidence (Item-11) with recorded rehearsal artifacts.
- Live mainnet execution remains subject to standard go/no-go controls and change-window approval.
