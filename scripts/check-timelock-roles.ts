import { ethers } from "hardhat";

async function main() {
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const BRIDGE_PROXY = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
  const RELAY_EOA = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const timelock = await ethers.getContractAt("MintedTimelockController", TIMELOCK);

  const PROPOSER = await timelock.PROPOSER_ROLE();
  const EXECUTOR = await timelock.EXECUTOR_ROLE();
  const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();

  console.log("\nTimelock roles for deployer:");
  console.log("  PROPOSER_ROLE:", await timelock.hasRole(PROPOSER, deployer.address));
  console.log("  EXECUTOR_ROLE:", await timelock.hasRole(EXECUTOR, deployer.address));
  console.log("  DEFAULT_ADMIN_ROLE:", await timelock.hasRole(ADMIN, deployer.address));
  console.log("  Min delay:", Number(await timelock.getMinDelay()), "seconds");

  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE_PROXY);
  try {
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();
    console.log("\nBridge RELAYER_ROLE constant:", RELAYER_ROLE);
    console.log("  Relay EOA has RELAYER_ROLE:", await bridge.hasRole(RELAYER_ROLE, RELAY_EOA));
    console.log("  >> RELAYER_ROLE already in contract bytecode");
  } catch (e: any) {
    console.log("\nBridge does NOT have RELAYER_ROLE yet - upgrade needed");
    console.log("  Error:", e.message?.substring(0, 100));
  }

  const bridgeAdmin = await bridge.hasRole(await bridge.DEFAULT_ADMIN_ROLE(), deployer.address);
  console.log("  Deployer is bridge admin:", bridgeAdmin);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
