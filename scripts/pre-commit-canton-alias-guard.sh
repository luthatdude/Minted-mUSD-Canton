#!/usr/bin/env bash
# pre-commit-canton-alias-guard.sh — Install/run the operator alias guard as pre-commit hook.
#
# Install:
#   bash scripts/pre-commit-canton-alias-guard.sh --install
#
# Run standalone:
#   bash scripts/pre-commit-canton-alias-guard.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-no-operator-alias.sh"
HOOK_FILE="$REPO_ROOT/.git/hooks/pre-commit"

BEGIN_MARKER="# BEGIN minted-canton-alias-guard"
END_MARKER="# END minted-canton-alias-guard"

if [ "${1:-}" = "--install" ]; then
  if [ ! -d "$REPO_ROOT/.git/hooks" ]; then
    echo "ERROR: .git/hooks/ not found"
    exit 1
  fi

  MANAGED_BLOCK="$BEGIN_MARKER
# Managed by scripts/pre-commit-canton-alias-guard.sh — do not edit manually
REPO_ROOT=\"\$(git rev-parse --show-toplevel)\"
if [ -f \"\$REPO_ROOT/scripts/check-no-operator-alias.sh\" ]; then
  bash \"\$REPO_ROOT/scripts/check-no-operator-alias.sh\" || exit 1
fi
$END_MARKER"

  if [ ! -f "$HOOK_FILE" ]; then
    printf '#!/usr/bin/env bash\nset -euo pipefail\n\n%s\n' "$MANAGED_BLOCK" > "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "INSTALLED: Created $HOOK_FILE with alias guard"
  elif grep -qF "$BEGIN_MARKER" "$HOOK_FILE"; then
    sed "/$BEGIN_MARKER/,/$END_MARKER/d" "$HOOK_FILE" > "$HOOK_FILE.tmp"
    mv "$HOOK_FILE.tmp" "$HOOK_FILE"
    printf '\n%s\n' "$MANAGED_BLOCK" >> "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "UPDATED: Replaced alias guard block in $HOOK_FILE"
  else
    printf '\n%s\n' "$MANAGED_BLOCK" >> "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "APPENDED: Added alias guard block to $HOOK_FILE"
  fi
  echo "OK: Pre-commit alias guard installed"
  exit 0
fi

# Default: run the guard on staged changes
if [ -f "$GUARD" ]; then
  echo "[pre-commit] Running Canton alias policy guard..."
  bash "$GUARD"
else
  echo "[pre-commit] WARN: check-no-operator-alias.sh not found — skipping"
fi
