#!/usr/bin/env bash
# pre-push-daml-lf2-guard.sh — Git pre-push hook for LF2 guard.
# Fails the push if any LF2 guard violations are detected.
#
# Install via: bash scripts/install-pre-push-daml-lf2-guard.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" \
  || REPO_ROOT="$(git rev-parse --show-toplevel)"

GUARD="$REPO_ROOT/scripts/daml-lf2-guard.sh"

if [ -f "$GUARD" ]; then
  echo "[pre-push] Running DAML LF2 guard..."
  bash "$GUARD"
else
  echo "[pre-push] WARN: daml-lf2-guard.sh not found at $GUARD — skipping"
fi
