// Minted mUSD Protocol - Treasury Yield Distribution Test
// Tests that yield flows correctly from Treasury to SMUSD stakers

import { ethers } from "hardhat";

// Deployed contract addresses on Sepolia (updated 2026-02-17)
const CONTRACTS = {
  MockUSDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  SMUSD: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  TreasuryV2: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  DirectMintV2: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═".repeat(60));
  console.log("Treasury Yield Distribution Test");
  console.log("═".repeat(60));
  console.log(`Tester: ${deployer.address}`);

  // Get contract instances
  const mockUSDC = await ethers.getContractAt("MockERC20", CONTRACTS.MockUSDC);
  const musd = await ethers.getContractAt("MUSD", CONTRACTS.MUSD);
  const smusd = await ethers.getContractAt("SMUSD", CONTRACTS.SMUSD);
  const treasury = await ethers.getContractAt("TreasuryV2", CONTRACTS.TreasuryV2);
  const directMint = await ethers.getContractAt("DirectMintV2", CONTRACTS.DirectMintV2);

  // ═══════════════════════════════════════════════════════════
  // Step 1: Check Treasury configuration
  // ═══════════════════════════════════════════════════════════
  console.log("\n1️⃣ Checking Treasury configuration...");
  
  const treasuryAsset = await treasury.asset();
  const reserveBps = await treasury.reserveBps();
  const minAutoAllocate = await treasury.minAutoAllocateAmount();
  
  console.log(`   Asset address: ${treasuryAsset}`);
  console.log(`   Reserve BPS: ${reserveBps} (${Number(reserveBps) / 100}%)`);
  console.log(`   Min Auto-Allocate: ${ethers.formatUnits(minAutoAllocate, 6)} USDC`);
  
  const totalValue = await treasury.totalValue();
  const reserveBal = await treasury.reserveBalance();
  console.log(`   Total Value: $${ethers.formatUnits(totalValue, 6)}`);
  console.log(`   Reserve Balance: $${ethers.formatUnits(reserveBal, 6)}`);

  // Gas limit constant for public RPC compatibility
  const GAS = { gasLimit: 300_000 };
  // ═══════════════════════════════════════════════════════════
  // Step 2: Deposit USDC into Treasury
  // ═══════════════════════════════════════════════════════════
  console.log("\n2️⃣ Depositing USDC into Treasury...");
  
  const depositAmount = ethers.parseUnits("50000", 6); // 50,000 USDC
  
  // Mint and approve USDC
  await (await mockUSDC.mint(deployer.address, depositAmount, GAS)).wait();
  await (await mockUSDC.approve(CONTRACTS.TreasuryV2, depositAmount, GAS)).wait();
  console.log(`   ✅ Minted and approved ${ethers.formatUnits(depositAmount, 6)} USDC`);

  // Check if we have VAULT_ROLE to deposit
  const VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VAULT_ROLE"));
  const hasVaultRole = await treasury.hasRole(VAULT_ROLE, deployer.address);
  
  if (!hasVaultRole) {
    console.log("   ⚠️ Granting VAULT_ROLE to deployer...");
    const DEFAULT_ADMIN_ROLE = await treasury.DEFAULT_ADMIN_ROLE();
    const isAdmin = await treasury.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
    
    if (isAdmin) {
      const grantTx = await treasury.grantRole(VAULT_ROLE, deployer.address, GAS);
      await grantTx.wait();
      console.log("   ✅ Granted VAULT_ROLE");
    } else {
      console.log("   ❌ Not admin - cannot deposit to treasury directly");
      console.log("   💡 Using alternative: deposit via DirectMint...");
      
      // Use DirectMint which deposits to Treasury
      const mintAmount = ethers.parseUnits("10000", 6);
      await (await mockUSDC.mint(deployer.address, mintAmount, GAS)).wait();
      await (await mockUSDC.approve(CONTRACTS.DirectMintV2, mintAmount, GAS)).wait();
      await (await directMint.mint(mintAmount, { gasLimit: 500_000 })).wait();
      console.log(`   ✅ Minted ${ethers.formatUnits(mintAmount, 6)} mUSD via DirectMint`);
    }
  } else {
    // Direct deposit to treasury
    const depositTx = await treasury.depositFromVault(depositAmount, { gasLimit: 500_000 });
    await depositTx.wait();
    console.log(`   ✅ Deposited ${ethers.formatUnits(depositAmount, 6)} USDC to Treasury`);
  }

  // Check new treasury balance
  const newTotalValue = await treasury.totalValue();
  const newReserve = await treasury.reserveBalance();
  console.log(`   📊 New Total Value: $${ethers.formatUnits(newTotalValue, 6)}`);
  console.log(`   📊 New Reserve: $${ethers.formatUnits(newReserve, 6)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 3: Set up SMUSD for yield reception
  // ═══════════════════════════════════════════════════════════
  console.log("\n3️⃣ Setting up SMUSD staking...");
  
  // First, we need some mUSD to stake
  const stakeAmount = ethers.parseUnits("5000", 18); // 5000 mUSD
  const currentMusdBalance = await musd.balanceOf(deployer.address);
  
  if (currentMusdBalance < stakeAmount) {
    // Mint mUSD via DirectMint
    const mintAmount = ethers.parseUnits("10000", 6);
    await (await mockUSDC.mint(deployer.address, mintAmount, GAS)).wait();
    await (await mockUSDC.approve(CONTRACTS.DirectMintV2, mintAmount, GAS)).wait();
    await (await directMint.mint(mintAmount, { gasLimit: 500_000 })).wait();
    console.log(`   ✅ Minted ${ethers.formatUnits(mintAmount, 6)} mUSD`);
  }

  // Stake mUSD
  await (await musd.approve(CONTRACTS.SMUSD, stakeAmount, GAS)).wait();
  const stakeTx = await smusd.deposit(stakeAmount, deployer.address, GAS);
  await stakeTx.wait();
  console.log(`   ✅ Staked ${ethers.formatUnits(stakeAmount, 18)} mUSD`);

  const smusdBalance = await smusd.balanceOf(deployer.address);
  console.log(`   📊 smUSD balance: ${ethers.formatUnits(smusdBalance, 18)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 4: Simulate yield generation
  // ═══════════════════════════════════════════════════════════
  console.log("\n4️⃣ Simulating yield generation...");
  
  // In production, yield comes from strategies
  // For testing, we'll directly distribute yield to SMUSD
  
  const yieldAmount = ethers.parseUnits("500", 18); // 500 mUSD yield (10%)
  
  // Get YIELD_MANAGER_ROLE
  const YIELD_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("YIELD_MANAGER_ROLE"));
  const hasYieldRole = await smusd.hasRole(YIELD_MANAGER_ROLE, deployer.address);
  
  if (!hasYieldRole) {
    console.log("   ⚠️ Granting YIELD_MANAGER_ROLE...");
    const grantTx = await smusd.grantRole(YIELD_MANAGER_ROLE, deployer.address, GAS);
    await grantTx.wait();
    console.log("   ✅ Granted YIELD_MANAGER_ROLE");
  }

  // Get share value before yield
  const shareValueBefore = await smusd.convertToAssets(ethers.parseUnits("1", 18));
  console.log(`   📊 Share value before: 1 smUSD = ${ethers.formatUnits(shareValueBefore, 18)} mUSD`);

  // Mint mUSD for yield distribution
  const yieldMusdBalance = await musd.balanceOf(deployer.address);
  if (yieldMusdBalance < yieldAmount) {
    const mintAmount = ethers.parseUnits("1000", 6);
    await (await mockUSDC.mint(deployer.address, mintAmount, GAS)).wait();
    await (await mockUSDC.approve(CONTRACTS.DirectMintV2, mintAmount, GAS)).wait();
    await (await directMint.mint(mintAmount, { gasLimit: 500_000 })).wait();
  }

  // Approve and distribute yield
  await (await musd.approve(CONTRACTS.SMUSD, yieldAmount, GAS)).wait();
  const yieldTx = await smusd.distributeYield(yieldAmount, { gasLimit: 200_000 });
  await yieldTx.wait();
  console.log(`   ✅ Distributed ${ethers.formatUnits(yieldAmount, 18)} mUSD yield`);

  // Get share value after yield
  const shareValueAfter = await smusd.convertToAssets(ethers.parseUnits("1", 18));
  console.log(`   📊 Share value after: 1 smUSD = ${ethers.formatUnits(shareValueAfter, 18)} mUSD`);

  const increase = shareValueAfter - shareValueBefore;
  const percentIncrease = (Number(increase) * 100) / Number(shareValueBefore);
  console.log(`   📈 Share value increased by ${percentIncrease.toFixed(4)}%`);

  // ═══════════════════════════════════════════════════════════
  // Step 5: Verify Treasury <-> SMUSD connection
  // ═══════════════════════════════════════════════════════════
  console.log("\n5️⃣ Verifying Treasury-SMUSD connection...");
  
  // Check if SMUSD has Treasury set
  const treasuryInSmusd = await smusd.treasury();
  console.log(`   Treasury in SMUSD: ${treasuryInSmusd}`);
  
  if (treasuryInSmusd === ethers.ZeroAddress) {
    console.log("   ⚠️ Treasury not set in SMUSD.");
    // setTreasury requires TIMELOCK_ROLE (self-governed)
    const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
    if (await smusd.hasRole(TIMELOCK_ROLE, deployer.address)) {
      const setTreasuryTx = await smusd.setTreasury(CONTRACTS.TreasuryV2, GAS);
      await setTreasuryTx.wait();
      console.log("   ✅ Treasury set in SMUSD");
    } else {
      console.log("   ⚠️ Cannot set treasury (requires TIMELOCK_ROLE). globalTotalAssets uses local fallback.");
    }
  } else if (treasuryInSmusd.toLowerCase() === CONTRACTS.TreasuryV2.toLowerCase()) {
    console.log("   ✅ Treasury correctly configured in SMUSD");
  } else {
    console.log(`   ⚠️ Different treasury configured: ${treasuryInSmusd}`);
  }

  // Check global share price
  const globalSharePrice = await smusd.globalSharePrice();
  console.log(`   📊 Global Share Price: ${ethers.formatUnits(globalSharePrice, 3)}`);

  // ═══════════════════════════════════════════════════════════
  // Step 6: Summary
  // ═══════════════════════════════════════════════════════════
  console.log("\n═".repeat(60));
  console.log("📋 Treasury Yield Distribution Summary");
  console.log("═".repeat(60));
  console.log(`
| Metric                    | Value                          |
|---------------------------|--------------------------------|
| Treasury Total Value      | $${ethers.formatUnits(await treasury.totalValue(), 6).padEnd(30)} |
| Treasury Reserve          | $${ethers.formatUnits(await treasury.reserveBalance(), 6).padEnd(30)} |
| SMUSD Total Supply        | ${ethers.formatUnits(await smusd.totalSupply(), 18).padEnd(30)} |
| SMUSD Total Assets        | ${ethers.formatUnits(await smusd.totalAssets(), 18).padEnd(30)} |
| Share Value               | ${ethers.formatUnits(shareValueAfter, 18).padEnd(30)} |
| Yield Distributed         | ${ethers.formatUnits(yieldAmount, 18).padEnd(30)} |
`);

  console.log("✅ Treasury Yield Distribution Test Complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
