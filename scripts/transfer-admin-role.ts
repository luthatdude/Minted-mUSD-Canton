// Transfer DEFAULT_ADMIN_ROLE to TimelockController and clean up compromised deployer
// Usage: npx hardhat run scripts/transfer-admin-role.ts --network sepolia
//
// IMPORTANT: DEPLOYER_PRIVATE_KEY in .env must temporarily be the OLD deployer key
// (the one that currently holds DEFAULT_ADMIN_ROLE).

import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);

  const BRIDGE = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const NEW_RELAYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
  const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";

  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);

  const ADMIN_ROLE = await bridge.DEFAULT_ADMIN_ROLE();
  const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();

  // ── Pre-flight checks ──
  const signerIsAdmin = await bridge.hasRole(ADMIN_ROLE, signer.address);
  const timelockIsAdmin = await bridge.hasRole(ADMIN_ROLE, TIMELOCK);
  const oldHasEmergency = await bridge.hasRole(EMERGENCY_ROLE, OLD_DEPLOYER);
  const newHasEmergency = await bridge.hasRole(EMERGENCY_ROLE, NEW_RELAYER);

  console.log("\n=== Pre-flight ===");
  console.log("Signer is DEFAULT_ADMIN:", signerIsAdmin);
  console.log("Timelock already has DEFAULT_ADMIN:", timelockIsAdmin);
  console.log("Old deployer has EMERGENCY_ROLE:", oldHasEmergency);
  console.log("New relayer has EMERGENCY_ROLE:", newHasEmergency);

  if (!signerIsAdmin) {
    console.error("\nERROR: Signer does not hold DEFAULT_ADMIN_ROLE. Cannot proceed.");
    console.error("Make sure DEPLOYER_PRIVATE_KEY in .env is the OLD deployer key.");
    process.exit(1);
  }

  // ── Step 1: Grant DEFAULT_ADMIN_ROLE to TimelockController ──
  if (!timelockIsAdmin) {
    console.log("\n[1/4] Granting DEFAULT_ADMIN_ROLE to TimelockController...");
    const tx1 = await bridge.grantRole(ADMIN_ROLE, TIMELOCK);
    console.log("  tx:", tx1.hash);
    await tx1.wait(2);
    console.log("  ✓ DEFAULT_ADMIN_ROLE granted to", TIMELOCK);
  } else {
    console.log("\n[1/4] Timelock already has DEFAULT_ADMIN_ROLE — skipping.");
  }

  // ── Step 2: Grant EMERGENCY_ROLE to new relayer ──
  if (!newHasEmergency) {
    console.log("\n[2/4] Granting EMERGENCY_ROLE to new relayer...");
    const tx2 = await bridge.grantRole(EMERGENCY_ROLE, NEW_RELAYER);
    console.log("  tx:", tx2.hash);
    await tx2.wait(2);
    console.log("  ✓ EMERGENCY_ROLE granted to", NEW_RELAYER);
  } else {
    console.log("\n[2/4] New relayer already has EMERGENCY_ROLE — skipping.");
  }

  // ── Step 3: Revoke EMERGENCY_ROLE from old deployer ──
  if (oldHasEmergency) {
    console.log("\n[3/4] Revoking EMERGENCY_ROLE from old (compromised) deployer...");
    const tx3 = await bridge.revokeRole(EMERGENCY_ROLE, OLD_DEPLOYER);
    console.log("  tx:", tx3.hash);
    await tx3.wait(2);
    console.log("  ✓ EMERGENCY_ROLE revoked from", OLD_DEPLOYER);
  } else {
    console.log("\n[3/4] Old deployer doesn't have EMERGENCY_ROLE — skipping.");
  }

  // ── Step 4: Renounce DEFAULT_ADMIN_ROLE from old deployer ──
  // renounceRole requires the caller to renounce their own role
  console.log("\n[4/4] Renouncing DEFAULT_ADMIN_ROLE from old deployer...");
  const tx4 = await bridge.renounceRole(ADMIN_ROLE, signer.address);
  console.log("  tx:", tx4.hash);
  await tx4.wait(2);
  console.log("  ✓ DEFAULT_ADMIN_ROLE renounced by", signer.address);

  // ── Final verification ──
  const finalTimelockAdmin = await bridge.hasRole(ADMIN_ROLE, TIMELOCK);
  const finalOldAdmin = await bridge.hasRole(ADMIN_ROLE, OLD_DEPLOYER);
  const finalOldEmergency = await bridge.hasRole(EMERGENCY_ROLE, OLD_DEPLOYER);
  const finalNewEmergency = await bridge.hasRole(EMERGENCY_ROLE, NEW_RELAYER);

  console.log("\n=== Final State ===");
  console.log("TimelockController has DEFAULT_ADMIN_ROLE:", finalTimelockAdmin);
  console.log("Old deployer has DEFAULT_ADMIN_ROLE:", finalOldAdmin);
  console.log("Old deployer has EMERGENCY_ROLE:", finalOldEmergency);
  console.log("New relayer has EMERGENCY_ROLE:", finalNewEmergency);

  if (finalTimelockAdmin && !finalOldAdmin && !finalOldEmergency) {
    console.log("\n✅ Admin transfer complete. Compromised address fully deprivileged.");
    console.log("   All future admin actions require the 48h TimelockController.");
  } else {
    console.error("\n⚠️  Unexpected final state — verify manually!");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
