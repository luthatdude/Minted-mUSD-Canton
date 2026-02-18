#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${OUTPUT_FILE:-$ROOT_DIR/artifacts/test-results/canton-domain-connect-live.log}"
NAMESPACE="${CANTON_NAMESPACE:-musd-canton}"
LABEL_SELECTOR="${CANTON_PARTICIPANT_LABEL:-app.kubernetes.io/name=canton-participant}"
LOG_PATTERN="Connected participant to domain alias"

mkdir -p "$(dirname "$OUT_FILE")"

status="PASS"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

append() {
  echo "$1" >>"$OUT_FILE"
}

fail() {
  append "$1"
  status="FAIL"
}

mask_url() {
  # Keep scheme + host for evidence, strip path/query.
  # shellcheck disable=SC2001
  echo "$1" | sed -E 's#(https?://[^/]+).*#\1#'
}

{
  echo "timestamp=$timestamp"
  echo "namespace=$NAMESPACE"
  echo "label_selector=$LABEL_SELECTOR"
  echo "mode=live-k8s"
} >"$OUT_FILE"

if ! command -v kubectl >/dev/null 2>&1; then
  fail "check=kubectl_available result=FAIL detail=kubectl_not_found"
  append "status=$status"
  exit 1
fi
append "check=kubectl_available result=PASS"

if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  fail "check=namespace_exists result=FAIL detail=namespace_not_found"
  append "status=$status"
  exit 1
fi
append "check=namespace_exists result=PASS"

if ! kubectl get secret -n "$NAMESPACE" canton-domain-connection >/dev/null 2>&1; then
  fail "check=domain_secret_exists result=FAIL detail=secret_missing"
  append "status=$status"
  exit 1
fi
append "check=domain_secret_exists result=PASS"

alias_b64="$(kubectl get secret -n "$NAMESPACE" canton-domain-connection -o jsonpath='{.data.CANTON_DOMAIN_ALIAS}' || true)"
url_b64="$(kubectl get secret -n "$NAMESPACE" canton-domain-connection -o jsonpath='{.data.CANTON_DOMAIN_URL}' || true)"

if [[ -z "$alias_b64" || -z "$url_b64" ]]; then
  fail "check=domain_secret_keys result=FAIL detail=missing_key_data"
else
  alias_val="$(echo "$alias_b64" | base64 --decode 2>/dev/null || true)"
  url_val="$(echo "$url_b64" | base64 --decode 2>/dev/null || true)"
  if [[ -z "$alias_val" || -z "$url_val" ]]; then
    fail "check=domain_secret_values result=FAIL detail=empty_value"
  else
    append "check=domain_secret_values result=PASS alias=$alias_val url_host=$(mask_url "$url_val")"
  fi
fi

pod_name="$(kubectl get pods -n "$NAMESPACE" -l "$LABEL_SELECTOR" -o jsonpath='{.items[0].metadata.name}' || true)"
if [[ -z "$pod_name" ]]; then
  fail "check=participant_pod_present result=FAIL detail=no_matching_pod"
  append "status=$status"
  exit 1
fi
append "check=participant_pod_present result=PASS pod=$pod_name"

if kubectl logs -n "$NAMESPACE" "$pod_name" --since=24h | rg -n "$LOG_PATTERN" >/dev/null; then
  append "check=domain_connect_log result=PASS pattern=\"$LOG_PATTERN\""
else
  fail "check=domain_connect_log result=FAIL pattern=\"$LOG_PATTERN\""
fi

append "status=$status"

if [[ "$status" != "PASS" ]]; then
  exit 1
fi

