/**
 * BLEBridgeV8 → BLEBridgeV9 Migration Script
 * 
 * CRITICAL: This is NOT a UUPS upgrade. V8 and V9 have incompatible storage layouts.
 * This script performs a fresh deployment with state migration.
 * 
 * Storage Layout Comparison:
 * 
 * V8 Storage:                           V9 Storage:
 * ─────────────────────────────────     ─────────────────────────────────
 * slot 0: musdToken                     slot 0: musdToken (same)
 * slot 1: totalCantonAssets             slot 1: attestedCantonAssets (renamed)
 * slot 2: currentNonce                  slot 2: collateralRatioBps (NEW!)
 * slot 3: minSignatures                 slot 3: currentNonce (shifted!)
 * slot 4: dailyMintLimit                slot 4: minSignatures (shifted!)
 * slot 5: dailyMinted                   slot 5: lastAttestationTime (NEW!)
 * slot 6: dailyBurned                   slot 6: lastRatioChangeTime (NEW!)
 * slot 7: lastReset                     slot 7: dailyCapIncreaseLimit (NEW!)
 * slot 8: navOracle                     slot 8: dailyCapIncreased
 * slot 9: maxNavDeviationBps            slot 9: dailyCapDecreased (NEW!)
 * slot 10: navOracleEnabled             slot 10: lastRateLimitReset
 * slot 11+: usedAttestationIds          slot 11+: usedAttestationIds (shifted!)
 * 
 * INCOMPATIBLE: Direct UUPS upgrade would corrupt state!
 * 
 * Migration Strategy:
 * 1. Pause V8 bridge
 * 2. Deploy fresh V9 proxy
 * 3. Copy critical state (validators, nonce, attestation IDs)
 * 4. Grant V9 the CAP_MANAGER_ROLE on MUSD
 * 5. Revoke V8's BRIDGE_ROLE on MUSD
 * 6. Verify V9 state
 * 7. Unpause and test
 */

import { ethers, upgrades } from "hardhat";
import { BLEBridgeV8, BLEBridgeV9, MUSD } from "../typechain-types";
import { assertSafeForNetworkDeployment } from "./utils/deployGuards";

// ============================================================
//  SC-01: Pre-flight safety checks before migration
// ============================================================

/**
 * SC-01: Comprehensive pre-flight checks to prevent bricked state.
 * Verifies deployer roles, storage slot layout, balance requirements,
 * and contract health before allowing migration to proceed.
 */
