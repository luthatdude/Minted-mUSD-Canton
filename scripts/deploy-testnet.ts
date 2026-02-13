import { ethers } from "hardhat";

/**
 * Testnet deployment script for the Minted / BLE Protocol.
 *
 * Deployment order:
 *   1. MintedTimelockController  (governance primitive — everything depends on it)
 *   2. MUSD                      (stablecoin — needed by most downstream contracts)
 *   3. PriceOracle               (price feeds — needed by vault, borrow, liquidation)
 *   4. InterestRateModel         (rate model — needed by BorrowModule)
 *   5. CollateralVault           (vault — needed by borrow + liquidation)
 *   6. BorrowModule              (lending — needed by liquidation)
 *   7. SMUSD                     (staking vault — needs MUSD)
 *   8. LiquidationEngine         (liquidation — needs vault, borrow, oracle, MUSD)
 *   9. DirectMintV2              (direct mint — needs MUSD, USDC, treasury)
 *  10. TreasuryV2                (UUPS proxy — asset management)
 *  11. BLEBridgeV9               (UUPS proxy — Canton bridge)
 *  12. LeverageVault             (leverage — needs vault, borrow, oracle, MUSD)
 *
 * All non-upgradeable contracts receive `timelockAddress` as their last
 * constructor arg.  UUPS contracts receive it in `initialize()`.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // ─────────────────────────────────────────────────────────────────────
  // Testnet placeholder addresses (replace with real values for staging)
  // ─────────────────────────────────────────────────────────────────────
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // mainnet USDC (fork) or testnet mock
  const FEE_RECIPIENT = deployer.address;
  const SWAP_ROUTER = deployer.address; // placeholder — not used in testnet

  // ─────────────────────────────────────────────────────────────────────
  // 1. MintedTimelockController
  // ─────────────────────────────────────────────────────────────────────
  const MIN_DELAY = 86400; // 24 h (meets MIN_EMERGENCY_DELAY)
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
  const musd = await MUSDFactory.deploy(INITIAL_SUPPLY_CAP);
  await musd.waitForDeployment();
  const musdAddress = await musd.getAddress();
  console.log("MUSD:", musdAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 3. PriceOracle
  // ─────────────────────────────────────────────────────────────────────
  const OracleFactory = await ethers.getContractFactory("PriceOracle");
  const oracle = await OracleFactory.deploy(timelockAddress);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("PriceOracle:", oracleAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 4. InterestRateModel
  // ─────────────────────────────────────────────────────────────────────
  const IRMFactory = await ethers.getContractFactory("InterestRateModel");
  const irm = await IRMFactory.deploy(deployer.address, timelockAddress);
  await irm.waitForDeployment();
  const irmAddress = await irm.getAddress();
  console.log("InterestRateModel:", irmAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 5. CollateralVault
  // ─────────────────────────────────────────────────────────────────────
  const VaultFactory = await ethers.getContractFactory("CollateralVault");
  const vault = await VaultFactory.deploy(timelockAddress);
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
    MIN_DEBT,
    timelockAddress
  );
  await borrow.waitForDeployment();
  const borrowAddress = await borrow.getAddress();
  console.log("BorrowModule:", borrowAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 7. SMUSD
  // ─────────────────────────────────────────────────────────────────────
  const SMUSDFactory = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSDFactory.deploy(musdAddress, timelockAddress);
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
    FEE_RECIPIENT,
    timelockAddress
  );
  await directMint.waitForDeployment();
  const directMintAddress = await directMint.getAddress();
  console.log("DirectMintV2:", directMintAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 10. TreasuryV2 (UUPS proxy)
  // ─────────────────────────────────────────────────────────────────────
  const TreasuryImpl = await ethers.getContractFactory("TreasuryV2");
  const treasuryImpl = await TreasuryImpl.deploy();
  await treasuryImpl.waitForDeployment();
  console.log("TreasuryV2 impl:", await treasuryImpl.getAddress());

  const treasuryInitData = TreasuryImpl.interface.encodeFunctionData("initialize", [
    USDC_ADDRESS,        // _asset
    vaultAddress,        // _vault
    deployer.address,    // _admin
    FEE_RECIPIENT,       // _feeRecipient
    timelockAddress,     // _timelock
  ]);

  const ERC1967ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const treasuryProxy = await ERC1967ProxyFactory.deploy(
    await treasuryImpl.getAddress(),
    treasuryInitData
  );
  await treasuryProxy.waitForDeployment();
  const treasuryAddress = await treasuryProxy.getAddress();
  console.log("TreasuryV2 proxy:", treasuryAddress);

  // ─────────────────────────────────────────────────────────────────────
  // 11. BLEBridgeV9 (UUPS proxy)
  // ─────────────────────────────────────────────────────────────────────
  const BridgeImpl = await ethers.getContractFactory("BLEBridgeV9");
  const bridgeImpl = await BridgeImpl.deploy();
  await bridgeImpl.waitForDeployment();
  console.log("BLEBridgeV9 impl:", await bridgeImpl.getAddress());

  const MIN_SIGS = 2;
  const COLLATERAL_RATIO_BPS = 10000; // 100 %
  const DAILY_CAP_INCREASE = ethers.parseEther("1000000"); // 1 M

  const bridgeInitData = BridgeImpl.interface.encodeFunctionData("initialize", [
    MIN_SIGS,
    musdAddress,
    COLLATERAL_RATIO_BPS,
    DAILY_CAP_INCREASE,
    timelockAddress,
  ]);

  const bridgeProxy = await ERC1967ProxyFactory.deploy(
    await bridgeImpl.getAddress(),
    bridgeInitData
  );
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

  // MUSD: grant BRIDGE_ROLE to BLEBridge and LIQUIDATOR_ROLE to LiquidationEngine
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  await musd.grantRole(BRIDGE_ROLE, bridgeAddress);
  await musd.grantRole(LIQUIDATOR_ROLE, liquidationAddress);
  // Also grant BRIDGE_ROLE to BorrowModule for mint/burn
  await musd.grantRole(BRIDGE_ROLE, borrowAddress);
  console.log("MUSD roles configured");

  // CollateralVault: grant VAULT_ADMIN_ROLE to BorrowModule & LiquidationEngine
  const VAULT_ADMIN_ROLE = await vault.VAULT_ADMIN_ROLE();
  await vault.grantRole(VAULT_ADMIN_ROLE, borrowAddress);
  await vault.grantRole(VAULT_ADMIN_ROLE, liquidationAddress);
  console.log("CollateralVault roles configured");

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== Deployment Summary ===");
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

  console.log("\n=== Post-deployment checklist ===");
  console.log("1. Transfer DEFAULT_ADMIN_ROLE on each contract to a multisig");
  console.log("2. Grant PROPOSER_ROLE / EXECUTOR_ROLE on timelock to the multisig");
  console.log("3. Renounce deployer's admin on the timelock");
  console.log("4. Configure Chainlink feeds on PriceOracle via timelock");
  console.log("5. Add collateral tokens to CollateralVault via timelock");
  console.log("6. Set BorrowModule on SMUSD via timelock (setInterestRateModel, setSMUSD, setTreasury)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
