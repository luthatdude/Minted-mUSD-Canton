import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
  const borrowModuleAddr = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const musdAddr = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";

  const musd = await ethers.getContractAt("MUSD", musdAddr);
  const borrow = await ethers.getContractAt("BorrowModule", borrowModuleAddr);

  // Check roles
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  console.log("BRIDGE_ROLE hash:", BRIDGE_ROLE);
  console.log("LIQUIDATOR_ROLE hash:", LIQUIDATOR_ROLE);

  const borrowHasBridge = await musd.hasRole(BRIDGE_ROLE, borrowModuleAddr);
  const borrowHasLiquidator = await musd.hasRole(LIQUIDATOR_ROLE, borrowModuleAddr);
  console.log("\nBorrowModule has BRIDGE_ROLE on MUSD?", borrowHasBridge);
  console.log("BorrowModule has LIQUIDATOR_ROLE on MUSD?", borrowHasLiquidator);

  // Check user state
  const balance = await musd.balanceOf(target);
  console.log("\nTarget mUSD balance:", ethers.formatUnits(balance, 18));

  const debt = await borrow.totalDebt(target);
  console.log("Target total debt:", ethers.formatUnits(debt, 18));

  const pos = await borrow.positions(target);
  console.log("Position principal:", ethers.formatUnits(pos.principal, 18));
  console.log("Position accrued interest:", ethers.formatUnits(pos.accruedInterest, 18));

  const minDebt = await borrow.minDebt();
  console.log("\nminDebt:", ethers.formatUnits(minDebt, 18));

  // Check allowance
  const allowance = await musd.allowance(target, borrowModuleAddr);
  console.log("Target allowance to BorrowModule:", ethers.formatUnits(allowance, 18));

  // Check if paused
  const paused = await borrow.paused();
  console.log("BorrowModule paused?", paused);

  const musdPaused = await musd.paused();
  console.log("MUSD paused?", musdPaused);

  // If BorrowModule doesn't have BRIDGE_ROLE, grant it
  if (!borrowHasBridge) {
    console.log("\n⚠️  BorrowModule is MISSING BRIDGE_ROLE on MUSD!");
    console.log("Granting BRIDGE_ROLE to BorrowModule...");
    const tx = await musd.grantRole(BRIDGE_ROLE, borrowModuleAddr);
    await tx.wait();
    console.log("✅ BRIDGE_ROLE granted to BorrowModule");
  } else {
    console.log("\n✅ BorrowModule already has BRIDGE_ROLE");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
