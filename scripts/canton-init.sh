#!/usr/bin/env bash
# Canton Devnet: Upload DAR + Initialize Protocol
#
# Prerequisites:
#   1. Docker Desktop running
#   2. Splice validator stack: cd ~/splice-node/docker-compose/validator && docker compose up -d
#   3. Port-forward: docker run --rm -d --name canton-port-fwd \
#        --network splice-validator_splice_validator -p 127.0.0.1:7575:7575 \
#        alpine/socat TCP-LISTEN:7575,fork,reuseaddr TCP:participant:7575
#   4. DAR built: cd daml && ~/.daml/bin/daml build

set -euo pipefail

DAML=~/.daml/bin/daml
# Derive DAR filename from daml.yaml to avoid version drift
DAR_VERSION=$(grep '^version:' daml/daml.yaml | awk '{print $2}')
DAR="daml/.daml/dist/ble-protocol-${DAR_VERSION}.dar"
LEDGER_HOST="${LEDGER_HOST:-localhost}"
LEDGER_PORT="${LEDGER_PORT:-7575}"
# Optional: JWT bearer token for authenticated Canton nodes
# Set CANTON_TOKEN env var or create ./secrets/canton_token file
CANTON_TOKEN="${CANTON_TOKEN:-}"
if [[ -z "$CANTON_TOKEN" && -f "./secrets/canton_token" ]]; then
  CANTON_TOKEN=$(cat ./secrets/canton_token)
fi
AUTH_HEADER=""
if [[ -n "$CANTON_TOKEN" ]]; then
  AUTH_HEADER="-H \"Authorization: Bearer $CANTON_TOKEN\""
fi

echo "=== Step 1: Upload DAR ==="
echo "Using: $DAR (v${DAR_VERSION})"

# Verify DAR exists
if [[ ! -f "$DAR" ]]; then
  echo "ERROR: DAR file not found at $DAR"
  echo "Run: cd daml && ~/.daml/bin/daml build"
  exit 1
fi

# SHA256 integrity check
echo "DAR SHA256: $(shasum -a 256 "$DAR" | cut -d' ' -f1)"

# Upload via daml ledger upload-dar (uses gRPC port 5001 by default)
# The HTTP JSON API v2 is on 7575, but upload-dar uses gRPC.
# Check if gRPC is on 5001 (direct) or we need to use HTTP API
if curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/ 2>/dev/null | grep -q "000"; then
  echo "gRPC port 5001 not available, using HTTP API on ${LEDGER_HOST}:${LEDGER_PORT}..."
  # Upload via HTTP JSON API v2
  CURL_AUTH=()
  if [[ -n "$CANTON_TOKEN" ]]; then
    CURL_AUTH=(-H "Authorization: Bearer $CANTON_TOKEN")
  fi
  RESPONSE=$(curl -s -X POST "http://${LEDGER_HOST}:${LEDGER_PORT}/v2/packages" \
    -H "Content-Type: application/octet-stream" \
    "${CURL_AUTH[@]}" \
    --data-binary "@${DAR}" \
    -w "\nHTTP_STATUS:%{http_code}")
  HTTP_STATUS=$(echo "$RESPONSE" | tail -1 | sed 's/HTTP_STATUS://')
  echo "$RESPONSE" | head -n -1
  echo "HTTP Status: $HTTP_STATUS"
  if [[ "$HTTP_STATUS" -ge 400 ]]; then
    echo "ERROR: DAR upload failed with HTTP $HTTP_STATUS"
    exit 1
  fi
else
  echo "Using gRPC port 5001..."
  if [[ -n "$CANTON_TOKEN" ]]; then
    $DAML ledger upload-dar "$DAR" --host "$LEDGER_HOST" --port 5001 --access-token-file <(echo "$CANTON_TOKEN")
  else
    $DAML ledger upload-dar "$DAR" --host "$LEDGER_HOST" --port 5001
  fi
fi

echo ""
echo "=== Step 2: Initialize Protocol ==="
SCRIPT_AUTH_ARGS=()
if [[ -n "$CANTON_TOKEN" ]]; then
  SCRIPT_AUTH_ARGS=(--access-token-file <(echo "$CANTON_TOKEN"))
fi
$DAML script --dar "$DAR" \
  --script-name InitProtocol:initProtocol \
  --ledger-host "$LEDGER_HOST" \
  --ledger-port "$LEDGER_PORT" \
  --wall-clock-time \
  "${SCRIPT_AUTH_ARGS[@]}"

echo ""
echo "=== Canton Protocol Initialized! ==="
echo "DAR uploaded and protocol contracts created on Canton Devnet."
echo "New relayer address (if rotated): check .env for current RELAYER_PRIVATE_KEY"
