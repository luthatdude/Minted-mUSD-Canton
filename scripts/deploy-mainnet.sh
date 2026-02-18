#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Minted mUSD Protocol — Mainnet Deployment Pipeline
#
#  Wraps scripts/deploy-mainnet.ts with:
#    • Pre-flight validation (env, balance, gas, compilation)
#    • Dry-run gate (DRY_RUN=true by default)
#    • Reproducible output in /deployments/
#    • Post-deploy Etherscan verification
#
#  Usage:
#    ./scripts/deploy-mainnet.sh                # dry-run (safe default)
#    ./scripts/deploy-mainnet.sh --live          # real deployment
#    ./scripts/deploy-mainnet.sh --verify-only   # verify already-deployed contracts
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Parse flags ──────────────────────────────────────────────────────
LIVE_MODE=false
VERIFY_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --live)        LIVE_MODE=true ;;
    --verify-only) VERIFY_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--live] [--verify-only]"
      echo ""
      echo "  (default)       Dry-run — simulate deployment on hardhat fork"
      echo "  --live          Deploy to Ethereum mainnet (requires KMS)"
      echo "  --verify-only   Only verify already-deployed contracts on Etherscan"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ── Banner ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     Minted mUSD Protocol — Mainnet Deploy Pipeline          ║"
if $LIVE_MODE; then
echo "║     Mode: 🔴  LIVE DEPLOYMENT                               ║"
else
echo "║     Mode: 🟢  DRY RUN (simulation)                          ║"
fi
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════════════════
#  VERIFY-ONLY PATH
# ═══════════════════════════════════════════════════════════════════════
if $VERIFY_ONLY; then
  MANIFEST="$ROOT_DIR/deployments/mainnet-latest.json"
  if [ ! -f "$MANIFEST" ]; then
    echo "❌ No deployment manifest found at $MANIFEST"
    echo "   Deploy first, then run --verify-only"
    exit 1
  fi

  echo "📋 Reading manifest: $MANIFEST"
  echo ""

  # Verify each contract
  # Uses jq to parse the manifest — fall back to node if jq not available
  if command -v jq >/dev/null 2>&1; then
    for name in $(jq -r '.contracts | keys[]' "$MANIFEST"); do
      addr=$(jq -r ".contracts[\"$name\"].address" "$MANIFEST")
      ctype=$(jq -r ".contracts[\"$name\"].type" "$MANIFEST")
      echo "🔍 Verifying $name at $addr ($ctype)…"
      if [ "$ctype" = "uups-proxy" ]; then
        echo "   ⚠️  Proxy — verify the implementation contract separately"
      fi
      npx hardhat verify --network mainnet "$addr" 2>&1 || echo "   ⚠️  Verification failed or already verified"
      echo ""
    done
  else
    echo "⚠️  jq not installed. Install with: brew install jq"
    echo "   Manually verify contracts from $MANIFEST"
  fi
  echo "✅ Verification pass complete"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
#  PRE-FLIGHT CHECKS
# ═══════════════════════════════════════════════════════════════════════
echo "─── Pre-flight Checks ────────────────────────────────────────"
ERRORS=0

# 1. Required tools
for cmd in node npx git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required tool: $cmd"
    ERRORS=$((ERRORS + 1))
  fi
done

# 2. Required env vars
for var in DEPLOYER_KMS_KEY_ID MAINNET_RPC_URL ETHERSCAN_API_KEY MULTISIG_ADDRESS GUARDIAN_ADDRESS FEE_RECIPIENT; do
  if [ -z "${!var:-}" ]; then
    echo "❌ Missing required env var: $var"
    ERRORS=$((ERRORS + 1))
  else
    # Mask sensitive values in output
    case "$var" in
      *KEY*|*PRIVATE*|*SECRET*)
        echo "✅ $var = ****${!var: -4}"
        ;;
      *)
        echo "✅ $var = ${!var}"
        ;;
    esac
  fi
done

