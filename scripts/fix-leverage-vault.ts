import { ethers } from "hardhat";

/**
 * Fix LeverageVault deployment
 * 
 * Problem: LeverageVault.swapRouter was set to old deployer address (placeholder bug).
 *          swapRouter is immutable — LeverageVault must be redeployed.
 *
 * Steps:
 * 1. Deploy MockSwapRouter (uses oracle prices for fair testnet swaps)
 * 2. Mint WETH to MockSwapRouter for liquidity 
 * 3. Deploy new LeverageVault with correct swapRouter
 * 4. Grant LEVERAGE_VAULT_ROLE on CollateralVault + BorrowModule to new LeverageVault
 * 5. Revoke LEVERAGE_VAULT_ROLE from old LeverageVault
 * 6. Transfer admin roles from deployer on new LeverageVault
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const GAS = { gasLimit: 300_000 };

  console.log("═".repeat(60));
  console.log("Fix LeverageVault Deployment");
  console.log("═".repeat(60));
  console.log(`Deployer: ${deployer.address}`);

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH\n`);

  // Known addresses
  const MUSD = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const COLLATERAL_VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const BORROW_MODULE = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const OLD_LEVERAGE_VAULT = "0x8a5D24bAc265d5ed0fa49AB1C2402C02823A2fbC";

  // ═══════════════════════════════════════════════════════════
  // Step 1: Use existing MockSwapRouter (or deploy new one)
  // ═══════════════════════════════════════════════════════════
  const EXISTING_MOCK_ROUTER = "0x510379a06bBb260E0442BCE7e519Fbf7Dd4ba77e";
  let routerAddr = EXISTING_MOCK_ROUTER;
  
  const routerCode = await ethers.provider.getCode(EXISTING_MOCK_ROUTER);
  if (routerCode === "0x") {
    console.log("1️⃣ Deploying MockSwapRouter...");
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const mockRouter = await MockSwapRouter.deploy(MUSD, WETH, ORACLE);
    await mockRouter.waitForDeployment();
    routerAddr = await mockRouter.getAddress();
    console.log(`   ✅ MockSwapRouter: ${routerAddr}`);
    await new Promise(r => setTimeout(r, 8000));
  } else {
    console.log(`1️⃣ MockSwapRouter already deployed: ${routerAddr}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: Seed MockSwapRouter with WETH liquidity
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣ Checking MockSwapRouter WETH liquidity...");
  const mockWETH = await ethers.getContractAt("MockERC20", WETH);
  const routerBal = await mockWETH.balanceOf(routerAddr);
  if (routerBal < ethers.parseEther("100")) {
    const liquidityAmount = ethers.parseEther("1000"); // 1000 WETH
    const mintTx = await mockWETH.mint(routerAddr, liquidityAmount, GAS);
    await mintTx.wait();
    console.log(`   ✅ Minted ${ethers.formatEther(liquidityAmount)} WETH to router`);
  } else {
    console.log(`   ✅ Router has ${ethers.formatEther(routerBal)} WETH (sufficient)`);
  }

  // Longer wait for public RPC nonce propagation
  console.log("   ⏳ Waiting for nonce propagation...");
  await new Promise(r => setTimeout(r, 8000));

  // ═══════════════════════════════════════════════════════════
  // Step 3: Deploy new LeverageVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Deploying new LeverageVault...");
  const LeverageVault = await ethers.getContractFactory("LeverageVault");
  const newLV = await LeverageVault.deploy(
    routerAddr,         // swapRouter (MockSwapRouter)
    COLLATERAL_VAULT,   // collateralVault
    BORROW_MODULE,      // borrowModule
    ORACLE,             // priceOracle
    MUSD,               // musd
    TIMELOCK            // timelock
  );
  await newLV.waitForDeployment();
  const newLVAddr = await newLV.getAddress();
  console.log(`   ✅ New LeverageVault: ${newLVAddr}`);

  // Verify immutables
  console.log(`   Verify swapRouter:      ${await newLV.swapRouter()}`);
  console.log(`   Verify collateralVault: ${await newLV.collateralVault()}`);
  console.log(`   Verify borrowModule:    ${await newLV.borrowModule()}`);

  await new Promise(r => setTimeout(r, 4000));

  // ═══════════════════════════════════════════════════════════
  // Step 4: Grant LEVERAGE_VAULT_ROLE on CollateralVault + BorrowModule
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣ Granting LEVERAGE_VAULT_ROLE...");
  const LEVERAGE_VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LEVERAGE_VAULT_ROLE"));
  
  const cv = await ethers.getContractAt("CollateralVault", COLLATERAL_VAULT);
  const bm = await ethers.getContractAt("BorrowModule", BORROW_MODULE);

  // Grant on CollateralVault
  const hasCV = await cv.hasRole(LEVERAGE_VAULT_ROLE, newLVAddr);
  if (!hasCV) {
    const tx1 = await cv.grantRole(LEVERAGE_VAULT_ROLE, newLVAddr, GAS);
    await tx1.wait();
    console.log(`   ✅ CollateralVault: LEVERAGE_VAULT_ROLE granted`);
  }

  await new Promise(r => setTimeout(r, 4000));

  // Grant on BorrowModule
  const hasBM = await bm.hasRole(LEVERAGE_VAULT_ROLE, newLVAddr);
  if (!hasBM) {
    const tx2 = await bm.grantRole(LEVERAGE_VAULT_ROLE, newLVAddr, GAS);
    await tx2.wait();
    console.log(`   ✅ BorrowModule: LEVERAGE_VAULT_ROLE granted`);
  }

  await new Promise(r => setTimeout(r, 4000));

  // ═══════════════════════════════════════════════════════════
  // Step 5: Revoke LEVERAGE_VAULT_ROLE from old LeverageVault
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣ Revoking roles from old LeverageVault...");
  
  const oldHasCV = await cv.hasRole(LEVERAGE_VAULT_ROLE, OLD_LEVERAGE_VAULT);
  if (oldHasCV) {
    const tx3 = await cv.revokeRole(LEVERAGE_VAULT_ROLE, OLD_LEVERAGE_VAULT, GAS);
    await tx3.wait();
    console.log(`   ✅ CollateralVault: revoked old LeverageVault`);
  } else {
    console.log(`   ℹ️  CollateralVault: old LeverageVault had no role`);
  }

  await new Promise(r => setTimeout(r, 4000));

  const oldHasBM = await bm.hasRole(LEVERAGE_VAULT_ROLE, OLD_LEVERAGE_VAULT);
  if (oldHasBM) {
    const tx4 = await bm.revokeRole(LEVERAGE_VAULT_ROLE, OLD_LEVERAGE_VAULT, GAS);
    await tx4.wait();
    console.log(`   ✅ BorrowModule: revoked old LeverageVault`);
  } else {
    console.log(`   ℹ️  BorrowModule: old LeverageVault had no role`);
  }

  // ═══════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════
  const endBal = await ethers.provider.getBalance(deployer.address);
  console.log("\n" + "═".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("═".repeat(60));
  console.log(`MockSwapRouter:      ${routerAddr}`);
  console.log(`New LeverageVault:   ${newLVAddr}`);
  console.log(`Old LeverageVault:   ${OLD_LEVERAGE_VAULT} (DEPRECATED)`);
  console.log(`Gas used:            ${ethers.formatEther(bal - endBal)} ETH`);
  console.log(`Remaining balance:   ${ethers.formatEther(endBal)} ETH`);
  console.log("\n⚠️  Update CONTRACTS.LeverageVault in test-leverage-vault.ts!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
