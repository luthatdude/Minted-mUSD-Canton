/**
 * Execute scheduled Timelock revocations from fix-codex-findings.ts
 * Also executes the RELAYER_ROLE bridge upgrade (Finding #3).
 * 
 * All 5 operations become executable after their 24h delays:
 *   - 4x old deployer role revocations: ~Feb 18 18:05 UTC
 *   - 1x RELAYER_ROLE bridge upgrade:   ~Feb 18 07:52 UTC
 * 
 * Usage: npx hardhat run scripts/execute-codex-revocations.ts --network sepolia
 */

import { ethers } from "hardhat";

const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const BRIDGE = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
const NEW_IMPL = "0x4FAF60221C6DA369d7B3cF8CdC9Cc43b894B8f0c";
const RELAY_EOA = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

const GAS = { gasLimit: 400_000 };

const timelockAbi = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function revokeRole(bytes32 role, address account)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)",
  "function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata payloads, bytes32 predecessor, bytes32 salt)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const tl = new ethers.Contract(TIMELOCK, timelockAbi, signer);

  console.log("═".repeat(60));
  console.log("Execute Scheduled Timelock Operations");
  console.log("═".repeat(60));
  console.log(`Signer: ${signer.address}`);
  console.log(`Now:    ${new Date().toISOString()}\n`);

  // ──────────────────────────────────────────────────────────
  // Part A: Old deployer role revocations (4 operations)
  // ──────────────────────────────────────────────────────────
  console.log("━━━ Part A: Revoke old deployer Timelock roles ━━━\n");

  const [PROPOSER, EXECUTOR, CANCELLER, TL_ADMIN] = await Promise.all([
    tl.PROPOSER_ROLE(), tl.EXECUTOR_ROLE(), tl.CANCELLER_ROLE(), tl.DEFAULT_ADMIN_ROLE(),
  ]);

  const tlIface = new ethers.Interface(timelockAbi);
  const predecessor = ethers.ZeroHash;

  const revocations = [
    { name: "PROPOSER", roleHash: PROPOSER },
    { name: "EXECUTOR", roleHash: EXECUTOR },
    { name: "CANCELLER", roleHash: CANCELLER },
    { name: "DEFAULT_ADMIN", roleHash: TL_ADMIN },
  ];

  for (const r of revocations) {
    const calldata = tlIface.encodeFunctionData("revokeRole", [r.roleHash, OLD_DEPLOYER]);
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`revoke-${r.name}-old-deployer-codex`));
    const opId = await tl.hashOperation(TIMELOCK, 0, calldata, predecessor, salt);

    const pending = await tl.isOperationPending(opId);
    const ready = await tl.isOperationReady(opId);
    const done = await tl.isOperationDone(opId);
    const ts = await tl.getTimestamp(opId);

    console.log(`  ${r.name} (${opId.slice(0, 18)}…)`);
    console.log(`    Pending=${pending} Ready=${ready} Done=${done}`);
    console.log(`    Executable at: ${new Date(Number(ts) * 1000).toISOString()}`);

    if (done) {
      console.log("    ✅ Already executed — skipping\n");
      continue;
    }
    if (!ready) {
      console.log("    ⏳ Not ready yet — skipping\n");
      continue;
    }

    console.log("    Executing...");
    try {
      const tx = await tl.execute(TIMELOCK, 0, calldata, predecessor, salt, GAS);
      console.log(`    tx: ${tx.hash}`);
      await tx.wait(2);
      const stillHas = await tl.hasRole(r.roleHash, OLD_DEPLOYER);
      console.log(`    ✅ Executed — old deployer has ${r.name}: ${stillHas}\n`);
    } catch (e: any) {
      console.log(`    ❌ Failed: ${e.message?.slice(0, 120)}\n`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Part B: RELAYER_ROLE bridge upgrade (Finding #3)
  // ──────────────────────────────────────────────────────────
  console.log("━━━ Part B: RELAYER_ROLE bridge upgrade ━━━\n");

  const BRIDGE_OP_ID = "0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4";
  const bPending = await tl.isOperationPending(BRIDGE_OP_ID);
  const bReady = await tl.isOperationReady(BRIDGE_OP_ID);
  const bDone = await tl.isOperationDone(BRIDGE_OP_ID);
  const bTs = await tl.getTimestamp(BRIDGE_OP_ID);

  console.log(`  Bridge upgrade op (${BRIDGE_OP_ID.slice(0, 18)}…)`);
  console.log(`    Pending=${bPending} Ready=${bReady} Done=${bDone}`);
  console.log(`    Executable at: ${new Date(Number(bTs) * 1000).toISOString()}`);

  if (bDone) {
    console.log("    ✅ Already executed\n");
  } else if (!bReady) {
    console.log("    ⏳ Not ready yet — skipping");
    console.log("    Run when ready: PHASE=execute npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia\n");
  } else {
    // Delegate to the original script which correctly reconstructs the batch
    // using prepareUpgrade() to derive the exact implementation address
    console.log("    ✅ READY — executing via original upgrade script...\n");
    
    // Reconstruct batch exactly as scheduled by upgrade-bridge-relayer-role.ts
    const SALT = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

    const proxyIface = new ethers.Interface([
      "function upgradeToAndCall(address newImplementation, bytes memory data)",
    ]);
    const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [
      NEW_IMPL, "0x",
    ]);

    const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
    const roleIface = new ethers.Interface([
      "function grantRole(bytes32 role, address account)",
    ]);
    const grantRoleData = roleIface.encodeFunctionData("grantRole", [
      RELAYER_ROLE, RELAY_EOA,
    ]);

    const targets = [BRIDGE, BRIDGE];
    const values = [0n, 0n];
    const payloads = [upgradeData, grantRoleData];

    try {
      const timelock = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
      const tx = await timelock.executeBatch(
        targets, values, payloads, ethers.ZeroHash, SALT, { gasLimit: 600_000 }
      );
      console.log(`    tx: ${tx.hash}`);
      await tx.wait(2);
      console.log("    ✅ Bridge upgraded + RELAYER_ROLE granted\n");
    } catch (e: any) {
      console.log(`    ❌ Batch execute failed: ${e.message?.slice(0, 150)}`);
      console.log("    Fallback: PHASE=execute npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia\n");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Final verification
  // ──────────────────────────────────────────────────────────
  console.log("═".repeat(60));
  console.log("FINAL STATE");
  console.log("═".repeat(60));

  console.log("\nTimelock — old deployer roles:");
  for (const r of revocations) {
    console.log(`  ${r.name}: ${await tl.hasRole(r.roleHash, OLD_DEPLOYER)}`);
  }

  console.log("\nBridge RELAYER_ROLE:");
  try {
    const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
    const rr = await bridge.RELAYER_ROLE();
    console.log(`  Relay EOA has RELAYER_ROLE: ${await bridge.hasRole(rr, RELAY_EOA)}`);
  } catch {
    console.log("  RELAYER_ROLE not available on current implementation");
  }

  console.log("\n" + "═".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
