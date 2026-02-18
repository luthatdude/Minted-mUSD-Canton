/**
 * Diagnose smUSD vault exchange rate issue on Sepolia
 */
import { ethers } from "hardhat";

const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
const MUSD  = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const smusd = await ethers.getContractAt("SMUSD", SMUSD);
  const musd  = await ethers.getContractAt("MUSD", MUSD);

  // Core vault state
  const totalAssets = await smusd.totalAssets();
  const totalSupply = await smusd.totalSupply();
  const asset = await smusd.asset();
  console.log("\n=== smUSD Vault State ===");
  console.log("asset():", asset);
  console.log("totalAssets():", ethers.formatUnits(totalAssets, 18), "mUSD");
  console.log("totalSupply():", ethers.formatUnits(totalSupply, 18), "smUSD");

  const sharePrice = totalSupply > 0n
    ? Number(totalAssets) / Number(totalSupply)
    : 1;
  console.log("Share price:", sharePrice.toFixed(6), "mUSD per smUSD");
  console.log("Expected: >= 1.0");

  // Check the vault's mUSD balance directly
  const vaultMusdBal = await musd.balanceOf(SMUSD);
  console.log("\nvault mUSD balance (balanceOf):", ethers.formatUnits(vaultMusdBal, 18));
  console.log("totalAssets reports:", ethers.formatUnits(totalAssets, 18));

  // Check if there's a custom totalAssets override
  console.log("\n=== Vault Config ===");
  try {
    const cooldown = await smusd.cooldownDuration();
    console.log("cooldownDuration:", cooldown.toString(), "seconds");
  } catch { console.log("No cooldownDuration"); }

  try {
    const minDeposit = await smusd.minDeposit();
    console.log("minDeposit:", ethers.formatUnits(minDeposit, 18));
  } catch { console.log("No minDeposit"); }

  // Check deployer balances
  const deployerSmusd = await smusd.balanceOf(deployer.address);
  const deployerMusd = await musd.balanceOf(deployer.address);
  console.log("\n=== Deployer Balances ===");
  console.log("smUSD:", ethers.formatUnits(deployerSmusd, 18));
  console.log("mUSD:", ethers.formatUnits(deployerMusd, 18));

  // Preview conversions
  try {
    const oneMusd = ethers.parseUnits("1", 18);
    const sharesForOne = await smusd.previewDeposit(oneMusd);
    console.log("\npreviewDeposit(1 mUSD):", ethers.formatUnits(sharesForOne, 18), "smUSD shares");
    
    const oneSmUSD = ethers.parseUnits("1", 18);
    const assetsForOne = await smusd.previewRedeem(oneSmUSD);
    console.log("previewRedeem(1 smUSD):", ethers.formatUnits(assetsForOne, 18), "mUSD");
  } catch (e: any) {
    console.log("Preview error:", e.message?.slice(0, 200));
  }

  // Check recent Transfer events to see who got all those shares
  console.log("\n=== Recent smUSD Mint Events (last 10000 blocks) ===");
  try {
    const currentBlock = await ethers.provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 10000);
    const filter = smusd.filters.Transfer(ethers.ZeroAddress); // mints (from 0x0)
    const events = await smusd.queryFilter(filter, fromBlock, currentBlock);
    console.log(`Found ${events.length} mint events:`);
    for (const ev of events.slice(-10)) {
      const args = (ev as any).args;
      console.log(`  Block ${ev.blockNumber}: to=${args[1].slice(0,10)}... amount=${ethers.formatUnits(args[2], 18)} smUSD`);
    }
  } catch (e: any) {
    console.log("Event query error:", e.message?.slice(0, 200));
  }

  // Also check Deposit events
  console.log("\n=== Recent Deposit Events ===");
  try {
    const currentBlock = await ethers.provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 10000);
    const filter = smusd.filters.Deposit();
    const events = await smusd.queryFilter(filter, fromBlock, currentBlock);
    console.log(`Found ${events.length} Deposit events:`);
    for (const ev of events.slice(-10)) {
      const args = (ev as any).args;
      console.log(`  Block ${ev.blockNumber}: sender=${args[0].slice(0,10)}... owner=${args[1].slice(0,10)}... assets=${ethers.formatUnits(args[2], 18)} shares=${ethers.formatUnits(args[3], 18)}`);
    }
  } catch (e: any) {
    console.log("Deposit event query error:", e.message?.slice(0, 200));
  }
}

main().catch(console.error);
