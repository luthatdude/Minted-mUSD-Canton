/**
 * Deploy DepositRouter Contracts
 * 
 * Deploys DepositRouter on Base and Arbitrum for cross-chain deposits.
 * Also deploys TreasuryReceiver on Ethereum mainnet.
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-deposit-router.ts --network base
 *   npx hardhat run scripts/deploy-deposit-router.ts --network arbitrum
 *   npx hardhat run scripts/deploy-deposit-router.ts --network mainnet
 */

import { ethers, network } from "hardhat";

// Chain-specific configuration
const CONFIG: Record<string, {
  usdc: string;
  wormholeRelayer: string;
  tokenBridge: string;
  treasuryAddress: string;
  directMintAddress: string;
  feeBps: number;
  wormholeCore?: string; // Only for TreasuryReceiver on mainnet
}> = {
  // Base Mainnet
  base: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    wormholeRelayer: "0x706F82e9bb5b0813501714Ab5974216704980e31",
    tokenBridge: "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627",
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    directMintAddress: process.env.DIRECT_MINT_ADDRESS || "",
    feeBps: 30, // 0.30%
  },
  // Base Sepolia (testnet)
  "base-sepolia": {
    usdc: process.env.BASE_SEPOLIA_USDC || "",
    wormholeRelayer: "0x93BAD53DDfB6132b0aC8E37f6029163E63372cEE",
    tokenBridge: "0x86F55A04690fd7815A3D802bD587e83eA888B239",
    treasuryAddress: process.env.SEPOLIA_TREASURY_ADDRESS || "",
    directMintAddress: process.env.SEPOLIA_DIRECT_MINT_ADDRESS || "",
    feeBps: 30,
  },
  // Arbitrum One
  arbitrum: {
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    wormholeRelayer: "0x27428DD2d3DD32A4D7f7C497eAaa23130d894911",
    tokenBridge: "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c",
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    directMintAddress: process.env.DIRECT_MINT_ADDRESS || "",
    feeBps: 30,
  },
  // Arbitrum Sepolia (testnet)
  "arbitrum-sepolia": {
    usdc: process.env.ARBITRUM_SEPOLIA_USDC || "",
    wormholeRelayer: "0x7B1bD7a6b4E61c2a123AC6BC2cbfC614437D0470",
    tokenBridge: "0xC7A204bDBFe983FCD8d8E61D02b475D4073fF97e",
    treasuryAddress: process.env.SEPOLIA_TREASURY_ADDRESS || "",
    directMintAddress: process.env.SEPOLIA_DIRECT_MINT_ADDRESS || "",
    feeBps: 30,
  },
  // Ethereum Mainnet (for TreasuryReceiver)
  mainnet: {
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    wormholeRelayer: "0x27428DD2d3DD32A4D7f7C497eAaa23130d894911",
    tokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    treasuryAddress: process.env.TREASURY_ADDRESS || "",
    directMintAddress: process.env.DIRECT_MINT_ADDRESS || "",
    wormholeCore: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
    feeBps: 0,
  },
  // Sepolia (for TreasuryReceiver testnet)
  sepolia: {
    usdc: process.env.SEPOLIA_USDC || "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
    wormholeRelayer: "0x7B1bD7a6b4E61c2a123AC6BC2cbfC614437D0470",
    tokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9",
    treasuryAddress: process.env.SEPOLIA_TREASURY_ADDRESS || "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
    directMintAddress: process.env.SEPOLIA_DIRECT_MINT_ADDRESS || "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
    wormholeCore: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78",
    feeBps: 0,
  },
};

// Wormhole chain IDs for router authorization
const WORMHOLE_CHAIN_IDS: Record<string, number> = {
  base: 30,
  "base-sepolia": 10004,
  arbitrum: 23,
  "arbitrum-sepolia": 10003,
};

async function main() {
  const networkName = network.name;
  const config = CONFIG[networkName];

  if (!config) {
    throw new Error(`No configuration found for network: ${networkName}`);
  }

  console.log(`\n========================================`);
  console.log(`Deploying to ${networkName}`);
  console.log(`========================================\n`);

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // Validate configuration
  if (!config.treasuryAddress) {
    throw new Error("TREASURY_ADDRESS not set in environment");
  }
  if (!config.directMintAddress) {
    throw new Error("DIRECT_MINT_ADDRESS not set in environment");
  }
  if (!config.usdc) {
    throw new Error("USDC address not configured for this network");
  }

  // Deploy based on network type
  if (networkName === "mainnet" || networkName === "sepolia") {
    // Deploy TreasuryReceiver on Ethereum
    await deployTreasuryReceiver(config);
  } else {
    // Deploy DepositRouter on L2s
    await deployDepositRouter(config);
  }
}

