import { ethers, upgrades } from "hardhat";
import * as fs from "fs";

interface DeployedContracts {
  network: string;
  chainId: number;
  timestamp: string;
  deployer: string;
  contracts: {
    MUSD: string;
    SMUSD: string;
    MockUSDC: string;
    PriceOracle: string;
    CollateralVault: string;
    BorrowModule: string;
    LiquidationEngine: string;
    DirectMint: string;
    Treasury: string;
    BLEBridgeV9: string;
  };
  chainlinkFeeds: {
    ETH_USD: string;
    BTC_USD: string;
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=".repeat(72));
  console.log("Minted mUSD Protocol - Testnet Deployment");
  console.log("=".repeat(72));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient balance. Need at least 0.1 ETH for deployment.");
  }

  const CHAINLINK_ETH_USD = process.env.CHAINLINK_ETH_USD || "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const CHAINLINK_BTC_USD = process.env.CHAINLINK_BTC_USD || "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
  const INITIAL_SUPPLY_CAP = process.env.MUSD_SUPPLY_CAP
    ? ethers.parseEther(process.env.MUSD_SUPPLY_CAP)
    : ethers.parseEther("10000000");
  const DAILY_CAP_INCREASE_LIMIT = process.env.BRIDGE_DAILY_CAP_LIMIT
    ? ethers.parseEther(process.env.BRIDGE_DAILY_CAP_LIMIT)
    : ethers.parseEther("1000000");

  // Optional token addresses to pre-configure oracle feeds.
  const WETH_ADDRESS = process.env.WETH_ADDRESS;
  const WBTC_ADDRESS = process.env.WBTC_ADDRESS;

  console.log("\n1/10 Deploying MockUSDC...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
  await mockUSDC.waitForDeployment();
  const mockUSDCAddress = await mockUSDC.getAddress();
  console.log(`     MockUSDC: ${mockUSDCAddress}`);

  console.log("2/10 Deploying MUSD...");
  const MUSD = await ethers.getContractFactory("MUSD");
  const musd = await MUSD.deploy(INITIAL_SUPPLY_CAP);
  await musd.waitForDeployment();
  const musdAddress = await musd.getAddress();
  console.log(`     MUSD: ${musdAddress}`);

  console.log("3/10 Deploying SMUSD...");
  const SMUSD = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSD.deploy(musdAddress);
  await smusd.waitForDeployment();
  const smusdAddress = await smusd.getAddress();
  console.log(`     SMUSD: ${smusdAddress}`);

  console.log("4/10 Deploying PriceOracle...");
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const priceOracle = await PriceOracle.deploy();
  await priceOracle.waitForDeployment();
  const priceOracleAddress = await priceOracle.getAddress();
  console.log(`     PriceOracle: ${priceOracleAddress}`);

  console.log("5/10 Deploying CollateralVault...");
  const CollateralVault = await ethers.getContractFactory("CollateralVault");
  const vault = await CollateralVault.deploy();
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`     CollateralVault: ${vaultAddress}`);

  console.log("6/10 Deploying TreasuryV2 (proxy)...");
  const Treasury = await ethers.getContractFactory("TreasuryV2");
  const treasury = await upgrades.deployProxy(
    Treasury,
    [mockUSDCAddress, deployer.address, deployer.address, deployer.address],
    { initializer: "initialize" }
  );
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log(`     Treasury: ${treasuryAddress}`);

  console.log("7/10 Deploying DirectMintV2...");
  const DirectMint = await ethers.getContractFactory("DirectMintV2");
  const directMint = await DirectMint.deploy(
    mockUSDCAddress,
    musdAddress,
    treasuryAddress,
    deployer.address
  );
  await directMint.waitForDeployment();
  const directMintAddress = await directMint.getAddress();
  console.log(`     DirectMint: ${directMintAddress}`);

  console.log("8/10 Deploying BorrowModule...");
  const BorrowModule = await ethers.getContractFactory("BorrowModule");
  const borrowModule = await BorrowModule.deploy(
    vaultAddress,
    priceOracleAddress,
    musdAddress,
    200,
    ethers.parseEther("100")
  );
  await borrowModule.waitForDeployment();
  const borrowModuleAddress = await borrowModule.getAddress();
  console.log(`     BorrowModule: ${borrowModuleAddress}`);

  console.log("9/10 Deploying LiquidationEngine...");
  const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
  const liquidationEngine = await LiquidationEngine.deploy(
    vaultAddress,
    borrowModuleAddress,
    priceOracleAddress,
    musdAddress,
    5000
  );
  await liquidationEngine.waitForDeployment();
  const liquidationEngineAddress = await liquidationEngine.getAddress();
  console.log(`     LiquidationEngine: ${liquidationEngineAddress}`);

  console.log("10/10 Deploying BLEBridgeV9 (proxy)...");
  const BLEBridgeV9 = await ethers.getContractFactory("BLEBridgeV9");
  const bridge = await upgrades.deployProxy(
    BLEBridgeV9,
    [2, musdAddress, 12000, DAILY_CAP_INCREASE_LIMIT],
    { initializer: "initialize" }
  );
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log(`     BLEBridgeV9: ${bridgeAddress}`);

  console.log("\n" + "=".repeat(72));
  console.log("Configuring roles and wiring dependencies...");
  console.log("=".repeat(72));

