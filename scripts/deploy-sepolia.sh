#!/bin/bash
# Minted mUSD Protocol - Sepolia Testnet Deployment
# Works WITHOUT Canton - uses mock mode for bridge

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     Minted mUSD Protocol - Sepolia Testnet Deployment         ║"
echo "║                    (Canton-less Mode)                          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check required tools
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required"; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "❌ npx required"; exit 1; }

# FIX HIGH-CRED: Never write private keys to .env files on disk.
# Credentials must be provided via environment variables or a secrets manager.
# DO NOT source .env files containing private keys.
if [ -z "${RPC_URL:-}" ] || [ -z "${DEPLOYER_PRIVATE_KEY:-}" ]; then
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║  Missing required environment variables!                      ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Set the following env vars before running this script:"
    echo ""
    echo "  export RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
    echo "  export CHAIN_ID=11155111"
    echo "  export DEPLOYER_PRIVATE_KEY=0x...  (or use hardware wallet)"
    echo "  export CHAINLINK_ETH_USD=0x694AA1769357215DE4FAC081bf1f309aDC325306"
    echo "  export CHAINLINK_BTC_USD=0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43"
    echo ""
    echo "For production, use a secrets manager (Vault, AWS SM, GCP SM)"
    echo "or a hardware wallet signer (--ledger flag)."
    echo ""
    echo "⚠️  NEVER store private keys in .env files on disk."
    exit 1
fi

# Warn if .env file exists (potential credential leak)
if [ -f ".env" ]; then
    echo "⚠️  WARNING: .env file detected. Ensure it does NOT contain private keys."
    echo "   Private keys should be set via env vars or a secrets manager."
fi

# Validate required env vars (already checked above, but double-check values)
if echo "$RPC_URL" | grep -q "YOUR_ALCHEMY_KEY"; then
    echo "❌ RPC_URL still contains placeholder — set a real Alchemy/Infura URL"
    exit 1
fi

if echo "$DEPLOYER_PRIVATE_KEY" | grep -q "YOUR_PRIVATE_KEY_HERE"; then
    echo "❌ DEPLOYER_PRIVATE_KEY still contains placeholder"
    exit 1
fi

echo "✅ Environment configured"
echo ""

# Step 1: Install dependencies
echo "📦 Step 1: Installing dependencies..."
npm install
echo ""

# Step 2: Compile contracts
echo "🔨 Step 2: Compiling Solidity contracts..."
npx hardhat compile
echo ""

# Step 3: Deploy contracts
echo "🚀 Step 3: Deploying contracts to Sepolia..."
npx hardhat run scripts/deploy-testnet.ts --network sepolia

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✅ Deployment Complete!"
echo ""
echo "Next steps:"
echo "  1. Copy deployed addresses to frontend/.env.local"
echo "  2. cd frontend && npm install && npm run dev"
echo "  3. Connect MetaMask to Sepolia"
echo "  4. Get test ETH from https://sepoliafaucet.com"
echo ""
echo "Canton Integration (later):"
echo "  - Apply for Canton testnet: https://canton.network/developers"
echo "  - Set CANTON_* env vars"
echo "  - Set BRIDGE_MODE=live"
echo "════════════════════════════════════════════════════════════════"
