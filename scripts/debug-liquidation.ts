import { ethers } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  const ADDR = {
    musd: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
    vault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
    borrow: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
    oracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
    liquidation: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
    weth: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  };

  const vault = await ethers.getContractAt("CollateralVault", ADDR.vault);
  const borrow = await ethers.getContractAt("BorrowModule", ADDR.borrow);
  const musd = await ethers.getContractAt("MUSD", ADDR.musd);
  const liq = await ethers.getContractAt("LiquidationEngine", ADDR.liquidation);

  // Check roles on CollateralVault
  const LIQ_ROLE_CV = await vault.LIQUIDATION_ROLE();
  console.log("CollateralVault — LiqEngine has LIQUIDATION_ROLE:", await vault.hasRole(LIQ_ROLE_CV, ADDR.liquidation));

  // Check roles on BorrowModule
  const LIQ_ROLE_BM = await borrow.LIQUIDATION_ROLE();
  console.log("BorrowModule — LiqEngine has LIQUIDATION_ROLE:", await borrow.hasRole(LIQ_ROLE_BM, ADDR.liquidation));

  // Check MUSD roles for LiqEngine
  const LIQ_ROLE_MUSD = await musd.LIQUIDATOR_ROLE();
  console.log("MUSD — LiqEngine has LIQUIDATOR_ROLE:", await musd.hasRole(LIQ_ROLE_MUSD, ADDR.liquidation));

  // Check deployer debt and health factor
  const debt = await borrow.totalDebt(deployer.address);
  console.log("\nDeployer debt:", ethers.formatUnits(debt, 18));

  try {
    const hf = await borrow.healthFactorUnsafe(deployer.address);
    console.log("Health factor:", Number(hf) / 10000);
  } catch(e: any) { console.log("Health factor error:", e.message?.slice(0,100)); }

  const deposit = await vault.getDeposit(deployer.address, ADDR.weth);
  console.log("WETH deposit:", ethers.formatUnits(deposit, 18));

  // Check pause states
  try { console.log("LiqEngine paused:", await liq.paused()); } catch { console.log("LiqEngine paused: N/A"); }
  try { console.log("BorrowModule paused:", await borrow.paused()); } catch { console.log("BorrowModule paused: N/A"); }

  // Check LiquidationEngine config
  console.log("\nLiqEngine config:");
  console.log("  vault:", await liq.vault());
  console.log("  borrowModule:", await liq.borrowModule());
  console.log("  oracle:", await liq.oracle());
  console.log("  musd:", await liq.musd());
  console.log("  closeFactorBps:", (await liq.closeFactorBps()).toString());
  try { console.log("  fullLiqThreshold:", (await liq.fullLiquidationThreshold()).toString()); } catch { console.log("  fullLiqThreshold: N/A"); }

  // Try to simulate liquidation
  console.log("\nSimulating liquidation (staticCall)...");
  try {
    await liq.liquidate.staticCall(deployer.address, ADDR.weth, ethers.parseUnits("100", 18));
    console.log("staticCall succeeded!");
  } catch(e: any) {
    console.log("staticCall FAILED:", e.message?.slice(0, 300));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
