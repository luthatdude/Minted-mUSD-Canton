/**
 * Reset script: Clears all balances on Sepolia testnet.
 * 
 * Steps:
 * 1. Refresh mock price feed (avoid StalePrice revert)
 * 2. Mint mUSD to cover debt repayment
 * 3. Repay all debt
 * 4. Withdraw all collateral
 */

import { ethers } from "hardhat";

const ADDRS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  WETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  WBTC: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  WETHFeed: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const musd = await ethers.getContractAt("MUSD", ADDRS.MUSD);
  const borrow = await ethers.getContractAt("BorrowModule", ADDRS.BorrowModule);
  const vault = await ethers.getContractAt("CollateralVault", ADDRS.CollateralVault);
  const oracle = await ethers.getContractAt("PriceOracle", ADDRS.PriceOracle);

  // ──────────────────────────────────────────────
  // Step 1: Refresh the mock price feed
  // ──────────────────────────────────────────────
  console.log("\n=== Step 1: Refresh Price Feed ===");
  const feed = new ethers.Contract(ADDRS.WETHFeed, [
    "function setAnswer(int256 answer) external",
    "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  ], deployer);

  const [, , , updatedAt] = await feed.latestRoundData();
  const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
  if (age > 82800) { // >23 hours
    const tx = await feed.setAnswer(250000000000n);
    await tx.wait();
    console.log("✅ Feed refreshed ($2500)");
  } else {
    console.log(`Feed is fresh (age: ${(age / 3600).toFixed(1)}h), skipping`);
  }

  // ──────────────────────────────────────────────
  // Step 2: Check current state
  // ──────────────────────────────────────────────
  console.log("\n=== Step 2: Current State ===");
  
  const tokens = [ADDRS.WETH, ADDRS.WBTC];
  const tokenNames = ["WETH", "WBTC"];
  
  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    if (dep > 0n) {
      console.log(`${tokenNames[i]} deposited: ${ethers.formatEther(dep)}`);
    }
  }
  
  const debt = await borrow.totalDebt(deployer.address);
  console.log("Total debt:", ethers.formatEther(debt), "mUSD");
  
  const musdBal = await musd.balanceOf(deployer.address);
  console.log("mUSD balance:", ethers.formatEther(musdBal));
  
  const totalBorrows = await borrow.totalBorrows();
  console.log("Global totalBorrows:", ethers.formatEther(totalBorrows));

  // ──────────────────────────────────────────────
  // Step 3: Repay all debt (if any)
  // ──────────────────────────────────────────────
  if (debt > 0n) {
    console.log("\n=== Step 3: Repay Debt ===");
    
    // Check if we need to mint more mUSD
    const needed = debt > musdBal ? debt - musdBal : 0n;
    if (needed > 0n) {
      // Add 1% buffer for interest accrual during tx
      const mintAmount = needed + (needed / 100n) + ethers.parseEther("10");
      console.log(`Need to mint ${ethers.formatEther(mintAmount)} mUSD for repayment`);
      
      // Check if deployer has MINTER_ROLE
      const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
      const hasMinter = await musd.hasRole(MINTER_ROLE, deployer.address);
      
      if (hasMinter) {
        const mintTx = await musd.mint(deployer.address, mintAmount);
        await mintTx.wait();
        console.log("✅ Minted mUSD for repayment");
      } else {
        // Check if BorrowModule has minter role — we can use it indirectly
        const borrowHasMinter = await musd.hasRole(MINTER_ROLE, ADDRS.BorrowModule);
        console.log("BorrowModule has MINTER_ROLE:", borrowHasMinter);
        
        // Grant MINTER_ROLE to deployer temporarily
        const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
        const hasAdmin = await musd.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
        console.log("Deployer has DEFAULT_ADMIN_ROLE:", hasAdmin);
        
        if (hasAdmin) {
          const grantTx = await musd.grantRole(MINTER_ROLE, deployer.address);
          await grantTx.wait();
          const mintTx = await musd.mint(deployer.address, mintAmount);
          await mintTx.wait();
          console.log("✅ Granted MINTER_ROLE and minted mUSD");
          
          // Revoke after use
          const revokeTx = await musd.revokeRole(MINTER_ROLE, deployer.address);
          await revokeTx.wait();
          console.log("✅ Revoked MINTER_ROLE");
        } else {
          console.log("❌ Cannot mint mUSD — deployer has no admin or minter role");
          console.log("   You need to manually transfer mUSD to the deployer address");
          return;
        }
      }
    }
    
    // Approve mUSD spending by BorrowModule
    const approveAmt = debt + ethers.parseEther("100"); // buffer for interest
    const approveTx = await musd.approve(ADDRS.BorrowModule, approveAmt);
    await approveTx.wait();
    console.log("✅ Approved mUSD spend");
    
    // Repay all debt
    const repayTx = await borrow.repay(ethers.MaxUint256); // Will be capped to actual debt
    await repayTx.wait();
    console.log("✅ Debt repaid");
    
    const newDebt = await borrow.totalDebt(deployer.address);
    console.log("Remaining debt:", ethers.formatEther(newDebt));
  } else {
    console.log("\n=== Step 3: No debt to repay ===");
  }

  // ──────────────────────────────────────────────
  // Step 4: Withdraw all collateral
  // ──────────────────────────────────────────────
  console.log("\n=== Step 4: Withdraw Collateral ===");
  
  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    if (dep > 0n) {
      console.log(`Withdrawing ${ethers.formatEther(dep)} ${tokenNames[i]}...`);
      const wTx = await borrow.withdrawCollateral(tokens[i], dep);
      await wTx.wait();
      console.log(`✅ ${tokenNames[i]} withdrawn`);
    }
  }

  // ──────────────────────────────────────────────
  // Step 5: Burn remaining mUSD (optional cleanup)
  // ──────────────────────────────────────────────
  console.log("\n=== Step 5: Final State ===");
  const finalMusd = await musd.balanceOf(deployer.address);
  console.log("mUSD balance:", ethers.formatEther(finalMusd));
  
  if (finalMusd > 0n) {
    // Burn leftover mUSD
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    const hasMinter = await musd.hasRole(MINTER_ROLE, deployer.address);
    if (!hasMinter) {
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      const hasAdmin = await musd.hasRole(DEFAULT_ADMIN_ROLE, deployer.address);
      if (hasAdmin) {
        const grantTx = await musd.grantRole(MINTER_ROLE, deployer.address);
        await grantTx.wait();
      }
    }
    try {
      const burnTx = await musd.burn(deployer.address, finalMusd);
      await burnTx.wait();
      console.log("✅ Burned remaining mUSD");
    } catch (e: any) {
      console.log("⚠️  Could not burn mUSD:", e.message?.slice(0, 100));
    }
    // Clean up role
    const hasMinterNow = await musd.hasRole(MINTER_ROLE, deployer.address);
    if (hasMinterNow) {
      await (await musd.revokeRole(MINTER_ROLE, deployer.address)).wait();
    }
  }
  
  // Final verification
  console.log("\n=== Final Verification ===");
  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    console.log(`${tokenNames[i]} deposited: ${ethers.formatEther(dep)}`);
  }
  const finalDebt = await borrow.totalDebt(deployer.address);
  console.log("Total debt:", ethers.formatEther(finalDebt), "mUSD");
  const finalMusdBal = await musd.balanceOf(deployer.address);
  console.log("mUSD balance:", ethers.formatEther(finalMusdBal));
  const finalTotalBorrows = await borrow.totalBorrows();
  console.log("Global totalBorrows:", ethers.formatEther(finalTotalBorrows));
  
  console.log("\n🧹 All balances cleared! You can start fresh.");
}

main().catch(console.error);
