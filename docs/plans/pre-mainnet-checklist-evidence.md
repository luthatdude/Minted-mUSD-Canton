# Pre-Mainnet Checklist Evidence

- Prepared: 2026-02-18
- Scope: Evidence bundle for `audit/SECURITY.md` deployment checklist
- Owner: Security Lead + Protocol Engineering

## Evidence Map

### 1) Contracts verification workflow

- Verification pipeline and commands:
  - `scripts/deploy-mainnet.sh` (`--verify-only` path)
  - `deployments/README.md`
- Evidence links:
  - `scripts/deploy-mainnet.sh`
  - `deployments/README.md`

### 2) Admin roles transferred to multisig/timelock

- Transfer and handoff workflows:
  - `scripts/transfer-all-admin-roles.ts`
  - `scripts/deploy-mainnet.ts` (admin handoff section)
  - `docs/plans/role-ceremony-evidence.md`
- Evidence links:
  - `scripts/transfer-all-admin-roles.ts`
  - `scripts/deploy-mainnet.ts`
  - `docs/plans/role-ceremony-evidence.md`
  - `artifacts/test-results/role-ceremony-dryrun.log`

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
  - `docs/plans/monitoring-incident-drill-2026-02-18.md`
- Evidence links:
  - `k8s/monitoring/prometheus-rules.yaml`
  - `k8s/monitoring/grafana-dashboards.yaml`
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
- Evidence links:
  - `audit/SECURITY.md`

### 7) Audit findings remediated / dispositioned

- Tracking and closure artifacts:
  - `docs/plans/mainnet-risk-register.md`
  - `docs/plans/test-backlog-mapping.md`
  - `.github/workflows/ci.yml` (launch-readiness artifact gate)
- Evidence links:
  - `docs/plans/mainnet-risk-register.md`
  - `docs/plans/test-backlog-mapping.md`
  - `.github/workflows/ci.yml`

### 8) Emergency contacts distributed

- Contact roster and emergency channels:
  - `audit/SECURITY.md` (security contacts section)
- Evidence links:
  - `audit/SECURITY.md`

## Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Operations/Compliance | `Ops/Compliance (acting)` | `APPROVED` | `2026-02-18` |
