#!/usr/bin/env bash
# install-pre-push-daml-lf2-guard.sh — Install/update the LF2 guard pre-push hook.
#
# Idempotent: safe to run multiple times. Uses managed block markers to
# avoid clobbering existing hook content.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$REPO_ROOT/.git/hooks"
HOOK_FILE="$HOOK_DIR/pre-push"

BEGIN_MARKER="# BEGIN minted-daml-lf2-guard"
END_MARKER="# END minted-daml-lf2-guard"

MANAGED_BLOCK="$BEGIN_MARKER
# Managed by scripts/install-pre-push-daml-lf2-guard.sh — do not edit manually
REPO_ROOT=\"\$(git rev-parse --show-toplevel)\"
if [ -f \"\$REPO_ROOT/scripts/daml-lf2-guard.sh\" ]; then
  echo \"[pre-push] Running DAML LF2 guard...\"
  bash \"\$REPO_ROOT/scripts/daml-lf2-guard.sh\" || exit 1
fi
$END_MARKER"

# ── Ensure hooks dir exists ────────────────────────────────────────
if [ ! -d "$HOOK_DIR" ]; then
  echo "ERROR: .git/hooks/ not found at $HOOK_DIR"
  echo "  Are you in a git repository?"
  exit 1
fi

# ── Create or update hook file ─────────────────────────────────────
if [ ! -f "$HOOK_FILE" ]; then
  # No existing hook — create new
  printf '#!/usr/bin/env bash\nset -euo pipefail\n\n%s\n' "$MANAGED_BLOCK" > "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
  echo "INSTALLED: Created $HOOK_FILE with LF2 guard block"
elif grep -qF "$BEGIN_MARKER" "$HOOK_FILE"; then
  # Managed block exists — remove old block, then append fresh
  sed "/$BEGIN_MARKER/,/$END_MARKER/d" "$HOOK_FILE" > "$HOOK_FILE.tmp"
  mv "$HOOK_FILE.tmp" "$HOOK_FILE"
  printf '\n%s\n' "$MANAGED_BLOCK" >> "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
  echo "UPDATED: Replaced existing LF2 guard block in $HOOK_FILE"
else
  # Hook exists but no managed block — append
  printf '\n%s\n' "$MANAGED_BLOCK" >> "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
  echo "APPENDED: Added LF2 guard block to existing $HOOK_FILE"
fi

echo "OK: Pre-push LF2 guard installed"