  // MUSD roles
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();

  await (await musd.grantRole(BRIDGE_ROLE, directMintAddress)).wait();
  await (await musd.grantRole(BRIDGE_ROLE, bridgeAddress)).wait();
  await (await musd.grantRole(BRIDGE_ROLE, borrowModuleAddress)).wait();
  await (await musd.grantRole(CAP_MANAGER_ROLE, bridgeAddress)).wait();
  await (await musd.grantRole(LIQUIDATOR_ROLE, liquidationEngineAddress)).wait();

  // Treasury roles
  const VAULT_ROLE = await treasury.VAULT_ROLE();
  await (await treasury.grantRole(VAULT_ROLE, directMintAddress)).wait();

  // CollateralVault roles
  const BORROW_MODULE_ROLE = await vault.BORROW_MODULE_ROLE();
  const VAULT_LIQUIDATION_ROLE = await vault.LIQUIDATION_ROLE();
  await (await vault.grantRole(BORROW_MODULE_ROLE, borrowModuleAddress)).wait();
  await (await vault.grantRole(VAULT_LIQUIDATION_ROLE, liquidationEngineAddress)).wait();
  await (await vault.setBorrowModule(borrowModuleAddress)).wait();

  // BorrowModule roles + integrations
  const BORROW_LIQUIDATION_ROLE = await borrowModule.LIQUIDATION_ROLE();
  await (await borrowModule.grantRole(BORROW_LIQUIDATION_ROLE, liquidationEngineAddress)).wait();
  await (await borrowModule.setSMUSD(smusdAddress)).wait();
  await (await borrowModule.setTreasury(treasuryAddress)).wait();

  // SMUSD integrations
  const SMUSD_BRIDGE_ROLE = await smusd.BRIDGE_ROLE();
  const INTEREST_ROUTER_ROLE = await smusd.INTEREST_ROUTER_ROLE();
  await (await smusd.grantRole(SMUSD_BRIDGE_ROLE, bridgeAddress)).wait();
  await (await smusd.grantRole(INTEREST_ROUTER_ROLE, borrowModuleAddress)).wait();
  await (await smusd.setTreasury(treasuryAddress)).wait();

  // Optional oracle feed configuration
  if (WETH_ADDRESS) {
    await (await priceOracle.setFeed(WETH_ADDRESS, CHAINLINK_ETH_USD, 3600, 18)).wait();
    console.log(`Configured WETH/USD feed for ${WETH_ADDRESS}`);
  }
  if (WBTC_ADDRESS) {
    await (await priceOracle.setFeed(WBTC_ADDRESS, CHAINLINK_BTC_USD, 3600, 8)).wait();
    console.log(`Configured WBTC/USD feed for ${WBTC_ADDRESS}`);
  }

  // Seed test USDC
  await (await mockUSDC.mint(deployer.address, 1_000_000n * 10n ** 6n)).wait();

  const deployed: DeployedContracts = {
    network: network.name,
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      MUSD: musdAddress,
      SMUSD: smusdAddress,
      MockUSDC: mockUSDCAddress,
      PriceOracle: priceOracleAddress,
      CollateralVault: vaultAddress,
      BorrowModule: borrowModuleAddress,
      LiquidationEngine: liquidationEngineAddress,
      DirectMint: directMintAddress,
      Treasury: treasuryAddress,
      BLEBridgeV9: bridgeAddress,
    },
    chainlinkFeeds: {
      ETH_USD: CHAINLINK_ETH_USD,
      BTC_USD: CHAINLINK_BTC_USD,
    },
  };

  fs.mkdirSync("deployments", { recursive: true });
  const deploymentPath = `deployments/${network.name}-${Date.now()}.json`;
  fs.writeFileSync(deploymentPath, JSON.stringify(deployed, null, 2));
  console.log(`\nDeployment saved to: ${deploymentPath}`);

  const frontendEnv = [
    "# Auto-generated from deploy-testnet.ts",
    `NEXT_PUBLIC_CHAIN_ID=${network.chainId}`,
    `NEXT_PUBLIC_MUSD_ADDRESS=${musdAddress}`,
    `NEXT_PUBLIC_SMUSD_ADDRESS=${smusdAddress}`,
    `NEXT_PUBLIC_USDC_ADDRESS=${mockUSDCAddress}`,
    `NEXT_PUBLIC_DIRECT_MINT_ADDRESS=${directMintAddress}`,
    `NEXT_PUBLIC_TREASURY_ADDRESS=${treasuryAddress}`,
    `NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=${vaultAddress}`,
    `NEXT_PUBLIC_BORROW_MODULE_ADDRESS=${borrowModuleAddress}`,
    `NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=${liquidationEngineAddress}`,
    `NEXT_PUBLIC_BRIDGE_ADDRESS=${bridgeAddress}`,
    `NEXT_PUBLIC_PRICE_ORACLE_ADDRESS=${priceOracleAddress}`,
  ].join("\n");

  fs.writeFileSync("frontend/.env.local", frontendEnv);
  console.log("Frontend env saved to: frontend/.env.local");

  console.log("\nContract Addresses:");
  console.log("-".repeat(72));
  for (const [name, addr] of Object.entries(deployed.contracts)) {
    console.log(`${name.padEnd(20)} ${addr}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
