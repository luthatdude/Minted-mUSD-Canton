#!/usr/bin/env bash
# daml-lf2-guard.sh — Static guard for LF2-blocked DAML modules.
#
# Checks:
#   1. All blocked files listed in daml/lf2-blocked-modules.txt exist
#   2. No non-blocked .daml files import blocked modules
#   3. No key declarations appear outside blocked modules
#
# Exit 0 = all checks pass. Non-zero = guard violation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKLIST="$REPO_ROOT/daml/lf2-blocked-modules.txt"

# ── 0. Blocklist exists ────────────────────────────────────────────
if [ ! -f "$BLOCKLIST" ]; then
  echo "FAIL: Blocklist not found: $BLOCKLIST"
  exit 1
fi

# ── Parse blocklist (skip comments and blank lines) ────────────────
BLOCKED=()
while IFS= read -r line; do
  line="${line%%#*}"       # strip inline comments
  line="${line// /}"       # trim whitespace
  [ -z "$line" ] && continue
  BLOCKED+=("$line")
done < "$BLOCKLIST"

if [ ${#BLOCKED[@]} -eq 0 ]; then
  echo "FAIL: Blocklist is empty after parsing"
  exit 1
fi

ERRORS=0

# ── 1. All blocked files must exist ────────────────────────────────
echo "=== Check 1: Blocked files exist ==="
for f in "${BLOCKED[@]}"; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "FAIL: Blocked file missing: $f"
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $ERRORS -eq 0 ]; then
  echo "OK: All ${#BLOCKED[@]} blocked files exist"
fi

# ── Build blocked module names (basename without .daml) ────────────
BLOCKED_MODULES=()
for f in "${BLOCKED[@]}"; do
  base="$(basename "$f" .daml)"
  BLOCKED_MODULES+=("$base")
done

# Build newline-delimited set of blocked basenames for lookup
BLOCKED_BASENAMES=""
for f in "${BLOCKED[@]}"; do
  base="$(basename "$f")"
  BLOCKED_BASENAMES="$BLOCKED_BASENAMES$base
"
done

# ── 2. No non-blocked files import blocked modules ─────────────────
echo ""
echo "=== Check 2: No non-blocked files import blocked modules ==="
IMPORT_ERRORS=0

# Only check the three primary blocked modules (not test files)
IMPORT_PATTERN="^[[:space:]]*import[[:space:]]+(CantonLending|CantonBoostPool|CantonLoopStrategy)[[:space:]]*$"

for daml_file in "$REPO_ROOT"/daml/*.daml; do
  [ -f "$daml_file" ] || continue
  base="$(basename "$daml_file")"

  # Skip if this file is itself blocked
  if echo "$BLOCKED_BASENAMES" | grep -qxF "$base"; then
    continue
  fi

  # Check for imports of blocked modules
  if grep -qE "$IMPORT_PATTERN" "$daml_file" 2>/dev/null; then
    matches=$(grep -nE "$IMPORT_PATTERN" "$daml_file" 2>/dev/null || true)
    echo "FAIL: $base imports blocked module(s):"
    echo "$matches" | sed 's/^/  /'
    echo "  Remediation: Remove or guard the import. These modules are LF2-blocked."
    IMPORT_ERRORS=$((IMPORT_ERRORS + 1))
  fi
done

if [ $IMPORT_ERRORS -eq 0 ]; then
  echo "OK: No non-blocked files import blocked modules"
else
  ERRORS=$((ERRORS + IMPORT_ERRORS))
fi

# ── 3. No key declarations outside blocked modules ─────────────────
echo ""
echo "=== Check 3: No key declarations outside blocked modules ==="
KEY_ERRORS=0
KEY_PATTERN="^[[:space:]]*key[[:space:]]"

for daml_file in "$REPO_ROOT"/daml/*.daml; do
  [ -f "$daml_file" ] || continue
  base="$(basename "$daml_file")"

  # Skip if this file is blocked (key declarations expected there)
  if echo "$BLOCKED_BASENAMES" | grep -qxF "$base"; then
    continue
  fi

  if grep -qE "$KEY_PATTERN" "$daml_file" 2>/dev/null; then
    matches=$(grep -nE "$KEY_PATTERN" "$daml_file" 2>/dev/null || true)
    echo "FAIL: $base has key declaration(s) outside blocked modules:"
    echo "$matches" | sed 's/^/  /'
    echo "  Remediation: Move to a blocked module or remove the key declaration."
    KEY_ERRORS=$((KEY_ERRORS + 1))
  fi
done

if [ $KEY_ERRORS -eq 0 ]; then
  echo "OK: No key declarations outside blocked modules"
else
  ERRORS=$((ERRORS + KEY_ERRORS))
fi

# ── Summary ────────────────────────────────────────────────────────
echo ""
if [ $ERRORS -gt 0 ]; then
  echo "FAIL: $ERRORS guard violation(s) found"
  exit 1
fi

echo "PASS: All LF2 guard checks passed (${#BLOCKED[@]} blocked modules verified)"
