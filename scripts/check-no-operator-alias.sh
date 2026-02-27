#!/usr/bin/env bash
# check-no-operator-alias.sh — Block alias configs that map non-operator keys to operator party.
#
# Usage:
#   bash scripts/check-no-operator-alias.sh          # check staged changes
#   bash scripts/check-no-operator-alias.sh --all     # check all tracked files
#
# Parses CANTON_RECIPIENT_PARTY_ALIASES and NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON
# values from env files. If any JSON key maps a non-operator party hint to
# a "minted-operator::" target, fails with remediation text.
set -euo pipefail

MODE="staged"
if [ "${1:-}" = "--all" ]; then
  MODE="all"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

# Collect files to check
FILES=()
if [ "$MODE" = "staged" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
  done < <(cd "$REPO_ROOT" && git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
else
  while IFS= read -r f; do
    [ -n "$f" ] && FILES+=("$f")
  done < <(cd "$REPO_ROOT" && git ls-files '*.env*' '*.local' '*.development' 2>/dev/null || true)
  # Also check common env files that might not be tracked
  for envf in frontend/.env.local relay/.env.development; do
    if [ -f "$REPO_ROOT/$envf" ]; then
      # Add if not already in list
      local_found=false
      for existing in "${FILES[@]:-}"; do
        [ "$existing" = "$envf" ] && local_found=true
      done
      if [ "$local_found" = false ]; then
        FILES+=("$envf")
      fi
    fi
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "OK: No files to check"
  exit 0
fi

# Check each file for alias policy violations
check_alias_json() {
  local file="$1"
  local var_name="$2"
  local json_value="$3"

  if [ -z "$json_value" ] || [ "$json_value" = "{}" ]; then
    return 0
  fi

  # Use python3 to parse JSON safely and check for operator alias mapping
  python3 -c "
import json, sys
try:
    data = json.loads('''$json_value''')
except:
    sys.exit(0)  # skip unparseable
if not isinstance(data, dict):
    sys.exit(0)
violations = []
for k, v in data.items():
    from_hint = k.split('::')[0] if '::' in k else k
    to_hint = v.split('::')[0] if '::' in v else v
    is_from_op = from_hint.startswith('minted-operator')
    is_to_op = to_hint.startswith('minted-operator')
    if not is_from_op and is_to_op:
        violations.append(f'  Key: {k[:32]}... -> {v[:32]}...')
if violations:
    print(f'FAIL: {\"$file\"}: {\"$var_name\"} maps non-operator key to operator party:')
    for v in violations:
        print(v)
    print(f'  Remediation: Map to the user\\'s own funded party, not operator.')
    sys.exit(1)
" 2>/dev/null
  return $?
}

for file in "${FILES[@]}"; do
  filepath="$REPO_ROOT/$file"
  [ -f "$filepath" ] || continue

  # Extract CANTON_RECIPIENT_PARTY_ALIASES value
  alias_val=$(grep -oP 'CANTON_RECIPIENT_PARTY_ALIASES=\K.*' "$filepath" 2>/dev/null || true)
  if [ -n "$alias_val" ]; then
    if ! check_alias_json "$file" "CANTON_RECIPIENT_PARTY_ALIASES" "$alias_val"; then
      ERRORS=$((ERRORS + 1))
    fi
  fi

  # Extract NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON value
  pub_alias_val=$(grep -oP 'NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON=\K.*' "$filepath" 2>/dev/null || true)
  if [ -n "$pub_alias_val" ]; then
    if ! check_alias_json "$file" "NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON" "$pub_alias_val"; then
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "FAIL: $ERRORS alias policy violation(s) found."
  echo "Non-operator keys MUST NOT map to operator party (masks real balances)."
  exit 1
fi

echo "PASS: No operator alias policy violations found"
