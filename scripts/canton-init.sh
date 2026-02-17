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
DAR="daml/.daml/dist/ble-protocol-2.0.0.dar"
LEDGER_HOST="localhost"
LEDGER_PORT="7575"

echo "=== Step 1: Upload DAR ==="
echo "Using: $DAR"

# Upload via daml ledger upload-dar (uses gRPC port 5001 by default)
# The HTTP JSON API v2 is on 7575, but upload-dar uses gRPC.
# Check if gRPC is on 5001 (direct) or we need to use HTTP API
if curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/ 2>/dev/null | grep -q "000"; then
  echo "gRPC port 5001 not available, using HTTP API on 7575..."
  # Upload via HTTP JSON API v2
  curl -X POST "http://${LEDGER_HOST}:${LEDGER_PORT}/v2/packages" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${DAR}" \
    -w "\nHTTP Status: %{http_code}\n"
else
  echo "Using gRPC port 5001..."
  $DAML ledger upload-dar "$DAR" --host "$LEDGER_HOST" --port 5001
fi

echo ""
echo "=== Step 2: Initialize Protocol ==="
$DAML script --dar "$DAR" \
  --script-name InitProtocol:initProtocol \
  --ledger-host "$LEDGER_HOST" \
  --ledger-port "$LEDGER_PORT" \
  --wall-clock-time

echo ""
echo "=== Canton Protocol Initialized! ==="
echo "DAR uploaded and protocol contracts created on Canton Devnet."
