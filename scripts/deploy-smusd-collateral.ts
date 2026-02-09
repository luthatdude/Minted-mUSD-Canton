// Minted mUSD Protocol - Deploy sMUSD as Collateral on Ethereum
// Deploys SMUSDPriceAdapter and adds sMUSD to CollateralVault + LeverageVault

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia
const CONTRACTS = {
  MUSD: "0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b",
  SMUSD: "0xbe47E05f8aE025D03D034a50bE0Efd23E591AA68",
  PriceOracle: "0x3F761A52091DB1349aF08C54336d1E5Ae6636901",
  CollateralVault: "0x3a11571879f5CAEB2CA881E8899303453a800C8c",
  BorrowModule: "0x114109F3555Ee75DD343710a63926B9899A6A4a8",
  // Set after deploy-leverage-vault.ts
  LeverageVault: "", // UPDATE THIS
};

// sMUSD collateral parameters (matching Canton: CTN_SMUSD)
const SMUSD_LTV_BPS = 9000;               // 90% LTV
const SMUSD_LIQ_THRESHOLD_BPS = 9300;     // 93% liquidation threshold
const SMUSD_LIQ_PENALTY_BPS = 400;        // 4% liquidation penalty

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("═".repeat(60));
  console.log("Minted mUSD - Add sMUSD as Ethereum Collateral");
  console.log("═".repeat(60));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log("");

  // ═══════════════════════════════════════════════════════════
  // Step 1: Deploy SMUSDPriceAdapter
  // ═══════════════════════════════════════════════════════════
  console.log("1️⃣  Deploying SMUSDPriceAdapter...");

  const SMUSDPriceAdapter = await ethers.getContractFactory("SMUSDPriceAdapter");
  const adapter = await SMUSDPriceAdapter.deploy(
    CONTRACTS.SMUSD,
    deployer.address
  );
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`   ✅ SMUSDPriceAdapter: ${adapterAddress}`);

  // Verify it reads the share price correctly
  const latestRound = await adapter.latestRoundData();
  const sharePrice = Number(latestRound.answer) / 1e8;
  console.log(`   📊 Current sMUSD price: $${sharePrice.toFixed(4)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 2: Register sMUSD price feed in PriceOracle
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣  Registering sMUSD price feed in PriceOracle...");

  const priceOracle = await ethers.getContractAt("PriceOracle", CONTRACTS.PriceOracle);
  const setFeedTx = await priceOracle.setFeed(
    CONTRACTS.SMUSD,
    adapterAddress,
    86400,  // 24h stale period (share price is always live, but keep a safety margin)
    18      // sMUSD has 18 decimals (ERC-4626 / ERC-20)
  );
  await setFeedTx.wait();
  console.log("   ✅ sMUSD feed registered in PriceOracle");

  // Verify the oracle reads it
  const oraclePrice = await priceOracle.getPrice(CONTRACTS.SMUSD);
  console.log(`   📊 PriceOracle.getPrice(sMUSD): $${ethers.formatEther(oraclePrice)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 3: Add sMUSD as collateral in CollateralVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣  Adding sMUSD as collateral in CollateralVault...");

  const collateralVault = await ethers.getContractAt("CollateralVault", CONTRACTS.CollateralVault);
  
  try {
    const config = await collateralVault.getConfig(CONTRACTS.SMUSD);
    if (config.enabled) {
      console.log("   ✅ sMUSD already configured as collateral");
    } else {
      throw new Error("Not enabled");
    }
  } catch {
    const addCollateralTx = await collateralVault.addCollateral(
      CONTRACTS.SMUSD,
      SMUSD_LTV_BPS,
      SMUSD_LIQ_THRESHOLD_BPS,
      SMUSD_LIQ_PENALTY_BPS
    );
    await addCollateralTx.wait();
    console.log(`   ✅ sMUSD added as collateral:`);
    console.log(`      LTV: ${SMUSD_LTV_BPS / 100}%`);
    console.log(`      Liquidation Threshold: ${SMUSD_LIQ_THRESHOLD_BPS / 100}%`);
    console.log(`      Liquidation Penalty: ${SMUSD_LIQ_PENALTY_BPS / 100}%`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Enable sMUSD in LeverageVault (if deployed)
  // ═══════════════════════════════════════════════════════════
  if (CONTRACTS.LeverageVault) {
    console.log("\n4️⃣  Enabling sMUSD in LeverageVault...");
    try {
      const leverageVault = await ethers.getContractAt("LeverageVault", CONTRACTS.LeverageVault);
      // sMUSD→mUSD doesn't need a swap (it's a redeem), but the vault uses Uniswap
      // Use 0.01% fee tier as a placeholder — the close path should use
      // closeLeveragedPositionWithMusd() which skips the swap entirely
      const enableTx = await leverageVault.enableToken(CONTRACTS.SMUSD, 100);
      await enableTx.wait();
      console.log("   ✅ sMUSD enabled for leverage");
    } catch (err: any) {
      console.log(`   ⚠️  LeverageVault not configured: ${err.message}`);
      console.log("   💡 Run this after deploy-leverage-vault.ts with the correct address");
    }
  } else {
    console.log("\n4️⃣  Skipping LeverageVault (address not set)");
    console.log("   💡 Update CONTRACTS.LeverageVault and re-run to enable leverage");
  }

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("📋 sMUSD Collateral Deployment Summary");
  console.log("═".repeat(60));
  console.log(`
| Component             | Value                                       |
|-----------------------|---------------------------------------------|
| SMUSDPriceAdapter     | ${adapterAddress} |
| sMUSD Share Price     | $${sharePrice.toFixed(4)}                                    |
| LTV                   | ${SMUSD_LTV_BPS / 100}%                                        |
| Liquidation Threshold | ${SMUSD_LIQ_THRESHOLD_BPS / 100}%                                        |
| Liquidation Penalty   | ${SMUSD_LIQ_PENALTY_BPS / 100}%                                         |
| Max Leverage (from LTV) | ${(10000 / (10000 - SMUSD_LTV_BPS)).toFixed(1)}x                                       |
`);

  console.log("🔁 sMUSD Loop Strategy (Ethereum):");
  console.log("   1. Stake mUSD → get sMUSD");
  console.log("   2. Deposit sMUSD as collateral");
  console.log("   3. Borrow mUSD against sMUSD (90% LTV)");
  console.log("   4. Stake borrowed mUSD → more sMUSD");
  console.log("   5. Repeat (up to 10x leverage)");
  console.log("   Net yield = (leveraged sMUSD APY) - (borrow APR)");
  console.log("");
  console.log("✅ sMUSD is now accepted as collateral on Ethereum!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
