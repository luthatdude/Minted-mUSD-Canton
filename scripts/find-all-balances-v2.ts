import { ethers } from "hardhat";

const VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
const BORROW = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
const MUSD = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
const WBTC = "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F";

async function main() {
  const provider = ethers.provider;
  const vault = await ethers.getContractAt("CollateralVault", VAULT);
  const borrow = await ethers.getContractAt("BorrowModule", BORROW);
  const musd = await ethers.getContractAt("MUSD", MUSD);

  const currentBlock = await provider.getBlockNumber();
  // Scan last 50000 blocks (~1 week on Sepolia)
  const fromBlock = currentBlock - 49000;

  console.log(`Scanning blocks ${fromBlock} to ${currentBlock}...\n`);

  // Scan Deposited events
  const filter = vault.filters.Deposited();
  const events = await vault.queryFilter(filter, fromBlock, currentBlock);
  
  const allAddrs = new Set<string>();
  for (const e of events) {
    if (e.args) allAddrs.add(e.args[0]);
  }

  // Also scan Borrowed events
  const borrowFilter = borrow.filters.Borrowed();
  const borrowEvents = await borrow.queryFilter(borrowFilter, fromBlock, currentBlock);
  for (const e of borrowEvents) {
    if (e.args) allAddrs.add(e.args[0]);
  }

  // Known addresses
  allAddrs.add("0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0"); // new deployer
  allAddrs.add("0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36"); // old deployer

  console.log(`Checking ${allAddrs.size} addresses...\n`);

  for (const addr of allAddrs) {
    const wethDep = await vault.deposits(addr, WETH);
    const wbtcDep = await vault.deposits(addr, WBTC);
    const debt = await borrow.totalDebt(addr);
    const musdBal = await musd.balanceOf(addr);
    
    const hasAnything = wethDep > 0n || wbtcDep > 0n || debt > 0n || musdBal > 0n;
    
    console.log(`${hasAnything ? "📍" : "  "} ${addr}`);
    console.log(`     WETH: ${ethers.formatEther(wethDep)}, WBTC: ${ethers.formatEther(wbtcDep)}, debt: ${ethers.formatEther(debt)}, mUSD: ${ethers.formatEther(musdBal)}`);
  }
  
  console.log("\n✅ Done");
}

main().catch(console.error);
