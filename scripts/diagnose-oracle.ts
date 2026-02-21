import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const FEED = "0xc82116f198C582C2570712Cbe514e17dC9E8e01A";
  
  // Read oracle contract
  const oracle = await ethers.getContractAt("PriceOracle", ORACLE);
  
  // Check feed config struct
  console.log("=== Oracle Feed Config ===");
  try {
    // feeds mapping returns the FeedConfig struct
    const feedData = await oracle.feeds(WETH);
    console.log("Raw feed data:", feedData);
  } catch (e: any) {
    console.log("feeds() error:", e.message?.slice(0, 200));
  }
  
  // Read the chainlink feed directly
  console.log("\n=== Chainlink Feed Direct Read ===");
  const chainlink = new ethers.Contract(FEED, [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
  ], deployer);

  try {
    const desc = await chainlink.description();
    console.log("Feed description:", desc);
  } catch (e: any) {
    console.log("description() error:", e.message?.slice(0, 200));
  }

  try {
    const dec = await chainlink.decimals();
    console.log("Feed decimals:", dec.toString());
  } catch (e: any) {
    console.log("decimals() error:", e.message?.slice(0, 200));
  }

  try {
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await chainlink.latestRoundData();
    const now = Math.floor(Date.now() / 1000);
    const age = now - Number(updatedAt);
    console.log("roundId:", roundId.toString());
    console.log("answer:", answer.toString());
    console.log("startedAt:", startedAt.toString());
    console.log("updatedAt:", updatedAt.toString());
    console.log("answeredInRound:", answeredInRound.toString());
    console.log("Age (seconds):", age);
    console.log("Age (hours):", (age / 3600).toFixed(1));
    console.log("Price (8 dec):", ethers.formatUnits(answer, 8));
    
    // Check staleness threshold from oracle
    console.log("\n=== Staleness Check ===");
    console.log("Feed age:", age, "seconds =", (age / 3600).toFixed(1), "hours");
    console.log("Oracle staleness threshold: 86400 seconds = 24 hours");
    if (age > 86400) {
      console.log(">>> STALE! Feed is older than staleness threshold. This is why getPrice reverts!");
    } else {
      console.log("Feed is NOT stale by staleness threshold");
    }
  } catch (e: any) {
    console.log("latestRoundData() error:", e.message?.slice(0, 200));
  }

  // Try getPrice with error decoding
  console.log("\n=== getPrice Error Details ===");
  try {
    const price = await oracle.getPrice(WETH);
    console.log("getPrice succeeded:", price.toString());
  } catch (e: any) {
    console.log("getPrice reverted.");
    if (e.data) {
      console.log("Error data:", e.data);
    }
    // Try to decode error
    const iface = oracle.interface;
    if (e.data && e.data !== "0x") {
      try {
        const decoded = iface.parseError(e.data);
        console.log("Decoded error:", decoded?.name, decoded?.args);
      } catch {
        console.log("Could not decode error selector:", e.data?.slice(0, 10));
      }
    }
    console.log("Full error message:", e.message?.slice(0, 500));
  }
}

main().catch(console.error);
