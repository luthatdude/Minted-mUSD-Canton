/**
 * Fix 2 Blocking Actions on Sepolia
 *
 * 1. TreasuryV2 (0xf205…) — proxy upgraded but initialize() never called
 * 2. BLEBridgeV9 — execute timelock batch (RELAYER_ROLE upgrade, op 0xb269…)
 *
 * Usage:
 *   npx hardhat run scripts/fix-sepolia-blockers.ts --network sepolia
 */

import { ethers, upgrades } from "hardhat";

// ── Sepolia addresses ──────────────────────────────────────────────────
const TREASURY_PROXY = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";
const MOCK_USDC      = "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474";
const SMUSD          = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
const TIMELOCK       = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const BRIDGE         = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";
const NEW_BRIDGE_IMPL = "0x4FAF60221C6DA369d7B3cF8CdC9Cc43b894B8f0c";
const RELAY_EOA      = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

// ── Timelock operation IDs ─────────────────────────────────────────────
const BRIDGE_OP_ID = "0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4";
const BRIDGE_SALT  = ethers.id("upgrade-bridge-relayer-role-batch-2026-02-17");

const GAS = { gasLimit: 500_000 };

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Fix Sepolia Blockers: TreasuryV2 init + Bridge timelock     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Deployer: ${deployer.address}`);
  const bal = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log(`Balance:  ${bal} ETH\n`);

  // ═══════════════════════════════════════════════════════════════════════
  //  BLOCKER 1: TreasuryV2 initialization
  // ═══════════════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  BLOCKER 1: TreasuryV2 initialization");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const treasury = await ethers.getContractAt("TreasuryV2", TREASURY_PROXY);

  // Check if already initialized by reading state
  let alreadyInitialized = false;
  try {
    const currentAsset = await treasury.asset();
    if (currentAsset !== ethers.ZeroAddress) {
      console.log(`  ✅ TreasuryV2 already initialized — asset = ${currentAsset}`);
      alreadyInitialized = true;
    }
  } catch (e: any) {
    console.log(`  asset() reverted — proxy likely uninitialized`);
  }

  if (!alreadyInitialized) {
    console.log("  Calling initialize()...");
    console.log(`    _asset:        ${MOCK_USDC}`);
    console.log(`    _vault:        ${SMUSD}`);
    console.log(`    _admin:        ${deployer.address}`);
    console.log(`    _feeRecipient: ${deployer.address}`);
    console.log(`    _timelock:     ${TIMELOCK}`);

    try {
      const tx = await treasury.initialize(
        MOCK_USDC,
        SMUSD,
        deployer.address,
        deployer.address,
        TIMELOCK,
        GAS,
      );
      console.log(`  tx: ${tx.hash}`);
      const receipt = await tx.wait(2);
      console.log(`  ✅ TreasuryV2 initialized (gas: ${receipt?.gasUsed})`);

      // Verify
      const asset = await treasury.asset();
      const vaultAddr = await treasury.vault();
      console.log(`  Verification: asset()=${asset}, vault()=${vaultAddr}`);
    } catch (e: any) {
      if (e.message?.includes("already initialized") || e.message?.includes("Initializable")) {
        console.log("  ⚠️  Already initialized (Initializable guard) — skipping");
      } else {
        console.error(`  ❌ Failed: ${e.message?.slice(0, 300)}`);
        console.error("     Trying to read current state anyway...");
        try {
          const a = await treasury.asset();
          console.log(`     asset() = ${a}`);
        } catch { console.log("     asset() still reverts"); }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BLOCKER 2: BLEBridgeV9 RELAYER_ROLE timelock execution
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  BLOCKER 2: BLEBridgeV9 RELAYER_ROLE upgrade");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const timelockAbi = [
    "function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata payloads, bytes32 predecessor, bytes32 salt) payable",
    "function isOperationPending(bytes32 id) view returns (bool)",
    "function isOperationReady(bytes32 id) view returns (bool)",
    "function isOperationDone(bytes32 id) view returns (bool)",
    "function getTimestamp(bytes32 id) view returns (uint256)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function EXECUTOR_ROLE() view returns (bytes32)",
  ];

  const tl = new ethers.Contract(TIMELOCK, timelockAbi, deployer);

  // Pre-check executor role
  const EXECUTOR_ROLE = await tl.EXECUTOR_ROLE();
  const hasExecutor = await tl.hasRole(EXECUTOR_ROLE, deployer.address);
  if (!hasExecutor) {
    console.log("  ❌ Deployer lacks EXECUTOR_ROLE — cannot execute timelock ops");
    console.log("     Check: is deployer 0xe640... or 0x7De3...?");
    console.log("     Skipping bridge execution.\n");
  } else {
    console.log("  ✅ Deployer has EXECUTOR_ROLE");

    const bDone  = await tl.isOperationDone(BRIDGE_OP_ID);
    const bReady = await tl.isOperationReady(BRIDGE_OP_ID);
    const bTs    = await tl.getTimestamp(BRIDGE_OP_ID);
    const bExecAt = new Date(Number(bTs) * 1000);

    console.log(`  Operation:  ${BRIDGE_OP_ID.slice(0, 18)}…`);
    console.log(`  Executable: ${bExecAt.toISOString()}`);

    if (bDone) {
      console.log("  ✅ Already executed — skipping\n");
    } else if (!bReady) {
      const now = Math.floor(Date.now() / 1000);
      const waitSec = Number(bTs) - now;
      console.log(`  ⏳ Not ready yet — wait ${(waitSec / 3600).toFixed(1)} hours`);
      console.log(`     Re-run after ${bExecAt.toISOString()}\n`);
    } else {
      console.log("  🟢 Ready — executing batch...");

      // Reconstruct calldata
      const proxyIface = new ethers.Interface([
        "function upgradeToAndCall(address newImplementation, bytes memory data)",
      ]);
      const upgradeData = proxyIface.encodeFunctionData("upgradeToAndCall", [NEW_BRIDGE_IMPL, "0x"]);

      const RELAYER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RELAYER_ROLE"));
      const roleIface = new ethers.Interface(["function grantRole(bytes32 role, address account)"]);
      const grantRoleData = roleIface.encodeFunctionData("grantRole", [RELAYER_ROLE, RELAY_EOA]);

      try {
        const timelockFull = await ethers.getContractAt("MintedTimelockController", TIMELOCK);
        const tx = await timelockFull.executeBatch(
          [BRIDGE, BRIDGE],
          [0, 0],
          [upgradeData, grantRoleData],
          ethers.ZeroHash,
          BRIDGE_SALT,
          { gasLimit: 600_000 },
        );
        console.log(`  tx: ${tx.hash}`);
        await tx.wait(2);

        // Verify
        const bridge = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
        const rr = await bridge.RELAYER_ROLE();
        const relayHasRole = await bridge.hasRole(rr, RELAY_EOA);
        console.log(`  ✅ Bridge upgraded + RELAYER_ROLE granted = ${relayHasRole}\n`);
      } catch (e: any) {
        console.error(`  ❌ Failed: ${e.message?.slice(0, 300)}\n`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  FINAL STATE");
  console.log("═══════════════════════════════════════════════════════════════");

  try {
    const t = await ethers.getContractAt("TreasuryV2", TREASURY_PROXY);
    const a = await t.asset();
    const v = await t.vault();
    const tv = await t.totalValue();
    console.log(`  TreasuryV2: asset=${a}, vault=${v}, totalValue=${tv}`);
  } catch (e: any) {
    console.log(`  TreasuryV2: ❌ still broken — ${e.message?.slice(0, 100)}`);
  }

  try {
    const b = await ethers.getContractAt("BLEBridgeV9", BRIDGE);
    const rr = await b.RELAYER_ROLE();
    const has = await b.hasRole(rr, RELAY_EOA);
    console.log(`  BLEBridgeV9: RELAYER_ROLE(${RELAY_EOA.slice(0, 10)}…) = ${has}`);
  } catch (e: any) {
    console.log(`  BLEBridgeV9: ❌ ${e.message?.slice(0, 100)}`);
  }

  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log(`\n  Gas spent: ${(parseFloat(bal) - parseFloat(remaining)).toFixed(6)} ETH`);
  console.log(`  Remaining: ${remaining} ETH`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
