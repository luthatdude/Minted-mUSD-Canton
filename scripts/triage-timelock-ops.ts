/**
 * Triage All 9 Pending Timelock Operations
 *
 * CANCEL (4 stale/superseded ops):
 *   1. 0xeca79ba… — Unknown bridge upgrade to stale impl 0x559fb6e7
 *   2. 0x0ed7bc5… — Bridge upgrade to 0x85D0d5BD (upgrade-proxies-via-timelock.ts)
 *   3. 0xbbd819b… — Standalone bridge upgrade to 0x4FAF6022 (no grantRole)
 *   4. 0x507a800… — Old treasury 0x11Cc upgrade (defunct, asset=EOA, strategyCount=0)
 *
 * EXECUTE (5 valid ops — only when ready):
 *   5. 0xb2693f1… — Bridge batch: upgradeToAndCall + grantRole(RELAYER_ROLE)
 *   6. 0x78b4cf1… — Revoke PROPOSER from old deployer
 *   7. 0x44bbaf9… — Revoke EXECUTOR from old deployer
 *   8. 0x12ddd4f… — Revoke CANCELLER from old deployer
 *   9. 0x970e168… — Revoke DEFAULT_ADMIN from old deployer
 *
 * Usage: npx hardhat run scripts/triage-timelock-ops.ts --network sepolia
 *
 * Idempotent — safe to run multiple times. Skips done/not-ready ops.
 */

import { ethers } from "hardhat";

// ── Addresses ──────────────────────────────────────────────────────────
const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const BRIDGE = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
const NEW_BRIDGE_IMPL = "0x4FAF60221C6DA369d7B3cF8CdC9Cc43b894B8f0c";
const RELAY_EOA = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

const GAS = { gasLimit: 400_000 };

// ── Timelock ABI ───────────────────────────────────────────────────────
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

// ── Operation IDs to CANCEL ────────────────────────────────────────────
const CANCEL_OPS = [
  {
    label: "Unknown bridge upgrade → 0x559fb6e7 (stale impl)",
    opId: "0xeca79ba78ec62e57ae0f5e0341ef1519eb05cb15e0571f7fc6d0e7d1274139ca",
  },
  {
    label: "Bridge upgrade → 0x85D0d5BD (upgrade-proxies-via-timelock.ts, superseded)",
    opId: "0x0ed7bc51a0414e32ea9710b06c6dbf71951e53b19cd6e70cd02967bf240ba0b7",
  },
  {
    label: "Standalone bridge upgrade → 0x4FAF6022 (no grantRole, superseded by batch)",
    opId: "0xbbd819b71511a34fb6333591ebfd5e2312e5f909534d27d9719251b9dbb5267a",
  },
  {
    label: "Old treasury 0x11Cc upgrade (defunct: strategyCount=0, asset=EOA)",
    opId: "0x507a8005010abc800db1b94558be92cb05a96abf4bc332b88316563cb2db3676",
  },
];

