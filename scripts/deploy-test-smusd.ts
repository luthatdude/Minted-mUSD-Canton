import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying TestSMUSD with 60s cooldown...");
  console.log("Deployer:", deployer.address);

  const musdAddr = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const globalPauseAddr = ethers.ZeroAddress; // skip global pause for testnet

  const TestSMUSD = await ethers.getContractFactory("TestSMUSD");
  const testSmusd = await TestSMUSD.deploy(musdAddr, globalPauseAddr);
  await testSmusd.waitForDeployment();
  const addr = await testSmusd.getAddress();
  console.log("TestSMUSD deployed at:", addr);

  // Grant YIELD_MANAGER_ROLE and INTEREST_ROUTER_ROLE so existing integrations work
  const YIELD_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("YIELD_MANAGER_ROLE"));
  const INTEREST_ROUTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("INTEREST_ROUTER_ROLE"));
  await (await testSmusd.grantRole(YIELD_MANAGER_ROLE, deployer.address)).wait();
  await (await testSmusd.grantRole(INTEREST_ROUTER_ROLE, deployer.address)).wait();
  console.log("Roles granted");

  // Grant BRIDGE_ROLE on mUSD to new smUSD so it can hold mUSD deposits
  // (smUSD doesn't need BRIDGE_ROLE - it just holds mUSD via ERC4626 deposit)

  console.log("");
  console.log("=== UPDATE frontend/.env.local ===");
  console.log(`NEXT_PUBLIC_SMUSD_ADDRESS=${addr}`);
  console.log(`NEXT_PUBLIC_SEPOLIA_SMUSD_ADDRESS=${addr}`);
  console.log("");
  console.log("Then restart the frontend: kill port 3000 and re-run next dev");
}

main().catch(console.error);