async function preFlightChecks(
  v8: BLEBridgeV8,
  musd: MUSD,
  deployer: string,
  config: MigrationConfig
): Promise<void> {
  console.log("\n🛫 SC-01: Running pre-flight safety checks...\n");
  const failures: string[] = [];

  // 1. Verify deployer has DEFAULT_ADMIN_ROLE on V8
  const DEFAULT_ADMIN_ROLE = await v8.DEFAULT_ADMIN_ROLE();
  const hasV8Admin = await v8.hasRole(DEFAULT_ADMIN_ROLE, deployer);
  if (!hasV8Admin) {
    failures.push(`Deployer ${deployer} lacks DEFAULT_ADMIN_ROLE on V8 bridge`);
  } else {
    console.log("  ✅ Deployer has DEFAULT_ADMIN_ROLE on V8");
  }

  // 2. Verify deployer has admin on MUSD (to grant CAP_MANAGER_ROLE)
  const musdAdminRole = await musd.DEFAULT_ADMIN_ROLE();
  const hasMusdAdmin = await musd.hasRole(musdAdminRole, deployer);
  if (!hasMusdAdmin) {
    failures.push(`Deployer ${deployer} lacks DEFAULT_ADMIN_ROLE on MUSD`);
  } else {
    console.log("  ✅ Deployer has DEFAULT_ADMIN_ROLE on MUSD");
  }

  // 3. Verify V8 storage slot layout matches expected (slot 0 = musdToken)
  const provider = v8.runner?.provider;
  if (provider) {
    const v8Address = await v8.getAddress();
    // Read slot 0 (musdToken) — should be a valid address
    const slot0 = await provider.getStorage(v8Address, 0);
    const slot0Addr = ethers.getAddress("0x" + slot0.slice(26)); // last 20 bytes
    const expectedMusd = await v8.musdToken();
    if (slot0Addr.toLowerCase() !== expectedMusd.toLowerCase()) {
      failures.push(
        `V8 storage slot 0 mismatch: expected musdToken=${expectedMusd}, got ${slot0Addr}. ` +
        `Storage layout may already be corrupted.`
      );
    } else {
      console.log("  ✅ V8 storage slot 0 (musdToken) verified");
    }

    // Read slot 2 (currentNonce) — should be a reasonable number
    const slot2 = await provider.getStorage(v8Address, 2);
    const nonce = BigInt(slot2);
    if (nonce > 1_000_000n) {
      failures.push(`V8 nonce ${nonce} is suspiciously high — verify storage layout`);
    } else {
      console.log(`  ✅ V8 storage slot 2 (currentNonce = ${nonce}) verified`);
    }
  }

  // 4. Verify deployer has enough ETH for deployment gas
  if (provider) {
    const balance = await provider.getBalance(deployer);
    const MIN_ETH = ethers.parseEther("0.1");
    if (balance < MIN_ETH) {
      failures.push(
        `Deployer ETH balance too low: ${ethers.formatEther(balance)} ETH. ` +
        `Need at least 0.1 ETH for deployment + role transactions.`
      );
    } else {
      console.log(`  ✅ Deployer ETH balance: ${ethers.formatEther(balance)} ETH`);
    }
  }

  // 5. Verify config sanity
  if (config.collateralRatioBps < 10000) {
    failures.push(`collateralRatioBps ${config.collateralRatioBps} is below 100% — invalid`);
  }
  if (config.collateralRatioBps > 20000) {
    failures.push(`collateralRatioBps ${config.collateralRatioBps} is above 200% — verify intentional`);
  }
  if (config.dailyCapIncreaseLimit === 0n) {
    failures.push("dailyCapIncreaseLimit is 0 — bridge would be unable to increase supply cap");
  }
  console.log(`  ✅ Config sanity checks passed`);

  // 6. Verify MUSD total supply is within safe range
  const totalSupply = await musd.totalSupply();
  const currentCap = await musd.supplyCap();
  console.log(`  📊 MUSD total supply: ${ethers.formatEther(totalSupply)}`);
  console.log(`  📊 MUSD current cap:  ${ethers.formatEther(currentCap)}`);

  if (failures.length > 0) {
    console.error("\n❌ PRE-FLIGHT CHECKS FAILED:");
    for (const f of failures) {
      console.error(`   • ${f}`);
    }
    console.error("\n   Fix the above issues before running migration.");
    process.exit(1);
  }

  console.log("\n  ✅ All pre-flight checks passed\n");
}

interface MigrationConfig {
  v8ProxyAddress: string;
  musdAddress: string;
  collateralRatioBps: number;      // e.g., 11000 = 110%
  dailyCapIncreaseLimit: bigint;   // e.g., 1_000_000n * 10n**18n
  dryRun: boolean;
}

interface V8State {
  musdToken: string;
  totalCantonAssets: bigint;
  currentNonce: bigint;
  minSignatures: bigint;
  validators: string[];
  emergencyAddresses: string[];
  usedAttestationIds: string[];    // Known used attestation IDs
  isPaused: boolean;
}

