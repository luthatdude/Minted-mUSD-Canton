// Debug the leverage vault revert reason
import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  
  const leverageVault = await ethers.getContractAt("LeverageVault", "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4");
  const mockWETH = await ethers.getContractAt("MockERC20", "0x7999F2894290F2Ce34a508eeff776126D9a7D46e");
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const borrowModule = await ethers.getContractAt("BorrowModule", "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8");
  const priceOracle = await ethers.getContractAt("PriceOracle", "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025");
  const collateralVault = await ethers.getContractAt("CollateralVault", "0x155d6618dcdeb2F4145395CA57C80e6931D7941e");

  const depositAmount = ethers.parseEther("5");
  
  // Check price feed
  console.log("=== Price oracle check ===");
  try {
    const price = await priceOracle.getValueUsd("0x7999F2894290F2Ce34a508eeff776126D9a7D46e", ethers.parseEther("1"));
    console.log("1 WETH value:", ethers.formatUnits(price, 18), "USD");
  } catch (e: any) {
    console.log("Price oracle FAILED:", e.reason || e.message);
  }

  // Check collateral config
  console.log("\n=== Collateral config ===");
  const config = await collateralVault.getConfig("0x7999F2894290F2Ce34a508eeff776126D9a7D46e");
  console.log("Enabled:", config.enabled);
  console.log("LTV:", Number(config.collateralFactorBps) / 100, "%");

  // Check WETH approval
  const allowance = await mockWETH.allowance(signer.address, "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4");
  console.log("\n=== Approvals ===");
  console.log("WETH allowance:", ethers.formatEther(allowance));
  
  // Check maxBorrow capacity after hypothetical deposit
  console.log("\n=== Borrow capacity ===");
  try {
    const maxBorrow = await borrowModule.maxBorrow(signer.address);
    console.log("Current maxBorrow (before deposit):", ethers.formatUnits(maxBorrow, 18));
  } catch (e: any) {
    console.log("maxBorrow check FAILED:", e.reason || e.message);
  }

  // Try static call to get error
  console.log("\n=== Static call test ===");
  try {
    const result = await leverageVault.openLeveragedPosition.staticCall(
      "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
      depositAmount,
      30,  // 3x
      10,
      0,
      { gasLimit: 2_000_000 }
    );
    console.log("Static call succeeded:", result);
  } catch (e: any) {
    console.log("Revert reason:", e.reason);
    console.log("Error name:", e.errorName);
    console.log("Error args:", e.errorArgs);
    if (e.data) console.log("Error data:", e.data);
    // Try to decode custom error
    const iface = leverageVault.interface;
    if (e.data && e.data !== "0x") {
      try {
        const decoded = iface.parseError(e.data);
        console.log("Decoded error:", decoded?.name, decoded?.args);
      } catch {
        console.log("Could not decode error data");
      }
    }
    console.log("Full error:", e.message?.substring(0, 300));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
