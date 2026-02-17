// Minted mUSD Protocol - Deploy Mock Oracles for Testnet
// Creates controllable price oracles for testing leverage vault and liquidations

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia (updated 2026-02-17)
const CONTRACTS = {
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Deploy Mock Chainlink Oracles for Testnet");
  console.log("═".repeat(60));
  console.log(`Deployer: ${deployer.address}`);

  // ═══════════════════════════════════════════════════════════
  // Deploy Mock WETH token
  // ═══════════════════════════════════════════════════════════
  console.log("\n1️⃣ Deploying Mock WETH...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockWETH = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
  await mockWETH.waitForDeployment();
  const wethAddress = await mockWETH.getAddress();
  console.log(`   Mock WETH: ${wethAddress}`);

  // ═══════════════════════════════════════════════════════════
  // Deploy Mock WBTC token
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣ Deploying Mock WBTC...");
  const mockWBTC = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);
  await mockWBTC.waitForDeployment();
  const wbtcAddress = await mockWBTC.getAddress();
  console.log(`   Mock WBTC: ${wbtcAddress}`);

  // ═══════════════════════════════════════════════════════════
  // Deploy Mock Chainlink Aggregators
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Deploying Mock Price Feeds...");
  const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
  
  // ETH/USD at $2,500
  const ethPrice = 2500n * 10n ** 8n; // Chainlink uses 8 decimals
  const mockEthFeed = await MockAggregator.deploy(8, ethPrice);
  await mockEthFeed.waitForDeployment();
  const ethFeedAddress = await mockEthFeed.getAddress();
  console.log(`   ETH/USD Feed: ${ethFeedAddress} ($2,500)`);

  // BTC/USD at $45,000
  const btcPrice = 45000n * 10n ** 8n;
  const mockBtcFeed = await MockAggregator.deploy(8, btcPrice);
  await mockBtcFeed.waitForDeployment();
  const btcFeedAddress = await mockBtcFeed.getAddress();
  console.log(`   BTC/USD Feed: ${btcFeedAddress} ($45,000)`);

  // USDC/USD at $1.00
  const usdcPrice = 1n * 10n ** 8n;
  const mockUsdcFeed = await MockAggregator.deploy(8, usdcPrice);
  await mockUsdcFeed.waitForDeployment();
  const usdcFeedAddress = await mockUsdcFeed.getAddress();
  console.log(`   USDC/USD Feed: ${usdcFeedAddress} ($1.00)`);

  // ═══════════════════════════════════════════════════════════
  // Configure PriceOracle with mock feeds
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣ Configuring PriceOracle...");
  const priceOracle = await ethers.getContractAt("PriceOracle", CONTRACTS.PriceOracle);

  // Add WETH feed (18 decimals token, 3600s stale period)
  const addEthTx = await priceOracle.setFeed(wethAddress, ethFeedAddress, 3600, 18, 0);
  await addEthTx.wait();
  console.log("   ✅ Added WETH/USD feed");

  // Add WBTC feed (8 decimals token)
  const addBtcTx = await priceOracle.setFeed(wbtcAddress, btcFeedAddress, 3600, 8, 0);
  await addBtcTx.wait();
  console.log("   ✅ Added WBTC/USD feed");

  // Add USDC feed (6 decimals token)
  const addUsdcTx = await priceOracle.setFeed(CONTRACTS.MockUSDC, usdcFeedAddress, 3600, 6, 0);
  await addUsdcTx.wait();
  console.log("   ✅ Added USDC/USD feed");

  // ═══════════════════════════════════════════════════════════
  // Verify oracle is working
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣ Verifying Oracle Prices...");
  
  const ethValue = await priceOracle.getValueUsd(wethAddress, ethers.parseEther("1"));
  console.log(`   1 WETH = $${ethers.formatUnits(ethValue, 18)}`);

  const btcValue = await priceOracle.getValueUsd(wbtcAddress, 1n * 10n ** 8n);
  console.log(`   1 WBTC = $${ethers.formatUnits(btcValue, 18)}`);

  const usdcValue = await priceOracle.getValueUsd(CONTRACTS.MockUSDC, ethers.parseUnits("1000", 6));
  console.log(`   1000 USDC = $${ethers.formatUnits(usdcValue, 18)}`);

  // ═══════════════════════════════════════════════════════════
  // Output deployment info
  // ═══════════════════════════════════════════════════════════
  console.log("\n═".repeat(60));
  console.log("📋 Mock Oracle Deployment Summary");
  console.log("═".repeat(60));
  console.log(`
| Token    | Address                                    | Feed Address                               |
|----------|--------------------------------------------|--------------------------------------------|
| WETH     | ${wethAddress} | ${ethFeedAddress} |
| WBTC     | ${wbtcAddress} | ${btcFeedAddress} |
| USDC     | ${CONTRACTS.MockUSDC} | ${usdcFeedAddress} |
`);

  console.log("💡 To update prices later, use:");
  console.log(`   MockAggregatorV3(${ethFeedAddress}).updateAnswer(newPrice)`);
  
  // Save addresses to file
  const deploymentInfo = {
    mockTokens: {
      WETH: wethAddress,
      WBTC: wbtcAddress,
      USDC: CONTRACTS.MockUSDC,
    },
    mockFeeds: {
      ETH_USD: ethFeedAddress,
      BTC_USD: btcFeedAddress,
      USDC_USD: usdcFeedAddress,
    },
  };

  console.log("\n✅ Mock oracles deployed and configured!");
  console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
