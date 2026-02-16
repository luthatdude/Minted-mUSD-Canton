import { ethers } from "hardhat";
async function main() {
  const [d] = await ethers.getSigners();
  console.log("Address:", d.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(d.address)), "ETH");
}
main();
