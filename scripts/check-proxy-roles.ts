import { ethers } from "hardhat";

/**
 * Check proxy ownership and timelock configuration for UUPS upgrade planning.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const timelockAddr = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";

  // --- Timelock ---
  const timelock = await ethers.getContractAt("MintedTimelockController", timelockAddr);
  const delay = await timelock.getMinDelay();
  console.log("\nTimelock minDelay:", delay.toString(), "seconds (", Number(delay) / 3600, "hours)");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  console.log("Deployer is PROPOSER:", await timelock.hasRole(PROPOSER_ROLE, deployer.address));
  console.log("Deployer is EXECUTOR:", await timelock.hasRole(EXECUTOR_ROLE, deployer.address));
  console.log("Deployer has ADMIN:", await timelock.hasRole(DEFAULT_ADMIN, deployer.address));

  // --- TreasuryV2 ---
  const treasury = await ethers.getContractAt("TreasuryV2", "0xf2051bDfc738f638668DF2f8c00d01ba6338C513");
  console.log("\nTreasuryV2 proxy:");
  console.log("  deployer has DEFAULT_ADMIN:", await treasury.hasRole(DEFAULT_ADMIN, deployer.address));
  console.log("  timelock has DEFAULT_ADMIN:", await treasury.hasRole(DEFAULT_ADMIN, timelockAddr));
  // Check UPGRADER_ROLE if it exists
  try {
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
    console.log("  deployer has UPGRADER_ROLE:", await treasury.hasRole(UPGRADER_ROLE, deployer.address));
    console.log("  timelock has UPGRADER_ROLE:", await treasury.hasRole(UPGRADER_ROLE, timelockAddr));
  } catch { console.log("  (no UPGRADER_ROLE check)"); }

  // --- BLEBridgeV9 ---
  const bridge = await ethers.getContractAt("BLEBridgeV9", "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125");
  console.log("\nBLEBridgeV9 proxy:");
  console.log("  deployer has DEFAULT_ADMIN:", await bridge.hasRole(DEFAULT_ADMIN, deployer.address));
  console.log("  timelock has DEFAULT_ADMIN:", await bridge.hasRole(DEFAULT_ADMIN, timelockAddr));
  try {
    const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
    console.log("  deployer has UPGRADER_ROLE:", await bridge.hasRole(UPGRADER_ROLE, deployer.address));
    console.log("  timelock has UPGRADER_ROLE:", await bridge.hasRole(UPGRADER_ROLE, timelockAddr));
  } catch { console.log("  (no UPGRADER_ROLE check)"); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
