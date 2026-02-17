#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Update K8s manifest image digests after CI builds
#
# Usage:
#   ./scripts/update-image-digests.sh relay sha256:<digest>
#   ./scripts/update-image-digests.sh bot   sha256:<digest>
#   ./scripts/update-image-digests.sh all   # Build locally + update
#
# Called automatically by CI job summaries with the new digest.
# ══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
  echo "Usage: $0 <relay|bot|all> [sha256:<digest>]"
  echo ""
  echo "Examples:"
  echo "  $0 relay sha256:807a2251b...  # Update relay manifests with specific digest"
  echo "  $0 bot sha256:49d1cbc0d...    # Update bot manifest with specific digest"
  echo "  $0 all                         # Build locally + auto-detect digests"
  exit 1
}

update_relay_digest() {
  local digest="$1"
  local file="$REPO_ROOT/k8s/canton/relay-deployment.yaml"
  local count

  echo -e "  Updating ${file}..."
  count=$(grep -c "bridge-relay@sha256:" "$file" || true)
  sed -i.bak "s|bridge-relay@sha256:[a-f0-9]\{64\}|bridge-relay@${digest}|g" "$file"
  rm -f "${file}.bak"
  echo -e "  ${GREEN}✅ Updated ${count} image references to ${digest:0:20}...${NC}"
}

update_bot_digest() {
  local digest="$1"
  local file="$REPO_ROOT/k8s/canton/bot-deployment.yaml"
  local count

  echo -e "  Updating ${file}..."
  count=$(grep -c "liquidation-bot@sha256:" "$file" || true)
  sed -i.bak "s|liquidation-bot@sha256:[a-f0-9]\{64\}|liquidation-bot@${digest}|g" "$file"
  rm -f "${file}.bak"
  echo -e "  ${GREEN}✅ Updated ${count} image references to ${digest:0:20}...${NC}"
}

build_and_get_digest() {
  local context="$1"
  local image="$2"
  echo -e "  Building ${image}..."
  DOCKER_BUILDKIT=1 docker build -t "${image}:latest" "$REPO_ROOT/$context" -q 2>/dev/null
  docker inspect --format='{{index .RepoDigests 0}}' "${image}:latest" 2>/dev/null | sed "s|.*@||"
}

# ── Main ──────────────────────────────────────────────────────
if [ $# -lt 1 ]; then
  usage
fi

COMPONENT="$1"
DIGEST="${2:-}"

case "$COMPONENT" in
  relay)
    if [ -z "$DIGEST" ]; then
      echo "Building relay to get digest..."
      DIGEST=$(build_and_get_digest "relay" "ghcr.io/minted-protocol/bridge-relay")
    fi
    if ! echo "$DIGEST" | grep -qE '^sha256:[a-f0-9]{64}$'; then
      echo -e "${RED}❌ Invalid digest format: ${DIGEST}${NC}"
      echo "  Expected: sha256:<64-hex-chars>"
      exit 1
    fi
    echo "Updating relay image digest..."
    update_relay_digest "$DIGEST"
    ;;

  bot)
    if [ -z "$DIGEST" ]; then
      echo "Building bot to get digest..."
      DIGEST=$(build_and_get_digest "bot" "ghcr.io/minted-protocol/liquidation-bot")
    fi
    if ! echo "$DIGEST" | grep -qE '^sha256:[a-f0-9]{64}$'; then
      echo -e "${RED}❌ Invalid digest format: ${DIGEST}${NC}"
      echo "  Expected: sha256:<64-hex-chars>"
      exit 1
    fi
    echo "Updating bot image digest..."
    update_bot_digest "$DIGEST"
    ;;

  all)
    echo "Building all images and updating digests..."
    echo ""

    RELAY_DIGEST=$(build_and_get_digest "relay" "ghcr.io/minted-protocol/bridge-relay")
    echo "  Relay digest: $RELAY_DIGEST"
    update_relay_digest "$RELAY_DIGEST"
    echo ""

    BOT_DIGEST=$(build_and_get_digest "bot" "ghcr.io/minted-protocol/liquidation-bot")
    echo "  Bot digest: $BOT_DIGEST"
    update_bot_digest "$BOT_DIGEST"
    ;;

  *)
    echo -e "${RED}Unknown component: $COMPONENT${NC}"
    usage
    ;;
esac

echo ""
echo -e "${GREEN}✅ Image digests updated. Review changes:${NC}"
echo "  git diff k8s/canton/relay-deployment.yaml k8s/canton/bot-deployment.yaml"
