import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const target = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");

  // Deployer has BRIDGE_ROLE, so we can mint mUSD directly to the target
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const hasBridge = await musd.hasRole(BRIDGE_ROLE, deployer.address);
  
  if (!hasBridge) {
    console.log("Granting BRIDGE_ROLE to deployer...");
    const tx = await musd.grantRole(BRIDGE_ROLE, deployer.address);
    await tx.wait();
  }

  // Mint 2000 mUSD to target (enough to repay 1000.01 debt + have extra for testing)
  const amount = ethers.parseUnits("2000", 18);
  console.log("Minting 2000 mUSD to", target);
  const tx = await musd.mint(target, amount);
  await tx.wait();

  const bal = await musd.balanceOf(target);
  console.log("New mUSD balance:", ethers.formatUnits(bal, 18));
  console.log("Done! You can now repay your debt.");
}

main().catch(console.error);
