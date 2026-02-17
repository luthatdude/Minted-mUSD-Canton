import { ethers, upgrades } from "hardhat";

/**
 * Testnet deployment script for the Minted / BLE Protocol.
 *
 * Deployment order:
 *   0. GlobalPauseRegistry       (needed by MUSD, SMUSD, CollateralVault)
 *   1. MintedTimelockController   (governance primitive)
 *   2. MUSD                       (stablecoin)
 *   3. PriceOracle                (price feeds)
 *   4. InterestRateModel          (rate model)
 *   5. CollateralVault            (vault)
 *   6. BorrowModule               (lending)
 *   7. SMUSD                      (staking vault)
 *   8. LiquidationEngine          (liquidation)
 *   9. DirectMintV2               (direct mint)
 *  10. TreasuryV2                 (UUPS proxy)
 *  11. BLEBridgeV9                (UUPS proxy — Canton bridge)
 *  12. LeverageVault              (leverage)
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

  // ─── 0. GlobalPauseRegistry ───
  console.log("\n[0/12] Deploying GlobalPauseRegistry...");
  const GPRFactory = await ethers.getContractFactory("GlobalPauseRegistry");
  const gpr = await GPRFactory.deploy(deployer.address, deployer.address);
  await gpr.waitForDeployment();
  const gprAddress = await gpr.getAddress();
  console.log("GlobalPauseRegistry:", gprAddress);

  // ─── 1. MintedTimelockController ───
  console.log("\n[1/12] Deploying MintedTimelockController...");
  const MIN_DELAY = 86400;
  const proposers = [deployer.address];
  const executors = [deployer.address];
  const admin = deployer.address;

  const TimelockFactory = await ethers.getContractFactory("MintedTimelockController");
  const timelock = await TimelockFactory.deploy(MIN_DELAY, proposers, executors, admin);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("MintedTimelockController:", timelockAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 2. MUSD
  // ─────────────────────────────────────────────────────────────────────
  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000"); // 10 M mUSD
  const MUSDFactory = await ethers.getContractFactory("MUSD");
  const musd = await MUSDFactory.deploy(INITIAL_SUPPLY_CAP, gprAddress);
  await musd.waitForDeployment();
  const musdAddress = await musd.getAddress();
  console.log("MUSD:", musdAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 3. PriceOracle
  // ─────────────────────────────────────────────────────────────────────
  const OracleFactory = await ethers.getContractFactory("PriceOracle");
  const oracle = await OracleFactory.deploy();
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("PriceOracle:", oracleAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 4. InterestRateModel
  // ─────────────────────────────────────────────────────────────────────
  const IRMFactory = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRMFactory.deploy(deployer.address);
  await irm.waitForDeployment();
  const irmAddress = await irm.getAddress();
  console.log("InterestRateModel:", irmAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 5. CollateralVault
  // ─────────────────────────────────────────────────────────────────────
  const VaultFactory = await ethers.getContractFactory("CollateralVault");
  const vault = await VaultFactory.deploy(gprAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("CollateralVault:", vaultAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 6. BorrowModule
  // ─────────────────────────────────────────────────────────────────────
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
  const SMUSDFactory = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSDFactory.deploy(musdAddress, gprAddress);
  await smusd.waitForDeployment();
  const smusdAddress = await smusd.getAddress();
  console.log("SMUSD:", smusdAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 8. LiquidationEngine
  // ─────────────────────────────────────────────────────────────────────
  const CLOSE_FACTOR_BPS = 5000; // 50 %

  const LiqFactory = await ethers.getContractFactory("LiquidationEngine");
  const liquidation = await LiqFactory.deploy(
    vaultAddress,
    borrowAddress,
    oracleAddress,
    musdAddress,
    CLOSE_FACTOR_BPS,
    timelockAddress
  );
  await liquidation.waitForDeployment();
  const liquidationAddress = await liquidation.getAddress();
  console.log("LiquidationEngine:", liquidationAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 9. DirectMintV2
  // ─────────────────────────────────────────────────────────────────────
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
  const BridgeImpl = await ethers.getContractFactory("BLEBridgeV9");
  const MIN_SIGS = 2; // contract enforces >= 2
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

  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  await (await musd.grantRole(BRIDGE_ROLE, bridgeAddress)).wait();
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress)).wait();
  await (await musd.grantRole(BRIDGE_ROLE, borrowAddress)).wait();
  console.log("MUSD roles configured");

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
