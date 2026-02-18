#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${OUTPUT_FILE:-$ROOT_DIR/artifacts/test-results/monitoring-routing-validation.log}"
RULES_FILE="$ROOT_DIR/k8s/monitoring/prometheus-rules.yaml"
GRAFANA_FILE="$ROOT_DIR/k8s/monitoring/grafana-dashboards.yaml"
DRILL_FILE="${DRILL_FILE:-$ROOT_DIR/artifacts/test-results/monitoring-drill-2026-02-18.log}"

mkdir -p "$(dirname "$OUT_FILE")"

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
status="PASS"

check_fail() {
  echo "$1" >>"$OUT_FILE"
  status="FAIL"
}

{
  echo "timestamp=$timestamp"
  echo "rules_file=$RULES_FILE"
  echo "grafana_file=$GRAFANA_FILE"
  echo "drill_file=$DRILL_FILE"
  echo "checks_begin=true"
} >"$OUT_FILE"

# 1) No placeholder runbook URLs.
if rg -n "your-docs-platform\\.example\\.com|docs\\.example\\.com" "$RULES_FILE" >/dev/null; then
  check_fail "check=runbook_placeholders result=FAIL"
else
  echo "check=runbook_placeholders result=PASS" >>"$OUT_FILE"
fi

# 2) Bridge security alerts are present and wired to minted_* metrics.
if rg -n "alert: BridgeValidationFailures|alert: ValidatorSigningRateLimitHit|alert: HighBridgeVolume" "$RULES_FILE" >/dev/null; then
  echo "check=bridge_alert_rules result=PASS" >>"$OUT_FILE"
else
  check_fail "check=bridge_alert_rules result=FAIL"
fi

if rg -n "minted_bridge_validation_failures_total|minted_validator_rate_limit_hits_total|minted_attestations_processed_total" "$RULES_FILE" >/dev/null; then
  echo "check=bridge_metrics_rules result=PASS" >>"$OUT_FILE"
else
  check_fail "check=bridge_metrics_rules result=FAIL"
fi

# 3) Grafana dashboards query minted_* bridge metrics directly.
if rg -n "minted_bridge_validation_failures_total|minted_validator_rate_limit_hits_total|minted_attestations_processed_total" "$GRAFANA_FILE" >/dev/null; then
  echo "check=bridge_metrics_grafana result=PASS" >>"$OUT_FILE"
else
  check_fail "check=bridge_metrics_grafana result=FAIL"
fi

# 4) Drill artifact exists and includes metric checks.
if [[ -f "$DRILL_FILE" ]]; then
  echo "check=drill_artifact_exists result=PASS" >>"$OUT_FILE"
  if rg -n "prometheus_rule_metric_names|grafana_queries_metric_names" "$DRILL_FILE" >/dev/null; then
    echo "check=drill_metric_paths result=PASS" >>"$OUT_FILE"
  else
    check_fail "check=drill_metric_paths result=FAIL"
  fi
else
  check_fail "check=drill_artifact_exists result=FAIL"
fi

echo "status=$status" >>"$OUT_FILE"

if [[ "$status" != "PASS" ]]; then
  exit 1
fi

