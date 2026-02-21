#!/usr/bin/env ts-node
/**
 * Keeper script: Refreshes mock Chainlink feeds on Sepolia testnet.
 * 
 * The MockAggregatorV3 feeds require periodic setAnswer() calls to keep
 * the updatedAt timestamp current and avoid StalePrice reverts.
 * 
 * Usage:
 *   npx hardhat run scripts/keeper-refresh-feeds.ts --network sepolia
 *
 * Cron (every 12 hours):
 *   0 */12 * * * cd /path/to/Minted-mUSD-Canton && npx hardhat run scripts/keeper-refresh-feeds.ts --network sepolia >> /tmp/keeper.log 2>&1
 */

import { ethers } from "hardhat";

interface FeedEntry {
  token: string;
  tokenName: string;
  feedAddress: string;
  priceUsd: number;     // Human-readable price (e.g. 2500 for WETH)
  feedDecimals: number;
}

// Testnet feed registry — add entries here for each collateral token
const FEEDS: FeedEntry[] = [
  {
    token: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
    tokenName: "WETH",
    feedAddress: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
    priceUsd: 2500,
    feedDecimals: 8,
  },
  // Add WBTC, etc. as they are deployed:
  // {
  //   token: "0x...",
  //   tokenName: "WBTC",
  //   feedAddress: "0x...",
  //   priceUsd: 97000,
  //   feedDecimals: 8,
  // },
];

const ORACLE_ADDRESS = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
const STALENESS_THRESHOLD = 86400; // 24 hours — must match oracle.feeds[token].stalePeriod
const REFRESH_MARGIN = 3600;       // Refresh if age > (threshold - margin) = 23 hours

async function main() {
  const [keeper] = await ethers.getSigners();
  console.log(`[${new Date().toISOString()}] Keeper: ${keeper.address}`);

  const oracle = await ethers.getContractAt("PriceOracle", ORACLE_ADDRESS);
  
  for (const entry of FEEDS) {
    const feed = new ethers.Contract(entry.feedAddress, [
      "function setAnswer(int256 answer) external",
      "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
    ], keeper);

    try {
      const [, answer, , updatedAt] = await feed.latestRoundData();
      const now = Math.floor(Date.now() / 1000);
      const age = now - Number(updatedAt);

      console.log(`  ${entry.tokenName}: price=$${ethers.formatUnits(answer, entry.feedDecimals)}, age=${(age / 3600).toFixed(1)}h`);

      if (age > STALENESS_THRESHOLD - REFRESH_MARGIN) {
        console.log(`  → Refreshing (age ${age}s exceeds margin ${STALENESS_THRESHOLD - REFRESH_MARGIN}s)`);
        
        const priceRaw = BigInt(Math.round(entry.priceUsd * 10 ** entry.feedDecimals));
        const tx = await feed.setAnswer(priceRaw);
        await tx.wait();
        console.log(`  ✅ ${entry.tokenName} feed refreshed at $${entry.priceUsd} (tx: ${tx.hash})`);

        // Also update lastKnownPrice in oracle
        try {
          const resetTx = await oracle.resetLastKnownPrice(entry.token);
          await resetTx.wait();
          console.log(`  ✅ lastKnownPrice reset`);
        } catch (e: any) {
          // May fail if circuit breaker tripped — that's OK, updatePrice will handle it
          try {
            const updateTx = await oracle.updatePrice(entry.token);
            await updateTx.wait();
            console.log(`  ✅ updatePrice succeeded`);
          } catch {
            console.log(`  ⚠️  Could not reset lastKnownPrice (circuit breaker?)`);
          }
        }
      } else {
        console.log(`  → Feed is fresh, no action needed`);
      }
    } catch (e: any) {
      console.error(`  ❌ ${entry.tokenName} error: ${e.message?.slice(0, 200)}`);
    }
  }

  console.log(`[${new Date().toISOString()}] Keeper run complete.`);
}

main().catch(console.error);
