#!/usr/bin/env bash
# Canton Dev Network Monitor
# Watches for validator to connect to the Global Synchronizer
# Run: ./scripts/canton-monitor.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Canton Dev Network Connection Monitor       ║${NC}"
echo -e "${CYAN}║  Watching validator for sequencer connection  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Sequencers being monitored:${NC}"
echo "  • Tradeweb-Markets-1 (sv-1.dev.global.canton.network.tradeweb.com)"
echo "  • Cumberland-1 (sv-1.dev.global.canton.network.cumberland.io)"
echo "  • Cumberland-2 (sv-2.dev.global.canton.network.cumberland.io)"
echo ""
echo -e "${YELLOW}Watching validator logs... (Ctrl+C to stop)${NC}"
echo ""

CHECK_INTERVAL=30
ATTEMPT=0

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  TIMESTAMP=$(date '+%H:%M:%S')

  # Check validator health
  VALIDATOR_STATUS=$(docker inspect --format='{{.State.Health.Status}}' splice-validator-validator-1 2>/dev/null || echo "unknown")

  if [ "$VALIDATOR_STATUS" = "healthy" ]; then
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  ✅ VALIDATOR IS HEALTHY!                     ║${NC}"
    echo -e "${GREEN}║  Connected to Canton Dev Global Synchronizer  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
    echo ""

    # Check if Ledger API is now reachable
    if docker exec canton-port-fwd sh -c "nc -z participant 7575 2>/dev/null" 2>/dev/null; then
      echo -e "${GREEN}✅ Ledger API (port 7575) is reachable${NC}"
    else
      echo -e "${YELLOW}⏳ Ledger API (port 7575) not yet listening${NC}"
    fi

    if docker exec canton-port-fwd-grpc sh -c "nc -z participant 5001 2>/dev/null" 2>/dev/null; then
      echo -e "${GREEN}✅ Admin API (port 5001) is reachable${NC}"
    else
      echo -e "${YELLOW}⏳ Admin API (port 5001) not yet listening${NC}"
    fi

    echo ""
    echo -e "${GREEN}You can now run:${NC}"
    echo "  1. ./scripts/canton-init.sh    # Upload DAR + init protocol"
    echo "  2. cd relay && npm run relay   # Start bridge relay"
    echo ""

    # macOS notification
    osascript -e 'display notification "Validator connected to Canton Dev!" with title "Canton Monitor" sound name "Glass"' 2>/dev/null || true

    break
  fi

  # Get latest error from logs
  LATEST_ERROR=$(docker logs splice-validator-validator-1 2>&1 | grep -i "RegisterSynchronizer\|domain_registered\|UNAVAILABLE\|PKIX\|sequencer\|connected\|initialized" | tail -1 | sed 's/.*"message":"\([^"]*\)".*/\1/' | head -c 80 2>/dev/null || echo "no logs")

  # Show status
  echo -e "[${TIMESTAMP}] Check #${ATTEMPT} | Validator: ${RED}${VALIDATOR_STATUS}${NC} | Retrying in ${CHECK_INTERVAL}s..."

  sleep "$CHECK_INTERVAL"
done
