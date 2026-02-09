# Minted Points System

Off-chain points tracking for the **Minted token airdrop**. Tracks user participation across Ethereum and Canton Network, applies season-based multipliers, and serves a REST API for the frontend.

## How Points Work

**Formula:** `points = USD_value × multiplier × hours`

Every hour, the system takes a snapshot of all user positions across both chains and awards points based on how much value they have deployed and where. Early adopters earn the most — multipliers decrease each season.

## Seasons

| Season | Name | Period | Boost Pool Multiplier |
|--------|------|--------|-----------------------|
| 1 | **Genesis** | Mar 2026 → Jun 2026 | **10x** 🔥 |
| 2 | **Growth** | Jun 2026 → Sep 2026 | **6x** |
| 3 | **Maturity** | Sep 2026 → Dec 2026 | **4x** |

### Season 1 Multipliers (Genesis)

| Action | Chain | Multiplier |
|--------|-------|------------|
| Canton Boost Pool | Canton | **10x** 🔥 |
| Hold sMUSD | Canton | 4x |
| sMUSD Collateral | Canton | 4x |
| Leverage Vault | Ethereum | 4x |
| Hold sMUSD | Ethereum | 3x |
| sMUSD Collateral | Ethereum | 3x |
| CTN Collateral | Canton | 3x |
| ETH Collateral | Ethereum | 2x |
| WBTC Collateral | Ethereum | 2x |
| Canton Borrow | Canton | 2x |
| ETH Borrow | Ethereum | 1.5x |

> **Canton Boost Pool is ALWAYS the highest multiplier across all seasons.**

## Architecture

```
snapshot.ts     →  Reads balances from ETH RPC + Canton Ledger API
calculator.ts   →  Applies multipliers, accumulates points
db.ts           →  SQLite storage (snapshots, points, leaderboard)
server.ts       →  Express REST API for frontend
config.ts       →  Season definitions, multipliers, contract addresses
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/points/:address` | User's points breakdown |
| `GET` | `/api/leaderboard` | Global leaderboard |
| `GET` | `/api/leaderboard/:seasonId` | Per-season leaderboard |
| `GET` | `/api/season` | Current season info + countdown |
| `GET` | `/api/seasons` | All seasons overview |
| `GET` | `/api/stats/:seasonId` | Season statistics |
| `GET` | `/api/projection?value=1000&action=CTN_BOOST_POOL` | Points calculator |
| `GET` | `/health` | Health check |
| `POST` | `/admin/snapshot` | Force snapshot (admin) |

## Setup

```bash
cd points
cp .env.example .env
# Edit .env with your RPC URL, Canton ledger, admin key

npm install
npm run dev     # Development
npm run build   # Compile
npm start       # Production
```

## Example: Points Projection

**$10,000 in Canton Boost Pool during Season 1 (Genesis):**

```
Points per hour:   10,000 × 10 = 100,000
Points per day:    2,400,000
Points per season: ~220,000,000
```

**Same $10,000 in sMUSD on Ethereum during Season 1:**

```
Points per hour:   10,000 × 3 = 30,000
Points per day:    720,000
Points per season: ~66,000,000
```

> Canton Boost Pool earns **3.3x more points** than ETH sMUSD for the same value.

## Data Storage

Uses SQLite (via `better-sqlite3`) stored at `./data/points.db`. The database is created automatically on first run. Back it up regularly.

## Points → Airdrop

At the end of Season 3, total accumulated points determine each user's share of the Minted token airdrop. The exact token amount and vesting schedule will be announced before Season 3 ends.
