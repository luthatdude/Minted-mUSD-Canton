/**
 * @title Register smUSD as Collateral
 * @notice Adds smUSD (Staked mUSD, ERC-4626 vault) as accepted collateral in CollateralVault.
 *         This enables smUSD holders to borrow mUSD against their yield-bearing position.
 *
 * Parameters (matching Canton DAML CantonLending defaultSMUSDConfig):
 *   - Collateral Factor (LTV):     90%  (9000 bps)
 *   - Liquidation Threshold:       93%  (9300 bps)
 *   - Liquidation Penalty:          4%  (400 bps)
 *
 * Rationale:
 *   smUSD is the primary yield-bearing token in the protocol (ERC-4626 wrapper over mUSD).
 *   High LTV is justified because smUSD is denominated in mUSD — minimal price deviation.
 *   The 3% buffer between LTV and liquidation threshold accounts for cooldown/yield lag.
 *   4% penalty is lower than volatile assets (WETH 5%, WBTC 5%) since smUSD is stable.
 *
 * Usage:
 *   npx hardhat run scripts/register-smusd-collateral.ts --network <network>
 *
 * Env vars required:
 *   NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS  — CollateralVault proxy
 *   NEXT_PUBLIC_SMUSD_ADDRESS             — smUSD token (ERC-4626)
 */

import { ethers } from "hardhat";

async function main() {
  const VAULT_ADDRESS = process.env.NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS;
  const SMUSD_ADDRESS = process.env.NEXT_PUBLIC_SMUSD_ADDRESS;

  if (!VAULT_ADDRESS || !SMUSD_ADDRESS) {
    throw new Error(
      "Missing env: NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS and NEXT_PUBLIC_SMUSD_ADDRESS must be set"
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Registering smUSD collateral with account:", deployer.address);
  console.log("CollateralVault:", VAULT_ADDRESS);
  console.log("smUSD token:", SMUSD_ADDRESS);

  const vault = await ethers.getContractAt("CollateralVault", VAULT_ADDRESS);

  // Parameters matching Canton DAML CantonLending defaultSMUSDConfig
  const COLLATERAL_FACTOR_BPS = 9000;     // 90% LTV — yield-bearing stable
  const LIQUIDATION_THRESHOLD_BPS = 9300;  // 93%
  const LIQUIDATION_PENALTY_BPS = 400;     // 4% penalty

  console.log("\nCollateral parameters:");
  console.log(`  LTV (Collateral Factor):  ${COLLATERAL_FACTOR_BPS / 100}%`);
  console.log(`  Liquidation Threshold:    ${LIQUIDATION_THRESHOLD_BPS / 100}%`);
  console.log(`  Liquidation Penalty:      ${LIQUIDATION_PENALTY_BPS / 100}%`);

  // Check if already added
  const config = await vault.collateralConfigs(SMUSD_ADDRESS);
  if (config.collateralFactorBps > 0n) {
    console.log("\n⚠️  smUSD is already registered as collateral:");
    console.log(`  Enabled: ${config.enabled}`);
    console.log(`  LTV: ${Number(config.collateralFactorBps) / 100}%`);
    console.log(`  Liq Threshold: ${Number(config.liquidationThresholdBps) / 100}%`);
    console.log(`  Liq Penalty: ${Number(config.liquidationPenaltyBps) / 100}%`);
    return;
  }

  const tx = await vault.addCollateral(
    SMUSD_ADDRESS,
    COLLATERAL_FACTOR_BPS,
    LIQUIDATION_THRESHOLD_BPS,
    LIQUIDATION_PENALTY_BPS
  );

  console.log("\nTransaction submitted:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ smUSD registered as collateral in block", receipt?.blockNumber);
  console.log("\nsmUSD can now be used for lending & borrowing alongside WETH, WBTC, and smUSD-E.");
}

main().catch((error) => {
  console.error("Registration failed:", error);
  process.exitCode = 1;
});
