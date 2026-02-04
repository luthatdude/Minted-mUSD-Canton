// Minted mUSD Protocol - Deploy LeverageVault for Testnet
// Deploys LeverageVault with mock swap router for testing

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia
const CONTRACTS = {
  MUSD: "0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b",
  PriceOracle: "0x3F761A52091DB1349aF08C54336d1E5Ae6636901",
  CollateralVault: "0x3a11571879f5CAEB2CA881E8899303453a800C8c",
  BorrowModule: "0x114109F3555Ee75DD343710a63926B9899A6A4a8",
  // Fill in after deploy-mock-oracles.ts
  MockWETH: "", // UPDATE THIS
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Deploy LeverageVault for Testnet");
  console.log("═".repeat(60));
  console.log(`Deployer: ${deployer.address}`);

  if (!CONTRACTS.MockWETH) {
    console.log("\n❌ Please run deploy-mock-oracles.ts first and update CONTRACTS.MockWETH");
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // Step 1: Deploy Mock Swap Router
  // ═══════════════════════════════════════════════════════════
  console.log("\n1️⃣ Deploying MockSwapRouter...");
  const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
  const mockSwapRouter = await MockSwapRouter.deploy(
    CONTRACTS.MUSD,
    CONTRACTS.MockWETH,
    CONTRACTS.PriceOracle
  );
  await mockSwapRouter.waitForDeployment();
  const swapRouterAddress = await mockSwapRouter.getAddress();
  console.log(`   MockSwapRouter: ${swapRouterAddress}`);

  // ═══════════════════════════════════════════════════════════
  // Step 2: Fund MockSwapRouter with tokens for swaps
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣ Funding MockSwapRouter with liquidity...");
  
  const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
  const mockWETH = await ethers.getContractAt("MockERC20", CONTRACTS.MockWETH);
  
  // Mint WETH to swap router for mUSD → WETH swaps
  const wethLiquidity = ethers.parseEther("1000"); // 1000 WETH
  await mockWETH.mint(swapRouterAddress, wethLiquidity);
  console.log(`   ✅ Added ${ethers.formatEther(wethLiquidity)} WETH liquidity`);

  // Grant BRIDGE_ROLE to swap router so it can mint mUSD for WETH → mUSD swaps
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const grantTx = await musd.grantRole(BRIDGE_ROLE, swapRouterAddress);
  await grantTx.wait();
  console.log("   ✅ Granted BRIDGE_ROLE to MockSwapRouter");

  // ═══════════════════════════════════════════════════════════
  // Step 3: Deploy LeverageVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Deploying LeverageVault...");
  const LeverageVault = await ethers.getContractFactory("LeverageVault");
  const leverageVault = await LeverageVault.deploy(
    swapRouterAddress,
    CONTRACTS.CollateralVault,
    CONTRACTS.BorrowModule,
    CONTRACTS.PriceOracle,
    CONTRACTS.MUSD
  );
  await leverageVault.waitForDeployment();
  const leverageVaultAddress = await leverageVault.getAddress();
  console.log(`   LeverageVault: ${leverageVaultAddress}`);

  // ═══════════════════════════════════════════════════════════
  // Step 4: Configure permissions
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣ Configuring permissions...");
  
  const collateralVault = await ethers.getContractAt("CollateralVault", CONTRACTS.CollateralVault);
  const borrowModule = await ethers.getContractAt("BorrowModule", CONTRACTS.BorrowModule);

  // Grant LEVERAGE_VAULT_ROLE to LeverageVault in CollateralVault
  const LEVERAGE_VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LEVERAGE_VAULT_ROLE"));
  const grantVaultTx = await collateralVault.grantRole(LEVERAGE_VAULT_ROLE, leverageVaultAddress);
  await grantVaultTx.wait();
  console.log("   ✅ Granted LEVERAGE_VAULT_ROLE in CollateralVault");

  // Grant LEVERAGE_VAULT_ROLE to LeverageVault in BorrowModule
  const grantBorrowTx = await borrowModule.grantRole(LEVERAGE_VAULT_ROLE, leverageVaultAddress);
  await grantBorrowTx.wait();
  console.log("   ✅ Granted LEVERAGE_VAULT_ROLE in BorrowModule");

  // ═══════════════════════════════════════════════════════════
  // Step 5: Enable WETH as leverageable token
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣ Enabling WETH for leverage...");
  const enableTx = await leverageVault.enableToken(CONTRACTS.MockWETH, 3000); // 0.3% fee tier
  await enableTx.wait();
  console.log("   ✅ Enabled WETH for leverage trading");

  // ═══════════════════════════════════════════════════════════
  // Step 6: Add WETH as collateral if not already
  // ═══════════════════════════════════════════════════════════
  console.log("\n6️⃣ Adding WETH as collateral...");
  try {
    const config = await collateralVault.getConfig(CONTRACTS.MockWETH);
    if (!config.enabled) {
      throw new Error("Not enabled");
    }
    console.log("   ✅ WETH already configured as collateral");
  } catch {
    const addCollateralTx = await collateralVault.addCollateral(
      CONTRACTS.MockWETH,
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      500   // 5% liquidation penalty
    );
    await addCollateralTx.wait();
    console.log("   ✅ Added WETH as collateral (75% LTV, 80% liq threshold, 5% penalty)");
  }

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  console.log("\n═".repeat(60));
  console.log("📋 LeverageVault Deployment Summary");
  console.log("═".repeat(60));
  console.log(`
| Contract       | Address                                    |
|----------------|-------------------------------------------|
| MockSwapRouter | ${swapRouterAddress} |
| LeverageVault  | ${leverageVaultAddress} |
`);
  console.log("💡 Update CONTRACTS.LeverageVault in test-leverage-vault.ts with:");
  console.log(`   LeverageVault: "${leverageVaultAddress}",`);
  console.log("\n✅ LeverageVault deployed and configured!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
