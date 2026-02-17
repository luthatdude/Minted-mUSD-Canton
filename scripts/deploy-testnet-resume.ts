import { ethers, upgrades } from "hardhat";

/**
 * RESUME deployment from step 6 (BorrowModule).
 * Steps 0–5 were deployed in the prior run. Addresses hardcoded below.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const startBalance = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("Balance:", startBalance, "ETH");
  if (parseFloat(startBalance) < 0.01) throw new Error("Insufficient Sepolia ETH");

  const USDC_ADDRESS = deployer.address; // placeholder for testnet
  const FEE_RECIPIENT = deployer.address;
  const SWAP_ROUTER = deployer.address;

  // ═══════════════════════════════════════════════════════════════════════
  // ALREADY DEPLOYED (steps 0–5)
  // ═══════════════════════════════════════════════════════════════════════
  const gprAddress      = "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F";
  const timelockAddress = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const musdAddress     = "0x76AA12B576b72041b91FDE11e33c4eb2fCfa48FA";
  const oracleAddress   = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const irmAddress      = "0x501265BeF81E6E96e4150661e2b9278272e9177B";
  const vaultAddress    = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";

  console.log("=== Resuming from step 6 ===");
  console.log("GlobalPauseRegistry:", gprAddress);
  console.log("MintedTimelockController:", timelockAddress);
  console.log("MUSD:", musdAddress);
  console.log("PriceOracle:", oracleAddress);
  console.log("InterestRateModel:", irmAddress);
  console.log("CollateralVault:", vaultAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 6. BorrowModule
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[6/12] Deploying BorrowModule...");
  const INTEREST_RATE_BPS = 500; // 5 %
  const MIN_DEBT = ethers.parseEther("100"); // 100 mUSD minimum

  const BorrowFactory = await ethers.getContractFactory("BorrowModule");
  const borrow = await BorrowFactory.deploy(
    vaultAddress,
    oracleAddress,
    musdAddress,
    INTEREST_RATE_BPS,
    MIN_DEBT
  );
  await borrow.waitForDeployment();
  const borrowAddress = await borrow.getAddress();
  console.log("BorrowModule:", borrowAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 7. SMUSD
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[7/12] Deploying SMUSD...");
  const SMUSDFactory = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSDFactory.deploy(musdAddress, gprAddress);
  await smusd.waitForDeployment();
  const smusdAddress = await smusd.getAddress();
  console.log("SMUSD:", smusdAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 8. LiquidationEngine
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[8/12] Deploying LiquidationEngine...");
  const CLOSE_FACTOR_BPS = 5000; // 50 %

  const LiqFactory = await ethers.getContractFactory("LiquidationEngine");
  const liquidation = await LiqFactory.deploy(
    vaultAddress,
    borrowAddress,
    oracleAddress,
    musdAddress,
    CLOSE_FACTOR_BPS
  );
  await liquidation.waitForDeployment();
  const liquidationAddress = await liquidation.getAddress();
  console.log("LiquidationEngine:", liquidationAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 9. DirectMintV2
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[9/12] Deploying DirectMintV2...");
  const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
  const directMint = await DirectMintFactory.deploy(
    USDC_ADDRESS,
    musdAddress,
    deployer.address, // treasury placeholder
    FEE_RECIPIENT
  );
  await directMint.waitForDeployment();
  const directMintAddress = await directMint.getAddress();
  console.log("DirectMintV2:", directMintAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 10. TreasuryV2 (UUPS proxy)
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[10/12] Deploying TreasuryV2 (UUPS proxy)...");
  const TreasuryImpl = await ethers.getContractFactory("TreasuryV2");
  const treasuryProxy = await upgrades.deployProxy(TreasuryImpl, [
    USDC_ADDRESS, vaultAddress, deployer.address, FEE_RECIPIENT, timelockAddress,
  ], { kind: "uups" });
  await treasuryProxy.waitForDeployment();
  const treasuryAddress = await treasuryProxy.getAddress();
  console.log("TreasuryV2 proxy:", treasuryAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 11. BLEBridgeV9 (UUPS proxy)
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[11/12] Deploying BLEBridgeV9 (UUPS proxy)...");
  const BridgeImpl = await ethers.getContractFactory("BLEBridgeV9");
  const MIN_SIGS = 1; // testnet: single validator
  const COLLATERAL_RATIO_BPS = 10000; // 100 %
  const DAILY_CAP_INCREASE = ethers.parseEther("1000000"); // 1 M

  const bridgeProxy = await upgrades.deployProxy(BridgeImpl, [
    MIN_SIGS, musdAddress, COLLATERAL_RATIO_BPS, DAILY_CAP_INCREASE, timelockAddress,
  ], { kind: "uups" });
  await bridgeProxy.waitForDeployment();
  const bridgeAddress = await bridgeProxy.getAddress();
  console.log("BLEBridgeV9 proxy:", bridgeAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 12. LeverageVault
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n[12/12] Deploying LeverageVault...");
  const LeverageFactory = await ethers.getContractFactory("LeverageVault");
  const leverage = await LeverageFactory.deploy(
    SWAP_ROUTER,
    vaultAddress,
    borrowAddress,
    oracleAddress,
    musdAddress,
    timelockAddress
  );
  await leverage.waitForDeployment();
  const leverageAddress = await leverage.getAddress();
  console.log("LeverageVault:", leverageAddress);

  // ═══════════════════════════════════════════════════════════════════════
  // ROLE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Configuring roles ===");

  const musd = await ethers.getContractAt("MUSD", musdAddress);
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  await (await musd.grantRole(BRIDGE_ROLE, bridgeAddress)).wait();
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress)).wait();
  await (await musd.grantRole(BRIDGE_ROLE, borrowAddress)).wait();
  console.log("MUSD roles configured");

  const vault = await ethers.getContractAt("CollateralVault", vaultAddress);
  const VAULT_ADMIN_ROLE = await vault.VAULT_ADMIN_ROLE();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, borrowAddress)).wait();
  await (await vault.grantRole(VAULT_ADMIN_ROLE, liquidationAddress)).wait();
  console.log("CollateralVault roles configured");

  // Register deployer as validator on BLEBridgeV9 for testnet
  const bridge = await ethers.getContractAt("BLEBridgeV9", bridgeAddress);
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  await (await bridge.grantRole(VALIDATOR_ROLE, deployer.address)).wait();
  console.log("BLEBridgeV9: deployer registered as validator");

  // ═══════════════════════════════════════════════════════════════════════
  const remaining = ethers.formatEther(await ethers.provider.getBalance(deployer.address));
  console.log("\n========== SEPOLIA DEPLOYMENT COMPLETE ==========");
  console.log("GlobalPauseRegistry:", gprAddress);
  console.log("MintedTimelockController:", timelockAddress);
  console.log("MUSD:", musdAddress);
  console.log("PriceOracle:", oracleAddress);
  console.log("InterestRateModel:", irmAddress);
  console.log("CollateralVault:", vaultAddress);
  console.log("BorrowModule:", borrowAddress);
  console.log("SMUSD:", smusdAddress);
  console.log("LiquidationEngine:", liquidationAddress);
  console.log("DirectMintV2:", directMintAddress);
  console.log("TreasuryV2 (proxy):", treasuryAddress);
  console.log("BLEBridgeV9 (proxy):", bridgeAddress);
  console.log("LeverageVault:", leverageAddress);
  console.log("=================================================");
  console.log("Gas used:", (parseFloat(startBalance) - parseFloat(remaining)).toFixed(6), "ETH");
  console.log("Remaining:", remaining, "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