async function main() {
  const [signer] = await ethers.getSigners();
  const tl = new ethers.Contract(TIMELOCK, timelockAbi, signer);

  console.log("═".repeat(70));
  console.log("  TRIAGE ALL 9 TIMELOCK OPERATIONS");
  console.log("═".repeat(70));
  console.log(`  Signer:  ${signer.address}`);
  console.log(`  Now:     ${new Date().toISOString()}`);

  // ── Pre-flight: verify signer roles ──────────────────────────────────
  const [CANCELLER_ROLE, EXECUTOR_ROLE, PROPOSER_ROLE] = await Promise.all([
    tl.CANCELLER_ROLE(),
    tl.EXECUTOR_ROLE(),
    tl.PROPOSER_ROLE(),
  ]);

  const hasCanceller = await tl.hasRole(CANCELLER_ROLE, signer.address);
  const hasExecutor = await tl.hasRole(EXECUTOR_ROLE, signer.address);

  console.log(`  CANCELLER_ROLE: ${hasCanceller}`);
  console.log(`  EXECUTOR_ROLE:  ${hasExecutor}`);

  if (!hasCanceller) {
    console.error("\n  ❌ Signer lacks CANCELLER_ROLE — cannot cancel ops.");
    console.error("  Need to grant via: timelock.grantRole(CANCELLER_ROLE, signer)");
    process.exit(1);
  }
  if (!hasExecutor) {
    console.error("\n  ⚠️  Signer lacks EXECUTOR_ROLE — can cancel but cannot execute.");
  }

  let cancelSuccess = 0, cancelSkip = 0, cancelFail = 0;
  let execSuccess = 0, execSkip = 0, execFail = 0;

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 1: CANCEL 4 stale/superseded operations
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "━".repeat(70));
  console.log("  PHASE 1: CANCEL 4 stale operations");
  console.log("━".repeat(70));

  for (const op of CANCEL_OPS) {
    const pending = await tl.isOperationPending(op.opId);
    const done = await tl.isOperationDone(op.opId);
    const ts = await tl.getTimestamp(op.opId);
    const execAt = Number(ts) > 1 ? new Date(Number(ts) * 1000).toISOString() : "N/A";

    console.log(`\n  🔴 ${op.label}`);
    console.log(`     OpId:   ${op.opId}`);
    console.log(`     ExecAt: ${execAt}`);

    if (done) {
      console.log("     ✅ Already done — cannot cancel (skipping)");
      cancelSkip++;
      continue;
    }
    if (!pending) {
      console.log("     ✅ Already cancelled/not found — skipping");
      cancelSkip++;
      continue;
    }

    try {
      const tx = await tl.cancel(op.opId, GAS);
      console.log(`     tx: ${tx.hash}`);
      await tx.wait(2);
      const stillPending = await tl.isOperationPending(op.opId);
      console.log(`     ✅ Cancelled — pending=${stillPending}`);
      cancelSuccess++;
    } catch (e: any) {
      console.log(`     ❌ Cancel failed: ${e.message?.slice(0, 120)}`);
      cancelFail++;
    }
  }

  console.log(`\n  Cancel summary: ${cancelSuccess} cancelled, ${cancelSkip} skipped, ${cancelFail} failed`);

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 2: EXECUTE bridge upgrade batch (RELAYER_ROLE)
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "━".repeat(70));
  console.log("  PHASE 2: EXECUTE bridge upgrade batch (BRIDGE-M-04)");
  console.log("━".repeat(70));

  const BRIDGE_OP_ID = "0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4";
  const BRIDGE_SALT = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

  const bDone = await tl.isOperationDone(BRIDGE_OP_ID);
  const bReady = await tl.isOperationReady(BRIDGE_OP_ID);
  const bPending = await tl.isOperationPending(BRIDGE_OP_ID);
  const bTs = await tl.getTimestamp(BRIDGE_OP_ID);

  console.log(`\n  🟢 Bridge batch: upgradeToAndCall + grantRole(RELAYER_ROLE)`);
  console.log(`     OpId:    ${BRIDGE_OP_ID}`);
  console.log(`     ExecAt:  ${new Date(Number(bTs) * 1000).toISOString()}`);
  console.log(`     Pending: ${bPending}  Ready: ${bReady}  Done: ${bDone}`);

  if (bDone) {
    console.log("     ✅ Already executed — skipping");
    execSkip++;
  } else if (!bReady) {
    console.log("     ⏳ Not ready yet — skipping (run again after delay)");
    execSkip++;
  } else if (!hasExecutor) {
    console.log("     ⚠️  Ready but signer lacks EXECUTOR_ROLE — skipping");
    execSkip++;
  } else {
    // Reconstruct exact batch payloads
    const proxyIface = new ethers.Interface([
      "function upgradeToAndCall(address newImplementation, bytes memory data)",
    ]);
    const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
      NEW_BRIDGE_IMPL,
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

    const targets = [BRIDGE, BRIDGE];
    const values = [BigInt(0), BigInt(0)];
    const payloads = [upgradeData, grantRoleData];

    try {
      console.log("     Executing batch...");
      const timelock = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
      const tx = await timelock.executeBatch(
        targets,
        values,
        payloads,
        ethers.ZeroHash,
        BRIDGE_SALT,
        { gasLimit: 600_000 },
      );
      console.log(`     tx: ${tx.hash}`);
      await tx.wait(2);

      // Verify
      const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
      const rr = await bridge.RELAYER_ROLE();
      const relayHasRole = await bridge.hasRole(rr, RELAY_EOA);
      console.log(`     ✅ Bridge upgraded + RELAYER_ROLE=${relayHasRole}`);
      execSuccess++;
    } catch (e: any) {
      console.log(`     ❌ Batch execute failed: ${e.message?.slice(0, 150)}`);
      execFail++;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 3: EXECUTE 4 Codex role revocations
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "━".repeat(70));
  console.log("  PHASE 3: EXECUTE 4 Codex role revocations");
  console.log("━".repeat(70));

  const [PROPOSER, EXECUTOR, CANCELLER, TL_ADMIN] = await Promise.all([
    tl.PROPOSER_ROLE(),
    tl.EXECUTOR_ROLE(),
    tl.CANCELLER_ROLE(),
    tl.DEFAULT_ADMIN_ROLE(),
  ]);

  const revocations = [
    { name: "PROPOSER", roleHash: PROPOSER },
    { name: "EXECUTOR", roleHash: EXECUTOR },
    { name: "CANCELLER", roleHash: CANCELLER },
    { name: "DEFAULT_ADMIN", roleHash: TL_ADMIN },
  ];

  const tlIface = new ethers.Interface(timelockAbi);

  for (const r of revocations) {
    const calldata = tlIface.encodeFunctionData("revokeRole", [r.roleHash, OLD_DEPLOYER]);
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`revoke-${r.name}-old-deployer-codex`));
    const predecessor = ethers.ZeroHash;

    // Compute opId to verify match
    const timelockFull = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
    const opId = await timelockFull.hashOperation(TIMELOCK, 0, calldata, predecessor, salt);

    const done = await tl.isOperationDone(opId);
    const ready = await tl.isOperationReady(opId);
    const pending = await tl.isOperationPending(opId);
    const ts = await tl.getTimestamp(opId);

    console.log(`\n  🟢 Revoke ${r.name} from old deployer`);
    console.log(`     OpId:    ${opId}`);
    console.log(`     ExecAt:  ${new Date(Number(ts) * 1000).toISOString()}`);
    console.log(`     Pending: ${pending}  Ready: ${ready}  Done: ${done}`);

    if (done) {
      console.log("     ✅ Already executed — skipping");
      execSkip++;
      continue;
    }
    if (!ready) {
      console.log("     ⏳ Not ready yet — skipping (run again after delay)");
      execSkip++;
      continue;
    }
    if (!hasExecutor) {
      console.log("     ⚠️  Ready but signer lacks EXECUTOR_ROLE — skipping");
      execSkip++;
      continue;
    }

    try {
      console.log("     Executing...");
      const tx = await tl.execute(TIMELOCK, 0, calldata, predecessor, salt, GAS);
      console.log(`     tx: ${tx.hash}`);
      await tx.wait(2);
      const stillHas = await tl.hasRole(r.roleHash, OLD_DEPLOYER);
      console.log(`     ✅ Revoked — old deployer has ${r.name}: ${stillHas}`);
      execSuccess++;
    } catch (e: any) {
      console.log(`     ❌ Execute failed: ${e.message?.slice(0, 120)}`);
      execFail++;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  FINAL SUMMARY
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log("  FINAL SUMMARY");
  console.log("═".repeat(70));

  console.log(`\n  Cancellations: ${cancelSuccess} done, ${cancelSkip} skipped, ${cancelFail} failed`);
  console.log(`  Executions:    ${execSuccess} done, ${execSkip} skipped, ${execFail} failed`);

  // Post-execution verification
  console.log("\n  ── Post-execution state ──");

  console.log("\n  Old deployer Timelock roles:");
  for (const r of revocations) {
    const has = await tl.hasRole(r.roleHash, OLD_DEPLOYER);
    console.log(`    ${r.name.padEnd(15)} ${has ? "⚠️  STILL HAS" : "✅ revoked"}`);
  }

  console.log("\n  Bridge RELAYER_ROLE:");
  try {
    const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
    const rr = await bridge.RELAYER_ROLE();
    const has = await bridge.hasRole(rr, RELAY_EOA);
    console.log(`    Relay EOA: ${has ? "✅ granted" : "⏳ pending"}`);
  } catch {
    console.log("    RELAYER_ROLE not available on current implementation");
  }

  console.log("\n  Cancelled ops:");
  for (const op of CANCEL_OPS) {
    const pending = await tl.isOperationPending(op.opId);
    const done = await tl.isOperationDone(op.opId);
    const status = done ? "done (was executed before cancel)" : pending ? "⚠️  STILL PENDING" : "✅ cancelled";
    console.log(`    ${op.opId.slice(0, 18)}… ${status}`);
  }

  const total = cancelSuccess + cancelSkip + cancelFail + execSuccess + execSkip + execFail;
  console.log(`\n  Total operations processed: ${total}/9`);

  if (cancelFail > 0 || execFail > 0) {
    console.log("\n  ⚠️  Some operations failed — review output above.");
    process.exit(1);
  }
  if (execSkip > 0) {
    console.log("\n  ⏳ Some execute ops not ready yet — re-run after their delay expires.");
  }

  console.log("\n" + "═".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
