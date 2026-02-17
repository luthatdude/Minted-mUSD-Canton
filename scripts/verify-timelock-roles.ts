/**
 * Verify Timelock role state and check if revoking DEFAULT_ADMIN
 * from old deployer would orphan admin control.
 *
 * Usage: npx hardhat run scripts/verify-timelock-roles.ts --network sepolia
 */

import { ethers } from "hardhat";

const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const OLD_DEPLOYER = "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36";
const NEW_DEPLOYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

async function main() {
  const tl = await ethers.getContractAt("MintedTimelockController", TIMELOCK);

  const [ADMIN, PROPOSER, EXECUTOR, CANCELLER] = await Promise.all([
    tl.DEFAULT_ADMIN_ROLE(),
    tl.PROPOSER_ROLE(),
    tl.EXECUTOR_ROLE(),
    tl.CANCELLER_ROLE(),
  ]);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  TIMELOCK ROLE VERIFICATION");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Timelock:     ${TIMELOCK}`);
  console.log(`  Old deployer: ${OLD_DEPLOYER}`);
  console.log(`  New deployer: ${NEW_DEPLOYER}`);
  console.log();

  // Check roles for each address
  const addresses = [
    { name: "Timelock (self)", addr: TIMELOCK },
    { name: "Old deployer",    addr: OLD_DEPLOYER },
    { name: "New deployer",    addr: NEW_DEPLOYER },
  ];

  const roles = [
    { name: "DEFAULT_ADMIN", hash: ADMIN },
    { name: "PROPOSER",      hash: PROPOSER },
    { name: "EXECUTOR",      hash: EXECUTOR },
    { name: "CANCELLER",     hash: CANCELLER },
  ];

  for (const a of addresses) {
    console.log(`  ${a.name} (${a.addr}):`);
    for (const r of roles) {
      const has = await tl.hasRole(r.hash, a.addr);
      console.log(`    ${r.name.padEnd(15)} ${has ? "✅ YES" : "❌ no"}`);
    }
    console.log();
  }

  // Check getRoleAdmin for each role
  console.log("  Role admin hierarchy:");
  for (const r of roles) {
    const admin = await tl.getRoleAdmin(r.hash);
    const adminName = roles.find(x => x.hash === admin)?.name || admin;
    console.log(`    ${r.name.padEnd(15)} administered by: ${adminName}`);
  }

  // Check the minimum delay
  const minDelay = await tl.getMinDelay();
  console.log(`\n  Min delay: ${minDelay} seconds (${Number(minDelay) / 3600} hours)`);

  // Critical: what happens if we revoke DEFAULT_ADMIN from old deployer?
  const timelockHasAdmin = await tl.hasRole(ADMIN, TIMELOCK);
  console.log(`\n  ⚠️  SAFETY CHECK:`);
  console.log(`     Timelock self-admin: ${timelockHasAdmin}`);

  if (!timelockHasAdmin) {
    console.log("     🔴 DANGER: Timelock does NOT have DEFAULT_ADMIN_ROLE on itself!");
    console.log("     If we revoke from old deployer, NO entity will be able to manage roles.");
    console.log("     Must grant DEFAULT_ADMIN to Timelock or new deployer FIRST.");
  } else {
    console.log("     ✅ Timelock is its own admin — safe to revoke from old deployer.");
    console.log("     Future role changes will go through the timelock delay (governance).");
  }

  // Check role member counts (AccessControlEnumerable if available)
  console.log(`\n  Role member count (DEFAULT_ADMIN):`);
  try {
    const count = await tl.getRoleMemberCount(ADMIN);
    console.log(`    ${count} member(s) with DEFAULT_ADMIN`);
    for (let i = 0; i < Number(count); i++) {
      const member = await tl.getRoleMember(ADMIN, i);
      console.log(`      [${i}] ${member}`);
    }
  } catch {
    console.log("    (getRoleMemberCount not available — not enumerable)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
