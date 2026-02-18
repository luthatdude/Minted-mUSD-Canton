import { ethers } from "hardhat";

/**
 * Recovery script: Re-mint mUSD that was burned during bridge-to-Canton
 * when the relay service wasn't running (Canton delivery never happened).
 *
 * Bridge events from check-bridge-events2.ts:
 *   Nonce 4: 200 mUSD from 0x7De3...Dd36 → minted-user-7de39963::...
 *   Nonce 5: 1000 mUSD from 0x7De3...Dd36 → dde6467edc610708573d717a53c7c396::...
 *   Nonce 1-3: 50 mUSD each from deployer → minted-validator-1::... (150 total)
 *
 * Total to recover for user wallet: 1,200 mUSD
 * Total to recover for deployer:     150 mUSD
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const musdAddr = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const userWallet = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";

  const musd = await ethers.getContractAt("MUSD", musdAddr);

  // Verify deployer has BRIDGE_ROLE
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const hasBridge = await musd.hasRole(BRIDGE_ROLE, deployer.address);
  console.log("Deployer has BRIDGE_ROLE:", hasBridge);
  if (!hasBridge) {
    console.log("ERROR: Deployer needs BRIDGE_ROLE to mint");
    return;
  }

  // Check current balances
  const userBal = await musd.balanceOf(userWallet);
  const deployerBal = await musd.balanceOf(deployer.address);
  console.log("\nBefore recovery:");
  console.log("  User mUSD balance:", ethers.formatUnits(userBal, 18));
  console.log("  Deployer mUSD balance:", ethers.formatUnits(deployerBal, 18));

  // Recovery amounts (from bridge events)
  const userRecovery = ethers.parseUnits("1200", 18);   // nonce 4 (200) + nonce 5 (1000)
  const deployerRecovery = ethers.parseUnits("150", 18); // nonces 1-3 (50 each)

  // Mint back to user wallet
  console.log("\nMinting 1,200 mUSD back to user wallet (bridge recovery)...");
  const tx1 = await musd.mint(userWallet, userRecovery);
  await tx1.wait();
  console.log("✅ User recovery TX:", tx1.hash);

  // Mint back to deployer
  console.log("Minting 150 mUSD back to deployer (bridge recovery)...");
  const tx2 = await musd.mint(deployer.address, deployerRecovery);
  await tx2.wait();
  console.log("✅ Deployer recovery TX:", tx2.hash);

  // Verify
  const userBalAfter = await musd.balanceOf(userWallet);
  const deployerBalAfter = await musd.balanceOf(deployer.address);
  console.log("\nAfter recovery:");
  console.log("  User mUSD balance:", ethers.formatUnits(userBalAfter, 18));
  console.log("  Deployer mUSD balance:", ethers.formatUnits(deployerBalAfter, 18));
  console.log("\n✅ Bridge recovery complete — mUSD re-minted for failed Canton deliveries");
}

main().catch((e) => { console.error(e); process.exit(1); });
