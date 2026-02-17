// Minted mUSD Protocol - Staking & Yield Distribution Test Script
// Tests SMUSD staking and yield distribution on Sepolia testnet

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia (updated 2026-02-17)
const CONTRACTS = {
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  SMUSD: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  DirectMintV2: "0xa869f58c213634Dda2Ef522b66E9587b953279C2",
  TreasuryV2: "0x11Cc7750F2033d21FC3762b94D1355eD15F7913d",
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Staking & Yield Distribution Test");
  console.log("═".repeat(60));
  console.log(`Tester: ${signer.address}`);

  // Get contract instances
  const mockUSDC = await ethers.getContractAt("MockERC20", CONTRACTS.MockUSDC);
  const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
  const smusd = await ethers.getContractAt("SMUSD", CONTRACTS.SMUSD);
  const directMint = await ethers.getContractAt("DirectMintV2", CONTRACTS.DirectMintV2);

  // Check current balances
  const usdcBalance = await mockUSDC.balanceOf(signer.address);
  const musdBalance = await musd.balanceOf(signer.address);
  const smusdBalance = await smusd.balanceOf(signer.address);

  console.log("\n📊 Current Balances:");
  console.log(`   USDC:  ${ethers.formatUnits(usdcBalance, 6)}`);
  console.log(`   mUSD:  ${ethers.formatUnits(musdBalance, 18)}`);
  console.log(`   smUSD: ${ethers.formatUnits(smusdBalance, 18)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 1: Mint some mock USDC if needed
  // ═══════════════════════════════════════════════════════════
  const testAmount = ethers.parseUnits("10000", 6); // 10,000 USDC
  
  if (usdcBalance < testAmount) {
    console.log("\n🪙 Step 1: Minting Mock USDC...");
    const mintTx = await mockUSDC.mint(signer.address, testAmount);
    await mintTx.wait();
    console.log(`   ✅ Minted ${ethers.formatUnits(testAmount, 6)} USDC`);
  } else {
    console.log("\n✅ Step 1: Sufficient USDC balance");
  }

  // ═══════════════════════════════════════════════════════════
  // Step 2: Mint mUSD via DirectMint (USDC → mUSD)
  // ═══════════════════════════════════════════════════════════
  console.log("\n🔄 Step 2: Minting mUSD from USDC...");
  
  // Approve DirectMint to spend USDC
  const approveTx = await mockUSDC.approve(CONTRACTS.DirectMintV2, testAmount);
  await approveTx.wait();
  console.log("   ✅ Approved DirectMintV2 to spend USDC");

  // Mint mUSD
  const mintMusdTx = await directMint.mint(testAmount);
  await mintMusdTx.wait();
  console.log(`   ✅ Minted ${ethers.formatUnits(testAmount, 6)} mUSD`);

  // ═══════════════════════════════════════════════════════════
  // Step 3: Stake mUSD → smUSD
  // ═══════════════════════════════════════════════════════════
  console.log("\n🥩 Step 3: Staking mUSD → smUSD...");
  
  const stakeAmount = ethers.parseUnits("5000", 18); // Stake 5,000 mUSD
  
  // Approve SMUSD to spend mUSD
  const approveMusdTx = await musd.approve(CONTRACTS.SMUSD, stakeAmount);
  await approveMusdTx.wait();
  console.log("   ✅ Approved SMUSD to spend mUSD");

  // Get share preview
  const sharePreview = await smusd.previewDeposit(stakeAmount);
  console.log(`   📐 Expected shares: ${ethers.formatUnits(sharePreview, 18)}`);

  // Deposit
  const depositTx = await smusd.deposit(stakeAmount, signer.address);
  await depositTx.wait();
  console.log(`   ✅ Staked ${ethers.formatUnits(stakeAmount, 18)} mUSD`);

  // Check new balance
  const newSmusdBalance = await smusd.balanceOf(signer.address);
  console.log(`   📊 smUSD balance: ${ethers.formatUnits(newSmusdBalance, 18)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 4: Check share value BEFORE yield
  // ═══════════════════════════════════════════════════════════
  console.log("\n📈 Step 4: Share Value Before Yield...");
  const shareValueBefore = await smusd.convertToAssets(ethers.parseUnits("1", 18));
  console.log(`   1 smUSD = ${ethers.formatUnits(shareValueBefore, 18)} mUSD`);

  // ═══════════════════════════════════════════════════════════
  // Step 5: Distribute Yield (requires YIELD_MANAGER_ROLE)
  // ═══════════════════════════════════════════════════════════
  console.log("\n💰 Step 5: Distributing Yield...");
  
  // Check if we have YIELD_MANAGER_ROLE
  const YIELD_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("YIELD_MANAGER_ROLE"));
  const hasRole = await smusd.hasRole(YIELD_MANAGER_ROLE, signer.address);
  
  if (!hasRole) {
    console.log("   ⚠️ You don't have YIELD_MANAGER_ROLE. Granting it now...");
    // Need DEFAULT_ADMIN_ROLE to grant
    const DEFAULT_ADMIN_ROLE = await smusd.DEFAULT_ADMIN_ROLE();
    const isAdmin = await smusd.hasRole(DEFAULT_ADMIN_ROLE, signer.address);
    
    if (isAdmin) {
      const grantTx = await smusd.grantRole(YIELD_MANAGER_ROLE, signer.address);
      await grantTx.wait();
      console.log("   ✅ Granted YIELD_MANAGER_ROLE");
    } else {
      console.log("   ❌ Cannot grant role - not admin. Skipping yield test.");
      return;
    }
  }

  // Distribute yield (500 mUSD = 10% yield on 5000 staked)
  const yieldAmount = ethers.parseUnits("500", 18);
  
  // Need to have mUSD to distribute
  const currentMusdBalance = await musd.balanceOf(signer.address);
  if (currentMusdBalance < yieldAmount) {
    console.log("   ⚠️ Minting more mUSD for yield distribution...");
    await mockUSDC.mint(signer.address, ethers.parseUnits("1000", 6));
    await mockUSDC.approve(CONTRACTS.DirectMintV2, ethers.parseUnits("1000", 6));
    await directMint.mint(ethers.parseUnits("1000", 6));
  }

  // Approve SMUSD to pull yield
  await musd.approve(CONTRACTS.SMUSD, yieldAmount);
  
  // Distribute yield
  const yieldTx = await smusd.distributeYield(yieldAmount);
  await yieldTx.wait();
  console.log(`   ✅ Distributed ${ethers.formatUnits(yieldAmount, 18)} mUSD yield`);

  // ═══════════════════════════════════════════════════════════
  // Step 6: Check share value AFTER yield
  // ═══════════════════════════════════════════════════════════
  console.log("\n📈 Step 6: Share Value After Yield...");
  const shareValueAfter = await smusd.convertToAssets(ethers.parseUnits("1", 18));
  console.log(`   1 smUSD = ${ethers.formatUnits(shareValueAfter, 18)} mUSD`);
  
  const increase = shareValueAfter - shareValueBefore;
  const percentIncrease = (Number(increase) / Number(shareValueBefore)) * 100;
  console.log(`   📊 Share value increased by ${percentIncrease.toFixed(2)}%`);

  // ═══════════════════════════════════════════════════════════
  // Step 7: Test Withdrawal (after cooldown)
  // ═══════════════════════════════════════════════════════════
  console.log("\n🏦 Step 7: Testing Withdrawal...");
  const canWithdraw = await smusd.canWithdraw(signer.address);
  const cooldownRemaining = await smusd.getRemainingCooldown(signer.address);
  
  console.log(`   Can withdraw: ${canWithdraw}`);
  console.log(`   Cooldown remaining: ${cooldownRemaining} seconds`);
  
  if (canWithdraw) {
    // Redeem all shares
    const redeemTx = await smusd.redeem(newSmusdBalance, signer.address, signer.address);
    await redeemTx.wait();
    console.log("   ✅ Redeemed all smUSD");
    
    const finalMusdBalance = await musd.balanceOf(signer.address);
    console.log(`   📊 Final mUSD balance: ${ethers.formatUnits(finalMusdBalance, 18)}`);
  } else {
    console.log(`   ⏳ Cannot withdraw yet. Wait ${cooldownRemaining} seconds.`);
  }

  console.log("\n═".repeat(60));
  console.log("✅ Staking & Yield Test Complete!");
  console.log("═".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
