import { ethers } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  const ADDR = {
    borrow: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
    liquidation: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
    timelock: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  };

  const borrow = await ethers.getContractAt("BorrowModule", ADDR.borrow);
  
  // Check role admin
  const LIQ_ROLE = await borrow.LIQUIDATION_ROLE();
  const roleAdmin = await borrow.getRoleAdmin(LIQ_ROLE);
  console.log("LIQUIDATION_ROLE:", LIQ_ROLE);
  console.log("Role admin hash:", roleAdmin);

  // Decode which role is the admin
  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const TIMELOCK_ROLE = await borrow.TIMELOCK_ROLE();
  console.log("TIMELOCK_ROLE:", TIMELOCK_ROLE);

  if (roleAdmin === DEFAULT_ADMIN) {
    console.log("Admin: DEFAULT_ADMIN_ROLE");
    const hasAdmin = await borrow.hasRole(DEFAULT_ADMIN, deployer.address);
    console.log("Deployer has DEFAULT_ADMIN_ROLE:", hasAdmin);
    const timelockHasAdmin = await borrow.hasRole(DEFAULT_ADMIN, ADDR.timelock);
    console.log("Timelock has DEFAULT_ADMIN_ROLE:", timelockHasAdmin);
  } else if (roleAdmin === TIMELOCK_ROLE) {
    console.log("Admin: TIMELOCK_ROLE");
    const hasTimelock = await borrow.hasRole(TIMELOCK_ROLE, deployer.address);
    console.log("Deployer has TIMELOCK_ROLE:", hasTimelock);
    const timelockHasTimelock = await borrow.hasRole(TIMELOCK_ROLE, ADDR.timelock);
    console.log("Timelock has TIMELOCK_ROLE:", timelockHasTimelock);
  } else {
    console.log("Admin is some other role:", roleAdmin);
  }

  // Check if deployer can directly grant
  console.log("\nAttempting to grant LIQUIDATION_ROLE to LiquidationEngine...");
  try {
    const tx = await borrow.grantRole(LIQ_ROLE, ADDR.liquidation);
    await tx.wait();
    console.log("✅ LIQUIDATION_ROLE granted successfully! tx:", tx.hash);
  } catch(e: any) {
    console.log("❌ Direct grant failed:", e.message?.slice(0, 200));
    console.log("\nWill need to go through timelock...");
  }

  // Verify
  const hasNow = await borrow.hasRole(LIQ_ROLE, ADDR.liquidation);
  console.log("\nBorrowModule — LiqEngine has LIQUIDATION_ROLE:", hasNow);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
