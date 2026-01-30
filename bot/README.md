# Minted mUSD Liquidation Bot

Automated liquidation bot for the Minted mUSD Protocol. Monitors borrower positions and executes profitable liquidations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LIQUIDATION BOT                          │
├─────────────────────────────────────────────────────────────┤
│  1. Event Listener: Subscribe to Borrowed events            │
│  2. Position Monitor: Poll healthFactor() for all borrowers │
│  3. Opportunity Finder: Calculate profit for liquidatable   │
│  4. Executor: Submit liquidate() transactions               │
└─────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  BorrowModule   │  │ LiquidationEngine│  │  PriceOracle   │
│ (health factor) │  │    (execute)     │  │   (pricing)    │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
cd bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

Required environment variables:
- `RPC_URL` - Ethereum RPC endpoint (Alchemy, Infura, etc.)
- `PRIVATE_KEY` - Bot wallet private key (with mUSD balance)
- Contract addresses for BorrowModule, LiquidationEngine, etc.

### 3. Fund Bot Wallet

The bot needs:
- **mUSD** to repay borrower debt during liquidations
- **ETH** for gas

## Usage

### Run Liquidation Bot

```bash
# Development (with ts-node)
npm run dev

# Production
npm run build
npm start
```

### Monitor Positions Only

```bash
# Scan for all borrowers from a specific block
npm run monitor -- --scan 18000000

# Watch mode (continuous monitoring)
npm run monitor -- --watch 18000000

# Check specific addresses
npm run monitor -- --address 0x123... 0x456...
```

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `POLL_INTERVAL_MS` | How often to check positions | 5000 |
| `MIN_PROFIT_USD` | Minimum profit to execute | $50 |
| `MAX_GAS_PRICE_GWEI` | Skip if gas is above this | 100 |
| `GAS_PRICE_BUFFER_PERCENT` | Buffer for gas estimation | 20% |

## How It Works

### 1. Position Discovery

The bot discovers borrowers by:
- Listening to `Borrowed` events in real-time
- Scanning historical events on startup (optional)

### 2. Health Factor Monitoring

For each borrower, the bot calls:
```solidity
function healthFactor(address user) external view returns (uint256);
```

If `healthFactor < 10000` (1.0), the position is liquidatable.

### 3. Profit Calculation

```
Profit = CollateralSeized × Price × (1 + LiquidationPenalty) - DebtRepaid - GasCost
```

Example:
- Borrower has $10,000 debt, $9,500 collateral (undercollateralized)
- Liquidation penalty: 10%
- Bot repays $5,000 (close factor = 50%)
- Bot seizes $5,500 worth of collateral
- **Profit: $500 - gas**

### 4. Execution

```typescript
await liquidationEngine.liquidate(
  borrower,          // Undercollateralized user
  collateralToken,   // Token to seize (e.g., WETH)
  debtToRepay        // Amount of mUSD to repay
);
```

## Security Considerations

⚠️ **Never commit your private key!**

- Use a dedicated bot wallet with only necessary funds
- Monitor wallet balance and top up as needed
- Consider using Flashbots to avoid front-running
- Run on a secure server with restricted access

## MEV Protection

The bot includes full Flashbots integration to avoid front-running by other bots.

### Enable Flashbots

```bash
# In .env
USE_FLASHBOTS=true
FLASHBOTS_RELAY_URL=https://relay.flashbots.net
```

### How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Liquidation    │────▶│  Flashbots Relay │────▶│   Block Builder │
│     Bot         │     │  (private)       │     │   (MEV-Boost)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────┐
                                                 │   Ethereum      │
                                                 │   Block         │
                                                 └─────────────────┘
```

1. **Bundle Creation** - Transaction is signed but NOT broadcast publicly
2. **Simulation** - Flashbots simulates to verify it won't revert
3. **Private Submission** - Bundle sent directly to block builders
4. **Inclusion** - Builders include bundle if profitable
5. **No Front-running** - Transaction never hits public mempool

### Features

| Feature | Description |
|---------|-------------|
| **Private Mempool** | Transactions not visible to other bots |
| **Bundle Simulation** | Verify success before paying gas |
| **Auto-Retry** | Tries inclusion for 5 consecutive blocks |
| **Fallback** | Falls back to regular tx if Flashbots fails |

### Alternative: Flashbots Protect RPC

For simpler MEV protection without bundles, use Flashbots Protect RPC:

```bash
# Just replace your RPC_URL with:
RPC_URL=https://rpc.flashbots.net
USE_FLASHBOTS=false
```

This sends transactions through a private channel without the bundle complexity.

## Monitoring & Alerts

The bot logs to:
- Console (stdout)
- `liquidations.log` file

For production, consider:
- Setting up Telegram alerts (configure `TELEGRAM_BOT_TOKEN`)
- Prometheus metrics export
- Grafana dashboards

## Profit Strategy

| Strategy | Risk | Reward |
|----------|------|--------|
| **Conservative** | Wait for HF < 0.9 | Lower competition |
| **Aggressive** | Liquidate immediately at HF < 1.0 | Race with other bots |
| **Flashbots** | Bundle with priority fee | Higher success rate |

## Troubleshooting

### "Insufficient mUSD balance"
Top up your bot wallet with mUSD.

### "Gas price too high"
Wait for lower gas or increase `MAX_GAS_PRICE_GWEI`.

### "POSITION_HEALTHY" revert
Another bot liquidated first. This is normal in competitive environments.

### No borrowers found
Run historical scan: `npm run monitor -- --scan 0`

## License

MIT - Part of the Minted mUSD Protocol
