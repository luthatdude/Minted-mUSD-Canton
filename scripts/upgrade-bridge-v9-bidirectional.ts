import { ethers, upgrades } from "hardhat";

/**
 * Two-phase UUPS upgrade of BLEBridgeV9 via MintedTimelockController.
 *
 * Phase 1 (SCHEDULE):
 *   npx hardhat run scripts/upgrade-bridge-v9-bidirectional.ts --network sepolia
 *   → Deploys new implementation, schedules upgradeToAndCall via timelock.
 *
 * Phase 2 (EXECUTE — after 24 h delay):
 *   PHASE=execute npx hardhat run scripts/upgrade-bridge-v9-bidirectional.ts --network sepolia
 *   → Executes the scheduled upgrade, verifies state, sets bridgeOutMinAmount.
 *
 * Storage-compatible upgrade:
 *   - Two new storage vars appended: bridgeOutNonce, bridgeOutMinAmount
 *   - __gap reduced 35 → 33 (total slots unchanged)
 */

const BRIDGE_PROXY = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
const TIMELOCK     = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const SALT         = ethers.id("upgrade-bridge-v9-bidirectional-2026-02-16");

async function main() {
  const phase = (process.env.PHASE || "schedule").toLowerCase();
  const [deployer] = await ethers.getSigners();
  console.log("Account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const timelock = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
  const minDelay = await timelock.getMinDelay();
  console.log("Timelock delay:", Number(minDelay), "seconds");

  if (phase === "schedule") {
    await scheduleUpgrade(deployer, timelock, minDelay);
  } else if (phase === "execute") {
    await executeUpgrade(deployer, timelock);
  } else {
    throw new Error(`Unknown PHASE="${phase}". Use "schedule" or "execute".`);
  }
}

async function scheduleUpgrade(
  deployer: any,
  timelock: any,
  minDelay: bigint
) {
  console.log("\n═══ PHASE 1: SCHEDULE ═══\n");

  // Pre-flight: verify deployer has PROPOSER_ROLE on timelock
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  if (!(await timelock.hasRole(PROPOSER_ROLE, deployer.address))) {
    throw new Error("Deployer lacks PROPOSER_ROLE on timelock");
  }
  console.log("✅ Deployer has PROPOSER_ROLE");

  // Deploy new implementation (OZ validates storage layout)
  console.log("\n🔄 Deploying new BLEBridgeV9 implementation...");
  const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
  const newImplAddress = await upgrades.prepareUpgrade(BRIDGE_PROXY, BridgeFactory, {
    kind: "uups",
  }) as string;
  console.log("✅ New implementation deployed:", newImplAddress);

  // Encode upgradeToAndCall(newImpl, "")
  const proxyIface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes memory data)",
  ]);
  const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
    newImplAddress,
    "0x", // no initializer call needed
  ]);

  // Schedule via timelock
  console.log("\n📋 Scheduling upgrade via timelock...");
  const predecessor = ethers.ZeroHash;
  const tx = await timelock.schedule(
    BRIDGE_PROXY,   // target
    0n,             // value
    upgradeData,    // data
    predecessor,    // predecessor
    SALT,           // salt
    minDelay        // delay
  );
  const receipt = await tx.wait();
  console.log("✅ Scheduled in tx:", receipt!.hash);

  // Compute operation ID for verification
  const operationId = await timelock.hashOperation(
    BRIDGE_PROXY, 0n, upgradeData, predecessor, SALT
  );
  const readyTimestamp = await timelock.getTimestamp(operationId);
  const readyDate = new Date(Number(readyTimestamp) * 1000);

  console.log("\n========== SCHEDULED ==========");
  console.log("Operation ID:", operationId);
  console.log("New implementation:", newImplAddress);
  console.log("Executable after:", readyDate.toISOString());
  console.log("\nTo execute after delay:");
  console.log("  PHASE=execute npx hardhat run scripts/upgrade-bridge-v9-bidirectional.ts --network sepolia");
  console.log("================================");
}

