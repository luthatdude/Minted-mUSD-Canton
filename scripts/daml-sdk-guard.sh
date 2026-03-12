#!/usr/bin/env bash
# daml-sdk-guard.sh — Verify DAML SDK version matches daml.yaml before build/test.
#
# Canton 3.4.x requires LF 2.1–2.2 (produced by SDK 3.4.x).
# SDK 2.10.x produces LF 1.14, which Canton 3.4.x rejects at DAR upload.
# This guard prevents silent LF version mismatch.
#
# Usage:
#   bash scripts/daml-sdk-guard.sh          # auto-detects daml/daml.yaml
#   REQUIRED_DAML_SDK=3.4.10 bash scripts/daml-sdk-guard.sh  # override
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAML_YAML="$REPO_ROOT/daml/daml.yaml"

# Required SDK version: env override or hardcoded default
REQUIRED="${REQUIRED_DAML_SDK:-3.4.10}"

# ── 1. Check daml.yaml exists ──────────────────────────────────────
if [ ! -f "$DAML_YAML" ]; then
  echo "ERROR: daml.yaml not found at $DAML_YAML"
  exit 1
fi

# ── 2. Parse sdk-version from daml.yaml ─────────────────────────────
YAML_VERSION=$(grep -E '^sdk-version:' "$DAML_YAML" | head -1 | awk '{print $2}')
if [ -z "$YAML_VERSION" ]; then
  echo "ERROR: Could not parse sdk-version from $DAML_YAML"
  exit 1
fi

if [ "$YAML_VERSION" != "$REQUIRED" ]; then
  echo "FAIL: daml.yaml sdk-version is '$YAML_VERSION', expected '$REQUIRED'"
  echo "  Canton 3.4.x requires LF 2.x (SDK 3.4.x). SDK 2.10.x produces LF 1.14."
  echo "  Fix: set sdk-version: $REQUIRED in $DAML_YAML"
  exit 1
fi
echo "OK: daml.yaml sdk-version = $YAML_VERSION (matches required $REQUIRED)"

# ── 3. Check local daml CLI version if installed ────────────────────
if command -v daml &>/dev/null; then
  CLI_VERSION=$(daml version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [ -n "$CLI_VERSION" ]; then
    if [ "$CLI_VERSION" != "$REQUIRED" ]; then
      echo "WARN: Local daml CLI version is $CLI_VERSION, expected $REQUIRED"
      echo "  Run: daml install $REQUIRED"
    else
      echo "OK: daml CLI version = $CLI_VERSION"
    fi
  fi
else
  echo "INFO: daml CLI not found locally (OK for CI — installed in workflow)"
fi
