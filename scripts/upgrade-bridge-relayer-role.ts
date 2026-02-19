import { ethers, upgrades } from "hardhat";

/**
 * Two-phase UUPS upgrade of BLEBridgeV9 via MintedTimelockController.
 * This upgrade adds RELAYER_ROLE access control to processAttestation (BRIDGE-M-04).
 *
 * Uses scheduleBatch/executeBatch to atomically:
 *   1. upgradeToAndCall(newImpl, "0x")   — UUPS upgrade
 *   2. grantRole(RELAYER_ROLE, relayEOA) — grant role via timelock (bridge admin)
 *
 * The grantRole MUST go through the timelock because the timelock holds
 * DEFAULT_ADMIN_ROLE on the bridge — the deployer does not.
 *
 * Phase 1 (SCHEDULE):
 *   npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia
 *   → Deploys new implementation with RELAYER_ROLE, schedules batch via timelock.
 *
 * Phase 2 (EXECUTE — after 24 h delay):
 *   PHASE=execute npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia
 *   → Executes the scheduled batch: upgrades proxy + grants RELAYER_ROLE to relay EOA.
 *
 * Storage-compatible: RELAYER_ROLE is a `bytes32 public constant` (compiled into bytecode,
 * no storage slot consumed). __gap unchanged at [33].
 */

const BRIDGE_PROXY = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
const TIMELOCK     = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const RELAY_EOA    = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
const SALT         = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

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
  console.log("\n═══ PHASE 1: SCHEDULE BATCH (BRIDGE-M-04 RELAYER_ROLE) ═══\n");

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

  // Verify RELAYER_ROLE constant exists on new impl
  const newImpl = BridgeFactory.attach(newImplAddress) as any;
  const RELAYER_ROLE = await newImpl.RELAYER_ROLE();
  console.log("✅ RELAYER_ROLE constant:", RELAYER_ROLE);

  // --- Build batch: two calls through the timelock ---

  // Call 1: upgradeToAndCall(newImpl, "0x") on the bridge proxy
  const proxyIface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes memory data)",
  ]);
  const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
    newImplAddress,
    "0x", // no reinitializer needed — RELAYER_ROLE is a constant
  ]);

  // Call 2: grantRole(RELAYER_ROLE, RELAY_EOA) on the bridge proxy
  // Timelock holds DEFAULT_ADMIN_ROLE on bridge, so this must go through timelock
  const roleIface = new ethers.Interface([
    "function grantRole(bytes32 role, address account)",
  ]);
  const grantRoleData = roleIface.encodeFunctionData("grantRole", [
    RELAYER_ROLE,
    RELAY_EOA,
  ]);

  const targets = [BRIDGE_PROXY, BRIDGE_PROXY];
  const values  = [0n, 0n];
  const payloads = [upgradeData, grantRoleData];
  const predecessor = ethers.ZeroHash;

  console.log("\n📋 Batch operations:");
  console.log("  [0] upgradeToAndCall →", newImplAddress);
  console.log("  [1] grantRole(RELAYER_ROLE) →", RELAY_EOA);

  // Schedule batch via timelock
  console.log("\n📋 Scheduling batch via timelock...");
  const tx = await timelock.scheduleBatch(
    targets,
    values,
    payloads,
    predecessor,
    SALT,
    minDelay
  );
  const receipt = await tx.wait();
  console.log("✅ Batch scheduled in tx:", receipt!.hash);

  // Compute operation ID for verification
  const operationId = await timelock.hashOperationBatch(
    targets, values, payloads, predecessor, SALT
  );
  const readyTimestamp = await timelock.getTimestamp(operationId);
  const readyDate = new Date(Number(readyTimestamp) * 1000);

  console.log("\n========== BATCH SCHEDULED ==========");
  console.log("Operation ID:", operationId);
  console.log("New implementation:", newImplAddress);
  console.log("RELAYER_ROLE grant to:", RELAY_EOA);
  console.log("Executable after:", readyDate.toISOString());
  console.log("\nTo execute after delay:");
  console.log("  PHASE=execute npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia");
  console.log("======================================");
}

async function executeUpgrade(deployer: any, timelock: any) {
  console.log("\n═══ PHASE 2: EXECUTE BATCH (BRIDGE-M-04 RELAYER_ROLE) ═══\n");

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

  // Prepare the upgrade data (must match what was scheduled)
  const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
  const newImplAddress = await upgrades.prepareUpgrade(BRIDGE_PROXY, BridgeFactory, {
    kind: "uups",
  }) as string;
  console.log("New implementation:", newImplAddress);

  // Reconstruct batch calldata (must exactly match schedule)
  const proxyIface = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes memory data)",
  ]);
  const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
    newImplAddress,
    "0x",
  ]);

  const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
  const roleIface = new ethers.Interface([
    "function grantRole(bytes32 role, address account)",
  ]);
  const grantRoleData = roleIface.encodeFunctionData("grantRole", [
    RELAYER_ROLE,
    RELAY_EOA,
  ]);

  const targets = [BRIDGE_PROXY, BRIDGE_PROXY];
  const values  = [0n, 0n];
  const payloads = [upgradeData, grantRoleData];
  const predecessor = ethers.ZeroHash;

  // Check if operation is ready
  const operationId = await timelock.hashOperationBatch(
    targets, values, payloads, predecessor, SALT
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

  // Execute batch
  console.log("\n🔄 Executing batch (upgrade + grantRole)...");
  const tx = await timelock.executeBatch(
    targets,
    values,
    payloads,
    predecessor,
    SALT
  );
  const receipt = await tx.wait();
  console.log("✅ Batch executed in tx:", receipt!.hash);

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

  // Verify RELAYER_ROLE was granted via the batch
  const relayHasRole = await bridge.hasRole(RELAYER_ROLE, RELAY_EOA);
  if (!relayHasRole) throw new Error("Failed to grant RELAYER_ROLE to relay EOA!");
  console.log("\n✅ RELAYER_ROLE:", RELAYER_ROLE);
  console.log("✅ Relay EOA has RELAYER_ROLE:", relayHasRole);

  // Also check deployer
  const deployerHasRole = await bridge.hasRole(RELAYER_ROLE, deployer.address);
  console.log("  Deployer has RELAYER_ROLE:", deployerHasRole);

  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== BATCH UPGRADE COMPLETE (BRIDGE-M-04) ==========");
  console.log("Proxy:", BRIDGE_PROXY);
  console.log("New impl:", newImplAddress);
  console.log("RELAYER_ROLE granted to:", RELAY_EOA);
  console.log("Remaining balance:", remaining, "ETH");
  console.log("==========================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
