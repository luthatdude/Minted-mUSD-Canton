import { ethers } from "hardhat";

async function main() {
  const smusd = await ethers.getContractAt("SMUSD", "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540");
  const provider = ethers.provider;
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 49000; // stay under 50k limit
  console.log(`Scanning blocks ${fromBlock} to ${currentBlock}`);

  // Check YieldDistributed events
  const yieldFilter = smusd.filters.YieldDistributed();
  const yieldEvents = await smusd.queryFilter(yieldFilter, fromBlock);
  console.log(`\nYieldDistributed events: ${yieldEvents.length}`);
  for (const e of yieldEvents) {
    const block = await e.getBlock();
    console.log(`  Block ${e.blockNumber} (${new Date(block.timestamp * 1000).toISOString()})`);
    console.log(`    from: ${e.args[0]}`);
    console.log(`    amount: ${ethers.formatUnits(e.args[1], 18)} mUSD`);
  }

  // Check Deposit events
  const depositFilter = smusd.filters.Deposit();
  const depositEvents = await smusd.queryFilter(depositFilter, fromBlock);
  console.log(`\nDeposit events: ${depositEvents.length}`);
  let totalDeposited = 0n;
  for (const e of depositEvents) {
    const block = await e.getBlock();
    console.log(`  Block ${e.blockNumber} (${new Date(block.timestamp * 1000).toISOString()})`);
    console.log(`    assets: ${ethers.formatUnits(e.args[2], 18)} mUSD -> shares: ${ethers.formatUnits(e.args[3], 21)} smUSD`);
    totalDeposited += e.args[2];
  }
  console.log(`\nTotal deposited via deposit(): ${ethers.formatUnits(totalDeposited, 18)} mUSD`);

  const totalAssets = await smusd.totalAssets();
  console.log(`Current totalAssets: ${ethers.formatUnits(totalAssets, 18)} mUSD`);
  console.log(`Apparent yield = totalAssets - deposits = ${ethers.formatUnits(totalAssets - totalDeposited, 18)} mUSD`);

  // Check ALL mUSD transfers TO the vault
  const musd = await ethers.getContractAt("IERC20", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const transferFilter = musd.filters.Transfer(null, "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540");
  const transfers = await musd.queryFilter(transferFilter, fromBlock);
  console.log(`\nmUSD Transfer events TO vault: ${transfers.length}`);
  let totalTransferred = 0n;
  for (const t of transfers) {
    console.log(`  from: ${t.args[0]}  amount: ${ethers.formatUnits(t.args[2], 18)} mUSD`);
    totalTransferred += t.args[2];
  }
  console.log(`Total mUSD ever sent to vault: ${ethers.formatUnits(totalTransferred, 18)}`);

  // Vesting state
  const unvested = await smusd.unvestedYield();
  const vestEnd = await smusd.yieldVestingEnd();
  console.log(`\nUnvested yield: ${ethers.formatUnits(unvested, 18)} mUSD`);
  console.log(`Vesting end: ${new Date(Number(vestEnd) * 1000).toISOString()}`);
}

main();
