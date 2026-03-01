#!/usr/bin/env bash
# pre-push-daml-guard.sh — Git pre-push hook that runs the DAML SDK guard.
#
# Install:
#   cp scripts/pre-push-daml-guard.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
# Or symlink:
#   ln -sf ../../scripts/pre-push-daml-guard.sh .git/hooks/pre-push
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" \
  || REPO_ROOT="$(git rev-parse --show-toplevel)"

GUARD="$REPO_ROOT/scripts/daml-sdk-guard.sh"

if [ -f "$GUARD" ]; then
  echo "[pre-push] Running DAML SDK version guard..."
  bash "$GUARD"
else
  echo "[pre-push] WARN: daml-sdk-guard.sh not found at $GUARD — skipping"
fi