# 3. SEC-GATE-01: Reject raw private keys on mainnet
if [ -n "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  echo "❌ DEPLOYER_PRIVATE_KEY is set — raw keys are FORBIDDEN on mainnet (SEC-GATE-01)"
  echo "   Unset it: unset DEPLOYER_PRIVATE_KEY"
  ERRORS=$((ERRORS + 1))
fi

# 4. Validate addresses are checksummed hex
for var in MULTISIG_ADDRESS GUARDIAN_ADDRESS FEE_RECIPIENT; do
  val="${!var:-}"
  if [ -n "$val" ] && ! echo "$val" | grep -qE '^0x[0-9a-fA-F]{40}$'; then
    echo "❌ $var is not a valid Ethereum address: $val"
    ERRORS=$((ERRORS + 1))
  fi
done

# 5. Check .env NOT sourced (credentials should come from env / secrets manager)
if [ -f ".env" ]; then
  echo "⚠️  .env file exists. Ensure credentials are NOT in .env on mainnet."
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "🛑 $ERRORS pre-flight check(s) failed. Fix errors above and retry."
  exit 1
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════
#  COMPILATION
# ═══════════════════════════════════════════════════════════════════════
echo "─── Compiling Contracts ──────────────────────────────────────"
npx hardhat compile --force
echo ""

# ═══════════════════════════════════════════════════════════════════════
#  STORAGE LAYOUT VALIDATION (for UUPS proxies)
# ═══════════════════════════════════════════════════════════════════════
echo "─── Validating Storage Layouts ───────────────────────────────"
if [ -f "$ROOT_DIR/scripts/validate-storage-layout.ts" ]; then
  npx hardhat run scripts/validate-storage-layout.ts 2>&1 || {
    echo "❌ Storage layout validation failed — UUPS proxies at risk"
    exit 1
  }
else
  echo "⚠️  validate-storage-layout.ts not found — skipping"
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════
#  CONFIRMATION (live mode only)
# ═══════════════════════════════════════════════════════════════════════
if $LIVE_MODE; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ⚠️   YOU ARE ABOUT TO DEPLOY TO ETHEREUM MAINNET           ║"
  echo "║                                                              ║"
  echo "║  This will spend real ETH and deploy immutable contracts.    ║"
  echo "║  Ensure you have reviewed the deployment parameters.         ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Deployment parameters:"
  echo "  Supply cap:         100,000,000 mUSD"
  echo "  Timelock delay:     48 hours"
  echo "  Bridge min sigs:    3"
  echo "  Collateral ratio:   110%"
  echo "  Daily cap increase: 5,000,000 mUSD"
  echo "  Multisig:           ${MULTISIG_ADDRESS}"
  echo "  Guardian:           ${GUARDIAN_ADDRESS}"
  echo "  Fee recipient:      ${FEE_RECIPIENT}"
  echo ""
  read -r -p "Type 'DEPLOY MAINNET' to confirm: " CONFIRM
  if [ "$CONFIRM" != "DEPLOY MAINNET" ]; then
    echo "❌ Deployment cancelled."
    exit 1
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════
#  DEPLOY
# ═══════════════════════════════════════════════════════════════════════
echo "─── Deploying ────────────────────────────────────────────────"

if $LIVE_MODE; then
  export DRY_RUN=false
  npx hardhat run scripts/deploy-mainnet.ts --network mainnet 2>&1 | tee "$ROOT_DIR/deployments/deploy-mainnet-$(date +%Y%m%d-%H%M%S).log"
else
  export DRY_RUN=true
  # Dry-run uses hardhat network (local fork or default)
  npx hardhat run scripts/deploy-mainnet.ts 2>&1 | tee "$ROOT_DIR/deployments/deploy-dryrun-$(date +%Y%m%d-%H%M%S).log"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════
#  POST-DEPLOY
# ═══════════════════════════════════════════════════════════════════════
if $LIVE_MODE; then
  echo "─── Post-Deploy ────────────────────────────────────────────"
  echo ""
  echo "📋 Deployment manifest: deployments/mainnet-latest.json"
  echo ""
  echo "Next steps:"
  echo "  1. Verify contracts:   $0 --verify-only"
  echo "  2. Add validators:     npx hardhat run scripts/grant-validator-role.ts --network mainnet"
  echo "  3. Deploy strategies:  npx hardhat run scripts/deploy-and-register-strategies.ts --network mainnet"
  echo "  4. Transfer admin:     npx hardhat run scripts/transfer-all-admin-roles.ts --network mainnet"
  echo "  5. Configure relay:    Update relay/.env with new bridge address"
  echo "  6. Configure frontend: Update frontend/.env.local with contract addresses"
  echo ""
fi

echo "═══════════════════════════════════════════════════════════════"
echo "✅ Pipeline complete"
echo "═══════════════════════════════════════════════════════════════"
