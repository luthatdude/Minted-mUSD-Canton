/**
 * Mint test USDC to user wallet on Sepolia
 */
import { ethers } from "hardhat";

const USDC = "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474";
const USER_WALLET = "0x33f9"; // Replace with actual user address

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const usdc = await ethers.getContractAt("MockERC20", USDC);
  
  // Mint 10,000 USDC to deployer (the user's wallet)
  const amount = ethers.parseUnits("10000", 6);
  console.log("Minting 10,000 test USDC to deployer...");
  const tx = await usdc.mint(deployer.address, amount, { gasLimit: 100_000 });
  console.log("tx:", tx.hash);
  await tx.wait(1);
  
  const bal = await usdc.balanceOf(deployer.address);
  console.log("✅ Deployer USDC balance:", ethers.formatUnits(bal, 6));
}

main().catch(console.error);
