// Check and grant VALIDATOR_ROLE on BLEBridgeV9 for the new relayer address
// Usage: npx hardhat run scripts/grant-validator-role.ts --network sepolia

import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);

  const BRIDGE = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
  const NEW_RELAYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
  const OLD_RELAYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";

  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);

  const ADMIN_ROLE = await bridge.DEFAULT_ADMIN_ROLE();
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();

  // Status check
  const signerIsAdmin = await bridge.hasRole(ADMIN_ROLE, signer.address);
  const oldIsValidator = await bridge.hasRole(VALIDATOR_ROLE, OLD_RELAYER);
  const newIsValidator = await bridge.hasRole(VALIDATOR_ROLE, NEW_RELAYER);

  console.log("\n=== Current State ===");
  console.log("Signer is admin:", signerIsAdmin);
  console.log("Old relayer (0x7De3) has VALIDATOR_ROLE:", oldIsValidator);
  console.log("New relayer (0xe640) has VALIDATOR_ROLE:", newIsValidator);

  if (!signerIsAdmin) {
    console.error("\nERROR: Signer does not have DEFAULT_ADMIN_ROLE. Cannot grant roles.");
    process.exit(1);
  }

  if (newIsValidator) {
    console.log("\n✓ New relayer already has VALIDATOR_ROLE. Nothing to do.");
    return;
  }

  // Grant VALIDATOR_ROLE to new relayer
  console.log("\n=== Granting VALIDATOR_ROLE to new relayer ===");
  const grantTx = await bridge.grantRole(VALIDATOR_ROLE, NEW_RELAYER);
  console.log("Grant tx:", grantTx.hash);
  await grantTx.wait(2);
  console.log("✓ VALIDATOR_ROLE granted to", NEW_RELAYER);

  // Optionally revoke from old relayer (compromised key)
  if (oldIsValidator) {
    console.log("\n=== Revoking VALIDATOR_ROLE from old (compromised) relayer ===");
    const revokeTx = await bridge.revokeRole(VALIDATOR_ROLE, OLD_RELAYER);
    console.log("Revoke tx:", revokeTx.hash);
    await revokeTx.wait(2);
    console.log("✓ VALIDATOR_ROLE revoked from", OLD_RELAYER);
  }

  // Final verification
  const finalCheck = await bridge.hasRole(VALIDATOR_ROLE, NEW_RELAYER);
  const oldCheck = await bridge.hasRole(VALIDATOR_ROLE, OLD_RELAYER);
  console.log("\n=== Final State ===");
  console.log("New relayer (0xe640) has VALIDATOR_ROLE:", finalCheck);
  console.log("Old relayer (0x7De3) has VALIDATOR_ROLE:", oldCheck);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
