#!/usr/bin/env bash
# daml-lf2-changed-files-policy.sh — Enforce plan co-change when blocked modules change.
#
# If any LF2-blocked module file is in the changeset, the migration plan
# document must also be in the changeset. Otherwise, fail.
#
# Usage:
#   # Auto-detect from git/CI env:
#   bash scripts/daml-lf2-changed-files-policy.sh
#
#   # Explicit range:
#   bash scripts/daml-lf2-changed-files-policy.sh --base abc123 --head def456
#
#   # Stdin (for testing):
#   echo "daml/CantonLending.daml" | bash scripts/daml-lf2-changed-files-policy.sh --stdin
#
#   # Custom plan path:
#   bash scripts/daml-lf2-changed-files-policy.sh --plan docs/plans/my-plan.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKLIST="$REPO_ROOT/daml/lf2-blocked-modules.txt"

# Defaults
PLAN_PATH="docs/plans/daml-lf2-key-removal-plan.md"
BASE_SHA=""
HEAD_SHA=""
USE_STDIN=false

# ── Parse args ─────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)   PLAN_PATH="$2"; shift 2 ;;
    --base)   BASE_SHA="$2"; shift 2 ;;
    --head)   HEAD_SHA="$2"; shift 2 ;;
    --stdin)  USE_STDIN=true; shift ;;
    *)        echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Parse blocklist ────────────────────────────────────────────────
if [ ! -f "$BLOCKLIST" ]; then
  echo "FAIL: Blocklist not found: $BLOCKLIST"
  exit 1
fi

BLOCKED_PATHS=""
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line// /}"
  [ -z "$line" ] && continue
  BLOCKED_PATHS="$BLOCKED_PATHS$line
"
done < "$BLOCKLIST"

# ── Get changed files ──────────────────────────────────────────────
CHANGED_FILES=()

if [ "$USE_STDIN" = true ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && CHANGED_FILES+=("$f")
  done
elif [ -n "$BASE_SHA" ] && [ -n "$HEAD_SHA" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && CHANGED_FILES+=("$f")
  done < <(cd "$REPO_ROOT" && git diff --name-only "$BASE_SHA" "$HEAD_SHA" 2>/dev/null || true)
else
  # Auto-detect from CI environment or fallback
  if [ -n "${GITHUB_BASE_SHA:-}" ] && [ -n "${GITHUB_SHA:-}" ]; then
    # PR context
    while IFS= read -r f; do
      [ -n "$f" ] && CHANGED_FILES+=("$f")
    done < <(cd "$REPO_ROOT" && git diff --name-only "$GITHUB_BASE_SHA" "$GITHUB_SHA" 2>/dev/null || true)
  elif [ -n "${GITHUB_BEFORE_SHA:-}" ] && [ -n "${GITHUB_SHA:-}" ]; then
    # Push context
    while IFS= read -r f; do
      [ -n "$f" ] && CHANGED_FILES+=("$f")
    done < <(cd "$REPO_ROOT" && git diff --name-only "$GITHUB_BEFORE_SHA" "$GITHUB_SHA" 2>/dev/null || true)
  else
    # Local fallback
    while IFS= read -r f; do
      [ -n "$f" ] && CHANGED_FILES+=("$f")
    done < <(cd "$REPO_ROOT" && git diff --name-only HEAD~1..HEAD 2>/dev/null || true)
  fi
fi

# ── Check for blocked files in changeset ───────────────────────────
BLOCKED_CHANGED=()
PLAN_IN_CHANGESET=false

for f in "${CHANGED_FILES[@]}"; do
  if echo "$BLOCKED_PATHS" | grep -qxF "$f"; then
    BLOCKED_CHANGED+=("$f")
  fi
  if [ "$f" = "$PLAN_PATH" ]; then
    PLAN_IN_CHANGESET=true
  fi
done

# ── Evaluate policy ───────────────────────────────────────────────
if [ ${#BLOCKED_CHANGED[@]} -eq 0 ]; then
  echo "PASS: No LF2-blocked modules in changeset"
  exit 0
fi

echo "LF2-blocked modules changed:"
for f in "${BLOCKED_CHANGED[@]}"; do
  echo "  - $f"
done

if [ "$PLAN_IN_CHANGESET" = true ]; then
  echo "OK: Migration plan ($PLAN_PATH) is also in changeset"
  echo "PASS: Changed-files policy satisfied"
  exit 0
fi

echo ""
echo "FAIL: LF2-blocked module(s) changed but migration plan was NOT updated."
echo "  Required plan: $PLAN_PATH"
echo "  When modifying blocked modules, you MUST also update the migration plan."
echo "  This ensures reviewers can verify the change is part of the key-removal roadmap."
exit 1
