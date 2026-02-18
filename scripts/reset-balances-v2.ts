/**
 * Reset script v2: Clears all deployer balances on Sepolia testnet.
 * 
 * Strategy:
 * 1. Refresh mock price feed
 * 2. Grant LIQUIDATION_ROLE to deployer on BorrowModule
 * 3. Use reduceDebt() to forgive all debt (no mUSD needed)
 * 4. Withdraw all collateral
 * 5. Burn existing mUSD balance
 * 6. Clean up roles
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

  const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));

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
  if (age > 82800) {
    const tx = await feed.setAnswer(250000000000n);
    await tx.wait();
    console.log("✅ Feed refreshed ($2500)");
  } else {
    console.log(`Feed is fresh (${(age / 3600).toFixed(1)}h), skipping`);
  }

  // ──────────────────────────────────────────────
  // Step 2: Current state
  // ──────────────────────────────────────────────
  console.log("\n=== Step 2: Current State ===");
  const tokens = [ADDRS.WETH, ADDRS.WBTC];
  const names = ["WETH", "WBTC"];

  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    if (dep > 0n) console.log(`  ${names[i]} deposited: ${ethers.formatEther(dep)}`);
  }

  const debt = await borrow.totalDebt(deployer.address);
  console.log(`  Total debt: ${ethers.formatEther(debt)} mUSD`);
  const musdBal = await musd.balanceOf(deployer.address);
  console.log(`  mUSD balance: ${ethers.formatEther(musdBal)}`);

  // ──────────────────────────────────────────────
  // Step 3: Grant LIQUIDATION_ROLE on BorrowModule to deployer
  // ──────────────────────────────────────────────
  if (debt > 0n) {
    console.log("\n=== Step 3: Forgive Debt via reduceDebt ===");
    
    const hasLiqRole = await borrow.hasRole(LIQUIDATION_ROLE, deployer.address);
    if (!hasLiqRole) {
      console.log("  Granting LIQUIDATION_ROLE...");
      const grantTx = await borrow.grantRole(LIQUIDATION_ROLE, deployer.address);
      await grantTx.wait();
      console.log("  ✅ LIQUIDATION_ROLE granted");
    }

    // reduceDebt forgives debt without needing mUSD tokens
    // Need to get the actual on-chain debt amount right before calling
    const actualDebt = await borrow.totalDebt(deployer.address);
    console.log(`  Reducing debt: ${ethers.formatEther(actualDebt)} mUSD...`);
    
    // Add small buffer since interest may accrue between read and tx
    const reduceAmount = actualDebt + ethers.parseEther("10");
    const reduceTx = await borrow.reduceDebt(deployer.address, reduceAmount);
    await reduceTx.wait();
    console.log("  ✅ Debt forgiven");

    const newDebt = await borrow.totalDebt(deployer.address);
    console.log(`  Remaining debt: ${ethers.formatEther(newDebt)} mUSD`);
  }

  // ──────────────────────────────────────────────
  // Step 4: Withdraw all collateral
  // ──────────────────────────────────────────────
  console.log("\n=== Step 4: Withdraw Collateral ===");
  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    if (dep > 0n) {
      console.log(`  Withdrawing ${ethers.formatEther(dep)} ${names[i]}...`);
      const wTx = await borrow.withdrawCollateral(tokens[i], dep);
      await wTx.wait();
      console.log(`  ✅ ${names[i]} withdrawn`);
    }
  }

  // ──────────────────────────────────────────────
  // Step 5: Burn mUSD balance
  // ──────────────────────────────────────────────
  console.log("\n=== Step 5: Burn mUSD ===");
  const currentMusd = await musd.balanceOf(deployer.address);
  if (currentMusd > 0n) {
    // Grant BRIDGE_ROLE to deployer for burn
    const hasBridgeRole = await musd.hasRole(BRIDGE_ROLE, deployer.address);
    if (!hasBridgeRole) {
      console.log("  Granting BRIDGE_ROLE on MUSD...");
      const grantTx = await musd.grantRole(BRIDGE_ROLE, deployer.address);
      await grantTx.wait();
    }
    
    console.log(`  Burning ${ethers.formatEther(currentMusd)} mUSD...`);
    const burnTx = await musd.burn(deployer.address, currentMusd);
    await burnTx.wait();
    console.log("  ✅ mUSD burned");

    // Revoke BRIDGE_ROLE
    const revokeTx = await musd.revokeRole(BRIDGE_ROLE, deployer.address);
    await revokeTx.wait();
    console.log("  ✅ BRIDGE_ROLE revoked");
  }

  // ──────────────────────────────────────────────
  // Step 6: Cleanup roles
  // ──────────────────────────────────────────────
  console.log("\n=== Step 6: Cleanup ===");
  const hasLiq = await borrow.hasRole(LIQUIDATION_ROLE, deployer.address);
  if (hasLiq) {
    const revTx = await borrow.revokeRole(LIQUIDATION_ROLE, deployer.address);
    await revTx.wait();
    console.log("  ✅ LIQUIDATION_ROLE revoked from deployer");
  }

  // ──────────────────────────────────────────────
  // Final verification
  // ──────────────────────────────────────────────
  console.log("\n=== ✅ Final State ===");
  for (let i = 0; i < tokens.length; i++) {
    const dep = await vault.deposits(deployer.address, tokens[i]);
    console.log(`  ${names[i]} deposited: ${ethers.formatEther(dep)}`);
  }
  console.log(`  Total debt: ${ethers.formatEther(await borrow.totalDebt(deployer.address))} mUSD`);
  console.log(`  mUSD balance: ${ethers.formatEther(await musd.balanceOf(deployer.address))}`);
  console.log(`  Global totalBorrows: ${ethers.formatEther(await borrow.totalBorrows())}`);
  console.log(`  MUSD total supply: ${ethers.formatEther(await musd.totalSupply())}`);
  
  console.log("\n🧹 All balances cleared! You can start fresh.");
}

main().catch(console.error);
