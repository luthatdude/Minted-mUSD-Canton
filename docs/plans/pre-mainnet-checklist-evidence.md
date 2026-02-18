# Pre-Mainnet Checklist Evidence

- Prepared: 2026-02-18
- Scope: Evidence bundle for `audit/SECURITY.md` deployment checklist
- Owner: Security Lead + Protocol Engineering

## Evidence Map

### 1) Contracts verification workflow

- Verification pipeline and commands:
  - `scripts/deploy-mainnet.sh` (`--verify-only` path)
  - `deployments/README.md`
  - `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`
- Evidence links:
  - `scripts/deploy-mainnet.sh`
  - `deployments/README.md`
  - `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`

### 2) Admin roles transferred to multisig/timelock

- Transfer and handoff workflows:
  - `scripts/transfer-all-admin-roles.ts`
  - `scripts/capture-role-ceremony-evidence.ts` (target-network proof capture; rejects dry-run/local chain)
  - `docs/plans/role-ceremony-evidence.md`
- Evidence links:
  - `scripts/transfer-all-admin-roles.ts`
  - `scripts/capture-role-ceremony-evidence.ts`
  - `docs/plans/role-ceremony-evidence.md`
  - `artifacts/test-results/role-ceremony-sepolia-proof.log`
  - `artifacts/test-results/role-ceremony-mainnet-proof.log` (required at launch)

### 3) Production rate limits configured

- Configured parameters and checks:
  - `contracts/BLEBridgeV9.sol` (24h cap controls)
  - `contracts/PriceOracle.sol` (staleness/deviation guards)
  - `scripts/deploy-mainnet.ts` (`PROTOCOL_PARAMS`)
- Evidence links:
  - `contracts/BLEBridgeV9.sol`
  - `contracts/PriceOracle.sol`
  - `scripts/deploy-mainnet.ts`

### 4) Monitoring and alerting enabled

- Monitoring manifests and alert rules:
  - `k8s/monitoring/prometheus-rules.yaml`
  - `k8s/monitoring/grafana-dashboards.yaml`
  - `scripts/validate-monitoring-evidence.sh` (placeholder/runbook/metric wiring validation)
  - `docs/plans/monitoring-incident-drill-2026-02-18.md`
- Evidence links:
  - `k8s/monitoring/prometheus-rules.yaml`
  - `k8s/monitoring/grafana-dashboards.yaml`
  - `artifacts/test-results/monitoring-routing-validation.log`
  - `docs/plans/monitoring-incident-drill-2026-02-18.md`
  - `artifacts/test-results/monitoring-drill-2026-02-18.log`

### 5) Incident response runbooks tested

- Runbook and drill artifacts:
  - `docs/RUNBOOKS.md`
  - `deployments/deploy-dryrun-20260218-003037.log` (deployment failure drill path)
  - `docs/plans/monitoring-incident-drill-2026-02-18.md`
- Evidence links:
  - `docs/RUNBOOKS.md`
  - `deployments/deploy-dryrun-20260218-003037.log`
  - `docs/plans/monitoring-incident-drill-2026-02-18.md`
  - `artifacts/test-results/monitoring-drill-2026-02-18.log`

### 6) Bug bounty program launched

- Program policy and scope:
  - `audit/SECURITY.md` (bug bounty section)
  - `docs/plans/launch-readiness-package-2026-02-18.md`
- Evidence links:
  - `audit/SECURITY.md`
  - `docs/plans/launch-readiness-package-2026-02-18.md`

### 7) Audit findings remediated / dispositioned

- Tracking and closure artifacts:
  - `docs/plans/mainnet-risk-register.md`
  - `docs/plans/test-backlog-mapping.md`
  - `.github/workflows/ci.yml` (launch-readiness artifact gate)
  - `scripts/capture-ci-status.ts` (API-based CI status capture without `gh`)
- Evidence links:
  - `docs/plans/mainnet-risk-register.md`
  - `docs/plans/test-backlog-mapping.md`
  - `.github/workflows/ci.yml`
  - `artifacts/test-results/ci-latest-status.log`

### 8) Emergency contacts distributed

- Contact roster and emergency channels:
  - `audit/SECURITY.md` (security contacts section)
  - `docs/plans/launch-readiness-package-2026-02-18.md`
- Evidence links:
  - `audit/SECURITY.md`
  - `docs/plans/launch-readiness-package-2026-02-18.md`

### 9) V9 migration/cutover + rollback dress rehearsal

- Rehearsal and rollback assets:
  - `docs/MIGRATION_V8_TO_V9.md`
  - `docs/plans/v9-migration-dress-rehearsal-report-2026-02-18.md`
  - `artifacts/test-results/v9-rollback-drill-2026-02-18.log`
- Evidence links:
  - `docs/plans/v9-migration-dress-rehearsal-report-2026-02-18.md`
  - `artifacts/test-results/v9-rollback-drill-2026-02-18.log`

### 10) Launch readiness package (bug bounty + hotline + audit closure)

- Signed package and go/no-go memo:
  - `docs/plans/launch-readiness-package-2026-02-18.md`
- Evidence links:
  - `docs/plans/launch-readiness-package-2026-02-18.md`

### 11) Mainnet deployment + verification + frontend cutover evidence

- Deployment and cutover evidence:
  - `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`
  - `deployments/mainnet-latest.json`
- Evidence links:
  - `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`
  - `deployments/mainnet-latest.json`

### 12) Canton production domain-connect runtime evidence

- Runtime capture workflow:
  - `scripts/capture-canton-domain-evidence.sh`
- Evidence links:
  - `scripts/capture-canton-domain-evidence.sh`
  - `artifacts/test-results/canton-domain-connect-live.log`

## Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Operations/Compliance | `Ops/Compliance (acting)` | `APPROVED` | `2026-02-18` |
