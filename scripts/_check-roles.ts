import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const timelock = await ethers.getContractAt("MintedTimelockController", "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410");
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const EXECUTOR = await timelock.EXECUTOR_ROLE();
  const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  const CANCELLER = await timelock.CANCELLER_ROLE();

  // Check known addresses
  const addresses: Record<string, string> = {
    "deployer (0xe640)": deployer.address,
    "timelock itself": "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
    "bridge proxy": "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125",
    "treasury": "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
    "address(0) [open]": ethers.ZeroAddress,
  };

  console.log("\n=== TIMELOCK ROLE CHECK ===");
  console.log("PROPOSER_ROLE:", PROPOSER);
  console.log("EXECUTOR_ROLE:", EXECUTOR);
  console.log("CANCELLER_ROLE:", CANCELLER);
  console.log("DEFAULT_ADMIN_ROLE:", ADMIN);

  for (const [name, addr] of Object.entries(addresses)) {
    const p = await timelock.hasRole(PROPOSER, addr);
    const e = await timelock.hasRole(EXECUTOR, addr);
    const a = await timelock.hasRole(ADMIN, addr);
    const c = await timelock.hasRole(CANCELLER, addr);
    if (p || e || a || c) {
      console.log(`\n  ${name} (${addr}):`);
      if (p) console.log("    ✅ PROPOSER");
      if (e) console.log("    ✅ EXECUTOR");
      if (c) console.log("    ✅ CANCELLER");
      if (a) console.log("    ✅ DEFAULT_ADMIN");
    }
  }

  // Also check RoleGranted events to find all holders
  console.log("\n=== TIMELOCK RoleGranted EVENTS (last 50000 blocks) ===");
  const currentBlock = await ethers.provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 50000);
  const filter = timelock.filters.RoleGranted();
  try {
    const events = await timelock.queryFilter(filter, fromBlock, currentBlock);
    for (const ev of events) {
      const args = (ev as any).args;
      console.log(`  Role ${args.role.slice(0,10)}... granted to ${args.account} by ${args.sender}`);
    }
    if (events.length === 0) console.log("  No events in range — try searching from block 0");
  } catch (e: any) {
    console.log("  Query failed:", e.message?.slice(0, 100));
    // Try a smaller range
    const filter2 = timelock.filters.RoleGranted();
    try {
      const events2 = await timelock.queryFilter(filter2, currentBlock - 10000, currentBlock);
      console.log("  (retried 10k blocks) Found", events2.length, "events");
    } catch { console.log("  Retry also failed"); }
  }

  // Check bridge admin
  const bridge = await ethers.getContractAt("BLEBridgeV9", "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125");
  console.log("\n=== BRIDGE ADMIN CHECK ===");
  const bAdmin = await bridge.DEFAULT_ADMIN_ROLE();
  console.log("Bridge DEFAULT_ADMIN holders:");
  for (const [name, addr] of Object.entries(addresses)) {
    if (await bridge.hasRole(bAdmin, addr)) {
      console.log(`  ✅ ${name} (${addr})`);
    }
  }
}

main().catch(console.error);
