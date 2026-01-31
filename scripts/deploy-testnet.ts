// Minted mUSD Protocol - Testnet Deployment Script
// Deploys all Solidity contracts to Sepolia (or any EVM testnet)

import { ethers } from "hardhat";
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
  
  console.log("═".repeat(60));
  console.log("Minted mUSD Protocol - Testnet Deployment");
  console.log("═".repeat(60));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  
  if (balance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient balance. Need at least 0.1 ETH for deployment.");
  }
  
  console.log("");
  
  // Chainlink feeds (Sepolia)
  const CHAINLINK_ETH_USD = process.env.CHAINLINK_ETH_USD || "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const CHAINLINK_BTC_USD = process.env.CHAINLINK_BTC_USD || "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
  
  // ═══════════════════════════════════════════════════════════
  // Deploy Mock USDC (for testnet)
  // ═══════════════════════════════════════════════════════════
  console.log("1/10 Deploying MockUSDC...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
  await mockUSDC.waitForDeployment();
  const mockUSDCAddress = await mockUSDC.getAddress();
  console.log(`     MockUSDC: ${mockUSDCAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy MUSD
  // ═══════════════════════════════════════════════════════════
  // FIX: MUSD constructor requires _initialSupplyCap parameter
  console.log("2/10 Deploying MUSD...");
  const MUSD = await ethers.getContractFactory("MUSD");
  const musd = await MUSD.deploy(ethers.parseEther("100000000")); // 100M supply cap
  await musd.waitForDeployment();
  const musdAddress = await musd.getAddress();
  console.log(`     MUSD: ${musdAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy SMUSD (Staked mUSD)
  // ═══════════════════════════════════════════════════════════
  console.log("3/10 Deploying SMUSD...");
  const SMUSD = await ethers.getContractFactory("SMUSD");
  const smusd = await SMUSD.deploy(musdAddress);
  await smusd.waitForDeployment();
  const smusdAddress = await smusd.getAddress();
  console.log(`     SMUSD: ${smusdAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy PriceOracle
  // ═══════════════════════════════════════════════════════════
  console.log("4/10 Deploying PriceOracle...");
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const priceOracle = await PriceOracle.deploy();
  await priceOracle.waitForDeployment();
  const priceOracleAddress = await priceOracle.getAddress();
  console.log(`     PriceOracle: ${priceOracleAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy CollateralVault
  // ═══════════════════════════════════════════════════════════
  console.log("5/10 Deploying CollateralVault...");
  const CollateralVault = await ethers.getContractFactory("CollateralVault");
  const vault = await CollateralVault.deploy(priceOracleAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`     CollateralVault: ${vaultAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy BorrowModule
  // ═══════════════════════════════════════════════════════════
  console.log("6/10 Deploying BorrowModule...");
  const BorrowModule = await ethers.getContractFactory("BorrowModule");
  const borrowModule = await BorrowModule.deploy(
    vaultAddress,
    priceOracleAddress,
    musdAddress,
    200, // 2% APR
    ethers.parseEther("100") // Min 100 mUSD debt
  );
  await borrowModule.waitForDeployment();
  const borrowModuleAddress = await borrowModule.getAddress();
  console.log(`     BorrowModule: ${borrowModuleAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy LiquidationEngine
  // ═══════════════════════════════════════════════════════════
  console.log("7/10 Deploying LiquidationEngine...");
  const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
  const liquidationEngine = await LiquidationEngine.deploy(
    vaultAddress,
    borrowModuleAddress,
    priceOracleAddress,
    musdAddress,
    5000 // 50% close factor
  );
  await liquidationEngine.waitForDeployment();
  const liquidationEngineAddress = await liquidationEngine.getAddress();
  console.log(`     LiquidationEngine: ${liquidationEngineAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy DirectMint
  // ═══════════════════════════════════════════════════════════
  // FIX: DirectMintV2 constructor requires (usdc, musd, treasury, feeRecipient)
  // Note: Treasury not deployed yet, will update after treasury deploy
  console.log("8/10 Deploying DirectMint (deferred treasury config)...");
  const DirectMint = await ethers.getContractFactory("DirectMintV2");
  const directMint = await DirectMint.deploy(
    mockUSDCAddress,
    musdAddress,
    deployer.address, // Placeholder treasury — updated post-deploy
    deployer.address  // Fee recipient
  );
  await directMint.waitForDeployment();
  const directMintAddress = await directMint.getAddress();
  console.log(`     DirectMint: ${directMintAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy Treasury
  // ═══════════════════════════════════════════════════════════
  // FIX: TreasuryV2 is upgradeable — deploy via proxy or use hardhat-upgrades
  // For testnet simplicity, deploy implementation and call initialize directly
  console.log("9/10 Deploying TreasuryV2...");
  const Treasury = await ethers.getContractFactory("TreasuryV2");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  // Initialize the treasury (asset, vault, admin, feeRecipient)
  await treasury.initialize(
    mockUSDCAddress,
    smusdAddress,     // vault = smUSD
    deployer.address, // admin
    deployer.address  // fee recipient
  );
  console.log(`     Treasury: ${treasuryAddress}`);
  
  // ═══════════════════════════════════════════════════════════
  // Deploy BLEBridgeV9 (Mock mode - no real Canton)
  // ═══════════════════════════════════════════════════════════
  // FIX: BLEBridgeV9 is upgradeable — deploy and call initialize
  console.log("10/10 Deploying BLEBridgeV9 (mock mode)...");
  const BLEBridgeV9 = await ethers.getContractFactory("BLEBridgeV9");
  const bridge = await BLEBridgeV9.deploy();
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  // Initialize: (minSigs, musdToken, collateralRatioBps, dailyCapIncreaseLimit)
  await bridge.initialize(
    1,                                   // Single validator for testnet
    musdAddress,
    11000,                               // 110% collateral ratio
    ethers.parseEther("10000000")        // 10M daily cap increase limit
  );
  // Grant validator role to deployer for testnet
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  await bridge.grantRole(VALIDATOR_ROLE, deployer.address);
  console.log(`     BLEBridgeV9: ${bridgeAddress}`);
  
  console.log("");
  console.log("═".repeat(60));
  console.log("Configuring contracts...");
  console.log("═".repeat(60));
  
  // ═══════════════════════════════════════════════════════════
  // Configure Roles & Permissions
  // ═══════════════════════════════════════════════════════════
  
  // FIX: MUSD uses BRIDGE_ROLE, not MINTER_ROLE
  console.log("Granting BRIDGE_ROLE...");
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  await musd.grantRole(BRIDGE_ROLE, directMintAddress);
  await musd.grantRole(BRIDGE_ROLE, bridgeAddress);
  await musd.grantRole(BRIDGE_ROLE, borrowModuleAddress);

  // Grant LIQUIDATION_ROLE to LiquidationEngine
  console.log("Granting LIQUIDATION_ROLE...");
  const LIQUIDATION_ROLE = await borrowModule.LIQUIDATION_ROLE();
  await borrowModule.grantRole(LIQUIDATION_ROLE, liquidationEngineAddress);

  // FIX: Grant BORROW_MODULE_ROLE on CollateralVault
  console.log("Granting BORROW_MODULE_ROLE...");
  const BORROW_MODULE_ROLE = await vault.BORROW_MODULE_ROLE();
  await vault.grantRole(BORROW_MODULE_ROLE, borrowModuleAddress);

  // Grant LIQUIDATION_ROLE on CollateralVault
  const VAULT_LIQUIDATION_ROLE = await vault.LIQUIDATION_ROLE();
  await vault.grantRole(VAULT_LIQUIDATION_ROLE, liquidationEngineAddress);

  // Grant CAP_MANAGER_ROLE to bridge for supply cap updates
  console.log("Granting CAP_MANAGER_ROLE to bridge...");
  const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
  await musd.grantRole(CAP_MANAGER_ROLE, bridgeAddress);
  
  // Configure PriceOracle with Chainlink feeds
  console.log("Configuring Chainlink price feeds...");
  
  // For testnet, we'll use WETH placeholder (you'd deploy or use existing WETH)
  // For now, we'll skip this and use mock prices
  
  // Mint test USDC to deployer
  console.log("Minting test USDC...");
  await mockUSDC.mint(deployer.address, 1000000n * 10n ** 6n); // 1M USDC
  
  console.log("");
  console.log("═".repeat(60));
  console.log("✅ Deployment Complete!");
  console.log("═".repeat(60));
  
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
  
  // Save deployment info
  const deploymentPath = `deployments/sepolia-${Date.now()}.json`;
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deployed, null, 2));
  console.log(`Deployment saved to: ${deploymentPath}`);
  
  // Generate frontend .env
  const frontendEnv = `
# Auto-generated from deployment
NEXT_PUBLIC_CHAIN_ID=${network.chainId}
NEXT_PUBLIC_MUSD_ADDRESS=${musdAddress}
NEXT_PUBLIC_SMUSD_ADDRESS=${smusdAddress}
NEXT_PUBLIC_USDC_ADDRESS=${mockUSDCAddress}
NEXT_PUBLIC_DIRECT_MINT_ADDRESS=${directMintAddress}
NEXT_PUBLIC_TREASURY_ADDRESS=${treasuryAddress}
NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=${vaultAddress}
NEXT_PUBLIC_BORROW_MODULE_ADDRESS=${borrowModuleAddress}
NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=${liquidationEngineAddress}
NEXT_PUBLIC_BRIDGE_ADDRESS=${bridgeAddress}
NEXT_PUBLIC_PRICE_ORACLE_ADDRESS=${priceOracleAddress}

# Canton (not configured yet)
# NEXT_PUBLIC_CANTON_LEDGER_HOST=
# NEXT_PUBLIC_CANTON_LEDGER_PORT=6865
`.trim();
  
  fs.writeFileSync("frontend/.env.local", frontendEnv);
  console.log("Frontend env saved to: frontend/.env.local");
  
  console.log("");
  console.log("Contract Addresses:");
  console.log("─".repeat(60));
  Object.entries(deployed.contracts).forEach(([name, addr]) => {
    console.log(`  ${name.padEnd(20)} ${addr}`);
  });
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
