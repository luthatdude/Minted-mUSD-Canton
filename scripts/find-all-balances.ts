import { ethers } from "hardhat";

const VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
const BORROW = "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8";
const MUSD = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
const WBTC = "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F";

async function main() {
  const vault = await ethers.getContractAt("CollateralVault", VAULT);
  const borrow = await ethers.getContractAt("BorrowModule", BORROW);
  const musd = await ethers.getContractAt("MUSD", MUSD);

  // Scan Deposited events to find all depositors
  console.log("=== Scanning Deposit events ===");
  const filter = vault.filters.Deposited();
  const events = await vault.queryFilter(filter, 0, "latest");
  
  // Collect unique depositors
  const depositors = new Set<string>();
  for (const e of events) {
    if (e.args) depositors.add(e.args[0]); // user address
  }
  
  console.log(`Found ${depositors.size} unique depositors from ${events.length} events\n`);

  // Check each depositor's current state
  for (const addr of depositors) {
    const wethDep = await vault.deposits(addr, WETH);
    const wbtcDep = await vault.deposits(addr, WBTC);
    const debt = await borrow.totalDebt(addr);
    const musdBal = await musd.balanceOf(addr);
    
    if (wethDep > 0n || wbtcDep > 0n || debt > 0n || musdBal > 0n) {
      console.log(`\n📍 ${addr}`);
      if (wethDep > 0n) console.log(`   WETH deposited: ${ethers.formatEther(wethDep)}`);
      if (wbtcDep > 0n) console.log(`   WBTC deposited: ${ethers.formatEther(wbtcDep)}`);
      if (debt > 0n)    console.log(`   Debt: ${ethers.formatEther(debt)} mUSD`);
      if (musdBal > 0n) console.log(`   mUSD balance: ${ethers.formatEther(musdBal)}`);
    }
  }

  // Also check Borrowed events for additional addresses
  console.log("\n=== Scanning Borrowed events ===");
  const borrowFilter = borrow.filters.Borrowed();
  const borrowEvents = await borrow.queryFilter(borrowFilter, 0, "latest");
  const borrowers = new Set<string>();
  for (const e of borrowEvents) {
    if (e.args) borrowers.add(e.args[0]);
  }
  
  for (const addr of borrowers) {
    if (depositors.has(addr)) continue; // already checked
    const debt = await borrow.totalDebt(addr);
    const musdBal = await musd.balanceOf(addr);
    if (debt > 0n || musdBal > 0n) {
      console.log(`\n📍 ${addr} (borrower only)`);
      if (debt > 0n)    console.log(`   Debt: ${ethers.formatEther(debt)} mUSD`);
      if (musdBal > 0n) console.log(`   mUSD balance: ${ethers.formatEther(musdBal)}`);
    }
  }

  // Check mUSD Transfer events for any holders
  console.log("\n=== Scanning mUSD transfers for holders ===");
  const transferFilter = musd.filters.Transfer();
  const transfers = await musd.queryFilter(transferFilter, 0, "latest");
  const holders = new Set<string>();
  for (const e of transfers) {
    if (e.args) {
      holders.add(e.args[1]); // 'to' address
    }
  }
  
  for (const addr of holders) {
    if (depositors.has(addr) || borrowers.has(addr)) continue;
    if (addr === ethers.ZeroAddress) continue;
    const bal = await musd.balanceOf(addr);
    if (bal > 0n) {
      console.log(`📍 ${addr} holds ${ethers.formatEther(bal)} mUSD`);
    }
  }
  
  console.log("\n✅ Scan complete");
}

main().catch(console.error);
