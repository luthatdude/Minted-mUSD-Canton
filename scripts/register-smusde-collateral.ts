/**
 * @title Register smUSD-E as Collateral
 * @notice Adds smUSD-E (Staked mUSD ETH Pool) as accepted collateral in CollateralVault.
 *         This enables smUSD-E holders to lend and borrow in the same pools as smUSD.
 *
 * Parameters (matching Canton DAML CantonYBStaking template):
 *   - Collateral Factor (LTV):     85%  (8500 bps)
 *   - Liquidation Threshold:       90%  (9000 bps)
 *   - Liquidation Penalty:          5%  (500 bps)
 *
 * Usage:
 *   npx hardhat run scripts/register-smusde-collateral.ts --network <network>
 *
 * Env vars required:
 *   NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS  — CollateralVault proxy
 *   NEXT_PUBLIC_SMUSDE_ADDRESS            — smUSD-E token
 */

import { ethers } from "hardhat";

async function main() {
  const VAULT_ADDRESS = process.env.NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS;
  const SMUSDE_ADDRESS = process.env.NEXT_PUBLIC_SMUSDE_ADDRESS;

  if (!VAULT_ADDRESS || !SMUSDE_ADDRESS) {
    throw new Error(
      "Missing env: NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS and NEXT_PUBLIC_SMUSDE_ADDRESS must be set"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Registering smUSD-E collateral with account:", deployer.address);
  console.log("CollateralVault:", VAULT_ADDRESS);
  console.log("smUSD-E token:", SMUSDE_ADDRESS);

  const vault = await ethers.getContractAt("CollateralVault", VAULT_ADDRESS);

  // Parameters matching Canton DAML CantonYBStaking config
  const COLLATERAL_FACTOR_BPS = 8500;    // 85% LTV
  const LIQUIDATION_THRESHOLD_BPS = 9000; // 90%
  const LIQUIDATION_PENALTY_BPS = 500;    // 5%

  console.log("\nCollateral parameters:");
  console.log(`  LTV (Collateral Factor):  ${COLLATERAL_FACTOR_BPS / 100}%`);
  console.log(`  Liquidation Threshold:    ${LIQUIDATION_THRESHOLD_BPS / 100}%`);
  console.log(`  Liquidation Penalty:      ${LIQUIDATION_PENALTY_BPS / 100}%`);

  // Check if already added
  const config = await vault.collateralConfigs(SMUSDE_ADDRESS);
  if (config.collateralFactorBps > 0n) {
    console.log("\n⚠️  smUSD-E is already registered as collateral:");
    console.log(`  Enabled: ${config.enabled}`);
    console.log(`  LTV: ${Number(config.collateralFactorBps) / 100}%`);
    console.log(`  Liq Threshold: ${Number(config.liquidationThresholdBps) / 100}%`);
    console.log(`  Liq Penalty: ${Number(config.liquidationPenaltyBps) / 100}%`);
    return;
  }

  const tx = await vault.addCollateral(
    SMUSDE_ADDRESS,
    COLLATERAL_FACTOR_BPS,
    LIQUIDATION_THRESHOLD_BPS,
    LIQUIDATION_PENALTY_BPS
  );

  console.log("\nTransaction submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ smUSD-E registered as collateral in block", receipt?.blockNumber);
  console.log("\nsmUSD-E can now be used for lending & borrowing alongside smUSD.");
}

main().catch((error) => {
  console.error("Registration failed:", error);
  process.exitCode = 1;
});
