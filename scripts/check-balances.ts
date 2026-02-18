import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
  const dead = "0x000000000000000000000000000000000000dEaD";

  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const smusd = await ethers.getContractAt("SMUSD", "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540");

  console.log("=== On-chain balances ===");
  console.log("Target mUSD:", ethers.formatUnits(await musd.balanceOf(target), 18));
  console.log("Target sMUSD:", ethers.formatUnits(await smusd.balanceOf(target), 21));
  console.log("Dead mUSD:", ethers.formatUnits(await musd.balanceOf(dead), 18));
  console.log("Dead sMUSD:", ethers.formatUnits(await smusd.balanceOf(dead), 21));
  console.log("Deployer mUSD:", ethers.formatUnits(await musd.balanceOf(deployer.address), 18));
  console.log("Deployer sMUSD:", ethers.formatUnits(await smusd.balanceOf(deployer.address), 21));
  console.log("Vault totalAssets:", ethers.formatUnits(await smusd.totalAssets(), 18));
  console.log("Vault totalSupply:", ethers.formatUnits(await smusd.totalSupply(), 21));
  console.log("mUSD totalSupply:", ethers.formatUnits(await musd.totalSupply(), 18));
}

main().catch(console.error);
