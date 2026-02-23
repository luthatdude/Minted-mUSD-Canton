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
 *   Run this script twice daily from your scheduler.
 */

import { ethers } from "hardhat";

interface FeedEntry {
  token: string;
  tokenName: string;
  feedAddress?: string;
  priceUsd: number;     // Human-readable price (e.g. 2500 for WETH)
  feedDecimals: number;
}

// Testnet feed registry — keep these aligned with deployed collateral tokens.
const FEEDS: FeedEntry[] = [
  {
    token: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
    tokenName: "WETH",
    priceUsd: 2500,
    feedDecimals: 8,
  },
  {
    token: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
    tokenName: "WBTC",
    priceUsd: 45000,
    feedDecimals: 8,
  },
  {
    token: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
    tokenName: "smUSD",
    // Oracle is limited to tokenDecimals<=18 while smUSD has 21 decimals.
    // Use effective 0.001 oracle price so getValueUsd(amount21dec) remains correct.
    priceUsd: 0.001,
    feedDecimals: 8,
  },
  {
    token: "0x6B8e8A0C376E592F35642418581Ec272623cF75E",
    tokenName: "smUSD-E",
    priceUsd: 1,
    feedDecimals: 8,
  },
  {
    token: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
    tokenName: "USDC",
    priceUsd: 1,
    feedDecimals: 8,
  },
];

const ORACLE_ADDRESS = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
const REFRESH_MARGIN = 300; // 5 minutes before stale cutoff

async function main() {
  const [keeper] = await ethers.getSigners();
  console.log(`[${new Date().toISOString()}] Keeper: ${keeper.address}`);

  const oracle = await ethers.getContractAt("PriceOracle", ORACLE_ADDRESS);
  
  for (const entry of FEEDS) {
    const feedCfg = await oracle.feeds(entry.token);
    if (!feedCfg.enabled) {
      console.log(`  ${entry.tokenName}: skipped (oracle feed disabled)`);
      continue;
    }

    const resolvedFeed = entry.feedAddress || feedCfg.feed;
    if (!resolvedFeed || resolvedFeed === ethers.ZeroAddress) {
      console.log(`  ${entry.tokenName}: skipped (no feed configured on oracle)`);
      continue;
    }

    const feed = new ethers.Contract(resolvedFeed, [
      "function setAnswer(int256 answer) external",
      "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
    ], keeper);

    try {
      const [, answer, , updatedAt] = await feed.latestRoundData();
      const now = Math.floor(Date.now() / 1000);
      const age = now - Number(updatedAt);
      const stalePeriod = Number(feedCfg.stalePeriod);
      const refreshThreshold = Math.max(0, stalePeriod - REFRESH_MARGIN);

      console.log(`  ${entry.tokenName}: price=$${ethers.formatUnits(answer, entry.feedDecimals)}, age=${(age / 3600).toFixed(1)}h`);

      if (age > refreshThreshold) {
        console.log(`  → Refreshing (age ${age}s exceeds threshold ${refreshThreshold}s)`);
        
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
