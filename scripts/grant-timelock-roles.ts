import { ethers } from "hardhat";

/**
 * Grant PROPOSER + EXECUTOR + CANCELLER roles on MintedTimelockController
 * to the new deployer (0xe640db3A...).
 *
 * Run with old deployer key:
 *   OLD_DEPLOYER_KEY=523ee93e... npx hardhat run scripts/grant-timelock-roles.ts --network sepolia
 */

const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
const NEW_DEPLOYER = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

async function main() {
  const oldKey = process.env.OLD_DEPLOYER_KEY;
  if (!oldKey) throw new Error("Set OLD_DEPLOYER_KEY env var");

  const provider = ethers.provider;
  const oldDeployer = new ethers.Wallet(oldKey, provider);
  console.log("Old deployer:", oldDeployer.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(oldDeployer.address)), "ETH");

  const timelock = (await ethers.getContractAt("MintedTimelockController", TIMELOCK)).connect(oldDeployer) as any;

  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();

  // Check old deployer has DEFAULT_ADMIN
  const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  const hasAdmin = await timelock.hasRole(ADMIN, oldDeployer.address);
  if (!hasAdmin) throw new Error("Old deployer lacks DEFAULT_ADMIN_ROLE");
  console.log("✅ Old deployer has DEFAULT_ADMIN_ROLE");

  // Grant roles to new deployer
  for (const [name, role] of [
    ["PROPOSER_ROLE", PROPOSER_ROLE],
    ["EXECUTOR_ROLE", EXECUTOR_ROLE],
    ["CANCELLER_ROLE", CANCELLER_ROLE],
  ]) {
    const has = await timelock.hasRole(role, NEW_DEPLOYER);
    if (has) {
      console.log(`✅ ${name} already granted to ${NEW_DEPLOYER}`);
    } else {
      console.log(`⚙️  Granting ${name} to ${NEW_DEPLOYER}...`);
      const tx = await timelock.grantRole(role, NEW_DEPLOYER);
      await tx.wait();
      console.log(`✅ ${name} granted (tx: ${tx.hash})`);
    }
  }

  // Verify
  console.log("\n=== Verification ===");
  console.log("PROPOSER:", await timelock.hasRole(PROPOSER_ROLE, NEW_DEPLOYER));
  console.log("EXECUTOR:", await timelock.hasRole(EXECUTOR_ROLE, NEW_DEPLOYER));
  console.log("CANCELLER:", await timelock.hasRole(CANCELLER_ROLE, NEW_DEPLOYER));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
