import { ethers } from "hardhat";

async function main() {
  const MUSD = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const wallet = "0x33f97321214b5b8443f6212a05836c8ffe42dda5";

  console.log("Granting DEFAULT_ADMIN_ROLE to", wallet, "...");
  const tx = await MUSD.grantRole(DEFAULT_ADMIN, wallet);
  console.log("TX hash:", tx.hash);
  await tx.wait();
  console.log("✅ Confirmed! Verifying...");

  const hasAdmin = await MUSD.hasRole(DEFAULT_ADMIN, wallet);
  console.log("  DEFAULT_ADMIN_ROLE:", hasAdmin);
}

main().catch(console.error);
