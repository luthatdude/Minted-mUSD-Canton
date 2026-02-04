// Minted mUSD Protocol - Update PendleMarketSelector Parameters
// Changes the minimum TVL requirement from $50M to $10M

import { ethers } from "hardhat";

// NOTE: Update this after PendleMarketSelector is deployed
const PENDLE_MARKET_SELECTOR = ""; // UPDATE THIS - proxy address

async function main() {
  const [admin] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Update PendleMarketSelector Parameters");
  console.log("═".repeat(60));
  console.log(`Admin: ${admin.address}`);

  if (!PENDLE_MARKET_SELECTOR) {
    console.log("\n❌ Please set PENDLE_MARKET_SELECTOR address");
    return;
  }

  const selector = await ethers.getContractAt("PendleMarketSelector", PENDLE_MARKET_SELECTOR);

  // ═══════════════════════════════════════════════════════════
  // Check current parameters
  // ═══════════════════════════════════════════════════════════
  console.log("\n📊 Current Parameters:");
  const currentMinTimeToExpiry = await selector.minTimeToExpiry();
  const currentMinTvlUsd = await selector.minTvlUsd();
  const currentMinApyBps = await selector.minApyBps();
  const currentTvlWeight = await selector.tvlWeight();
  const currentApyWeight = await selector.apyWeight();

  console.log(`   Min Time to Expiry: ${currentMinTimeToExpiry} seconds (${Number(currentMinTimeToExpiry) / 86400} days)`);
  console.log(`   Min TVL USD: $${ethers.formatUnits(currentMinTvlUsd, 6)} (6 decimals)`);
  console.log(`   Min APY BPS: ${currentMinApyBps} (${Number(currentMinApyBps) / 100}%)`);
  console.log(`   TVL Weight: ${currentTvlWeight} (${Number(currentTvlWeight) / 100}%)`);
  console.log(`   APY Weight: ${currentApyWeight} (${Number(currentApyWeight) / 100}%)`);

  // ═══════════════════════════════════════════════════════════
  // Check if we have PARAMS_ADMIN_ROLE
  // ═══════════════════════════════════════════════════════════
  const PARAMS_ADMIN_ROLE = await selector.PARAMS_ADMIN_ROLE();
  const hasRole = await selector.hasRole(PARAMS_ADMIN_ROLE, admin.address);

  if (!hasRole) {
    console.log("\n❌ You don't have PARAMS_ADMIN_ROLE");
    console.log("   Ask the admin to grant you this role or use the admin wallet.");
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // Update parameters - change minTvlUsd to $10M
  // ═══════════════════════════════════════════════════════════
  console.log("\n🔧 Updating Parameters...");
  
  const newMinTvlUsd = ethers.parseUnits("10000000", 6); // $10M with 6 decimals
  
  console.log(`   Changing Min TVL from $50M to $10M...`);
  
  const tx = await selector.setParams(
    currentMinTimeToExpiry,  // Keep same: 30 days
    newMinTvlUsd,            // Changed: $10M instead of $50M
    currentMinApyBps,        // Keep same: 9%
    currentTvlWeight,        // Keep same: 40%
    currentApyWeight         // Keep same: 60%
  );
  
  const receipt = await tx.wait();
  console.log(`   ✅ Updated! Tx: ${receipt?.hash}`);

  // ═══════════════════════════════════════════════════════════
  // Verify new parameters
  // ═══════════════════════════════════════════════════════════
  console.log("\n📊 New Parameters:");
  const newMinTvlUsdVerify = await selector.minTvlUsd();
  console.log(`   Min TVL USD: $${ethers.formatUnits(newMinTvlUsdVerify, 6)}`);

  console.log("\n✅ PendleMarketSelector parameters updated!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
