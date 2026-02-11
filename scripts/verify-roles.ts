// Minted mUSD Protocol - Post-Deploy Role Verification Script
// Verifies all critical access control bindings are correctly configured
// Usage: npx hardhat run scripts/verify-roles.ts --network <network>

import { ethers } from "hardhat";
import * as fs from "fs";

interface RoleCheck {
  contract: string;
  role: string;
  roleHash: string;
  grantee: string;
  granteeName: string;
  hasRole: boolean;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("═".repeat(60));
  console.log("Minted mUSD Protocol — Post-Deploy Role Verification");
  console.log("═".repeat(60));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Verifier: ${deployer.address}`);
  console.log("");

  // ─── Load deployed addresses ───────────────────────────────
  const deploymentFile = `deployments/${network.name}.json`;
  if (!fs.existsSync(deploymentFile)) {
    // Fallback: try loading from hardhat local deployment
    console.log(`⚠ No deployment file found at ${deploymentFile}`);
    console.log("  Provide contract addresses via environment variables or deploy first.");
    console.log("");
    console.log("Expected env vars:");
    console.log("  MUSD_ADDRESS, COLLATERAL_VAULT_ADDRESS, BORROW_MODULE_ADDRESS,");
    console.log("  LIQUIDATION_ENGINE_ADDRESS, DIRECT_MINT_ADDRESS, BRIDGE_ADDRESS,");
    console.log("  TREASURY_ADDRESS, LEVERAGE_VAULT_ADDRESS");
    console.log("");
  }

  // Helper: load address from deployment file or env
  function getAddress(name: string, envKey: string): string | null {
    // Try env var first
    const envVal = process.env[envKey];
    if (envVal) return envVal;

    // Try deployment file
    try {
      const data = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
      if (data.contracts && data.contracts[name]) {
        return data.contracts[name];
      }
    } catch {
      // File not found or invalid JSON
    }
    return null;
  }

  const addresses: Record<string, string | null> = {
    MUSD: getAddress("MUSD", "MUSD_ADDRESS"),
    CollateralVault: getAddress("CollateralVault", "COLLATERAL_VAULT_ADDRESS"),
    BorrowModule: getAddress("BorrowModule", "BORROW_MODULE_ADDRESS"),
    LiquidationEngine: getAddress("LiquidationEngine", "LIQUIDATION_ENGINE_ADDRESS"),
    DirectMint: getAddress("DirectMint", "DIRECT_MINT_ADDRESS"),
    BLEBridgeV9: getAddress("BLEBridgeV9", "BRIDGE_ADDRESS"),
    Treasury: getAddress("Treasury", "TREASURY_ADDRESS"),
    LeverageVault: getAddress("LeverageVault", "LEVERAGE_VAULT_ADDRESS"),
  };

  // Check that we have at least the critical addresses
  const missing = Object.entries(addresses)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    console.log(`⚠ Missing addresses for: ${missing.join(", ")}`);
    console.log("  Skipping checks for those contracts.");
    console.log("");
  }

  // ─── Role hash helpers ─────────────────────────────────────
  const roleHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

  // ─── Define expected role bindings ─────────────────────────
  interface RoleBinding {
    contractName: string;
    contractAddr: string | null;
    roleName: string;
    roleHashVal: string;
    granteeName: string;
    granteeAddr: string | null;
    critical: boolean; // If true, failure is a CRITICAL finding
  }

  const bindings: RoleBinding[] = [
    // MUSD: BRIDGE_ROLE → DirectMint, BLEBridgeV9, BorrowModule
    {
      contractName: "MUSD",
      contractAddr: addresses.MUSD,
      roleName: "BRIDGE_ROLE",
      roleHashVal: roleHash("BRIDGE_ROLE"),
      granteeName: "DirectMint",
      granteeAddr: addresses.DirectMint,
      critical: true,
    },
    {
      contractName: "MUSD",
      contractAddr: addresses.MUSD,
      roleName: "BRIDGE_ROLE",
      roleHashVal: roleHash("BRIDGE_ROLE"),
      granteeName: "BLEBridgeV9",
      granteeAddr: addresses.BLEBridgeV9,
      critical: true,
    },
    {
      contractName: "MUSD",
      contractAddr: addresses.MUSD,
      roleName: "BRIDGE_ROLE",
      roleHashVal: roleHash("BRIDGE_ROLE"),
      granteeName: "BorrowModule",
      granteeAddr: addresses.BorrowModule,
      critical: true,
    },

    // MUSD: LIQUIDATOR_ROLE → LiquidationEngine
    {
      contractName: "MUSD",
      contractAddr: addresses.MUSD,
      roleName: "LIQUIDATOR_ROLE",
      roleHashVal: roleHash("LIQUIDATOR_ROLE"),
      granteeName: "LiquidationEngine",
      granteeAddr: addresses.LiquidationEngine,
      critical: true,
    },

    // BorrowModule: LIQUIDATION_ROLE → LiquidationEngine
    {
      contractName: "BorrowModule",
      contractAddr: addresses.BorrowModule,
      roleName: "LIQUIDATION_ROLE",
      roleHashVal: roleHash("LIQUIDATION_ROLE"),
      granteeName: "LiquidationEngine",
      granteeAddr: addresses.LiquidationEngine,
      critical: true,
    },

    // BorrowModule: BORROW_MODULE_ROLE (legacy) or LEVERAGE_VAULT_ROLE → LeverageVault
    {
      contractName: "BorrowModule",
      contractAddr: addresses.BorrowModule,
      roleName: "LEVERAGE_VAULT_ROLE",
      roleHashVal: roleHash("LEVERAGE_VAULT_ROLE"),
      granteeName: "LeverageVault",
      granteeAddr: addresses.LeverageVault,
      critical: true,
    },

    // CollateralVault: BORROW_MODULE_ROLE → BorrowModule
    {
      contractName: "CollateralVault",
      contractAddr: addresses.CollateralVault,
      roleName: "BORROW_MODULE_ROLE",
      roleHashVal: roleHash("BORROW_MODULE_ROLE"),
      granteeName: "BorrowModule",
      granteeAddr: addresses.BorrowModule,
      critical: true,
    },

    // CollateralVault: LEVERAGE_VAULT_ROLE → LeverageVault
    {
      contractName: "CollateralVault",
      contractAddr: addresses.CollateralVault,
      roleName: "LEVERAGE_VAULT_ROLE",
      roleHashVal: roleHash("LEVERAGE_VAULT_ROLE"),
      granteeName: "LeverageVault",
      granteeAddr: addresses.LeverageVault,
      critical: true,
    },

    // MUSD: DEFAULT_ADMIN_ROLE → Deployer (should be transferred to multisig)
    {
      contractName: "MUSD",
      contractAddr: addresses.MUSD,
      roleName: "DEFAULT_ADMIN_ROLE",
      roleHashVal: DEFAULT_ADMIN_ROLE,
      granteeName: "Deployer",
      granteeAddr: deployer.address,
      critical: false,
    },
  ];

  // ─── Execute checks ───────────────────────────────────────
  const results: RoleCheck[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  console.log("─".repeat(60));
  console.log("Role Binding Checks:");
  console.log("─".repeat(60));

  for (const binding of bindings) {
    if (!binding.contractAddr || !binding.granteeAddr) {
      console.log(`⏭  SKIP  ${binding.contractName}.${binding.roleName} → ${binding.granteeName} (address missing)`);
      skipped++;
      continue;
    }

    try {
      // Use the generic AccessControl ABI to call hasRole
      const contract = await ethers.getContractAt(
        ["function hasRole(bytes32 role, address account) view returns (bool)"],
        binding.contractAddr
      );

      const hasRole = await contract.hasRole(binding.roleHashVal, binding.granteeAddr);

      const status = hasRole ? "✅ PASS" : (binding.critical ? "❌ FAIL" : "⚠ WARN");
      console.log(`${status}  ${binding.contractName}.${binding.roleName} → ${binding.granteeName}`);

      if (hasRole) {
        passed++;
      } else {
        failed++;
      }

      results.push({
        contract: binding.contractName,
        role: binding.roleName,
        roleHash: binding.roleHashVal,
        grantee: binding.granteeAddr,
        granteeName: binding.granteeName,
        hasRole,
      });
    } catch (err: any) {
      console.log(`❌ ERR   ${binding.contractName}.${binding.roleName} → ${binding.granteeName}: ${err.message?.slice(0, 80)}`);
      failed++;
    }
  }

  // ─── Summary ───────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(60));
  console.log("Summary:");
  console.log("─".repeat(60));
  console.log(`  ✅ Passed:  ${passed}`);
  console.log(`  ❌ Failed:  ${failed}`);
  console.log(`  ⏭  Skipped: ${skipped}`);
  console.log(`  Total:     ${bindings.length}`);
  console.log("");

  if (failed > 0) {
    console.log("🚨 CRITICAL: Some role bindings are missing!");
    console.log("   Run the deploy script or manually grant the missing roles.");
    console.log("   Missing roles will cause runtime reverts in production.");
    process.exitCode = 1;
  } else if (skipped > 0) {
    console.log("⚠  Some checks were skipped due to missing addresses.");
    console.log("   Provide all contract addresses for a complete verification.");
  } else {
    console.log("✅ All role bindings verified successfully.");
  }

  console.log("");
  console.log("═".repeat(60));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