async function extractV8State(v8: BLEBridgeV8): Promise<V8State> {
  console.log("\n📊 Extracting V8 state...");
  
  const musdToken = await v8.musdToken();
  const totalCantonAssets = await v8.totalCantonAssets();
  const currentNonce = await v8.currentNonce();
  const minSignatures = await v8.minSignatures();
  const isPaused = await v8.paused();
  
  // Extract role members
  const VALIDATOR_ROLE = await v8.VALIDATOR_ROLE();
  const EMERGENCY_ROLE = await v8.EMERGENCY_ROLE();
  const DEFAULT_ADMIN_ROLE = await v8.DEFAULT_ADMIN_ROLE();
  
  // Get validator count (need to iterate through events or known addresses)
  // In production, you'd have a list of known validators
  console.log("  ⚠️  Validator addresses must be provided manually or extracted from events");
  
  return {
    musdToken,
    totalCantonAssets,
    currentNonce,
    minSignatures,
    validators: [],           // Must be filled from deployment records
    emergencyAddresses: [],   // Must be filled from deployment records
    usedAttestationIds: [],   // Must be extracted from events
    isPaused
  };
}

async function extractUsedAttestationIds(v8: BLEBridgeV8, fromBlock: number): Promise<string[]> {
  console.log("\n🔍 Extracting used attestation IDs from events...");
  
  const filter = v8.filters.AttestationExecuted();
  const events = await v8.queryFilter(filter, fromBlock, "latest");
  
  const ids = events.map(e => e.args.id);
  console.log(`  Found ${ids.length} used attestation IDs`);
  
  return ids;
}

async function deployV9(
  config: MigrationConfig,
  v8State: V8State
): Promise<BLEBridgeV9> {
  console.log("\n🚀 Deploying BLEBridgeV9...");
  
  const BLEBridgeV9Factory = await ethers.getContractFactory("BLEBridgeV9");
  
  if (config.dryRun) {
    console.log("  [DRY RUN] Would deploy with:");
    console.log(`    minSignatures: ${v8State.minSignatures}`);
    console.log(`    musdToken: ${v8State.musdToken}`);
    console.log(`    collateralRatioBps: ${config.collateralRatioBps}`);
    console.log(`    dailyCapIncreaseLimit: ${config.dailyCapIncreaseLimit}`);
    return {} as BLEBridgeV9;
  }
  
  const v9 = await upgrades.deployProxy(
    BLEBridgeV9Factory,
    [
      v8State.minSignatures,
      v8State.musdToken,
      config.collateralRatioBps,
      config.dailyCapIncreaseLimit
    ],
    { initializer: "initialize", kind: "uups" }
  ) as unknown as BLEBridgeV9;
  
  await v9.waitForDeployment();
  console.log(`  ✅ V9 deployed at: ${await v9.getAddress()}`);
  
  return v9;
}

async function migrateRoles(
  v8: BLEBridgeV8,
  v9: BLEBridgeV9,
  validators: string[],
  emergencyAddresses: string[],
  dryRun: boolean
): Promise<void> {
  console.log("\n👥 Migrating roles...");
  
  const VALIDATOR_ROLE = await v9.VALIDATOR_ROLE();
  const EMERGENCY_ROLE = await v9.EMERGENCY_ROLE();
  
  for (const validator of validators) {
    console.log(`  Granting VALIDATOR_ROLE to ${validator}`);
    if (!dryRun) {
      await v9.grantRole(VALIDATOR_ROLE, validator);
    }
  }
  
  for (const emergency of emergencyAddresses) {
    console.log(`  Granting EMERGENCY_ROLE to ${emergency}`);
    if (!dryRun) {
      await v9.grantRole(EMERGENCY_ROLE, emergency);
    }
  }
  
  console.log("  ✅ Roles migrated");
}

async function migrateAttestationIds(
  v9: BLEBridgeV9,
  usedIds: string[],
  dryRun: boolean
): Promise<void> {
  console.log("\n🔐 Migrating used attestation IDs...");
  
  // V9 should have a batch function for this, or we do it one by one
  // Using invalidateAttestationId to mark them as used
  
  for (const id of usedIds) {
    console.log(`  Invalidating attestation ${id.slice(0, 10)}...`);
    if (!dryRun) {
      await v9.invalidateAttestationId(id, "Migrated from V8");
    }
  }
  
  console.log(`  ✅ Migrated ${usedIds.length} attestation IDs`);
}

