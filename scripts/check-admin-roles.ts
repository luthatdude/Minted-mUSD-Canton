import { ethers } from "hardhat";

async function main() {
  const MUSD = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const TIMELOCK_ROLE = "0xf66846415d2bf9eabda9e84793ff9c0ea96d87f50fc41e66aa16469c6a442f05";
  const wallet = "0x33f97321214b5b8443f6212a05836c8ffe42dda5";
  const timelockAddr = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const [signer] = await ethers.getSigners();

  console.log("=== MUSD Role Check ===");
  console.log("Your wallet:", wallet);
  console.log("  DEFAULT_ADMIN_ROLE:", await MUSD.hasRole(DEFAULT_ADMIN, wallet));
  console.log("  TIMELOCK_ROLE:", await MUSD.hasRole(TIMELOCK_ROLE, wallet));
  console.log("Deployer:", signer.address);
  console.log("  DEFAULT_ADMIN_ROLE:", await MUSD.hasRole(DEFAULT_ADMIN, signer.address));
  console.log("  TIMELOCK_ROLE:", await MUSD.hasRole(TIMELOCK_ROLE, signer.address));
  console.log("Timelock:", timelockAddr);
  console.log("  DEFAULT_ADMIN_ROLE:", await MUSD.hasRole(DEFAULT_ADMIN, timelockAddr));
  console.log("  TIMELOCK_ROLE:", await MUSD.hasRole(TIMELOCK_ROLE, timelockAddr));
}

main().catch(console.error);
