import { ethers } from "hardhat";

async function main() {
  const GPR = await ethers.getContractAt("GlobalPauseRegistry", "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F");
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const wallet = "0x33f97321214b5b8443f6212a05836c8ffe42dda5";

  console.log("Granting GUARDIAN_ROLE to", wallet, "...");
  const tx = await GPR.grantRole(GUARDIAN_ROLE, wallet);
  console.log("TX hash:", tx.hash);
  await tx.wait();
  console.log("✅ Confirmed! Verifying...");
  console.log("  GUARDIAN_ROLE:", await GPR.hasRole(GUARDIAN_ROLE, wallet));
}

main().catch(console.error);
