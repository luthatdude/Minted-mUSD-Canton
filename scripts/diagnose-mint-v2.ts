/**
 * Deeper diagnosis — the VAULT_ROLE is already granted.
 * Decode error 0xfb8f41b2 and trace step by step.
 */
import { ethers } from "hardhat";

const DIRECT_MINT = "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7";
const MUSD_ADDR = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
const USDC_ADDR = "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474";
const TREASURY_ADDR = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const dm = await ethers.getContractAt("DirectMintV2", DIRECT_MINT);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDR);

  // Decode the error
  const errorData = "0xfb8f41b2000000000000000000000000aa3e42f2afb5df83d6a33746c2927bce8b22bae7000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4240";
  
  // 0xfb8f41b2 = SafeERC20FailedOperation(address)
  const safeIface = new ethers.Interface(["error SafeERC20FailedOperation(address token)"]);
  try {
    const decoded = safeIface.parseError(errorData);
    console.log("Decoded error: SafeERC20FailedOperation");
    console.log("  token:", decoded?.args[0]);
  } catch {
    console.log("Not SafeERC20FailedOperation");
  }

  // 0xfb8f41b2 = check against AccessControlUnauthorizedAccount
  const acIface = new ethers.Interface(["error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)"]);
  try {
    const decoded = acIface.parseError(errorData);
    console.log("Decoded error: AccessControlUnauthorizedAccount");
    console.log("  account:", decoded?.args[0]);
    console.log("  neededRole:", decoded?.args[1]);
  } catch {
    console.log("Not AccessControlUnauthorizedAccount");
  }

  // Let's compute the selectors to be sure
  const safeSel = ethers.id("SafeERC20FailedOperation(address)").slice(0, 10);
  const acSel = ethers.id("AccessControlUnauthorizedAccount(address,bytes32)").slice(0, 10);
  console.log("\nSelector in error data:", errorData.slice(0, 10));
  console.log("SafeERC20FailedOperation(address) selector:", safeSel);
  console.log("AccessControlUnauthorizedAccount(address,bytes32) selector:", acSel);

  // Check deployer's USDC balance and allowance to DirectMintV2
  const bal = await usdc.balanceOf(deployer.address);
  const allowance = await usdc.allowance(deployer.address, DIRECT_MINT);
  console.log("\nDeployer USDC balance:", ethers.formatUnits(bal, 6));
  console.log("Deployer USDC allowance for DirectMintV2:", ethers.formatUnits(allowance, 6));

  // Check if USDC is the actual contract the error refers to
  // The error data has: aa3e42f2afb5df83d6a33746c2927bce8b22bae7 = DirectMintV2 address
  // So the failed operation is happening ON DirectMintV2, not on USDC
  
  // The full ABI decode: first 32 bytes after selector = address, second 32 bytes = ?, third 32 bytes = 0x0f4240 = 1000000 = 1 USDC
  // This looks like it could be a different error entirely
  
  // Let me check all custom errors in TreasuryV2
  const treasury = await ethers.getContractAt("TreasuryV2", TREASURY_ADDR);
  const treasuryIface = treasury.interface;
  
  // Try to parse with treasury interface
  try {
    const decoded = treasuryIface.parseError(errorData);
    console.log("\nTreasury error:", decoded?.name);
    console.log("  args:", decoded?.args);
  } catch {
    console.log("\nNot a Treasury error");
  }

  // Try DirectMintV2 interface
  const dmIface = dm.interface;
  try {
    const decoded = dmIface.parseError(errorData);
    console.log("DirectMintV2 error:", decoded?.name);
    console.log("  args:", decoded?.args);
  } catch {
    console.log("Not a DirectMintV2 error");
  }

  // Try MUSD interface
  const musd = await ethers.getContractAt("MUSD", MUSD_ADDR);
  try {
    const decoded = musd.interface.parseError(errorData);
    console.log("MUSD error:", decoded?.name);
    console.log("  args:", decoded?.args);
  } catch {
    console.log("Not a MUSD error");
  }

  // Step-by-step: Test USDC transferFrom independently
  console.log("\n--- Step-by-step mint trace ---");
  
  // Step 1: Approve USDC
  console.log("1. Approving 1 USDC to DirectMintV2...");
  try {
    const approveTx = await usdc.approve(DIRECT_MINT, ethers.parseUnits("1", 6), { gasLimit: 100_000 });
    await approveTx.wait(1);
    console.log("   ✅ Approved");
  } catch (e: any) {
    console.log("   ❌ Approve failed:", e.message?.slice(0, 200));
    return;
  }

  // Step 2: Try mint again with approval
  console.log("2. Static call dm.mint(1 USDC) after approval...");
  try {
    const result = await dm.mint.staticCall(ethers.parseUnits("1", 6));
    console.log("   ✅ Would succeed — output:", ethers.formatUnits(result, 18), "mUSD");
  } catch (e: any) {
    console.log("   ❌ Still fails:", e.message?.slice(0, 400));
    if (e.data) console.log("   Error data:", e.data);
  }

  // Step 3: Actually do the mint
  console.log("3. Executing dm.mint(1 USDC)...");
  try {
    const tx = await dm.mint(ethers.parseUnits("1", 6), { gasLimit: 500_000 });
    console.log("   tx:", tx.hash);
    const receipt = await tx.wait(2);
    console.log("   ✅ Minted! Gas used:", receipt?.gasUsed.toString());
    
    const musdBal = await musd.balanceOf(deployer.address);
    console.log("   mUSD balance:", ethers.formatUnits(musdBal, 18));
  } catch (e: any) {
    console.log("   ❌ Mint tx failed:", e.message?.slice(0, 400));
  }
}

main().catch(console.error);
