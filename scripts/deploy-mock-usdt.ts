import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  // USDT uses 6 decimals, same as real USDT
  const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
  await usdt.waitForDeployment();
  const addr = await usdt.getAddress();
  console.log("MockUSDT deployed to:", addr);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
