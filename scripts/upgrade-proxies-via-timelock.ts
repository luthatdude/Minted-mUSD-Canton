/**
 * Upgrade TreasuryV2 and BLEBridgeV9 UUPS proxies via MintedTimelockController.
 *
 * Flow:
 *   1. Deploy new implementation contracts (with audit fixes)
 *   2. Schedule upgradeToAndCall() on each proxy via timelock.schedule()
 *   3. Wait 24h (86400s) — the timelock's minDelay
 *   4. Execute via timelock.execute()
 *
 * Usage:
 *   STEP=schedule  npx hardhat run scripts/upgrade-proxies-via-timelock.ts --network sepolia
 *   STEP=execute   npx hardhat run scripts/upgrade-proxies-via-timelock.ts --network sepolia
 *   STEP=status    npx hardhat run scripts/upgrade-proxies-via-timelock.ts --network sepolia
 */

import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ── Addresses ──────────────────────────────────────────────────────────
const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const TREASURY_PROXY = "0x11Cc7750F2033d21FC3762b94D1355eD15F7913d";
const BRIDGE_PROXY = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";

// Pre-deployed implementations (set these if resuming after partial deploy)
// Leave empty to deploy fresh.
const TREASURY_IMPL_OVERRIDE = process.env.TREASURY_IMPL || "";
const BRIDGE_IMPL_OVERRIDE = process.env.BRIDGE_IMPL || "";

// ── ABIs (only the functions we need) ──────────────────────────────────
const TIMELOCK_ABI = [
  "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) external payable",
  "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
];

const UUPS_ABI = [
  "function upgradeToAndCall(address newImplementation, bytes memory data) external",
];

// ── State file to persist operation IDs between schedule and execute ──
const STATE_FILE = path.join(__dirname, ".upgrade-state.json");

interface UpgradeState {
  treasuryNewImpl: string;
  bridgeNewImpl: string;
  treasuryOpId: string;
  bridgeOpId: string;
  treasurySalt: string;
  bridgeSalt: string;
  scheduledAt: number;
  readyAt: number;
}

