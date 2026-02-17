import { ethers } from "hardhat";

async function main() {
  const BRIDGE_PROXY = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";

  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE_PROXY);
  const ADMIN_ROLE = await bridge.DEFAULT_ADMIN_ROLE();

  // Check known addresses
  const addresses = [
    ["Deployer (0xe640)", "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0"],
    ["Old deployer (0x7De3)", "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36"],
    ["Timelock", TIMELOCK],
  ];

  console.log("BLEBridgeV9 DEFAULT_ADMIN_ROLE check:");
  for (const [name, addr] of addresses) {
    const has = await bridge.hasRole(ADMIN_ROLE, addr);
    console.log("  " + name + ": " + has);
  }

  // Also check TIMELOCK_ROLE
  try {
    const TIMELOCK_ROLE = await bridge.TIMELOCK_ROLE();
    console.log("\nTIMELOCK_ROLE check:");
    for (const [name, addr] of addresses) {
      const has = await bridge.hasRole(TIMELOCK_ROLE, addr);
      console.log("  " + name + ": " + has);
    }
  } catch (e) {
    console.log("\nBridge has no TIMELOCK_ROLE");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
