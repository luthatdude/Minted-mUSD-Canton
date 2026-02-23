import { ethers } from "hardhat";

/**
 * Devnet hotfix:
 * Deploy a dedicated mock feed for smUSD and set an effective oracle price.
 *
 * NOTE:
 * - PriceOracle currently enforces tokenDecimals <= 18.
 * - smUSD token has 21 decimals (ERC4626 decimalsOffset +3).
 * - To keep getValueUsd() correct with tokenDecimals=18, use an effective
 *   price of 0.001 USD for smUSD (i.e. 1e-3 * 1e8 = 100000 in feed units).
 *
 * Usage:
 *   npx hardhat run scripts/fix-smusd-feed-sepolia.ts --network sepolia
 */

const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
const FEED_DECIMALS = 8;
const SMUSD_EFFECTIVE_USD = 0.001;

async function main() {
  const [signer] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("PriceOracle", ORACLE, signer);

  console.log("Signer:", signer.address);
  console.log("Deploying dedicated smUSD mock feed...");

  const initialAnswer = BigInt(Math.round(SMUSD_EFFECTIVE_USD * 10 ** FEED_DECIMALS));
  const MockFeed = await ethers.getContractFactory("MockAggregatorV3", signer);
  const feed = await MockFeed.deploy(FEED_DECIMALS, initialAnswer);
  await feed.waitForDeployment();
  const feedAddress = await feed.getAddress();
  console.log("smUSD mock feed:", feedAddress);

  console.log("Setting smUSD oracle feed...");

  // setFeed(token, feed, stalePeriod, tokenDecimals, assetMaxDeviationBps)
  const tx = await oracle.setFeed(SMUSD, feedAddress, 172800, 18, 0);
  console.log("setFeed tx:", tx.hash);
  await tx.wait();

  // Ensure lastKnownPrice and circuit breaker state are refreshed.
  try {
    const resetTx = await oracle.resetLastKnownPrice(SMUSD);
    await resetTx.wait();
    console.log("resetLastKnownPrice tx:", resetTx.hash);
  } catch (e: any) {
    console.log("resetLastKnownPrice failed, trying updatePrice:", e.message?.slice(0, 120));
    const updateTx = await oracle.updatePrice(SMUSD);
    await updateTx.wait();
    console.log("updatePrice tx:", updateTx.hash);
  }

  const [price, latestRound] = await Promise.all([
    oracle.getPrice(SMUSD),
    feed.latestRoundData(),
  ]);
  const cfg = await oracle.feeds(SMUSD);
  console.log("✅ smUSD getPrice:", ethers.formatUnits(price, 18), "USD");
  console.log("✅ smUSD feed answer:", latestRound.answer.toString());
  console.log("✅ smUSD feed config:", {
    feed: cfg.feed,
    stalePeriod: cfg.stalePeriod.toString(),
    tokenDecimals: cfg.tokenDecimals.toString(),
    enabled: cfg.enabled,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
