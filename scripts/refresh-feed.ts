import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const FEED = "0xc82116f198C582C2570712Cbe514e17dC9E8e01A";
  const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";

  // 1. Refresh the mock feed with $2500 (same price, but resets timestamp)
  const feed = new ethers.Contract(FEED, [
    "function setAnswer(int256 answer) external",
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function decimals() view returns (uint8)",
  ], deployer);

  console.log("\n=== Before Refresh ===");
  const [_, answerBefore, __, updatedBefore] = await feed.latestRoundData();
  const ageBefore = Math.floor(Date.now() / 1000) - Number(updatedBefore);
  console.log(`Price: $${ethers.formatUnits(answerBefore, 8)}, Age: ${(ageBefore / 3600).toFixed(1)} hours`);

  console.log("\n=== Refreshing Feed (setAnswer $2500) ===");
  const tx = await feed.setAnswer(250000000000n); // $2500 with 8 decimals
  console.log("TX hash:", tx.hash);
  await tx.wait();
  console.log("Feed refreshed!");

  console.log("\n=== After Refresh ===");
  const [_3, answerAfter, _4, updatedAfter] = await feed.latestRoundData();
  const ageAfter = Math.floor(Date.now() / 1000) - Number(updatedAfter);
  console.log(`Price: $${ethers.formatUnits(answerAfter, 8)}, Age: ${ageAfter} seconds`);

  // 2. Verify oracle getPrice now works
  const oracle = await ethers.getContractAt("PriceOracle", ORACLE);
  console.log("\n=== Oracle Verification ===");
  try {
    const price = await oracle.getPrice(WETH);
    console.log("✅ getPrice(WETH):", ethers.formatUnits(price, 18), "USD");
  } catch (e: any) {
    console.log("❌ getPrice still fails:", e.message?.slice(0, 200));
  }

  try {
    const oneETH = ethers.parseEther("1");
    const value = await oracle.getValueUsd(WETH, oneETH);
    console.log("✅ getValueUsd(1 WETH):", ethers.formatUnits(value, 18), "USD");
  } catch (e: any) {
    console.log("❌ getValueUsd still fails:", e.message?.slice(0, 200));
  }

  // 3. Also update the lastKnownPrice via resetLastKnownPrice (deployer has KEEPER_ROLE)
  console.log("\n=== Resetting lastKnownPrice ===");
  try {
    const resetTx = await oracle.resetLastKnownPrice(WETH);
    await resetTx.wait();
    console.log("✅ lastKnownPrice reset");
  } catch (e: any) {
    console.log("resetLastKnownPrice error:", e.message?.slice(0, 200));
  }

  // 4. Verify BorrowModule can read collateral
  const BORROW = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const borrow = await ethers.getContractAt("BorrowModule", BORROW);
  console.log("\n=== BorrowModule Verification ===");
  try {
    const hf = await borrow.healthFactor(deployer.address);
    console.log("✅ healthFactor:", ethers.formatUnits(hf, 18));
  } catch (e: any) {
    console.log("❌ healthFactor error:", e.message?.slice(0, 200));
  }

  try {
    const mb = await borrow.maxBorrow(deployer.address);
    console.log("✅ maxBorrow:", ethers.formatUnits(mb, 18), "mUSD");
  } catch (e: any) {
    console.log("❌ maxBorrow error:", e.message?.slice(0, 200));
  }

  console.log("\n✅ Feed refresh complete. The Borrow page should now work.");
}

main().catch(console.error);
