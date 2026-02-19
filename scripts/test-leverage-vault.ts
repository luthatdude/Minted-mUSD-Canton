// Minted mUSD Protocol - Leverage Vault Test Script
// Tests leveraged positions with mock oracles on Sepolia testnet

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia
// NOTE: Update these after running deploy-mock-oracles.ts
const CONTRACTS = {
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MUSD: "0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b",
  PriceOracle: "0x3F761A52091DB1349aF08C54336d1E5Ae6636901",
  CollateralVault: "0x3a11571879f5CAEB2CA881E8899303453a800C8c",
  BorrowModule: "0x114109F3555Ee75DD343710a63926B9899A6A4a8",
  LiquidationEngine: "0x4cF182a0E3440175338033B49E84d0d5b55d987E",
  // Fill in after deploy-mock-oracles.ts
  MockWETH: "", // UPDATE THIS
  MockWBTC: "", // UPDATE THIS
  // Fill in after deploying LeverageVault
  LeverageVault: "", // UPDATE THIS
};

// Mock Chainlink feeds - UPDATE after deploy-mock-oracles.ts
const MOCK_FEEDS = {
  ETH_USD: "", // UPDATE THIS
  BTC_USD: "", // UPDATE THIS
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Leverage Vault Test");
  console.log("═".repeat(60));
  console.log(`Tester: ${signer.address}`);

  // Validate addresses
  if (!CONTRACTS.MockWETH || !CONTRACTS.LeverageVault) {
    console.log("\n❌ Please update contract addresses after running:");
    console.log("   1. npx hardhat run scripts/deploy-mock-oracles.ts --network sepolia");
    console.log("   2. npx hardhat run scripts/deploy-leverage-vault.ts --network sepolia");
    console.log("\nThen update CONTRACTS.MockWETH, CONTRACTS.MockWBTC, and CONTRACTS.LeverageVault");
    return;
  }

  // Get contract instances
  const mockWETH = await ethers.getContractAt("MockERC20", CONTRACTS.MockWETH);
  const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
  const priceOracle = await ethers.getContractAt("PriceOracle", CONTRACTS.PriceOracle);
  const collateralVault = await ethers.getContractAt("CollateralVault", CONTRACTS.CollateralVault);
  const borrowModule = await ethers.getContractAt("BorrowModule", CONTRACTS.BorrowModule);
  const leverageVault = await ethers.getContractAt("LeverageVault", CONTRACTS.LeverageVault);

  // ═══════════════════════════════════════════════════════════
  // Step 1: Mint test WETH
  // ═══════════════════════════════════════════════════════════
  console.log("\n1️⃣ Minting test WETH...");
  const wethAmount = ethers.parseEther("10"); // 10 WETH = $25,000 at $2500/ETH
  
  const mintTx = await mockWETH.mint(signer.address, wethAmount);
  await mintTx.wait();
  console.log(`   ✅ Minted ${ethers.formatEther(wethAmount)} WETH`);

  // ═══════════════════════════════════════════════════════════
  // Step 2: Check if WETH is enabled in CollateralVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣ Checking collateral configuration...");
  
  try {
    const config = await collateralVault.getConfig(CONTRACTS.MockWETH);
    console.log(`   Enabled: ${config.enabled}`);
    console.log(`   Collateral Factor: ${config.collateralFactorBps / 100}%`);
    console.log(`   Liquidation Threshold: ${config.liquidationThresholdBps / 100}%`);
    console.log(`   Liquidation Penalty: ${config.liquidationPenaltyBps / 100}%`);
    
    if (!config.enabled) {
      console.log("\n   ⚠️ WETH not enabled as collateral. Adding it now...");
      const addTx = await collateralVault.addCollateral(
        CONTRACTS.MockWETH,
        7500, // 75% LTV
        8000, // 80% liquidation threshold
        500   // 5% liquidation penalty
      );
      await addTx.wait();
      console.log("   ✅ Added WETH as collateral");
    }
  } catch (e) {
    console.log("   ⚠️ WETH not configured. Adding it now...");
    const addTx = await collateralVault.addCollateral(
      CONTRACTS.MockWETH,
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      500   // 5% liquidation penalty
    );
    await addTx.wait();
    console.log("   ✅ Added WETH as collateral");
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: Check WETH in LeverageVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Checking LeverageVault configuration...");
  const isEnabled = await leverageVault.leverageEnabled(CONTRACTS.MockWETH);
  
  if (!isEnabled) {
    console.log("   ⚠️ WETH not enabled in LeverageVault. Enabling...");
    const enableTx = await leverageVault.enableToken(CONTRACTS.MockWETH, 3000); // 0.3% fee tier
    await enableTx.wait();
    console.log("   ✅ Enabled WETH for leverage");
  } else {
    console.log("   ✅ WETH is enabled for leverage");
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Approve and open leveraged position
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣ Opening leveraged position...");
  
  const depositAmount = ethers.parseEther("5"); // 5 WETH = $12,500
  
  // Approve LeverageVault
  const approveTx = await mockWETH.approve(CONTRACTS.LeverageVault, depositAmount);
  await approveTx.wait();
  console.log(`   ✅ Approved ${ethers.formatEther(depositAmount)} WETH`);

  // Open 3x leveraged position
  const targetLeverage = 30; // 3.0x
  const maxLoops = 10;
  
  console.log(`   📊 Opening ${targetLeverage / 10}x leveraged position (target 3x)...`);
  
  const openTx = await leverageVault.openLeveragedPosition(
    CONTRACTS.MockWETH,
    depositAmount,
    targetLeverage,
    maxLoops,
    0
  );
  const receipt = await openTx.wait();
  console.log(`   ✅ Position opened! Gas used: ${receipt?.gasUsed}`);

  // ═══════════════════════════════════════════════════════════
  // Step 5: Check position details
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣ Position Details:");
  
  const position = await leverageVault.getPosition(signer.address);
  console.log(`   Collateral Token: ${position.collateralToken}`);
  console.log(`   Initial Deposit: ${ethers.formatEther(position.initialDeposit)} WETH`);
  console.log(`   Total Collateral: ${ethers.formatEther(position.totalCollateral)} WETH`);
  console.log(`   Total Debt: ${ethers.formatUnits(position.totalDebt, 18)} mUSD`);
  console.log(`   Loops Executed: ${position.loopsExecuted}`);
  
  const effectiveLeverage = await leverageVault.getEffectiveLeverage(signer.address);
  console.log(`   Effective Leverage: ${Number(effectiveLeverage) / 10}x`);

  // Calculate health
  const collateralValue = await priceOracle.getValueUsd(
    CONTRACTS.MockWETH, 
    position.totalCollateral
  );
  const healthFactor = (collateralValue * 8000n) / (position.totalDebt * 10000n);
  console.log(`   Collateral Value: $${ethers.formatUnits(collateralValue, 18)}`);
  console.log(`   Health Factor: ${Number(healthFactor) / 100}`);

  // ═══════════════════════════════════════════════════════════
  // Step 6: Simulate price drop (for liquidation testing)
  // ═══════════════════════════════════════════════════════════
  if (MOCK_FEEDS.ETH_USD) {
    console.log("\n6️⃣ Simulating price movement...");
    const mockFeed = await ethers.getContractAt("MockAggregatorV3", MOCK_FEEDS.ETH_USD);
    
    // Drop price by 20% to test liquidation threshold
    const newPrice = 2000n * 10n ** 8n; // $2000 (down from $2500)
    console.log("   ⚠️ Dropping ETH price to $2,000 (-20%)...");
    
    const updateTx = await mockFeed.updateAnswer(newPrice);
    await updateTx.wait();
    
    // Check new health
    const newCollateralValue = await priceOracle.getValueUsd(
      CONTRACTS.MockWETH, 
      position.totalCollateral
    );
    const newHealthFactor = (newCollateralValue * 8000n) / (position.totalDebt * 10000n);
    console.log(`   📉 New Collateral Value: $${ethers.formatUnits(newCollateralValue, 18)}`);
    console.log(`   📉 New Health Factor: ${Number(newHealthFactor) / 100}`);
    
    // Check if liquidatable
    const isLiquidatable = await borrowModule.isLiquidatable(signer.address);
    console.log(`   🔴 Is Liquidatable: ${isLiquidatable}`);
    
    // Restore price
    console.log("\n   🔄 Restoring ETH price to $2,500...");
    const restoreTx = await mockFeed.updateAnswer(2500n * 10n ** 8n);
    await restoreTx.wait();
  }

  // ═══════════════════════════════════════════════════════════
  // Step 7: Close position
  // ═══════════════════════════════════════════════════════════
  console.log("\n7️⃣ Closing leveraged position...");
  
  const wethBefore = await mockWETH.balanceOf(signer.address);
  
  // Note: This requires sufficient swap liquidity in the mock DEX
  // For testnet without real DEX, use closeLeveragedPositionWithMusd instead
  
  const debtNeeded = await leverageVault.getMusdNeededToClose(signer.address);
  console.log(`   Debt to repay: ${ethers.formatUnits(debtNeeded, 18)} mUSD`);
  
  if (debtNeeded > 0n) {
    // Mint mUSD to close position
    console.log("   📝 Minting mUSD to close position...");
    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    
    // Check if we can mint
    const canMint = await musd.hasRole(BRIDGE_ROLE, signer.address);
    if (!canMint) {
      console.log("   ⚠️ Need BRIDGE_ROLE to mint mUSD for closing.");
      console.log("   💡 Use DirectMint to get mUSD, then close with closeLeveragedPositionWithMusd()");
      return;
    }
    
    await musd.mint(signer.address, debtNeeded);
    await musd.approve(CONTRACTS.LeverageVault, debtNeeded);
    
    const closeTx = await leverageVault.closeLeveragedPositionWithMusd(debtNeeded, 0);
    await closeTx.wait();
    console.log("   ✅ Position closed!");
  }

  const wethAfter = await mockWETH.balanceOf(signer.address);
  console.log(`   📊 WETH returned: ${ethers.formatEther(wethAfter - wethBefore)} WETH`);

  console.log("\n═".repeat(60));
  console.log("✅ Leverage Vault Test Complete!");
  console.log("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
