# Launch Readiness Package

- Date: 2026-02-18
- Owners: Security Lead + Operations/Compliance + Release Manager
- Scope: Item-12 launch-readiness package (bug bounty, emergency contacts, audit closeout, go/no-go memo)

## Package Contents

- `audit/SECURITY.md`
- `docs/plans/pre-mainnet-checklist-evidence.md`
- `docs/plans/mainnet-risk-register.md`
- `docs/plans/v9-migration-dress-rehearsal-report-2026-02-18.md`
- `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`

## 1) Bug Bounty Status

- Program state: `ACTIVE`
- Effective date: `2026-02-18`
- Scope: pre-mainnet/mainnet launch contracts, relay, Canton integration surface
- Evidence: `audit/SECURITY.md`, `docs/plans/pre-mainnet-checklist-evidence.md`

## 2) Emergency Contacts + Hotline

| Channel | Endpoint | Status |
|---|---|---|
| Security lead mailbox | `security@minted.finance` | Active |
| Emergency hotline | `security-hotline@minted.finance` | Active |
| Escalation route | Pager/incident runbook routing | Active |

Distribution and routing evidence:

- `audit/SECURITY.md`
- `docs/RUNBOOKS.md`
- `docs/plans/monitoring-incident-drill-2026-02-18.md`

## 3) Audit Status Closeout

| Audit Closeout Gate | Status | Evidence |
|---|---|---|
| Medium findings owner/decision/evidence completeness | CLOSED | `docs/plans/mainnet-risk-register.md` |
| Test backlog ownership and CI artifact mapping | CLOSED | `docs/plans/test-backlog-mapping.md`, `.github/workflows/ci.yml` |
| Main security checklist evidence bundle | CLOSED | `docs/plans/pre-mainnet-checklist-evidence.md` |

## 4) Go/No-Go Memo

Decision for this package:

- `GO` for controlled mainnet release execution window, with evidence package complete.
- Hard gate remains: no public launch announcement until live deployment transaction hashes and final verification links are captured in `docs/plans/mainnet-deploy-cutover-evidence-2026-02-18.md`.

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |
| Operations/Compliance Lead | `Ops/Compliance (acting)` | `APPROVED` | `2026-02-18` |
| Release Manager | `Release Manager (acting)` | `APPROVED` | `2026-02-18` |
