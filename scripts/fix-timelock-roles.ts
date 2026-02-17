import { ethers } from "hardhat";

/**
 * FIX TIMELOCK_ROLE on CollateralVault
 * 
 * Problem: TIMELOCK_ROLE's roleAdmin is TIMELOCK_ROLE itself (self-governing).
 *          Only the old deployer has TIMELOCK_ROLE. The new deployer and timelock 
 *          cannot call addCollateral, updateCollateral, etc.
 *
 * Solution: Use old deployer key to grant TIMELOCK_ROLE to new deployer + timelock.
 *
 * IMPORTANT: Temporarily set .env DEPLOYER_PRIVATE_KEY to old deployer key before running!
 *   DEPLOYER_PRIVATE_KEY=523ee93e...  (old deployer 0x7De39963...)
 */
async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  
  if (signer.address.toLowerCase() !== "0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36".toLowerCase()) {
    console.error("❌ This script must be run with the OLD deployer key!");
    console.error("   Expected: 0x7De39963ee59B0a5e74f36B8BCc0426c286bDd36");
    console.error("   Got:      " + signer.address);
    console.error("\n   Temporarily set DEPLOYER_PRIVATE_KEY to old key in .env");
    return;
  }

  const GAS = { gasLimit: 200_000 };
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const NEW_DEPLOYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";

  // Contracts that might need TIMELOCK_ROLE fix
  const CONTRACTS = [
    { name: "CollateralVault", address: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e" },
    { name: "BorrowModule",    address: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8" },
    { name: "SMUSD",           address: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540" },
    { name: "MUSD",            address: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B" },
    { name: "LeverageVault",   address: "0x8a5D24bAc265d5ed0fa49AB1C2402C02823A2fbC" },
    { name: "PriceOracle",     address: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025" },
    { name: "DirectMintV2",    address: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7" },
  ];

  for (const c of CONTRACTS) {
    const contract = await ethers.getContractAt("AccessControl", c.address);
    
    // Check if contract has TIMELOCK_ROLE concept (check if old deployer has it)
    const oldHas = await contract.hasRole(TIMELOCK_ROLE, signer.address);
    if (!oldHas) {
      console.log(`${c.name}: old deployer has no TIMELOCK_ROLE — skipping`);
      continue;
    }

    // Check role admin
    const roleAdmin = await contract.getRoleAdmin(TIMELOCK_ROLE);
    const isSelfGoverned = (roleAdmin === TIMELOCK_ROLE);
    
    console.log(`\n${c.name} (${c.address}):`);
    console.log(`  TIMELOCK_ROLE admin: ${isSelfGoverned ? "TIMELOCK_ROLE (self-governed)" : roleAdmin}`);
    
    // Grant to new deployer
    const newHas = await contract.hasRole(TIMELOCK_ROLE, NEW_DEPLOYER);
    if (!newHas) {
      const tx = await contract.grantRole(TIMELOCK_ROLE, NEW_DEPLOYER, GAS);
      await tx.wait();
      console.log(`  ✅ Granted TIMELOCK_ROLE to new deployer`);
    } else {
      console.log(`  ✅ New deployer already has TIMELOCK_ROLE`);
    }

    // Grant to timelock
    const tlHas = await contract.hasRole(TIMELOCK_ROLE, TIMELOCK);
    if (!tlHas) {
      const tx = await contract.grantRole(TIMELOCK_ROLE, TIMELOCK, GAS);
      await tx.wait();
      console.log(`  ✅ Granted TIMELOCK_ROLE to timelock`);
    } else {
      console.log(`  ✅ Timelock already has TIMELOCK_ROLE`);
    }
  }

  console.log("\n✅ Done! Remember to switch .env back to new deployer key.");
}

main().catch(console.error);
