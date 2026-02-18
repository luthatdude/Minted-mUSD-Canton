import { ethers } from "hardhat";

async function main() {
  const weth = new ethers.Contract("0x7999F2894290F2Ce34a508eeff776126D9a7D46e", [
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function mint(address, uint256)",
    "function balanceOf(address) view returns (uint256)",
  ], ethers.provider);

  console.log(`Name: ${await weth.name()}`);
  console.log(`Symbol: ${await weth.symbol()}`);
  console.log(`Decimals: ${await weth.decimals()}`);
  console.log(`TotalSupply: ${ethers.formatEther(await weth.totalSupply())}`);

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer WETH bal: ${ethers.formatEther(await weth.balanceOf(deployer.address))}`);

  // Try to mint
  try {
    const wethSigned = weth.connect(deployer);
    const tx = await wethSigned.mint(deployer.address, ethers.parseEther("10"));
    await tx.wait();
    console.log(`\nMinted 10 WETH to deployer ✅`);
    console.log(`New balance: ${ethers.formatEther(await weth.balanceOf(deployer.address))}`);
  } catch (e: any) {
    console.log(`\nMint failed: ${e.message?.slice(0, 120)}`);
  }
}

main();
