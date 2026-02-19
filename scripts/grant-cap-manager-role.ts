/**
 * Grant CAP_MANAGER_ROLE to BLEBridgeV9 on MUSD (Sepolia)
 *
 * BLEBridgeV9 needs CAP_MANAGER_ROLE on MUSD to update the supply cap
 * after processing attestations. Without this role, processAttestation()
 * reverts with Unauthorized() when calling MUSD.setSupplyCap().
 *
 * Usage:
 *   npx hardhat run scripts/grant-cap-manager-role.ts --network sepolia
 */
import { ethers } from "hardhat";

async function main() {
  const MUSD_ADDRESS = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const BRIDGE_ADDRESS = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";

  const CAP_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CAP_MANAGER_ROLE"));

  const musd = await ethers.getContractAt(
    [
      "function hasRole(bytes32 role, address account) view returns (bool)",
      "function grantRole(bytes32 role, address account) external",
      "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    ],
    MUSD_ADDRESS
  );

  // Check if already granted
  const alreadyHasRole = await musd.hasRole(CAP_MANAGER_ROLE, BRIDGE_ADDRESS);
  if (alreadyHasRole) {
    console.log(`✅ BLEBridgeV9 (${BRIDGE_ADDRESS}) already has CAP_MANAGER_ROLE on MUSD`);
    return;
  }

  console.log(`Granting CAP_MANAGER_ROLE to BLEBridgeV9...`);
  console.log(`  MUSD:        ${MUSD_ADDRESS}`);
  console.log(`  BLEBridgeV9: ${BRIDGE_ADDRESS}`);
  console.log(`  Role:        ${CAP_MANAGER_ROLE}`);

  const tx = await musd.grantRole(CAP_MANAGER_ROLE, BRIDGE_ADDRESS);
  console.log(`  TX submitted: ${tx.hash}`);

  const receipt = await tx.wait(2);
  console.log(`  TX confirmed in block ${receipt!.blockNumber}`);

  // Verify
  const hasRole = await musd.hasRole(CAP_MANAGER_ROLE, BRIDGE_ADDRESS);
  if (hasRole) {
    console.log(`✅ CAP_MANAGER_ROLE granted successfully to BLEBridgeV9 on MUSD`);
  } else {
    console.error(`❌ Role grant FAILED — caller may not hold DEFAULT_ADMIN_ROLE on MUSD`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
