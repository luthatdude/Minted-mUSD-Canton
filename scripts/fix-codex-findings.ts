/**
 * Fix Codex Audit Findings #1 and #2
 * 
 * Finding #1 (CRITICAL): Revoke old deployer governance roles on Timelock
 *   - Uses TimelockController.schedule() + execute() with minDelay=0 check,
 *     or direct revokeRole if signer has DEFAULT_ADMIN
 * 
 * Finding #2 (HIGH): Grant LIQUIDATION_ROLE on BorrowModule to LiquidationEngine
 * 
 * Usage: npx hardhat run scripts/fix-codex-findings.ts --network sepolia
 */

import { ethers } from "hardhat";

const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const BORROW_MODULE = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
const LIQUIDATION_ENGINE = "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8";

const GAS = { gasLimit: 300_000 };

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Fix Codex Audit Findings");
  console.log("═".repeat(60));
  console.log(`Signer: ${signer.address}\n`);

  // ──────────────────────────────────────────────────────────
  // FINDING #2: Grant LIQUIDATION_ROLE on BorrowModule
  // ──────────────────────────────────────────────────────────
  console.log("━━━ FINDING #2: Grant LIQUIDATION_ROLE ━━━");
  const bm = await ethers.getContractAt("BorrowModule", BORROW_MODULE);
  const LIQ_ROLE = await bm.LIQUIDATION_ROLE();
  const ADMIN_ROLE = await bm.DEFAULT_ADMIN_ROLE();
  
  const signerIsAdminBM = await bm.hasRole(ADMIN_ROLE, signer.address);
  console.log(`  Signer has DEFAULT_ADMIN on BorrowModule: ${signerIsAdminBM}`);
  
  const liqAlready = await bm.hasRole(LIQ_ROLE, LIQUIDATION_ENGINE);
  if (liqAlready) {
    console.log("  ✅ LiquidationEngine already has LIQUIDATION_ROLE — skipping");
  } else if (!signerIsAdminBM) {
    console.error("  ❌ Signer cannot grant — no DEFAULT_ADMIN on BorrowModule");
  } else {
    console.log("  Granting LIQUIDATION_ROLE to LiquidationEngine...");
    const tx = await bm.grantRole(LIQ_ROLE, LIQUIDATION_ENGINE, GAS);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait(2);
    const verify = await bm.hasRole(LIQ_ROLE, LIQUIDATION_ENGINE);
    console.log(`  ✅ LIQUIDATION_ROLE granted: ${verify}`);
  }

  // ──────────────────────────────────────────────────────────
  // FINDING #1: Revoke old deployer roles on Timelock
  // ──────────────────────────────────────────────────────────
  console.log("\n━━━ FINDING #1: Revoke old deployer Timelock roles ━━━");
  
  const timelockAbi = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function revokeRole(bytes32 role, address account)",
    "function grantRole(bytes32 role, address account)",
    "function renounceRole(bytes32 role, address callerConfirmation)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function PROPOSER_ROLE() view returns (bytes32)",
    "function EXECUTOR_ROLE() view returns (bytes32)",
    "function CANCELLER_ROLE() view returns (bytes32)",
    "function getMinDelay() view returns (uint256)",
    "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay)",
    "function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)",
    "function isOperation(bytes32 id) view returns (bool)",
    "function isOperationReady(bytes32 id) view returns (bool)",
    "function isOperationDone(bytes32 id) view returns (bool)",
    "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  ];

  const tl = new ethers.Contract(TIMELOCK, timelockAbi, signer);
  
  const [PROPOSER, EXECUTOR, CANCELLER, TL_ADMIN] = await Promise.all([
    tl.PROPOSER_ROLE(), tl.EXECUTOR_ROLE(), tl.CANCELLER_ROLE(), tl.DEFAULT_ADMIN_ROLE(),
  ]);

  // Check current state
  const roles = [
    { name: "PROPOSER", hash: PROPOSER },
    { name: "EXECUTOR", hash: EXECUTOR },
    { name: "CANCELLER", hash: CANCELLER },
    { name: "DEFAULT_ADMIN", hash: TL_ADMIN },
  ];

  console.log("  Current old deployer roles on Timelock:");
  for (const r of roles) {
    const has = await tl.hasRole(r.hash, OLD_DEPLOYER);
    console.log(`    ${r.name}: ${has}`);
  }

  // Check if signer has DEFAULT_ADMIN on Timelock (can revoke directly)
  const signerIsTimelockAdmin = await tl.hasRole(TL_ADMIN, signer.address);
  const signerIsProposer = await tl.hasRole(PROPOSER, signer.address);
  const signerIsExecutor = await tl.hasRole(EXECUTOR, signer.address);
  const minDelay = await tl.getMinDelay();
  
  console.log(`\n  Signer is Timelock DEFAULT_ADMIN: ${signerIsTimelockAdmin}`);
  console.log(`  Signer is Timelock PROPOSER: ${signerIsProposer}`);
  console.log(`  Signer is Timelock EXECUTOR: ${signerIsExecutor}`);
  console.log(`  Timelock minDelay: ${minDelay}s`);

  if (signerIsTimelockAdmin) {
    // Direct revoke path — signer has DEFAULT_ADMIN
    console.log("\n  Using direct revokeRole (signer has DEFAULT_ADMIN)...");
    for (const r of roles) {
      const has = await tl.hasRole(r.hash, OLD_DEPLOYER);
      if (!has) {
        console.log(`  ⏭  ${r.name}: old deployer doesn't have it — skipping`);
        continue;
      }
      if (r.name === "DEFAULT_ADMIN") {
        // For DEFAULT_ADMIN, only revoke if Timelock-self still has it (safety)
        const tlSelfAdmin = await tl.hasRole(TL_ADMIN, TIMELOCK);
        if (!tlSelfAdmin) {
          console.log(`  ⚠  Skipping DEFAULT_ADMIN revoke — Timelock-self doesn't have it`);
          continue;
        }
      }
      console.log(`  Revoking ${r.name} from old deployer...`);
      const tx = await tl.revokeRole(r.hash, OLD_DEPLOYER, GAS);
      console.log(`    tx: ${tx.hash}`);
      await tx.wait(2);
      const verify = await tl.hasRole(r.hash, OLD_DEPLOYER);
      console.log(`    ✅ ${r.name} revoked: old deployer has it = ${verify}`);
    }
  } else if (signerIsProposer && signerIsExecutor && minDelay === 0n) {
    // Timelock path with 0 delay — schedule + execute in same block
    console.log("\n  Using Timelock schedule+execute (minDelay=0)...");
    const iface = new ethers.Interface(timelockAbi);
    
    for (const r of roles) {
      const has = await tl.hasRole(r.hash, OLD_DEPLOYER);
      if (!has) {
        console.log(`  ⏭  ${r.name}: old deployer doesn't have it — skipping`);
        continue;
      }
      const calldata = iface.encodeFunctionData("revokeRole", [r.hash, OLD_DEPLOYER]);
      const salt = ethers.keccak256(ethers.toUtf8Bytes(`revoke-${r.name}-old-deployer-${Date.now()}`));
      const predecessor = ethers.ZeroHash;
      
      console.log(`  Scheduling+executing revoke of ${r.name}...`);
      const tx1 = await tl.schedule(TIMELOCK, 0, calldata, predecessor, salt, 0, GAS);
      console.log(`    schedule tx: ${tx1.hash}`);
      await tx1.wait(2);
      
      const tx2 = await tl.execute(TIMELOCK, 0, calldata, predecessor, salt, GAS);
      console.log(`    execute tx: ${tx2.hash}`);
      await tx2.wait(2);
      
      const verify = await tl.hasRole(r.hash, OLD_DEPLOYER);
      console.log(`    ✅ ${r.name} revoked: old deployer has it = ${verify}`);
    }
  } else if (signerIsProposer) {
    // Timelock path with delay — schedule only, execute later
    console.log(`\n  ⚠  Timelock has ${minDelay}s delay — scheduling revocations only.`);
    console.log("  Execute after delay expires.\n");
    const iface = new ethers.Interface(timelockAbi);
    
    for (const r of roles) {
      const has = await tl.hasRole(r.hash, OLD_DEPLOYER);
      if (!has) continue;
      const calldata = iface.encodeFunctionData("revokeRole", [r.hash, OLD_DEPLOYER]);
      const salt = ethers.keccak256(ethers.toUtf8Bytes(`revoke-${r.name}-old-deployer-codex`));
      const predecessor = ethers.ZeroHash;
      
      const opId = await tl.hashOperation(TIMELOCK, 0, calldata, predecessor, salt);
      const alreadyScheduled = await tl.isOperation(opId);
      if (alreadyScheduled) {
        console.log(`  ⏭  ${r.name}: already scheduled (${opId.slice(0, 18)}...)`);
        continue;
      }
      
      console.log(`  Scheduling revoke of ${r.name}...`);
      const tx = await tl.schedule(TIMELOCK, 0, calldata, predecessor, salt, minDelay, GAS);
      console.log(`    tx: ${tx.hash}`);
      console.log(`    opId: ${opId}`);
      await tx.wait(2);
      console.log(`    ✅ Scheduled — executable after ${Number(minDelay)}s`);
    }
  } else {
    console.error("\n  ❌ Signer has neither DEFAULT_ADMIN nor PROPOSER on Timelock.");
    console.error("  Cannot revoke old deployer roles. Need old deployer key.");
  }

  // ──────────────────────────────────────────────────────────
  // Also revoke old deployer DEFAULT_ADMIN on BorrowModule
  // ──────────────────────────────────────────────────────────
  console.log("\n━━━ Revoke old deployer DEFAULT_ADMIN on BorrowModule ━━━");
  const oldHasAdminBM = await bm.hasRole(ADMIN_ROLE, OLD_DEPLOYER);
  if (!oldHasAdminBM) {
    console.log("  ✅ Old deployer doesn't have DEFAULT_ADMIN — already clean");
  } else if (signerIsAdminBM) {
    console.log("  Revoking DEFAULT_ADMIN from old deployer on BorrowModule...");
    const tx = await bm.revokeRole(ADMIN_ROLE, OLD_DEPLOYER, GAS);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait(2);
    const verify = await bm.hasRole(ADMIN_ROLE, OLD_DEPLOYER);
    console.log(`  ✅ Revoked: old deployer has DEFAULT_ADMIN = ${verify}`);
  } else {
    console.log("  ❌ Cannot revoke — signer not admin on BorrowModule");
  }

  // ──────────────────────────────────────────────────────────
  // Final summary
  // ──────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("FINAL VERIFICATION");
  console.log("═".repeat(60));
  
  console.log("\nBorrowModule:");
  console.log(`  LiqEngine LIQUIDATION_ROLE: ${await bm.hasRole(LIQ_ROLE, LIQUIDATION_ENGINE)}`);
  console.log(`  Old deployer DEFAULT_ADMIN: ${await bm.hasRole(ADMIN_ROLE, OLD_DEPLOYER)}`);
  
  console.log("\nTimelock:");
  for (const r of roles) {
    console.log(`  Old deployer ${r.name}: ${await tl.hasRole(r.hash, OLD_DEPLOYER)}`);
  }
  
  console.log("\n" + "═".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
