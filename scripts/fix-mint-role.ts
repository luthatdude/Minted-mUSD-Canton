/**
 * Fix: Grant VAULT_ROLE on TreasuryV2 to DirectMintV2
 * 
 * Root cause: DirectMintV2.mint() calls treasury.deposit() which requires VAULT_ROLE.
 * This role was never granted during deployment.
 */
import { ethers } from "hardhat";

const DIRECT_MINT = "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7";
const TREASURY    = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const treasury = await ethers.getContractAt("TreasuryV2", TREASURY);

  // Get VAULT_ROLE hash
  const VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("VAULT_ROLE"));
  console.log("VAULT_ROLE:", VAULT_ROLE);

  // Check if already granted
  const alreadyHas = await treasury.hasRole(VAULT_ROLE, DIRECT_MINT);
  if (alreadyHas) {
    console.log("✅ DirectMintV2 already has VAULT_ROLE — nothing to do");
    return;
  }

  // Check deployer has admin role
  const DEFAULT_ADMIN = ethers.ZeroHash;
  const isAdmin = await treasury.hasRole(DEFAULT_ADMIN, deployer.address);
  console.log("Deployer is DEFAULT_ADMIN on Treasury:", isAdmin);

  if (!isAdmin) {
    console.log("❌ Cannot grant role — deployer is not admin");
    return;
  }

  // Grant VAULT_ROLE to DirectMintV2
  console.log("Granting VAULT_ROLE to DirectMintV2...");
  const tx = await treasury.grantRole(VAULT_ROLE, DIRECT_MINT, { gasLimit: 100_000 });
  console.log("tx:", tx.hash);
  const receipt = await tx.wait(2);
  console.log("✅ VAULT_ROLE granted (gas:", receipt?.gasUsed.toString(), ")");

  // Verify
  const hasNow = await treasury.hasRole(VAULT_ROLE, DIRECT_MINT);
  console.log("Verification — DirectMintV2 has VAULT_ROLE:", hasNow);

  // Now try static call to mint
  console.log("\nRetesting mint(1 USDC) static call...");
  const dm = await ethers.getContractAt("DirectMintV2", DIRECT_MINT);
  try {
    const result = await dm.mint.staticCall(ethers.parseUnits("1", 6));
    console.log("✅ Mint would succeed — output:", ethers.formatUnits(result, 18), "mUSD");
  } catch (e: any) {
    console.log("❌ Still failing:", e.message?.slice(0, 300));
  }
}

main().catch(console.error);
