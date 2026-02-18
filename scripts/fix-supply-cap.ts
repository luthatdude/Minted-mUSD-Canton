import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");

  const lastIncrease = await musd.lastCapIncreaseTime();
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - Number(lastIncrease);
  console.log("Last cap increase:", new Date(Number(lastIncrease) * 1000).toISOString());
  console.log("Time since last increase:", (elapsed / 3600).toFixed(1), "hours");
  console.log("Can increase:", elapsed > 86400 ? "YES" : `NO (need ${((86400 - elapsed) / 3600).toFixed(1)}h more)`);

  const currentCap = await musd.supplyCap();
  console.log("Current cap:", ethers.formatUnits(currentCap, 18));

  // Option A: Increase supply cap (if cooldown elapsed)
  if (elapsed > 86400) {
    const newCap = ethers.parseUnits("500000", 18); // 500K mUSD
    console.log("Setting supply cap to 500,000 mUSD...");
    const tx = await musd.setSupplyCap(newCap);
    await tx.wait();
    console.log("Supply cap updated!");
  } else {
    // Option B: Increase localCapBps to 10000 (100%) so effectiveCap = supplyCap
    console.log("Cap cooldown active. Trying to set localCapBps to 10000 (100%)...");
    try {
      const tx = await musd.setLocalCapBps(10000);
      await tx.wait();
      console.log("localCapBps set to 10000 (100%)!");
      
      const effectiveCap = (currentCap * 10000n) / 10000n;
      const totalSupply = await musd.totalSupply();
      console.log("New effective cap:", ethers.formatUnits(effectiveCap, 18));
      console.log("Remaining mintable:", ethers.formatUnits(effectiveCap - totalSupply, 18));
    } catch (e: any) {
      console.log("setLocalCapBps failed:", e.reason || e.message?.slice(0, 200));
    }
  }
}

main().catch(console.error);
