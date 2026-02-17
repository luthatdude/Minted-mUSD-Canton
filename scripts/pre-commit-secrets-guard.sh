#!/usr/bin/env bash
# Pre-commit hook: block commits containing high-entropy secrets
# Install: cp scripts/pre-commit-secrets-guard.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -euo pipefail

RED='\033[0;31m'
NC='\033[0m' # No Color

# Patterns that should NEVER appear in committed code
FORBIDDEN_PATTERNS=(
  # Raw private keys (64 hex chars, optionally 0x-prefixed)
  '(PRIVATE_KEY|private_key|privateKey)\s*[:=]\s*"?0?x?[0-9a-fA-F]{64}"?'
  # Alchemy/Infura API keys embedded in URLs
  'g\.alchemy\.com/v2/[a-zA-Z0-9_-]{20,}'
  'infura\.io/v3/[a-f0-9]{32}'
  # AWS secret keys (40 chars)
  'AKIA[0-9A-Z]{16}'
  # Generic secrets assigned inline (not placeholders)
  'SECRET.*=\s*["\x27][a-zA-Z0-9/+]{40,}["\x27]'
)

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)
FAILED=0

for file in $STAGED_FILES; do
  # Skip binary files and .env.example templates
  if [[ "$file" == *.example ]] || [[ "$file" == *.png ]] || [[ "$file" == *.dar ]]; then
    continue
  fi

  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if git diff --cached -- "$file" | grep -qEi "$pattern"; then
      echo -e "${RED}BLOCKED${NC}: Potential secret in staged file: $file"
      echo "  Pattern: $pattern"
      FAILED=1
    fi
  done
done

if [[ $FAILED -ne 0 ]]; then
  echo ""
  echo -e "${RED}Commit blocked by pre-commit secrets guard.${NC}"
  echo "If this is a false positive, use: git commit --no-verify"
  echo "But NEVER commit real private keys or API keys."
  exit 1
fi
