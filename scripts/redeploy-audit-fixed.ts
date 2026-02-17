import { ethers, upgrades } from "hardhat";

/**
 * Redeploy contracts modified by audit fix commit (041d154) so bytecode
 * matches current source for Etherscan verification.
 *
 * Contracts redeployed (non-proxy):
 *   - MUSD, BorrowModule, SMUSD, LiquidationEngine, DirectMintV2, LeverageVault
 *
 * Contracts upgraded in-place (UUPS proxy):
 *   - TreasuryV2 (proxy 0x11Cc…), BLEBridgeV9 (proxy 0xB466…)
 *
 * Unchanged contracts (already verified):
 *   - GlobalPauseRegistry, MintedTimelockController, PriceOracle,
 *     InterestRateModel, CollateralVault
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("Balance:", startBalance, "ETH");
  if (parseFloat(startBalance) < 0.05) throw new Error("Need >= 0.05 ETH for redeployment");

  // ═══════════════════════════════════════════════════════════════════════
  // UNCHANGED ADDRESSES (already verified on Etherscan)
  // ═══════════════════════════════════════════════════════════════════════
  const gprAddress      = "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F";
  const timelockAddress = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const oracleAddress   = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const irmAddress      = "0x501265BeF81E6E96e4150661e2b9278272e9177B";
  const vaultAddress    = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";

  // UUPS proxy addresses (stay the same, implementation upgraded)
  const treasuryProxyAddress = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";
  const bridgeProxyAddress   = "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125";

  const USDC_ADDRESS  = deployer.address; // placeholder for testnet
  const FEE_RECIPIENT = deployer.address;
  const SWAP_ROUTER   = deployer.address;

  // ═══════════════════════════════════════════════════════════════════════
  // REDEPLOY NON-PROXY CONTRACTS
  // ═══════════════════════════════════════════════════════════════════════

  // ─── 1. MUSD ───
  console.log("\n[1/8] Redeploying MUSD...");
  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000"); // 10 M
  const MUSDFactory = await ethers.getContractFactory("MUSD");
  const musd = await MUSDFactory.deploy(INITIAL_SUPPLY_CAP, gprAddress);
  await musd.waitForDeployment();
  const musdAddress = await musd.getAddress();
  console.log("  MUSD:", musdAddress);

  // ─── 2. BorrowModule ───
  console.log("\n[2/8] Redeploying BorrowModule...");
  const INTEREST_RATE_BPS = 500; // 5%
  const MIN_DEBT = ethers.parseEther("100");
  const BorrowFactory = await ethers.getContractFactory("BorrowModule");
  const borrow = await BorrowFactory.deploy(
    vaultAddress, oracleAddress, musdAddress, INTEREST_RATE_BPS, MIN_DEBT
  );
  await borrow.waitForDeployment();
  const borrowAddress = await borrow.getAddress();
  console.log("  BorrowModule:", borrowAddress);

  // ─── 3. SMUSD ───
  console.log("\n[3/8] Redeploying SMUSD...");
  const SMUSDFactory = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSDFactory.deploy(musdAddress, gprAddress);
  await smusd.waitForDeployment();
  const smusdAddress = await smusd.getAddress();
  console.log("  SMUSD:", smusdAddress);

  // ─── 4. LiquidationEngine ───
  console.log("\n[4/8] Redeploying LiquidationEngine...");
  const CLOSE_FACTOR_BPS = 5000; // 50%
  const LiqFactory = await ethers.getContractFactory("LiquidationEngine");
  const liquidation = await LiqFactory.deploy(
    vaultAddress, borrowAddress, oracleAddress, musdAddress,
    CLOSE_FACTOR_BPS, timelockAddress
  );
  await liquidation.waitForDeployment();
  const liquidationAddress = await liquidation.getAddress();
  console.log("  LiquidationEngine:", liquidationAddress);

  // ─── 5. DirectMintV2 ───
  console.log("\n[5/8] Redeploying DirectMintV2...");
  const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
  const directMint = await DirectMintFactory.deploy(
    USDC_ADDRESS, musdAddress, deployer.address, FEE_RECIPIENT
  );
  await directMint.waitForDeployment();
  const directMintAddress = await directMint.getAddress();
  console.log("  DirectMintV2:", directMintAddress);

  // ─── 6. LeverageVault ───
  console.log("\n[6/8] Redeploying LeverageVault...");
  const LeverageFactory = await ethers.getContractFactory("LeverageVault");
  const leverage = await LeverageFactory.deploy(
    SWAP_ROUTER, vaultAddress, borrowAddress, oracleAddress,
    musdAddress, timelockAddress
  );
  await leverage.waitForDeployment();
  const leverageAddress = await leverage.getAddress();
  console.log("  LeverageVault:", leverageAddress);

  // ═══════════════════════════════════════════════════════════════════════
  // UPGRADE UUPS PROXIES (same address, new implementation)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── 7. TreasuryV2 upgrade ───
  console.log("\n[7/8] Upgrading TreasuryV2 proxy...");
  const TreasuryV2Factory = await ethers.getContractFactory("TreasuryV2");
  const treasuryUpgraded = await upgrades.upgradeProxy(treasuryProxyAddress, TreasuryV2Factory);
  await treasuryUpgraded.waitForDeployment();
  console.log("  TreasuryV2 upgraded at:", treasuryProxyAddress);

  // ─── 8. BLEBridgeV9 upgrade ───
  console.log("\n[8/8] Upgrading BLEBridgeV9 proxy...");
  const BLEBridgeV9Factory = await ethers.getContractFactory("BLEBridgeV9");
  const bridgeUpgraded = await upgrades.upgradeProxy(bridgeProxyAddress, BLEBridgeV9Factory);
  await bridgeUpgraded.waitForDeployment();
  console.log("  BLEBridgeV9 upgraded at:", bridgeProxyAddress);

  // ═══════════════════════════════════════════════════════════════════════
  // ROLE CONFIGURATION (new contract addresses need roles)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Configuring roles ===");

  // MUSD roles
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  await (await musd.grantRole(BRIDGE_ROLE, bridgeProxyAddress)).wait();
  console.log("  MUSD: BRIDGE_ROLE -> BLEBridgeV9");
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress)).wait();
  console.log("  MUSD: LIQUIDATOR_ROLE -> LiquidationEngine");
  await (await musd.grantRole(BRIDGE_ROLE, borrowAddress)).wait();
  console.log("  MUSD: BRIDGE_ROLE -> BorrowModule");

  // CollateralVault roles
  const vault = await ethers.getContractAt("CollateralVault", vaultAddress);
  const VAULT_ADMIN_ROLE = await vault.VAULT_ADMIN_ROLE();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, borrowAddress)).wait();
  console.log("  CollateralVault: VAULT_ADMIN_ROLE -> BorrowModule");
  await (await vault.grantRole(VAULT_ADMIN_ROLE, liquidationAddress)).wait();
  console.log("  CollateralVault: VAULT_ADMIN_ROLE -> LiquidationEngine");

  // BLEBridgeV9 validator role
  const bridge = await ethers.getContractAt("BLEBridgeV9", bridgeProxyAddress);
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  await (await bridge.grantRole(VALIDATOR_ROLE, deployer.address)).wait();
  console.log("  BLEBridgeV9: VALIDATOR_ROLE -> deployer");

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== REDEPLOYMENT COMPLETE ==========");
  console.log("--- Unchanged (already verified) ---");
  console.log("GlobalPauseRegistry:      ", gprAddress);
  console.log("MintedTimelockController: ", timelockAddress);
  console.log("PriceOracle:              ", oracleAddress);
  console.log("InterestRateModel:        ", irmAddress);
  console.log("CollateralVault:          ", vaultAddress);
  console.log("");
  console.log("--- Redeployed (new addresses) ---");
  console.log("MUSD:                     ", musdAddress);
  console.log("BorrowModule:             ", borrowAddress);
  console.log("SMUSD:                    ", smusdAddress);
  console.log("LiquidationEngine:        ", liquidationAddress);
  console.log("DirectMintV2:             ", directMintAddress);
  console.log("LeverageVault:            ", leverageAddress);
  console.log("");
  console.log("--- Upgraded in-place (same proxy) ---");
  console.log("TreasuryV2 (proxy):       ", treasuryProxyAddress);
  console.log("BLEBridgeV9 (proxy):      ", bridgeProxyAddress);
  console.log("===========================================");
  console.log("Gas used:", (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6), "ETH");
  console.log("Remaining:", remaining, "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
