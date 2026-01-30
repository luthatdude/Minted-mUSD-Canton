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

# Check environment
if [ ! -f ".env" ]; then
    echo "Creating .env from template..."
    cp .env.example .env 2>/dev/null || cat > .env << 'EOF'
# Ethereum Testnet (Sepolia)
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
CHAIN_ID=11155111
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Chainlink Price Feeds (Sepolia)
CHAINLINK_ETH_USD=0x694AA1769357215DE4FAC081bf1f309aDC325306
CHAINLINK_BTC_USD=0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43

# Bridge Config (no Canton for now)
BRIDGE_MODE=mock
VALIDATOR_THRESHOLD=2

# Frontend
NEXT_PUBLIC_CHAIN_ID=11155111
EOF
    echo "⚠️  Please edit .env with your Alchemy API key and deployer private key"
    echo "   Then run this script again."
    exit 1
fi

source .env

# Validate required env vars
if [ "$RPC_URL" == "https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY" ]; then
    echo "❌ Please set RPC_URL in .env"
    exit 1
fi

if [ "$DEPLOYER_PRIVATE_KEY" == "0xYOUR_PRIVATE_KEY_HERE" ]; then
    echo "❌ Please set DEPLOYER_PRIVATE_KEY in .env"
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
