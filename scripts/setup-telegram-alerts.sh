#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Minted mUSD Canton — Telegram Alert Bot Setup
# Creates a Telegram bot and K8s secret for canton-health-cronjob
#
# Usage: ./scripts/setup-telegram-alerts.sh
# ══════════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

NAMESPACE="${NAMESPACE:-musd-canton}"

echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Minted Protocol — Telegram Alert Bot Setup      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: BotFather ─────────────────────────────────────────
echo -e "${YELLOW}Step 1: Create a bot via @BotFather on Telegram${NC}"
echo ""
echo "  1. Open Telegram and search for @BotFather"
echo "  2. Send /newbot"
echo "  3. Name:     Minted Canton Monitor"
echo "  4. Username: minted_canton_monitor_bot (must end in 'bot')"
echo "  5. Copy the HTTP API token BotFather gives you"
echo ""
read -p "Paste your bot token: " BOT_TOKEN

if [ -z "$BOT_TOKEN" ]; then
  echo -e "${RED}❌ Bot token cannot be empty${NC}"
  exit 1
fi

# Validate token format (rough check: digits:alphanumeric)
if ! echo "$BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
  echo -e "${YELLOW}⚠️  Token doesn't look like a Telegram bot token (expected format: 123456:ABC-DEF...)${NC}"
  read -p "Continue anyway? (y/N): " -r
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Step 2: Get Chat ID ──────────────────────────────────────
echo ""
echo -e "${YELLOW}Step 2: Get your chat ID${NC}"
echo ""
echo "  Option A — Personal alerts:"
echo "    1. Send any message to your new bot in Telegram"
echo "    2. Press Enter here and we'll auto-detect your chat ID"
echo ""
echo "  Option B — Group alerts:"
echo "    1. Add the bot to a Telegram group"
echo "    2. Send a message in that group"
echo "    3. Press Enter here and we'll auto-detect the group chat ID"
echo ""
read -p "Press Enter after sending a message to your bot..."

echo -e "  Fetching chat ID from Telegram API..."
UPDATES=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" 2>/dev/null)

if echo "$UPDATES" | grep -q '"ok":true'; then
  # Try to extract chat ID from the most recent message
  CHAT_ID=$(echo "$UPDATES" | grep -o '"chat":{"id":[0-9-]*' | head -1 | grep -o '[0-9-]*$')
  
  if [ -n "$CHAT_ID" ]; then
    CHAT_NAME=$(echo "$UPDATES" | grep -o '"first_name":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo -e "  ${GREEN}✅ Detected chat ID: ${CHAT_ID} (${CHAT_NAME:-unknown})${NC}"
    echo ""
    read -p "  Use this chat ID? (Y/n): " -r
    if [[ $REPLY =~ ^[Nn]$ ]]; then
      read -p "  Enter chat ID manually: " CHAT_ID
    fi
  else
    echo -e "  ${YELLOW}⚠️  No messages found — have you sent a message to the bot?${NC}"
    read -p "  Enter chat ID manually: " CHAT_ID
  fi
else
  echo -e "  ${RED}❌ Failed to reach Telegram API — check your bot token${NC}"
  echo "  Response: $(echo "$UPDATES" | head -c 200)"
  read -p "  Enter chat ID manually: " CHAT_ID
fi

if [ -z "$CHAT_ID" ]; then
  echo -e "${RED}❌ Chat ID cannot be empty${NC}"
  exit 1
fi

# ── Step 3: Test the bot ──────────────────────────────────────
echo ""
echo -e "${YELLOW}Step 3: Testing bot...${NC}"

TEST_RESULT=$(curl -s -o /dev/null -w "%{http_code}" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=✅ Minted Canton Monitor is online!

This bot will alert you when Canton health checks fail.
- Canton Participant (Ledger API + JSON API)
- Bridge Relay (health + metrics)
- PostgreSQL database

Setup complete at $(date -u '+%Y-%m-%d %H:%M:%S UTC')" \
  --data-urlencode "parse_mode=Markdown" \
  "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage")

if [ "$TEST_RESULT" = "200" ]; then
  echo -e "  ${GREEN}✅ Test message sent successfully! Check Telegram.${NC}"
else
  echo -e "  ${RED}❌ Failed to send test message (HTTP ${TEST_RESULT})${NC}"
  echo -e "  Verify bot token and chat ID, then try again"
  exit 1
fi

# ── Step 4: Create K8s secret ─────────────────────────────────
echo ""
echo -e "${YELLOW}Step 4: Creating K8s secret...${NC}"

# Check if kubectl is available
if ! command -v kubectl &>/dev/null; then
  echo -e "${YELLOW}⚠️  kubectl not found — saving secret command for manual execution${NC}"
  echo ""
  echo "Run this command when kubectl is available:"
  echo ""
  echo "  kubectl create secret generic telegram-alerting \\"
  echo "    --namespace=${NAMESPACE} \\"
  echo "    --from-literal=bot-token='${BOT_TOKEN}' \\"
  echo "    --from-literal=chat-id='${CHAT_ID}'"
  echo ""
  exit 0
fi

# Check cluster connectivity
if ! kubectl cluster-info &>/dev/null; then
  echo -e "${YELLOW}⚠️  Cannot reach K8s cluster — saving secret command${NC}"
  echo ""
  echo "  kubectl create secret generic telegram-alerting \\"
  echo "    --namespace=${NAMESPACE} \\"
  echo "    --from-literal=bot-token='${BOT_TOKEN}' \\"
  echo "    --from-literal=chat-id='${CHAT_ID}'"
  echo ""
  exit 0
fi

# Check if secret already exists
if kubectl get secret telegram-alerting -n "$NAMESPACE" &>/dev/null; then
  echo -e "  ${YELLOW}⚠️  Secret 'telegram-alerting' already exists in ${NAMESPACE}${NC}"
  read -p "  Overwrite? (y/N): " -r
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    kubectl delete secret telegram-alerting -n "$NAMESPACE"
  else
    echo "  Keeping existing secret."
    exit 0
  fi
fi

# Create the secret
kubectl create secret generic telegram-alerting \
  --namespace="$NAMESPACE" \
  --from-literal=bot-token="$BOT_TOKEN" \
  --from-literal=chat-id="$CHAT_ID"

echo -e "  ${GREEN}✅ Secret created: telegram-alerting in ${NAMESPACE}${NC}"

# ── Summary ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Telegram alerting configured!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Bot Token:  ${BOT_TOKEN:0:10}...${BOT_TOKEN: -5} (redacted)"
echo "  Chat ID:    ${CHAT_ID}"
echo "  K8s Secret: telegram-alerting (namespace: ${NAMESPACE})"
echo ""
echo "  The canton-health-check CronJob will now send alerts"
echo "  to this Telegram chat when health checks fail."
echo ""
echo "  Manual trigger:"
echo "    kubectl create job --from=cronjob/canton-health-check test-alert -n ${NAMESPACE}"
echo ""
