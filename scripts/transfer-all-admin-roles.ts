// ══════════════════════════════════════════════════════════════════════
// Transfer DEFAULT_ADMIN_ROLE on ALL contracts from old deployer to new
// ══════════════════════════════════════════════════════════════════════
// Usage:
//   1. Temporarily set DEPLOYER_PRIVATE_KEY in .env to the OLD deployer key
//      (the 0x7De39963... key that currently holds DEFAULT_ADMIN_ROLE)
//   2. npx hardhat run scripts/transfer-all-admin-roles.ts --network sepolia
//   3. Restore DEPLOYER_PRIVATE_KEY to the NEW key (0xe640db3A...)
//
// This script:
//   - Grants DEFAULT_ADMIN_ROLE to NEW_DEPLOYER on all contracts
//   - Grants MINTER_ROLE (where applicable) to NEW_DEPLOYER
//   - Grants TIMELOCK_ROLE to NEW_DEPLOYER on PriceOracle (for testnet feed config)
//   - Does NOT revoke old deployer roles (run revoke step separately after verification)

import { ethers } from "hardhat";

const NEW_DEPLOYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";

// All deployed contracts on Sepolia (2026-02-17)
const CONTRACTS: Record<string, { address: string; artifact: string; extraRoles?: string[] }> = {
  MUSD: {
    address: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
    artifact: "MUSD",
    extraRoles: ["MINTER_ROLE"],
  },
  SMUSD: {
    address: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
    artifact: "SMUSD",
  },
  DirectMintV2: {
    address: "0xa869f58c213634Dda2Ef522b66E9587b953279C2",
    artifact: "DirectMintV2",
    extraRoles: ["MINTER_ROLE"],
  },
  CollateralVault: {
    address: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
    artifact: "CollateralVault",
  },
  BorrowModule: {
    address: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
    artifact: "BorrowModule",
  },
  PriceOracle: {
    address: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
    artifact: "PriceOracle",
    extraRoles: ["ORACLE_ADMIN_ROLE", "TIMELOCK_ROLE"],
  },
  InterestRateModel: {
    address: "0x501265BeF81E6E96e4150661e2b9278272e9177B",
    artifact: "InterestRateModel",
  },
  LiquidationEngine: {
    address: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
    artifact: "LiquidationEngine",
  },
  LeverageVault: {
    address: "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
    artifact: "LeverageVault",
  },
  GlobalPauseRegistry: {
    address: "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F",
    artifact: "GlobalPauseRegistry",
  },
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Transfer Admin Roles: All Contracts");
  console.log("═".repeat(60));
  console.log(`Signer (must be OLD deployer): ${signer.address}`);
  console.log(`New deployer: ${NEW_DEPLOYER}`);
  console.log(`Timelock: ${TIMELOCK}`);

  if (signer.address.toLowerCase() !== OLD_DEPLOYER.toLowerCase()) {
    console.error("\n❌ ERROR: Signer is NOT the old deployer.");
    console.error("Set DEPLOYER_PRIVATE_KEY in .env to the OLD deployer key.");
    process.exit(1);
  }

  let success = 0;
  let failed = 0;

  for (const [name, config] of Object.entries(CONTRACTS)) {
    console.log(`\n── ${name} (${config.address}) ──`);
    try {
      const contract = await ethers.getContractAt(config.artifact, config.address);
      const ADMIN_ROLE = await contract.DEFAULT_ADMIN_ROLE();

      // Check current state
      const newHasAdmin = await contract.hasRole(ADMIN_ROLE, NEW_DEPLOYER);
      if (newHasAdmin) {
        console.log("  ✅ New deployer already has DEFAULT_ADMIN_ROLE");
        success++;
        continue;
      }

      // Grant DEFAULT_ADMIN_ROLE to new deployer
      const tx = await contract.grantRole(ADMIN_ROLE, NEW_DEPLOYER);
      await tx.wait();
      console.log("  ✅ Granted DEFAULT_ADMIN_ROLE to new deployer");

      // Grant extra roles if defined
      if (config.extraRoles) {
        for (const roleName of config.extraRoles) {
          try {
            const role = await (contract as any)[roleName]();
            const hasBefore = await contract.hasRole(role, NEW_DEPLOYER);
            if (!hasBefore) {
              const tx2 = await contract.grantRole(role, NEW_DEPLOYER);
              await tx2.wait();
              console.log(`  ✅ Granted ${roleName} to new deployer`);
            } else {
              console.log(`  ✅ New deployer already has ${roleName}`);
            }
          } catch (e: any) {
            console.log(`  ⚠️  Could not grant ${roleName}: ${e.message.slice(0, 80)}`);
          }
        }
      }

      // Also grant DEFAULT_ADMIN_ROLE to Timelock (governance)
      const timelockHasAdmin = await contract.hasRole(ADMIN_ROLE, TIMELOCK);
      if (!timelockHasAdmin) {
        const tx3 = await contract.grantRole(ADMIN_ROLE, TIMELOCK);
        await tx3.wait();
        console.log("  ✅ Granted DEFAULT_ADMIN_ROLE to Timelock");
      }

      success++;
    } catch (e: any) {
      console.error(`  ❌ FAILED: ${e.message.slice(0, 120)}`);
      failed++;
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`Admin role results: ${success} succeeded, ${failed} failed`);
  console.log("═".repeat(60));

  // ══════════════════════════════════════════════════════════
  // Phase 2: Cross-contract role grants
  // These roles let contracts call each other (e.g. DirectMintV2 → MUSD.mint)
  // ══════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("Phase 2: Cross-Contract Role Grants");
  console.log("══════════════════════════════════════════════════════════");

  const crossRoles: { contract: string; addr: string; role: string; grantee: string; granteeName: string }[] = [
    // DirectMintV2 needs BRIDGE_ROLE on MUSD to call musd.mint() / musd.burn()
    { contract: "MUSD", addr: CONTRACTS.MUSD.address, role: "BRIDGE_ROLE", grantee: CONTRACTS.DirectMintV2.address, granteeName: "DirectMintV2" },
    // BLEBridgeV9 needs BRIDGE_ROLE on MUSD to call musd.mint()
    { contract: "MUSD", addr: CONTRACTS.MUSD.address, role: "BRIDGE_ROLE", grantee: "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125", granteeName: "BLEBridgeV9" },
    // LiquidationEngine needs LIQUIDATOR_ROLE on MUSD for liquidation burns
    { contract: "MUSD", addr: CONTRACTS.MUSD.address, role: "LIQUIDATOR_ROLE", grantee: CONTRACTS.LiquidationEngine.address, granteeName: "LiquidationEngine" },
    // BorrowModule needs BORROW_MODULE_ROLE on CollateralVault for seizure
    { contract: "CollateralVault", addr: CONTRACTS.CollateralVault.address, role: "BORROW_MODULE_ROLE", grantee: CONTRACTS.BorrowModule.address, granteeName: "BorrowModule" },
    // LiquidationEngine needs LIQUIDATION_ROLE on CollateralVault for seizing collateral
    { contract: "CollateralVault", addr: CONTRACTS.CollateralVault.address, role: "LIQUIDATION_ROLE", grantee: CONTRACTS.LiquidationEngine.address, granteeName: "LiquidationEngine" },
    // LeverageVault needs LEVERAGE_VAULT_ROLE on CollateralVault for depositFor
    { contract: "CollateralVault", addr: CONTRACTS.CollateralVault.address, role: "LEVERAGE_VAULT_ROLE", grantee: CONTRACTS.LeverageVault.address, granteeName: "LeverageVault" },
    // BLEBridgeV9 needs CAP_MANAGER_ROLE on MUSD for supply cap updates
    { contract: "MUSD", addr: CONTRACTS.MUSD.address, role: "CAP_MANAGER_ROLE", grantee: "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125", granteeName: "BLEBridgeV9" },
  ];

  let crossSuccess = 0;
  let crossFailed = 0;

  for (const cr of crossRoles) {
    console.log(`\n  ${cr.contract}.${cr.role} → ${cr.granteeName}`);
    try {
      const contract = await ethers.getContractAt(
        CONTRACTS[cr.contract as keyof typeof CONTRACTS]?.artifact || cr.contract,
        cr.addr
      );
      const roleHash = await (contract as any)[cr.role]();
      const already = await contract.hasRole(roleHash, cr.grantee);
      if (already) {
        console.log(`    ✅ Already granted`);
        crossSuccess++;
        continue;
      }
      const tx = await contract.grantRole(roleHash, cr.grantee);
      await tx.wait();
      console.log(`    ✅ Granted`);
      crossSuccess++;
    } catch (e: any) {
      console.error(`    ❌ FAILED: ${e.message.slice(0, 120)}`);
      crossFailed++;
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`Cross-role results: ${crossSuccess} succeeded, ${crossFailed} failed`);
  console.log("═".repeat(60));

  const totalFailed = failed + crossFailed;
  if (totalFailed === 0) {
    console.log("\n✅ All admin roles transferred successfully!");
    console.log("Next steps:");
    console.log("  1. Restore DEPLOYER_PRIVATE_KEY in .env to the NEW key (0xe640...)");
    console.log("  2. Verify with: node /tmp/check-all-roles.js");
    console.log("  3. Run test scripts: npx hardhat run scripts/deploy-mock-oracles.ts --network sepolia");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
