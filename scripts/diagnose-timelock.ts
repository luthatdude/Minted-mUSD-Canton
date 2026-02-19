import { ethers, upgrades } from "hardhat";

const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const BRIDGE_PROXY = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
const RELAY_EOA = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
const SALT = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const timelock = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE_PROXY);

  // 1. Check roles
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const EXECUTOR = await timelock.EXECUTOR_ROLE();
  const CANCELLER = await timelock.CANCELLER_ROLE();
  const ADMIN = await bridge.DEFAULT_ADMIN_ROLE();

  console.log("\n=== Timelock Roles ===");
  console.log("Deployer PROPOSER:", await timelock.hasRole(PROPOSER, deployer.address));
  console.log("Deployer EXECUTOR:", await timelock.hasRole(EXECUTOR, deployer.address));
  console.log("Deployer CANCELLER:", await timelock.hasRole(CANCELLER, deployer.address));
  console.log("Timelock is bridge admin:", await bridge.hasRole(ADMIN, TIMELOCK));
  console.log("Deployer is bridge admin:", await bridge.hasRole(ADMIN, deployer.address));

  // 2. Check TIMELOCK_ROLE on bridge (for UUPS upgrade auth)
  try {
    const TIMELOCK_ROLE = await bridge.TIMELOCK_ROLE();
    console.log("\nBridge TIMELOCK_ROLE:", TIMELOCK_ROLE);
    console.log("Timelock has TIMELOCK_ROLE:", await bridge.hasRole(TIMELOCK_ROLE, TIMELOCK));
  } catch (e: any) {
    console.log("\nNo TIMELOCK_ROLE on bridge:", e.message?.substring(0, 80));
  }

  // 3. Check existing operation status
  const newImpl = "0x4FAF60221C6DA369d7B3cF8CdC9Cc43b894B8f0c";
  const proxyIface = new ethers.Interface(["function upgradeToAndCall(address,bytes)"]);
  const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]);

  // Get RELAYER_ROLE from the new impl
  const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
  const newImplContract = BridgeFactory.attach(newImpl) as any;
  const RELAYER_ROLE = await newImplContract.RELAYER_ROLE();
  console.log("\nRELAYER_ROLE:", RELAYER_ROLE);

  const roleIface = new ethers.Interface(["function grantRole(bytes32,address)"]);
  const grantRoleData = roleIface.encodeFunctionData("grantRole", [RELAYER_ROLE, RELAY_EOA]);

  const targets = [BRIDGE_PROXY, BRIDGE_PROXY];
  const values = [0n, 0n];
  const payloads = [upgradeData, grantRoleData];

  const opId = await timelock.hashOperationBatch(targets, values, payloads, ethers.ZeroHash, SALT);
  console.log("\n=== Operation Status ===");
  console.log("Operation ID:", opId);

  const ts = await timelock.getTimestamp(opId);
  console.log("Timestamp:", ts.toString());

  if (ts > 0n) {
    const isPending = await timelock.isOperationPending(opId);
    const isReady = await timelock.isOperationReady(opId);
    const isDone = await timelock.isOperationDone(opId);
    console.log("isPending:", isPending);
    console.log("isReady:", isReady);
    console.log("isDone:", isDone);
    if (isPending && !isReady) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const remaining = Number(ts - now);
      console.log(`Ready in: ${remaining}s (${(remaining / 3600).toFixed(1)}h)`);
    }
  } else {
    console.log("Operation NOT scheduled yet");
    
    // Try to understand why scheduleBatch reverts
    console.log("\n=== Diagnosing revert ===");
    
    // Static call to scheduleBatch to get revert reason
    try {
      const minDelay = await timelock.getMinDelay();
      await timelock.scheduleBatch.staticCall(
        targets, values, payloads, ethers.ZeroHash, SALT, minDelay
      );
      console.log("Static call succeeded — scheduleBatch should work");
    } catch (e: any) {
      console.log("Static call revert reason:", e.message?.substring(0, 200));
      // Try to decode the error
      if (e.data) {
        console.log("Error data:", e.data);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
