import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  const newBridge = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";

  const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
  console.log("CAP_MANAGER_ROLE:", CAP_MANAGER_ROLE);

  const hasCap = await musd.hasRole(CAP_MANAGER_ROLE, newBridge);
  console.log("New bridge has CAP_MANAGER_ROLE:", hasCap);

  if (!hasCap) {
    const tx = await musd.grantRole(CAP_MANAGER_ROLE, newBridge);
    await tx.wait(2);
    console.log("Granted CAP_MANAGER_ROLE to new bridge:", tx.hash);
  }

  console.log("Verified CAP_MANAGER_ROLE:", await musd.hasRole(CAP_MANAGER_ROLE, newBridge));
}

main().catch(console.error);
