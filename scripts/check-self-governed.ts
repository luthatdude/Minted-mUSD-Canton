import { ethers } from "hardhat";

/**
 * Check who holds TIMELOCK_ROLE on self-governed contracts where current deployer doesn't.
 * Look for RoleGranted events to find any holders.
 */
async function main() {
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  
  // Self-governed contracts where nobody we know has TIMELOCK_ROLE
  const targets = [
    { name: "InterestRateModel", address: "0x501265BeF81E6E96e4150661e2b9278272e9177B" },
    { name: "PendleStrategyV2",  address: "0x38726CC401b732Cf3c5AF8CC0Dc4E7c10204c6C6" },
  ];

  // Known addresses that might have the role (deployers, timelock)
  const candidates = [
    { label: "current deployer",  addr: "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0" },
    { label: "timelock",          addr: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410" },
    { label: "old deployer (resume2)", addr: "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36" },
  ];

  for (const t of targets) {
    console.log(`\n=== ${t.name} (${t.address}) ===`);
    const contract = await ethers.getContractAt("AccessControl", t.address);
    
    for (const c of candidates) {
      const has = await contract.hasRole(TIMELOCK_ROLE, c.addr);
      console.log(`  ${c.label.padEnd(25)} ${c.addr.slice(0, 10)}...  ${has ? "✅ HAS ROLE" : "❌ no"}`);
    }

    // Also check DEFAULT_ADMIN_ROLE
    const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
    for (const c of candidates) {
      const has = await contract.hasRole(DEFAULT_ADMIN, c.addr);
      if (has) console.log(`  ${c.label.padEnd(25)} has DEFAULT_ADMIN_ROLE ✅`);
    }

    // Scan RoleGranted events to find any TIMELOCK_ROLE holders
    console.log("\n  Scanning RoleGranted events...");
    const filter = contract.filters.RoleGranted(TIMELOCK_ROLE);
    try {
      const events = await contract.queryFilter(filter, 0, "latest");
      if (events.length === 0) {
        console.log("  ⚠️  NO RoleGranted events for TIMELOCK_ROLE — role was never granted!");
      } else {
        for (const ev of events) {
          const args = (ev as any).args;
          console.log(`  RoleGranted: account=${args.account}, sender=${args.sender}, block=${ev.blockNumber}`);
        }
      }
    } catch (e: any) {
      console.log(`  Event scan failed: ${e.message?.slice(0, 80)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