function saveState(state: UpgradeState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\nState saved to ${STATE_FILE}`);
}

function loadState(): UpgradeState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No state file found at ${STATE_FILE}. Run with STEP=schedule first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

// ── Schedule Step ──────────────────────────────────────────────────────
async function scheduleUpgrades() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const timelock = new ethers.Contract(TIMELOCK, TIMELOCK_ABI, deployer);
  const minDelay = await timelock.getMinDelay();
  console.log(`Timelock minDelay: ${minDelay}s (${Number(minDelay) / 3600}h)\n`);

  // 1. Deploy new implementations (or use overrides)
  console.log("=== Deploying New Implementation Contracts ===\n");

  let treasuryImplAddr: string;
  if (TREASURY_IMPL_OVERRIDE) {
    treasuryImplAddr = TREASURY_IMPL_OVERRIDE;
    console.log(`TreasuryV2 impl (pre-deployed): ${treasuryImplAddr}`);
  } else {
    const TreasuryV2Factory = await ethers.getContractFactory("TreasuryV2");
    const treasuryImpl = await TreasuryV2Factory.deploy();
    await treasuryImpl.waitForDeployment();
    treasuryImplAddr = await treasuryImpl.getAddress();
    console.log(`TreasuryV2 new impl:  ${treasuryImplAddr}`);
  }

  let bridgeImplAddr: string;
  if (BRIDGE_IMPL_OVERRIDE) {
    bridgeImplAddr = BRIDGE_IMPL_OVERRIDE;
    console.log(`BLEBridgeV9 impl (pre-deployed): ${bridgeImplAddr}`);
  } else {
    const BLEBridgeV9Factory = await ethers.getContractFactory("BLEBridgeV9");
    const bridgeImpl = await BLEBridgeV9Factory.deploy();
    await bridgeImpl.waitForDeployment();
    bridgeImplAddr = await bridgeImpl.getAddress();
    console.log(`BLEBridgeV9 new impl: ${bridgeImplAddr}`);
  }

  // 2. Encode upgradeToAndCall(newImpl, "") for each proxy
  const uupsIface = new ethers.Interface(UUPS_ABI);
  const treasuryCalldata = uupsIface.encodeFunctionData("upgradeToAndCall", [
    treasuryImplAddr,
    "0x", // no re-initialization needed
  ]);
  const bridgeCalldata = uupsIface.encodeFunctionData("upgradeToAndCall", [
    bridgeImplAddr,
    "0x",
  ]);

  // 3. Create unique salts
  const treasurySalt = ethers.id("upgrade-treasuryv2-audit-fix-" + Date.now());
  const bridgeSalt = ethers.id("upgrade-blebridgev9-audit-fix-" + Date.now());

  // 4. Compute operation IDs
  const treasuryOpId = await timelock.hashOperation(
    TREASURY_PROXY, 0, treasuryCalldata, ethers.ZeroHash, treasurySalt
  );
  const bridgeOpId = await timelock.hashOperation(
    BRIDGE_PROXY, 0, bridgeCalldata, ethers.ZeroHash, bridgeSalt
  );

  console.log(`\nTreasury operation ID:  ${treasuryOpId}`);
  console.log(`Bridge operation ID:   ${bridgeOpId}`);

  // 5. Schedule both operations
  console.log("\n=== Scheduling Upgrades ===\n");

  const tx1 = await timelock.schedule(
    TREASURY_PROXY, 0, treasuryCalldata, ethers.ZeroHash, treasurySalt, minDelay
  );
  console.log(`Treasury schedule tx: ${tx1.hash}`);
  await tx1.wait();
  console.log("  ✅ Confirmed");

  const tx2 = await timelock.schedule(
    BRIDGE_PROXY, 0, bridgeCalldata, ethers.ZeroHash, bridgeSalt, minDelay
  );
  console.log(`Bridge schedule tx:   ${tx2.hash}`);
  await tx2.wait();
  console.log("  ✅ Confirmed");

  const block = await ethers.provider.getBlock("latest");
  const scheduledAt = block!.timestamp;
  const readyAt = scheduledAt + Number(minDelay);
  const readyDate = new Date(readyAt * 1000).toISOString();

  console.log(`\n=== Scheduled Successfully ===`);
  console.log(`Scheduled at:  ${scheduledAt} (block ${block!.number})`);
  console.log(`Ready at:      ${readyAt} (${readyDate})`);
  console.log(`\nRun with STEP=execute after ${readyDate}`);

  // 6. Save state for the execute step
  saveState({
    treasuryNewImpl: treasuryImplAddr,
    bridgeNewImpl: bridgeImplAddr,
    treasuryOpId,
    bridgeOpId,
    treasurySalt,
    bridgeSalt,
    scheduledAt,
    readyAt,
  });
}

// ── Execute Step ───────────────────────────────────────────────────────
async function executeUpgrades() {
  const state = loadState();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const timelock = new ethers.Contract(TIMELOCK, TIMELOCK_ABI, deployer);

  // Check readiness
  const now = Math.floor(Date.now() / 1000);
  if (now < state.readyAt) {
    const remaining = state.readyAt - now;
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    console.log(`\n⏳ Not ready yet. ${hours}h ${mins}m remaining.`);
    console.log(`   Ready at: ${new Date(state.readyAt * 1000).toISOString()}`);
    return;
  }

  const treasuryReady = await timelock.isOperationReady(state.treasuryOpId);
  const bridgeReady = await timelock.isOperationReady(state.bridgeOpId);

  console.log(`Treasury operation ready: ${treasuryReady}`);
  console.log(`Bridge operation ready:   ${bridgeReady}`);

  if (!treasuryReady || !bridgeReady) {
    console.log("\n❌ One or more operations not ready on-chain.");
    return;
  }

  // Reconstruct calldata
  const uupsIface = new ethers.Interface(UUPS_ABI);
  const treasuryCalldata = uupsIface.encodeFunctionData("upgradeToAndCall", [
    state.treasuryNewImpl,
    "0x",
  ]);
  const bridgeCalldata = uupsIface.encodeFunctionData("upgradeToAndCall", [
    state.bridgeNewImpl,
    "0x",
  ]);

  // Execute Treasury upgrade
  console.log("\n=== Executing Upgrades ===\n");

  const tx1 = await timelock.execute(
    TREASURY_PROXY, 0, treasuryCalldata, ethers.ZeroHash, state.treasurySalt
  );
  console.log(`Treasury execute tx: ${tx1.hash}`);
  await tx1.wait();
  console.log("  ✅ TreasuryV2 upgraded");

  // Execute Bridge upgrade
  const tx2 = await timelock.execute(
    BRIDGE_PROXY, 0, bridgeCalldata, ethers.ZeroHash, state.bridgeSalt
  );
  console.log(`Bridge execute tx:   ${tx2.hash}`);
  await tx2.wait();
  console.log("  ✅ BLEBridgeV9 upgraded");

  console.log("\n=== Both Proxies Upgraded ===");
  console.log(`TreasuryV2 proxy ${TREASURY_PROXY} → impl ${state.treasuryNewImpl}`);
  console.log(`BLEBridgeV9 proxy ${BRIDGE_PROXY} → impl ${state.bridgeNewImpl}`);
  console.log(`\nNext: Verify new implementations on Etherscan`);
}

// ── Status Step ────────────────────────────────────────────────────────
async function checkStatus() {
  const state = loadState();
  const timelock = new ethers.Contract(TIMELOCK, TIMELOCK_ABI, ethers.provider);

  console.log("=== Upgrade Operation Status ===\n");
  console.log(`Treasury new impl: ${state.treasuryNewImpl}`);
  console.log(`Bridge new impl:   ${state.bridgeNewImpl}`);
  console.log(`Scheduled at:      ${new Date(state.scheduledAt * 1000).toISOString()}`);
  console.log(`Ready at:          ${new Date(state.readyAt * 1000).toISOString()}`);

  const now = Math.floor(Date.now() / 1000);
  if (now < state.readyAt) {
    const remaining = state.readyAt - now;
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    console.log(`Time remaining:    ${hours}h ${mins}m`);
  }

  const tPending = await timelock.isOperationPending(state.treasuryOpId);
  const tReady = await timelock.isOperationReady(state.treasuryOpId);
  const tDone = await timelock.isOperationDone(state.treasuryOpId);

  const bPending = await timelock.isOperationPending(state.bridgeOpId);
  const bReady = await timelock.isOperationReady(state.bridgeOpId);
  const bDone = await timelock.isOperationDone(state.bridgeOpId);

  console.log(`\nTreasury op ${state.treasuryOpId.slice(0, 10)}...:`);
  console.log(`  pending=${tPending}  ready=${tReady}  done=${tDone}`);

  console.log(`Bridge op ${state.bridgeOpId.slice(0, 10)}...:`);
  console.log(`  pending=${bPending}  ready=${bReady}  done=${bDone}`);

  if (tReady && bReady) {
    console.log("\n✅ Both operations are READY. Run with STEP=execute now.");
  } else if (tDone && bDone) {
    console.log("\n✅ Both operations are DONE. Upgrades complete.");
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const step = (process.env.STEP || "schedule").toLowerCase();

  switch (step) {
    case "schedule":
      await scheduleUpgrades();
      break;
    case "execute":
      await executeUpgrades();
      break;
    case "status":
      await checkStatus();
      break;
    default:
      console.log("Unknown STEP. Use STEP=schedule|execute|status");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
