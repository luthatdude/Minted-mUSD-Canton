/**
 * Execute Timelock Phase 2 + Phase 3: Bridge upgrade batch + Old deployer role revocations
 *
 * Run AFTER the timelock delay expires:
 *   - Phase 2 (bridge batch):      ready after 2026-02-18T07:52:36 UTC
 *   - Phase 3 (role revocations):  ready after 2026-02-18T18:10:12 UTC
 *
 * Safe to run repeatedly — skips already-executed or not-yet-ready ops.
 *
 * Usage: npx hardhat run scripts/execute-timelock-revocations.ts --network sepolia
 */

import { ethers } from "hardhat";

const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const NEW_DEPLOYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
const BRIDGE = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
const NEW_BRIDGE_IMPL = "0x4FAF60221C6DA369d7B3cF8CdC9Cc43b894B8f0c";
const RELAY_EOA = NEW_DEPLOYER;

const GAS = { gasLimit: 400_000 };

const timelockAbi = [
  "function cancel(bytes32 id)",
  "function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) payable",
  "function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata payloads, bytes32 predecessor, bytes32 salt) payable",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function revokeRole(bytes32 role, address account)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const tl = new ethers.Contract(TIMELOCK, timelockAbi, signer);
  const timelockFull = await ethers.getContractAt("MintedTimelockController", TIMELOCK);

  const now = Math.floor(Date.now() / 1000);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  EXECUTE TIMELOCK: Bridge Batch + Role Revocations");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Signer:  ${signer.address}`);
  console.log(`  Now:     ${new Date().toISOString()}`);
  console.log();

  // Preflight
  const [CANCELLER_ROLE, EXECUTOR_ROLE, PROPOSER_ROLE, ADMIN_ROLE] = await Promise.all([
    tl.CANCELLER_ROLE(), tl.EXECUTOR_ROLE(), tl.PROPOSER_ROLE(), tl.DEFAULT_ADMIN_ROLE(),
  ]);
  const hasExecutor = await tl.hasRole(EXECUTOR_ROLE, signer.address);
  if (!hasExecutor) {
    console.error("  ❌ Signer lacks EXECUTOR_ROLE — cannot execute operations.");
    process.exit(1);
  }
  console.log("  ✅ Signer has EXECUTOR_ROLE");

  let executed = 0;
  let skipped = 0;
  let notReady = 0;

  // ────────────────────────────────────────────────────────────────────
  //  PHASE 2: Bridge upgrade batch
  // ────────────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  PHASE 2: Bridge upgrade + RELAYER_ROLE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const BRIDGE_OP_ID = "0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4";
  const BRIDGE_SALT = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

  const bDone = await tl.isOperationDone(BRIDGE_OP_ID);
  const bReady = await tl.isOperationReady(BRIDGE_OP_ID);
  const bTs = await tl.getTimestamp(BRIDGE_OP_ID);
  const bExecAt = new Date(Number(bTs) * 1000);

  console.log(`\n  Bridge batch → ready at ${bExecAt.toISOString()}`);

  if (bDone) {
    console.log("  ✅ Already executed — skipping");
    skipped++;
  } else if (!bReady) {
    const waitSec = Number(bTs) - now;
    console.log(`  ⏳ Not ready — wait ${(waitSec / 3600).toFixed(1)} hours (${bExecAt.toISOString()})`);
    notReady++;
  } else {
    const proxyIface = new ethers.Interface([
      "function upgradeToAndCall(address newImplementation, bytes memory data)",
    ]);
    const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [NEW_BRIDGE_IMPL, "0x"]);
    const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
    const roleIface = new ethers.Interface(["function grantRole(bytes32 role, address account)"]);
    const grantRoleData = roleIface.encodeFunctionData("grantRole", [RELAYER_ROLE, RELAY_EOA]);

    try {
      console.log("  Executing batch...");
      const tx = await timelockFull.executeBatch(
        [BRIDGE, BRIDGE], [0, 0], [upgradeData, grantRoleData],
        ethers.ZeroHash, BRIDGE_SALT, { gasLimit: 600_000 },
      );
      console.log(`  tx: ${tx.hash}`);
      await tx.wait(2);

      const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
      const rr = await bridge.RELAYER_ROLE();
      const relayHasRole = await bridge.hasRole(rr, RELAY_EOA);
      console.log(`  ✅ Bridge upgraded + RELAYER_ROLE=${relayHasRole}`);
      executed++;
    } catch (e: any) {
      console.error(`  ❌ Failed: ${e.message?.slice(0, 200)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  PHASE 3: Revoke 4 roles from old deployer
  // ────────────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  PHASE 3: Revoke all roles from old deployer");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const revocations = [
    { name: "PROPOSER",      roleHash: PROPOSER_ROLE },
    { name: "EXECUTOR",      roleHash: EXECUTOR_ROLE },
    { name: "CANCELLER",     roleHash: CANCELLER_ROLE },
    { name: "DEFAULT_ADMIN", roleHash: ADMIN_ROLE },
  ];

  const tlIface = new ethers.Interface(timelockAbi);

  for (const r of revocations) {
    const calldata = tlIface.encodeFunctionData("revokeRole", [r.roleHash, OLD_DEPLOYER]);
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`revoke-${r.name}-old-deployer-codex`));
    const predecessor = ethers.ZeroHash;

    const opId = await timelockFull.hashOperation(TIMELOCK, 0, calldata, predecessor, salt);
    const done = await tl.isOperationDone(opId);
    const ready = await tl.isOperationReady(opId);
    const ts = await tl.getTimestamp(opId);
    const execAt = new Date(Number(ts) * 1000);

    console.log(`\n  Revoke ${r.name.padEnd(14)} → ready at ${execAt.toISOString()}`);

    if (done) {
      console.log("  ✅ Already executed — skipping");
      skipped++;
      continue;
    }
    if (!ready) {
      const waitSec = Number(ts) - now;
      console.log(`  ⏳ Not ready — wait ${(waitSec / 3600).toFixed(1)} hours`);
      notReady++;
      continue;
    }

    try {
      console.log("  Executing...");
      const tx = await tl.execute(TIMELOCK, 0, calldata, predecessor, salt, GAS);
      console.log(`  tx: ${tx.hash}`);
      await tx.wait(2);
      const stillHas = await tl.hasRole(r.roleHash, OLD_DEPLOYER);
      console.log(`  ✅ Revoked — old deployer ${r.name}: ${stillHas ? "⚠️ STILL HAS" : "REMOVED"}`);
      executed++;
    } catch (e: any) {
      console.error(`  ❌ Failed: ${e.message?.slice(0, 200)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  FINAL VERIFICATION
  // ────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  FINAL STATE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`\n  Executed: ${executed}  |  Skipped: ${skipped}  |  Not ready: ${notReady}`);

  console.log("\n  Old deployer roles:");
  for (const r of revocations) {
    const has = await tl.hasRole(r.roleHash, OLD_DEPLOYER);
    console.log(`    ${r.name.padEnd(15)} ${has ? "⚠️  STILL HAS" : "✅ REVOKED"}`);
  }

  console.log("\n  New deployer roles:");
  for (const r of revocations) {
    const has = await tl.hasRole(r.roleHash, NEW_DEPLOYER);
    console.log(`    ${r.name.padEnd(15)} ${has ? "✅ YES" : "❌ no"}`);
  }

  console.log("\n  Timelock self-admin:");
  const selfAdmin = await tl.hasRole(ADMIN_ROLE, TIMELOCK);
  console.log(`    DEFAULT_ADMIN   ${selfAdmin ? "✅ YES (governance via timelock)" : "⚠️  MISSING"}`);

  if (notReady > 0) {
    console.log("\n  ⏳ Some operations still time-locked — re-run after delay expires.");
    console.log("     npx hardhat run scripts/execute-timelock-revocations.ts --network sepolia");
  } else if (executed > 0) {
    console.log("\n  🎉 All timelock operations complete. Old deployer fully de-privileged.");
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