async function deployDepositRouter(config: typeof CONFIG[string]) {
  console.log("Deploying DepositRouter...\n");
  console.log("Configuration:");
  console.log(`  USDC: ${config.usdc}`);
  console.log(`  Wormhole Relayer: ${config.wormholeRelayer}`);
  console.log(`  Token Bridge: ${config.tokenBridge}`);
  console.log(`  Treasury: ${config.treasuryAddress}`);
  console.log(`  DirectMint: ${config.directMintAddress}`);
  console.log(`  Fee: ${config.feeBps} bps (${config.feeBps / 100}%)\n`);

  const DepositRouter = await ethers.getContractFactory("DepositRouter");
  const router = await DepositRouter.deploy(
    config.usdc,
    config.wormholeRelayer,
    config.tokenBridge,
    config.treasuryAddress,
    config.directMintAddress,
    config.feeBps,
    (await ethers.getSigners())[0].address, // admin
    config.timelockController || (await ethers.getSigners())[0].address // timelockController
  );

  await router.waitForDeployment();
  const address = await router.getAddress();

  console.log(`\n✅ DepositRouter deployed to: ${address}`);
  console.log(`\nVerify with:`);
  console.log(`npx hardhat verify --network ${network.name} ${address} \\`);
  console.log(`  ${config.usdc} \\`);
  console.log(`  ${config.wormholeRelayer} \\`);
  console.log(`  ${config.tokenBridge} \\`);
  console.log(`  ${config.treasuryAddress} \\`);
  console.log(`  ${config.directMintAddress} \\`);
  console.log(`  ${config.feeBps}`);

  // Save deployment info
  const deploymentInfo = {
    network: network.name,
    contract: "DepositRouter",
    address,
    deployer: (await ethers.getSigners())[0].address,
    timestamp: new Date().toISOString(),
    config: {
      usdc: config.usdc,
      wormholeRelayer: config.wormholeRelayer,
      tokenBridge: config.tokenBridge,
      treasuryAddress: config.treasuryAddress,
      directMintAddress: config.directMintAddress,
      feeBps: config.feeBps,
    },
  };

  console.log("\n📋 Deployment Info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  return address;
}

async function deployTreasuryReceiver(config: typeof CONFIG[string]) {
  console.log("Deploying TreasuryReceiver...\n");
  console.log("Configuration:");
  console.log(`  USDC: ${config.usdc}`);
  console.log(`  Wormhole Core: ${config.wormholeCore}`);
  console.log(`  Token Bridge: ${config.tokenBridge}`);
  console.log(`  DirectMint: ${config.directMintAddress}`);
  console.log(`  Treasury: ${config.treasuryAddress}\n`);

  const TreasuryReceiver = await ethers.getContractFactory("TreasuryReceiver");
  const receiver = await TreasuryReceiver.deploy(
    config.usdc,
    config.wormholeCore!,
    config.tokenBridge,
    config.directMintAddress,
    config.treasuryAddress
  );

  await receiver.waitForDeployment();
  const address = await receiver.getAddress();

  console.log(`\n✅ TreasuryReceiver deployed to: ${address}`);
  console.log(`\nVerify with:`);
  console.log(`npx hardhat verify --network ${network.name} ${address} \\`);
  console.log(`  ${config.usdc} \\`);
  console.log(`  ${config.wormholeCore} \\`);
  console.log(`  ${config.tokenBridge} \\`);
  console.log(`  ${config.directMintAddress} \\`);
  console.log(`  ${config.treasuryAddress}`);

  console.log("\n📋 Next Steps:");
  console.log("1. Authorize DepositRouter addresses from each L2:");
  console.log("   - Call authorizeRouter(chainId, routerAddress)");
  console.log("   - Base: chainId = 30");
  console.log("   - Arbitrum: chainId = 23");

  return address;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