async function executeUpgrade(deployer: any, timelock: any) {
  console.log("\n═══ PHASE 2: EXECUTE ═══\n");

  // Verify deployer has EXECUTOR_ROLE
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  if (!(await timelock.hasRole(EXECUTOR_ROLE, deployer.address))) {
    throw new Error("Deployer lacks EXECUTOR_ROLE on timelock");
  }
  console.log("✅ Deployer has EXECUTOR_ROLE");

  // Read pre-upgrade state
  const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE_PROXY);
  const nonceBefore = await bridge.currentNonce();
  const minSigsBefore = await bridge.minSignatures();
  const musdBefore = await bridge.musdToken();
  console.log("\nPre-upgrade state:");
  console.log("  currentNonce:", nonceBefore.toString());
  console.log("  minSignatures:", minSigsBefore.toString());
  console.log("  musdToken:", musdBefore);

  // We need to reconstruct the call data to find the operation
  // Get the latest BLEBridgeV9 impl from the OZ manifest
  const implAddress = await upgrades.erc1967.getImplementationAddress(BRIDGE_PROXY);
  console.log("\nCurrent implementation:", implAddress);

  // Find the scheduled new implementation by looking at OZ manifest
  // The new impl was deployed by prepareUpgrade — read from .openzeppelin
  const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
  const newImplAddress = await upgrades.prepareUpgrade(BRIDGE_PROXY, BridgeFactory, {
    kind: "uups",
  }) as string;
  console.log("New implementation:", newImplAddress);

  const proxyIface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes memory data)",
  ]);
  const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
    newImplAddress,
    "0x",
  ]);

  const predecessor = ethers.ZeroHash;

  // Check if operation is ready
  const operationId = await timelock.hashOperation(
    BRIDGE_PROXY, 0n, upgradeData, predecessor, SALT
  );
  const isReady = await timelock.isOperationReady(operationId);
  const isPending = await timelock.isOperationPending(operationId);
  console.log("\nOperation ID:", operationId);
  console.log("  isPending:", isPending);
  console.log("  isReady:", isReady);

  if (!isReady) {
    const readyTimestamp = await timelock.getTimestamp(operationId);
    if (readyTimestamp === 0n) {
      throw new Error("Operation not found — was it scheduled?");
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const remaining = Number(readyTimestamp - now);
    throw new Error(`Operation not ready yet. ${remaining} seconds remaining (${(remaining / 3600).toFixed(1)} hours)`);
  }

  // Execute
  console.log("\n🔄 Executing upgrade...");
  const tx = await timelock.execute(
    BRIDGE_PROXY,
    0n,
    upgradeData,
    predecessor,
    SALT
  );
  const receipt = await tx.wait();
  console.log("✅ Upgrade executed in tx:", receipt!.hash);

  // Post-upgrade verification
  const nonceAfter = await bridge.currentNonce();
  const minSigsAfter = await bridge.minSignatures();
  const musdAfter = await bridge.musdToken();
  console.log("\nPost-upgrade state:");
  console.log("  currentNonce:", nonceAfter.toString());
  console.log("  minSignatures:", minSigsAfter.toString());
  console.log("  musdToken:", musdAfter);

  if (nonceBefore !== nonceAfter) throw new Error("currentNonce changed!");
  if (minSigsBefore !== minSigsAfter) throw new Error("minSignatures changed!");
  if (musdBefore !== musdAfter) throw new Error("musdToken changed!");
  console.log("✅ All pre-upgrade state preserved");

  // Verify new functions
  const bridgeOutNonce = await bridge.bridgeOutNonce();
  const bridgeOutMin = await bridge.bridgeOutMinAmount();
  console.log("\nNew state variables:");
  console.log("  bridgeOutNonce:", bridgeOutNonce.toString());
  console.log("  bridgeOutMinAmount:", bridgeOutMin.toString());
  console.log("✅ New functions accessible");

  // Set bridge-out minimum (100 mUSD)
  const MIN_BRIDGE_OUT = ethers.parseEther("100");
  console.log("\n⚙️  Setting bridgeOutMinAmount to", ethers.formatEther(MIN_BRIDGE_OUT), "mUSD...");
  const setTx = await bridge.setBridgeOutMinAmount(MIN_BRIDGE_OUT);
  await setTx.wait();
  console.log("✅ bridgeOutMinAmount set");

  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== UPGRADE COMPLETE ==========");
  console.log("Proxy:", BRIDGE_PROXY);
  console.log("New impl:", newImplAddress);
  console.log("Remaining balance:", remaining, "ETH");
  console.log("=======================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
