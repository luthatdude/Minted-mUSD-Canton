import { ethers } from "hardhat";

async function main() {
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const borrow = await ethers.getContractAt("BorrowModule", "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8");

  const bal = await musd.balanceOf(target);
  const debt = await borrow.totalDebt(target);
  console.log("mUSD wallet balance:", ethers.formatUnits(bal, 18));
  console.log("Outstanding debt:", ethers.formatUnits(debt, 18));
  console.log("Can repay:", bal >= debt ? "YES (has enough mUSD)" : `NO (needs ${ethers.formatUnits(debt - bal, 18)} more mUSD)`);
}

main().catch(console.error);
