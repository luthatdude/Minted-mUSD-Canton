import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const BORROW = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";

  const oracle = await ethers.getContractAt("PriceOracle", ORACLE);
  const borrow = await ethers.getContractAt("BorrowModule", BORROW);
  const vault = await ethers.getContractAt("CollateralVault", VAULT);

  // Check deployer's collateral
  console.log("=== Deployer Collateral ===");
  const deposited = await vault.deposits(deployer.address, WETH);
  console.log("WETH deposited:", ethers.formatEther(deposited));
  
  // Check oracle state
  console.log("\n=== Oracle State ===");
  const lastKnown = await oracle.lastKnownPrice(WETH);
  console.log("lastKnownPrice:", ethers.formatUnits(lastKnown, 18), "USD");
  const currentPrice = await oracle.getPrice(WETH);
  console.log("getPrice:", ethers.formatUnits(currentPrice, 18), "USD");
  const cbTripped = await oracle.circuitBreakerTrippedAt(WETH);
  console.log("circuitBreakerTrippedAt:", cbTripped.toString());
  const cbEnabled = await oracle.circuitBreakerEnabled();
  console.log("circuitBreakerEnabled:", cbEnabled);
  
  // Check collateral value
  console.log("\n=== Collateral Value ===");
  const valueUsd = await oracle.getValueUsd(WETH, deposited);
  console.log("Deployer WETH value:", ethers.formatUnits(valueUsd, 18), "USD");
  
  // Check borrow state
  console.log("\n=== Borrow State ===");
  const totalDebt = await borrow.totalDebt(deployer.address);
  console.log("totalDebt:", ethers.formatUnits(totalDebt, 18), "mUSD");
  const totalBorrows = await borrow.totalBorrows();
  console.log("totalBorrows:", ethers.formatUnits(totalBorrows, 18), "mUSD");
  
  // Health factor breakdown
  console.log("\n=== Health Factor Breakdown ===");
  const colFactor = await vault.collateralFactor(WETH);
  console.log("Collateral factor:", colFactor.toString(), "bps");
  const liqThreshold = await vault.liquidationThreshold(WETH);
  console.log("Liquidation threshold:", liqThreshold.toString(), "bps");
  
  // Manual health factor calc: (collateral_value * liq_threshold / 10000) / debt
  const weightedCollateral = (valueUsd * liqThreshold) / 10000n;
  console.log("Weighted collateral:", ethers.formatUnits(weightedCollateral, 18), "USD");
  console.log("Manual health factor:", totalDebt > 0n ? 
    Number(ethers.formatUnits(weightedCollateral * ethers.parseEther("1") / totalDebt, 18)).toFixed(4) : 
    "Infinity (no debt)");
  
  // Check who the user in the screenshot is
  console.log("\n=== User with 20 WETH ===");
  // The screenshot shows 20 WETH. Deployer has 7.9, so it's a different address.
  // Let's check if health factor calculation works at the contract level
  const hf = await borrow.healthFactor(deployer.address);
  console.log("Contract healthFactor:", ethers.formatUnits(hf, 18));
  const mb = await borrow.maxBorrow(deployer.address);
  console.log("Contract maxBorrow:", ethers.formatUnits(mb, 18));
  
  // Try updatePrice (ORACLE_ADMIN_ROLE) 
  console.log("\n=== Updating lastKnownPrice via updatePrice ===");
  try {
    const tx = await oracle.updatePrice(WETH);
    await tx.wait();
    console.log("✅ updatePrice succeeded");
    const newLastKnown = await oracle.lastKnownPrice(WETH);
    console.log("New lastKnownPrice:", ethers.formatUnits(newLastKnown, 18), "USD");
  } catch (e: any) {
    console.log("❌ updatePrice error:", e.message?.slice(0, 300));
  }
  
  // Re-check health factor after lastKnownPrice update
  console.log("\n=== After lastKnownPrice Update ===");
  try {
    const hf2 = await borrow.healthFactor(deployer.address);
    console.log("healthFactor:", ethers.formatUnits(hf2, 18));
    const mb2 = await borrow.maxBorrow(deployer.address);
    console.log("maxBorrow:", ethers.formatUnits(mb2, 18), "mUSD");
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 200));
  }
}

main().catch(console.error);
