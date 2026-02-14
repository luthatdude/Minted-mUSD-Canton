/**
 * M-05: Storage Layout Validation for UUPS Upgradeable Contracts
 *
 * Compiles all upgradeable contracts via Hardhat and uses
 * @openzeppelin/upgrades-core to verify that no storage collisions or
 * layout-breaking changes have been introduced.
 *
 * Run standalone:   npx hardhat run scripts/validate-storage-layout.ts
 * Run in CI:        see .github/workflows/ci.yml → storage-layout job
 */

import { ethers, upgrades } from "hardhat";

// All UUPS-upgradeable contracts that must pass layout validation.
// Add new contracts here as they are created.
const UPGRADEABLE_CONTRACTS = [
  "BLEBridgeV9",
  "TreasuryV2",
  "PendleStrategyV2",
  "MorphoLoopStrategy",
  "SkySUSDSStrategy",
  "PendleMarketSelector",
  "LiquidationEngineUpgradeable",
  "BorrowModuleUpgradeable",
  "LeverageVaultUpgradeable",
  "CollateralVaultUpgradeable",
  "SMUSDUpgradeable",
];

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  M-05: UUPS Storage Layout Validation");
  console.log("═══════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const name of UPGRADEABLE_CONTRACTS) {
    process.stdout.write(`  Validating ${name}...`);
    try {
      const Factory = await ethers.getContractFactory(name);
      // validateImplementation checks:
      //  - No constructor with state changes (initializer pattern enforced)
      //  - No selfdestruct / delegatecall in implementation
      //  - Storage layout compatibility (if reference exists in .openzeppelin/)
      await upgrades.validateImplementation(Factory, {
        kind: "uups",
      });
      console.log(" ✅");
      passed++;
    } catch (err: any) {
      console.log(" ❌");
      const msg = err.message || String(err);
      errors.push(`${name}: ${msg}`);
      failed++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (errors.length > 0) {
    console.error("Failures:\n");
    errors.forEach((e) => console.error(`  • ${e}\n`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