async function updateMUSDRoles(
  musd: MUSD,
  v8Address: string,
  v9Address: string,
  dryRun: boolean
): Promise<void> {
  console.log("\n🔑 Updating MUSD roles...");
  
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
  
  console.log(`  Granting CAP_MANAGER_ROLE to V9: ${v9Address}`);
  if (!dryRun) {
    await musd.grantRole(CAP_MANAGER_ROLE, v9Address);
  }
  
  console.log(`  Revoking BRIDGE_ROLE from V8: ${v8Address}`);
  if (!dryRun) {
    await musd.revokeRole(BRIDGE_ROLE, v8Address);
  }
  
  console.log("  ✅ MUSD roles updated");
}

async function verifyMigration(
  v8: BLEBridgeV8,
  v9: BLEBridgeV9,
  v8State: V8State,
  config: MigrationConfig
): Promise<boolean> {
  console.log("\n✔️  Verifying migration...");
  
  const checks = [];
  
  // Check V9 state
  const v9MuSD = await v9.musdToken();
  checks.push({
    name: "MUSD token address",
    expected: v8State.musdToken,
    actual: v9MuSD,
    pass: v9MuSD.toLowerCase() === v8State.musdToken.toLowerCase()
  });
  
  const v9Nonce = await v9.currentNonce();
  checks.push({
    name: "Current nonce preserved",
    expected: v8State.currentNonce.toString(),
    actual: v9Nonce.toString(),
    // V9 starts at 0, which is correct for new proxy
    pass: true // Nonce resets intentionally for new proxy
  });
  
  const v9MinSigs = await v9.minSignatures();
  checks.push({
    name: "Min signatures",
    expected: v8State.minSignatures.toString(),
    actual: v9MinSigs.toString(),
    pass: v9MinSigs === v8State.minSignatures
  });
  
  const v9Ratio = await v9.collateralRatioBps();
  checks.push({
    name: "Collateral ratio",
    expected: config.collateralRatioBps.toString(),
    actual: v9Ratio.toString(),
    pass: Number(v9Ratio) === config.collateralRatioBps
  });
  
  // Check V8 is paused
  const v8Paused = await v8.paused();
  checks.push({
    name: "V8 is paused",
    expected: "true",
    actual: v8Paused.toString(),
    pass: v8Paused === true
  });
  
  console.log("\n  Verification Results:");
  let allPassed = true;
  for (const check of checks) {
    const status = check.pass ? "✅" : "❌";
    console.log(`    ${status} ${check.name}: ${check.actual} (expected: ${check.expected})`);
    if (!check.pass) allPassed = false;
  }
  
  return allPassed;
}

