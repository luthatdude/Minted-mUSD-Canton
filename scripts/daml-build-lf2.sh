#!/usr/bin/env bash
# daml-build-lf2.sh — Build LF2-safe DAR by excluding blocked modules.
#
# Copies daml/ to a temp directory, removes blocked files, runs daml build,
# and copies the DAR output to daml/.daml/dist-lf2/.
# Never mutates tracked source files.
#
# Usage:
#   bash scripts/daml-build-lf2.sh             # build + test
#   bash scripts/daml-build-lf2.sh --no-test   # build only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKLIST="$REPO_ROOT/daml/lf2-blocked-modules.txt"
GUARD="$REPO_ROOT/scripts/daml-lf2-guard.sh"
RUN_TEST=true

# Parse args
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TEST=false ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ── 0. Run guard first ─────────────────────────────────────────────
echo "=== Running LF2 guard ==="
bash "$GUARD"
echo ""

# ── 1. Create temp copy ────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== Copying daml/ to temp directory ==="
cp -a "$REPO_ROOT/daml/." "$TMPDIR/"
echo "OK: Temp copy at $TMPDIR"

# ── 2. Remove blocked files from temp copy ─────────────────────────
echo ""
echo "=== Removing blocked modules from temp copy ==="
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line// /}"
  [ -z "$line" ] && continue
  base="$(basename "$line")"
  target="$TMPDIR/$base"
  if [ -f "$target" ]; then
    rm -f "$target"
    echo "  Removed: $base"
  fi
done < "$BLOCKLIST"

# ── 3. Build in temp copy ──────────────────────────────────────────
echo ""
echo "=== Running daml build in temp copy ==="
(cd "$TMPDIR" && daml build)
echo "OK: daml build succeeded"

# ── 4. Run test (unless --no-test) ─────────────────────────────────
if [ "$RUN_TEST" = true ]; then
  echo ""
  echo "=== Running daml test --files InitProtocol.daml ==="
  (cd "$TMPDIR" && daml test --files InitProtocol.daml)
  echo "OK: daml test succeeded"
else
  echo ""
  echo "SKIP: Tests disabled (--no-test)"
fi

# ── 5. Copy DAR output to dist-lf2/ ───────────────────────────────
echo ""
echo "=== Copying DAR output ==="
DIST_LF2="$REPO_ROOT/daml/.daml/dist-lf2"
mkdir -p "$DIST_LF2"

DAR_COUNT=0
for dar in "$TMPDIR/.daml/dist/"*.dar; do
  [ -f "$dar" ] || continue
  cp "$dar" "$DIST_LF2/"
  echo "  Copied: $(basename "$dar") -> daml/.daml/dist-lf2/"
  DAR_COUNT=$((DAR_COUNT + 1))
done

if [ $DAR_COUNT -eq 0 ]; then
  echo "WARN: No DAR files found in temp build output"
else
  echo "OK: $DAR_COUNT DAR file(s) copied to daml/.daml/dist-lf2/"
fi

echo ""
echo "DONE: LF2-safe build complete"
