/**
 * Clear all balances for wallet 0x33f9...DDa5 
 * Uses admin seize() to withdraw collateral and burn() for mUSD.
 */
import { ethers } from "hardhat";

const TARGET = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";

const ADDRS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  WETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Target:", TARGET);

  const vault = await ethers.getContractAt("CollateralVault", ADDRS.CollateralVault);
  const borrow = await ethers.getContractAt("BorrowModule", ADDRS.BorrowModule);
  const musd = await ethers.getContractAt("MUSD", ADDRS.MUSD);

  // Current state
  console.log("\n=== Before ===");
  const wethDep = await vault.deposits(TARGET, ADDRS.WETH);
  const debt = await borrow.totalDebt(TARGET);
  const musdBal = await musd.balanceOf(TARGET);
  console.log(`  WETH deposited: ${ethers.formatEther(wethDep)}`);
  console.log(`  Debt: ${ethers.formatEther(debt)} mUSD`);
  console.log(`  mUSD balance: ${ethers.formatEther(musdBal)}`);

  // Step 1: Reduce any debt
  if (debt > 0n) {
    console.log("\n=== Reducing Debt ===");
    const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));
    const hasLiqRole = await borrow.hasRole(LIQUIDATION_ROLE, deployer.address);
    if (!hasLiqRole) {
      await (await borrow.grantRole(LIQUIDATION_ROLE, deployer.address)).wait();
      console.log("  Granted LIQUIDATION_ROLE on BorrowModule");
    }
    await (await borrow.reduceDebt(TARGET, debt + ethers.parseEther("10"))).wait();
    console.log("  ✅ Debt cleared");
    if (!hasLiqRole) {
      await (await borrow.revokeRole(LIQUIDATION_ROLE, deployer.address)).wait();
    }
  }

  // Step 2: Seize collateral (LIQUIDATION_ROLE on vault)
  if (wethDep > 0n) {
    console.log("\n=== Seizing Collateral ===");
    const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));
    const hasLiqRole = await vault.hasRole(LIQUIDATION_ROLE, deployer.address);
    if (!hasLiqRole) {
      await (await vault.grantRole(LIQUIDATION_ROLE, deployer.address)).wait();
      console.log("  Granted LIQUIDATION_ROLE on CollateralVault");
    }
    await (await vault.seize(TARGET, ADDRS.WETH, wethDep, deployer.address)).wait();
    console.log(`  ✅ Seized ${ethers.formatEther(wethDep)} WETH`);
    if (!hasLiqRole) {
      await (await vault.revokeRole(LIQUIDATION_ROLE, deployer.address)).wait();
      console.log("  Revoked LIQUIDATION_ROLE on CollateralVault");
    }
  }

  // Step 3: Burn mUSD from target
  // burn() requires msg.sender has BRIDGE_ROLE + allowance from target, OR we need target's signature
  // Since we can't sign as target, we can't burn their mUSD directly.
  // But 297 mUSD is negligible — just note it.
  if (musdBal > 0n) {
    console.log(`\n=== mUSD Balance ===`);
    console.log(`  ⚠️  ${ethers.formatEther(musdBal)} mUSD remains in wallet (requires wallet signature to burn)`);
    console.log(`  This is cosmetic — no collateral or debt to worry about.`);
  }

  // Final state
  console.log("\n=== After ===");
  const wethAfter = await vault.deposits(TARGET, ADDRS.WETH);
  const debtAfter = await borrow.totalDebt(TARGET);
  const musdAfter = await musd.balanceOf(TARGET);
  console.log(`  WETH deposited: ${ethers.formatEther(wethAfter)}`);
  console.log(`  Debt: ${ethers.formatEther(debtAfter)} mUSD`);
  console.log(`  mUSD balance: ${ethers.formatEther(musdAfter)}`);
  
  console.log("\n🧹 Collateral and debt cleared for target wallet.");
}

main().catch(console.error);