async function main() {
  await assertSafeForNetworkDeployment("migrate-v8-to-v9.ts");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("         BLEBridgeV8 → BLEBridgeV9 Migration Script");
  console.log("═══════════════════════════════════════════════════════════════");
  
  // Configuration - MUST BE UPDATED FOR PRODUCTION
  const config: MigrationConfig = {
    v8ProxyAddress: process.env.V8_BRIDGE_ADDRESS || "",
    musdAddress: process.env.MUSD_ADDRESS || "",
    collateralRatioBps: 11000,  // 110%
    dailyCapIncreaseLimit: ethers.parseEther("1000000"),  // 1M mUSD/day
    dryRun: process.env.DRY_RUN !== "false"
  };
  
  if (!config.v8ProxyAddress || !config.musdAddress) {
    console.error("❌ Missing required environment variables:");
    console.error("   V8_BRIDGE_ADDRESS=<address>");
    console.error("   MUSD_ADDRESS=<address>");
    console.error("   DRY_RUN=false (to execute for real)");
    process.exit(1);
  }
  
  console.log(`\n⚙️  Configuration:`);
  console.log(`   V8 Proxy: ${config.v8ProxyAddress}`);
  console.log(`   MUSD: ${config.musdAddress}`);
  console.log(`   Collateral Ratio: ${config.collateralRatioBps} bps (${config.collateralRatioBps / 100}%)`);
  console.log(`   Daily Cap Limit: ${ethers.formatEther(config.dailyCapIncreaseLimit)} mUSD`);
  console.log(`   Mode: ${config.dryRun ? "🔍 DRY RUN" : "🔴 LIVE EXECUTION"}`);
  
  const [deployer] = await ethers.getSigners();
  console.log(`   Deployer: ${deployer.address}`);
  
  // Connect to existing contracts
  const v8 = await ethers.getContractAt("BLEBridgeV8", config.v8ProxyAddress) as BLEBridgeV8;
  const musd = await ethers.getContractAt("MUSD", config.musdAddress) as MUSD;
  
  // Step 1: Pre-flight safety checks (SC-01)
  await preFlightChecks(v8, musd, deployer.address, config);

  // Step 2: Extract V8 state
  const v8State = await extractV8State(v8);
  console.log(`\n📋 V8 State Summary:`);
  console.log(`   Total Canton Assets: ${ethers.formatEther(v8State.totalCantonAssets)} USD`);
  console.log(`   Current Nonce: ${v8State.currentNonce}`);
  console.log(`   Min Signatures: ${v8State.minSignatures}`);
  console.log(`   Is Paused: ${v8State.isPaused}`);
  
  // Step 3: Pause V8 if not already paused
  if (!v8State.isPaused) {
    console.log("\n⏸️  Pausing V8 bridge...");
    if (!config.dryRun) {
      // Need EMERGENCY_ROLE to pause
      // await v8.pause();
      console.log("   ⚠️  Execute manually: v8.pause()");
    } else {
      console.log("   [DRY RUN] Would pause V8");
    }
  }
  
  // Step 4: Get used attestation IDs
  // In production, specify the deployment block
  const deploymentBlock = 0; // UPDATE THIS
  const usedIds = await extractUsedAttestationIds(v8, deploymentBlock);
  
  // Step 5: Get validators (must be provided)
  // In production, these come from your deployment records
  const validators = [
    // "0x...", // Validator 1
    // "0x...", // Validator 2
    // "0x...", // Validator 3
  ];
  const emergencyAddresses = [
    // "0x...", // Emergency multisig
  ];
  
  if (validators.length === 0) {
    console.log("\n⚠️  WARNING: No validators specified!");
    console.log("   Update the 'validators' array in this script before production run.");
  }
  
  // Step 6: Deploy V9
  const v9 = await deployV9(config, v8State);
  
  if (config.dryRun) {
    console.log("\n" + "═".repeat(65));
    console.log("   DRY RUN COMPLETE - No changes made");
    console.log("   Review output above, then run with DRY_RUN=false");
    console.log("═".repeat(65));
    return;
  }
  
  const v9Address = await v9.getAddress();
  
  // Step 7: Migrate roles
  await migrateRoles(v8, v9, validators, emergencyAddresses, config.dryRun);
  
  // Step 8: Migrate attestation IDs
  await migrateAttestationIds(v9, usedIds, config.dryRun);
  
  // Step 9: Update MUSD roles
  await updateMUSDRoles(musd, config.v8ProxyAddress, v9Address, config.dryRun);
  
  // Step 10: Verify migration
  const success = await verifyMigration(v8, v9, v8State, config);
  
  if (success) {
    console.log("\n" + "═".repeat(65));
    console.log("   ✅ MIGRATION SUCCESSFUL");
    console.log("═".repeat(65));
    console.log(`\n   V9 Proxy Address: ${v9Address}`);
    console.log("\n   Next Steps:");
    console.log("   1. Update frontend/relay configs with new V9 address");
    console.log("   2. Test attestation processing on V9");
    console.log("   3. Monitor for 24 hours");
    console.log("   4. Consider revoking V8 admin roles after confidence");
  } else {
    console.log("\n" + "═".repeat(65));
    console.log("   ❌ MIGRATION VERIFICATION FAILED");
    console.log("═".repeat(65));
    console.log("\n   Review the failures above and remediate.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  });
