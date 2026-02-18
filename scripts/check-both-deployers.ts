import { ethers } from "hardhat";
async function main() {
  const v = await ethers.getContractAt("CollateralVault", "0x155d6618dcdeb2F4145395CA57C80e6931D7941e");
  const b = await ethers.getContractAt("BorrowModule", "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8");
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  // Check both deployer addresses
  const addrs = [
    ["newDeployer", "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0"],
    ["oldDeployer", "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36"],
  ];
  for (const [name, a] of addrs) {
    const dep = await v.deposits(a, WETH);
    const debt = await b.totalDebt(a);
    const bal = await musd.balanceOf(a);
    console.log(`${name} (${a.slice(0,10)}) => WETH: ${ethers.formatEther(dep)}, debt: ${ethers.formatEther(debt)}, mUSD: ${ethers.formatEther(bal)}`);
  }
}
main().catch(console.error);
