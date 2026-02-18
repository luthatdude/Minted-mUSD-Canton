/**
 * Diagnose why mint is reverting on Sepolia
 */
import { ethers } from "hardhat";

const DIRECT_MINT = "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7";
const MUSD_ADDR = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
const USDC_ADDR = "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474";
const TREASURY_ADDR = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";
const PAUSE_REG = "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const dm = await ethers.getContractAt("DirectMintV2", DIRECT_MINT);
  const musd = await ethers.getContractAt("MUSD", MUSD_ADDR);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDR);
  const treasury = await ethers.getContractAt("TreasuryV2", TREASURY_ADDR);

  // 1. Is DirectMintV2 paused?
  try {
    const paused = await dm.paused();
    console.log("1. DirectMintV2 paused:", paused);
  } catch (e: any) {
    console.log("1. DirectMintV2 paused() ERROR:", e.message?.slice(0, 200));
  }

  // 2. Does DirectMintV2 have BRIDGE_ROLE on MUSD?
  try {
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const has = await musd.hasRole(BRIDGE_ROLE, DIRECT_MINT);
    console.log("2. DirectMintV2 has BRIDGE_ROLE:", has);
  } catch (e: any) {
    console.log("2. BRIDGE_ROLE check ERROR:", e.message?.slice(0, 200));
  }

  // 3. DirectMintV2 config (usdc, musd, treasury addresses)
  try {
    const u = await dm.usdc();
    const m = await dm.musd();
    const t = await dm.treasury();
    console.log("3. DM config: usdc=", u, "musd=", m, "treasury=", t);
    console.log("   Expected:  usdc=", USDC_ADDR, "musd=", MUSD_ADDR, "treasury=", TREASURY_ADDR);
    console.log("   Match:     usdc=", u.toLowerCase() === USDC_ADDR.toLowerCase(),
                "musd=", m.toLowerCase() === MUSD_ADDR.toLowerCase(),
                "treasury=", t.toLowerCase() === TREASURY_ADDR.toLowerCase());
  } catch (e: any) {
    console.log("3. DM config ERROR:", e.message?.slice(0, 200));
  }

  // 4. Mint limits
  try {
    const minMint = await dm.minMintAmount();
    const maxMint = await dm.maxMintAmount();
    const fee = await dm.mintFeeBps();
    console.log("4. minMintAmount:", minMint.toString(), "maxMintAmount:", maxMint.toString(), "feeBps:", fee.toString());
  } catch (e: any) {
    console.log("4. Mint limits ERROR:", e.message?.slice(0, 200));
  }

  // 5. MUSD supply cap vs total supply
  try {
    const cap = await musd.supplyCap();
    const supply = await musd.totalSupply();
    console.log("5. MUSD supplyCap:", ethers.formatUnits(cap, 18), "totalSupply:", ethers.formatUnits(supply, 18));
  } catch (e: any) {
    console.log("5. MUSD supply check ERROR:", e.message?.slice(0, 200));
  }

  // 6. TreasuryV2 state
  try {
    const asset = await treasury.asset();
    console.log("6. Treasury asset():", asset);
  } catch (e: any) {
    console.log("6. Treasury asset() REVERTED:", e.message?.slice(0, 200));
  }

  // 7. Does Treasury have a vault set?
  try {
    const vault = await treasury.vault();
    console.log("7. Treasury vault():", vault);
  } catch (e: any) {
    console.log("7. Treasury vault() ERROR:", e.message?.slice(0, 200));
  }

  // 8. GlobalPauseRegistry
  try {
    const gp = await ethers.getContractAt("GlobalPauseRegistry", PAUSE_REG);
    const globalPaused = await gp.paused();
    console.log("8. GlobalPauseRegistry paused:", globalPaused);
  } catch (e: any) {
    console.log("8. GlobalPause ERROR:", e.message?.slice(0, 200));
  }

  // 9. Deployer USDC balance
  try {
    const bal = await usdc.balanceOf(deployer.address);
    console.log("9. Deployer USDC balance:", ethers.formatUnits(bal, 6));
  } catch (e: any) {
    console.log("9. USDC balance ERROR:", e.message?.slice(0, 200));
  }

  // 10. Try static call to mint(1 USDC)
  console.log("\n10. Static call dm.mint(1 USDC)...");
  try {
    const result = await dm.mint.staticCall(ethers.parseUnits("1", 6));
    console.log("    SUCCESS — would mint:", ethers.formatUnits(result, 18), "mUSD");
  } catch (e: any) {
    console.log("    REVERTED:", e.message?.slice(0, 500));
    // Try to decode
    if (e.data) {
      console.log("    Error data:", e.data);
    }
    if (e.revert) {
      console.log("    Revert name:", e.revert?.name);
      console.log("    Revert args:", e.revert?.args);
    }
  }

  // 11. Check if Treasury.deposit() has DEPOSITOR_ROLE requirement
  console.log("\n11. Checking Treasury deposit role...");
  try {
    const DEPOSITOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DEPOSITOR_ROLE"));
    const dmHasDepositor = await treasury.hasRole(DEPOSITOR_ROLE, DIRECT_MINT);
    console.log("    DirectMintV2 has DEPOSITOR_ROLE on Treasury:", dmHasDepositor);
  } catch (e: any) {
    console.log("    Treasury role check ERROR:", e.message?.slice(0, 200));
  }

  // 12. Check TreasuryV2 deposit function signature exists
  try {
    // Try calling with the exact signature DirectMintV2 uses
    // treasury.deposit(address depositor, uint256 amount)
    const iface = treasury.interface;
    const depositFrag = iface.getFunction("deposit");
    console.log("12. Treasury deposit function:", depositFrag?.format("full"));
  } catch (e: any) {
    console.log("12. Treasury deposit function lookup ERROR:", e.message?.slice(0, 200));
  }
}

main().catch(console.error);
