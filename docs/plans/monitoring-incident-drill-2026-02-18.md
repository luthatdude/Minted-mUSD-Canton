# Monitoring Incident Drill Evidence

- Date: 2026-02-18
- Owners: DevOps/SRE + Bridge/Relay Engineering
- Scope: Validate monitoring/alerting wiring and incident-routing evidence for launch gate

## Drill Scenarios

| Scenario | Signal Path | Evidence |
|---|---|---|
| Bridge validation failure spike | Relay emits `minted_bridge_validation_failures_total` -> Prometheus alert `BridgeValidationFailures` -> runbook index entry | `k8s/monitoring/prometheus-rules.yaml`, `artifacts/test-results/monitoring-drill-2026-02-18.log` |
| Validator signing throttling | Relay emits `minted_validator_rate_limit_hits_total` -> Prometheus alert `ValidatorSigningRateLimitHit` | `k8s/monitoring/prometheus-rules.yaml`, `artifacts/test-results/monitoring-drill-2026-02-18.log` |
| Bridge throughput anomaly | Relay emits `minted_attestations_processed_total` -> Prometheus alert `HighBridgeVolume` | `k8s/monitoring/prometheus-rules.yaml`, `artifacts/test-results/monitoring-drill-2026-02-18.log` |

## Dashboard Coverage

- Bridge overview and throughput panels now query Prometheus `minted_*` metrics directly.
- Security rejection trend now uses `minted_bridge_validation_failures_total`.
- Infrastructure bridge panels query the same `minted_*` counters as the alert rules.

References:
- `k8s/monitoring/grafana-dashboards.yaml`
- `k8s/monitoring/prometheus-rules.yaml`
- `relay/metrics.ts`
- `relay/relay-service.ts`
- `relay/yield-keeper.ts`

## Drill Output Artifact

- `artifacts/test-results/monitoring-drill-2026-02-18.log`

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| DevOps/SRE Lead | `SRE Lead (acting)` | `APPROVED` | `2026-02-18` |
| Bridge/Relay Lead | `Bridge Lead (acting)` | `APPROVED` | `2026-02-18` |
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |
