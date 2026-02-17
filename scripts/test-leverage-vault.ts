// Minted mUSD Protocol - Leverage Vault Test Script
// Tests leveraged positions with mock oracles on Sepolia testnet

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia (updated 2026-02-17)
// NOTE: MockWETH/MockWBTC/feeds updated from deploy-mock-oracles.ts output (2026-02-17)
const CONTRACTS = {
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  LiquidationEngine: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
  MockWETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  MockWBTC: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  // Deployed LeverageVault
  LeverageVault: "0x8a5D24bAc265d5ed0fa49AB1C2402C02823A2fbC",
};

// Mock Chainlink feeds from deploy-mock-oracles.ts
const MOCK_FEEDS = {
  ETH_USD: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
  BTC_USD: "0xE9A0164efA641Aa14142aF3754545A61cD224106",
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
  
  // Gas limit constant for public RPC compatibility
  const GAS = { gasLimit: 300_000 };

  try {
    const config = await collateralVault.getConfig(CONTRACTS.MockWETH);
    console.log(`   Enabled: ${config.enabled}`);
    console.log(`   Collateral Factor: ${config.collateralFactorBps / 100}%`);
    console.log(`   Liquidation Threshold: ${config.liquidationThresholdBps / 100}%`);
    console.log(`   Liquidation Penalty: ${config.liquidationPenaltyBps / 100}%`);
    
    if (!config.enabled) {
      console.log("\n   ⚠️ WETH not enabled as collateral. Adding it now...");
      const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
      if (!(await collateralVault.hasRole(TIMELOCK_ROLE, signer.address))) {
        // TIMELOCK_ROLE is self-governed — can only be granted by existing holders
        // Try granting via DEFAULT_ADMIN_ROLE (will fail if roleAdmin != DEFAULT_ADMIN_ROLE)
        try {
          console.log("   Granting TIMELOCK_ROLE...");
          await (await collateralVault.grantRole(TIMELOCK_ROLE, signer.address, GAS)).wait();
        } catch {
          console.log("   ⚠️ Cannot grant TIMELOCK_ROLE (self-governed). Need old deployer key.");
          console.log("   💡 Run: npx hardhat run scripts/fix-timelock-roles.ts --network sepolia");
          console.log("   💡 (with old deployer key in .env)");
          console.log("   Skipping collateral setup...");
          return;
        }
      }
      await (await collateralVault.addCollateral(CONTRACTS.MockWETH, 7500, 8000, 500, GAS)).wait();
      console.log("   ✅ Added WETH as collateral");
    }
  } catch (e: any) {
    if (e?.message?.includes("Cannot grant")) throw e;
    console.log("   ⚠️ WETH not configured. Adding it now...");
    const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
    if (!(await collateralVault.hasRole(TIMELOCK_ROLE, signer.address))) {
      try {
        console.log("   Granting TIMELOCK_ROLE...");
        await (await collateralVault.grantRole(TIMELOCK_ROLE, signer.address, GAS)).wait();
      } catch {
        console.log("   ⚠️ Cannot grant TIMELOCK_ROLE (self-governed). Need old deployer key.");
        console.log("   💡 Run: npx hardhat run scripts/fix-timelock-roles.ts --network sepolia");
        console.log("   💡 (with old deployer key in .env)");
        return;
      }
    }
    await (await collateralVault.addCollateral(CONTRACTS.MockWETH, 7500, 8000, 500, GAS)).wait();
    console.log("   ✅ Added WETH as collateral");
  }

  // ═══════════════════════════════════════════════════════════
  // Step 3: Check WETH in LeverageVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Checking LeverageVault configuration...");
  const isEnabled = await leverageVault.leverageEnabled(CONTRACTS.MockWETH);
  
  if (!isEnabled) {
    console.log("   ⚠️ WETH not enabled in LeverageVault. Enabling...");
    // Ensure we have LEVERAGE_ADMIN_ROLE
    const LEVERAGE_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LEVERAGE_ADMIN_ROLE"));
    if (!(await leverageVault.hasRole(LEVERAGE_ADMIN_ROLE, signer.address))) {
      console.log("   Granting LEVERAGE_ADMIN_ROLE...");
      await (await leverageVault.grantRole(LEVERAGE_ADMIN_ROLE, signer.address, GAS)).wait();
    }
    const enableTx = await leverageVault.enableToken(CONTRACTS.MockWETH, 3000, GAS); // 0.3% fee tier
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
  const approveTx = await mockWETH.approve(CONTRACTS.LeverageVault, depositAmount, GAS);
  await approveTx.wait();
  console.log(`   ✅ Approved ${ethers.formatEther(depositAmount)} WETH`);

  // Open 2x leveraged position
  const targetLeverage = 20; // 2.0x
  const maxLoops = 5;
  
  console.log(`   📊 Opening ${targetLeverage / 10}x leveraged position...`);
  
  const openTx = await leverageVault.openLeveragedPosition(
    CONTRACTS.MockWETH,
    depositAmount,
    targetLeverage,
    maxLoops,
    0,
    { gasLimit: 1_000_000 }
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
    
    const updateTx = await mockFeed.updateAnswer(newPrice, GAS);
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
    const restoreTx = await mockFeed.updateAnswer(2500n * 10n ** 8n, GAS);
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
    // Get mUSD via DirectMintV2 to close position
    console.log("   📝 Getting mUSD via DirectMintV2 to repay debt...");
    const mockUSDC = await ethers.getContractAt("MockERC20", CONTRACTS.MockUSDC);
    const directMint = await ethers.getContractAt("DirectMintV2", "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7");
    
    // Need USDC (6 decimals) → mUSD (18 decimals). Add 2% buffer for fees
    const usdcNeeded = (debtNeeded / 10n ** 12n) * 102n / 100n;
    await (await mockUSDC.mint(signer.address, usdcNeeded, GAS)).wait();
    await (await mockUSDC.approve(await directMint.getAddress(), usdcNeeded, GAS)).wait();
    await (await directMint.mint(usdcNeeded, { gasLimit: 500_000 })).wait();
    
    await (await musd.approve(CONTRACTS.LeverageVault, debtNeeded, GAS)).wait();
    
    const closeTx = await leverageVault.closeLeveragedPositionWithMusd(debtNeeded, 0, { gasLimit: 1_000_000 });
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
