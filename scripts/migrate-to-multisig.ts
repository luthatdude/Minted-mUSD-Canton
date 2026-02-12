// scripts/migrate-to-multisig.ts
// ═══════════════════════════════════════════════════════════════════════
// MULTISIG MIGRATION SCRIPT
// ═══════════════════════════════════════════════════════════════════════
//
// Purpose: Transfer all admin roles from deployer EOA to a Gnosis Safe
//          multisig, then revoke deployer access.
//
// Usage:
//   SAFE_ADDRESS=0x... npx hardhat run scripts/migrate-to-multisig.ts --network mainnet
//
// Pre-requisites:
//   1. Deploy a Gnosis Safe at https://app.safe.global with 3-of-5 signers
//   2. Set SAFE_ADDRESS environment variable to the Safe proxy address
//   3. Run verify-roles.ts AFTER migration to confirm
//
// WARNING: This script is IRREVERSIBLE. Once deployer roles are revoked,
//          only the multisig can administer the protocol.
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from "hardhat";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // 0x00...00

interface ContractConfig {
  name: string;
  address: string;
  roles: string[]; // Role identifiers to transfer
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const safeAddress = process.env.SAFE_ADDRESS;

  if (!safeAddress || !ethers.isAddress(safeAddress)) {
    throw new Error("SAFE_ADDRESS environment variable must be set to a valid Ethereum address");
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MULTISIG MIGRATION — Minted mUSD Protocol");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Safe:       ${safeAddress}`);
  console.log(`  Network:    ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  Chain ID:   ${(await ethers.provider.getNetwork()).chainId}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Load deployed contract addresses ──────────────────────────────
  // These should match your deployment output (deploy-testnet.ts saves to deployments/)
  let addresses: Record<string, string>;
  try {
    const fs = require("fs");
    const deploymentFile = `deployments/${(await ethers.provider.getNetwork()).name}.json`;
    addresses = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    console.log(`✅ Loaded addresses from ${deploymentFile}\n`);
  } catch {
    console.error("❌ No deployment file found. Set addresses manually below.");
    console.error("   Expected file: deployments/<network>.json");
    process.exit(1);
  }

  // ── Define all contracts and their admin roles ────────────────────
  const contracts: ContractConfig[] = [
    {
      name: "MUSD",
      address: addresses.MUSD || addresses.musd,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("EMERGENCY_ROLE")),
      ],
    },
    {
      name: "SMUSD",
      address: addresses.SMUSD || addresses.smusd,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
    {
      name: "CollateralVault",
      address: addresses.CollateralVault || addresses.vault,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("VAULT_ADMIN_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
    {
      name: "BorrowModule",
      address: addresses.BorrowModule || addresses.borrowModule,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("BORROW_ADMIN_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
    {
      name: "LiquidationEngine",
      address: addresses.LiquidationEngine || addresses.liquidation,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("ENGINE_ADMIN_ROLE")),
      ],
    },
    {
      name: "PriceOracle",
      address: addresses.PriceOracle || addresses.oracle,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ADMIN_ROLE")),
      ],
    },
    {
      name: "DirectMintV2",
      address: addresses.DirectMintV2 || addresses.directMint,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("FEE_MANAGER_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
    {
      name: "InterestRateModel",
      address: addresses.InterestRateModel || addresses.irm,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("RATE_ADMIN_ROLE")),
      ],
    },
    {
      name: "TreasuryV2",
      address: addresses.TreasuryV2 || addresses.treasury,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ADMIN_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
    {
      name: "BLEBridgeV9",
      address: addresses.BLEBridgeV9 || addresses.bridge,
      roles: [
        DEFAULT_ADMIN_ROLE,
        ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ADMIN_ROLE")),
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      ],
    },
  ];

  // ── Phase 1: Grant all roles to multisig ──────────────────────────
  console.log("PHASE 1: GRANTING ROLES TO MULTISIG\n");

  const iface = new ethers.Interface([
    "function grantRole(bytes32 role, address account) external",
    "function revokeRole(bytes32 role, address account) external",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  ]);

  for (const config of contracts) {
    if (!config.address) {
      console.log(`⚠️  ${config.name}: address not found in deployment file, skipping`);
      continue;
    }

    const contract = new ethers.Contract(config.address, iface, deployer);
    console.log(`📋 ${config.name} (${config.address})`);

    for (const role of config.roles) {
      const roleName = role === DEFAULT_ADMIN_ROLE ? "DEFAULT_ADMIN" : `0x${role.slice(2, 10)}...`;

      // Check if deployer has this role
      const deployerHasRole = await contract.hasRole(role, deployer.address);
      if (!deployerHasRole) {
        console.log(`   ⏭️  ${roleName}: deployer doesn't have this role, skipping`);
        continue;
      }

      // Check if safe already has this role
      const safeHasRole = await contract.hasRole(role, safeAddress);
      if (safeHasRole) {
        console.log(`   ✅ ${roleName}: Safe already has this role`);
        continue;
      }

      // Grant role to safe
      const tx = await contract.grantRole(role, safeAddress);
      await tx.wait();
      console.log(`   ✅ ${roleName}: Granted to Safe (tx: ${tx.hash})`);
    }
    console.log();
  }

  // ── Phase 2: Verify all grants ────────────────────────────────────
  console.log("\nPHASE 2: VERIFYING GRANTS\n");

  let allGrantsVerified = true;
  for (const config of contracts) {
    if (!config.address) continue;

    const contract = new ethers.Contract(config.address, iface, deployer);
    for (const role of config.roles) {
      const safeHasRole = await contract.hasRole(role, safeAddress);
      if (!safeHasRole) {
        console.log(`❌ ${config.name}: Safe missing role ${role}`);
        allGrantsVerified = false;
      }
    }
  }

  if (!allGrantsVerified) {
    console.error("\n❌ ABORTING: Not all roles were granted to the Safe.");
    console.error("   Fix the failed grants above before proceeding to revocation.");
    process.exit(1);
  }
  console.log("✅ All roles verified on Safe\n");

  // ── Phase 3: Revoke deployer roles ────────────────────────────────
  console.log("PHASE 3: REVOKING DEPLOYER ROLES\n");
  console.log("⚠️  WARNING: This is IRREVERSIBLE. Press Ctrl+C within 10 seconds to abort.\n");

  // 10-second countdown
  for (let i = 10; i > 0; i--) {
    process.stdout.write(`   Revoking in ${i}...\r`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\n");

  for (const config of contracts) {
    if (!config.address) continue;

    const contract = new ethers.Contract(config.address, iface, deployer);
    console.log(`🔒 ${config.name} (${config.address})`);

    // Revoke non-admin roles first, then DEFAULT_ADMIN_ROLE last
    // (revoking DEFAULT_ADMIN first would prevent revoking other roles)
    const sortedRoles = [...config.roles].sort((a, b) => {
      if (a === DEFAULT_ADMIN_ROLE) return 1;
      if (b === DEFAULT_ADMIN_ROLE) return -1;
      return 0;
    });

    for (const role of sortedRoles) {
      const roleName = role === DEFAULT_ADMIN_ROLE ? "DEFAULT_ADMIN" : `0x${role.slice(2, 10)}...`;

      const deployerHasRole = await contract.hasRole(role, deployer.address);
      if (!deployerHasRole) {
        console.log(`   ⏭️  ${roleName}: already revoked`);
        continue;
      }

      const tx = await contract.revokeRole(role, deployer.address);
      await tx.wait();
      console.log(`   🔒 ${roleName}: Revoked from deployer (tx: ${tx.hash})`);
    }
    console.log();
  }

  // ── Phase 4: Final verification ───────────────────────────────────
  console.log("\nPHASE 4: FINAL VERIFICATION\n");

  let migrationComplete = true;
  for (const config of contracts) {
    if (!config.address) continue;

    const contract = new ethers.Contract(config.address, iface, deployer);

    for (const role of config.roles) {
      const roleName = role === DEFAULT_ADMIN_ROLE ? "DEFAULT_ADMIN" : `0x${role.slice(2, 10)}...`;

      const deployerStillHasRole = await contract.hasRole(role, deployer.address);
      const safeHasRole = await contract.hasRole(role, safeAddress);

      if (deployerStillHasRole) {
        console.log(`❌ ${config.name}.${roleName}: Deployer still has role!`);
        migrationComplete = false;
      }
      if (!safeHasRole) {
        console.log(`❌ ${config.name}.${roleName}: Safe doesn't have role!`);
        migrationComplete = false;
      }
    }
  }

  if (migrationComplete) {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  ✅ MIGRATION COMPLETE");
    console.log("  All admin roles transferred to Gnosis Safe");
    console.log("  Deployer EOA has been fully de-privileged");
    console.log("═══════════════════════════════════════════════════════════");
  } else {
    console.log("\n⚠️  MIGRATION INCOMPLETE — see errors above");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
