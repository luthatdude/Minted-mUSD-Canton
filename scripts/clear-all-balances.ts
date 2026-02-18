/**
 * Clear ALL balances for target wallet across Stake, Mint, and Borrow pages.
 * Covers: MUSD, sMUSD, USDC, WETH, WBTC, DirectMint, TreasuryV2, CollateralVault, BorrowModule
 */
import { ethers } from "hardhat";

const TARGET = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";

const ADDRS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  SMUSD: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  USDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  WETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  WBTC: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  DirectMintV2: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
  TreasuryV2: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  DepositRouter: "0x531e95585bcDfcB2303511483F232EEF4a0Cd2de",
};

// Also clear deployer
const DEPLOYER_ADDR = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Target wallet:", TARGET);

  const musd = await ethers.getContractAt("MUSD", ADDRS.MUSD);
  const smusd = await ethers.getContractAt("SMUSD", ADDRS.SMUSD);
  const vault = await ethers.getContractAt("CollateralVault", ADDRS.CollateralVault);
  const borrow = await ethers.getContractAt("BorrowModule", ADDRS.BorrowModule);

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function transfer(address,uint256) returns (bool)",
    "function burn(address,uint256)",
  ];

  const tokens = [
    { name: "MUSD", addr: ADDRS.MUSD },
    { name: "sMUSD", addr: ADDRS.SMUSD },
    { name: "USDC", addr: ADDRS.USDC },
    { name: "WETH", addr: ADDRS.WETH },
    { name: "WBTC", addr: ADDRS.WBTC },
  ];

  // ──────────────────────────────────────────────
  // Step 1: Show current balances for target + deployer
  // ──────────────────────────────────────────────
  console.log("\n=== Current Balances ===");
  for (const who of [{ name: "Target", addr: TARGET }, { name: "Deployer", addr: DEPLOYER_ADDR }]) {
    console.log(`\n${who.name} (${who.addr.slice(0, 10)}):`);
    for (const t of tokens) {
      const c = new ethers.Contract(t.addr, ERC20_ABI, deployer);
      const bal = await c.balanceOf(who.addr);
      if (bal > 0n) {
        const dec = await c.decimals();
        console.log(`  ${t.name}: ${ethers.formatUnits(bal, dec)}`);
      }
    }
    // Vault deposits
    const wethDep = await vault.deposits(who.addr, ADDRS.WETH);
    const wbtcDep = await vault.deposits(who.addr, ADDRS.WBTC);
    if (wethDep > 0n) console.log(`  WETH vault deposit: ${ethers.formatEther(wethDep)}`);
    if (wbtcDep > 0n) console.log(`  WBTC vault deposit: ${ethers.formatEther(wbtcDep)}`);
    // Debt
    const debt = await borrow.totalDebt(who.addr);
    if (debt > 0n) console.log(`  Debt: ${ethers.formatEther(debt)} mUSD`);
  }

  // ──────────────────────────────────────────────
  // Step 2: Setup roles
  // ──────────────────────────────────────────────
  console.log("\n=== Granting Temp Roles ===");
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));
  const LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"));

  // Grant BRIDGE_ROLE on MUSD (for mint/burn)
  const hadBridge = await musd.hasRole(BRIDGE_ROLE, deployer.address);
  if (!hadBridge) {
    await (await musd.grantRole(BRIDGE_ROLE, deployer.address)).wait();
    console.log("  ✅ BRIDGE_ROLE on MUSD");
  }

  // Grant LIQUIDATION_ROLE on BorrowModule (for reduceDebt)
  const hadLiqBorrow = await borrow.hasRole(LIQUIDATION_ROLE, deployer.address);
  if (!hadLiqBorrow) {
    await (await borrow.grantRole(LIQUIDATION_ROLE, deployer.address)).wait();
    console.log("  ✅ LIQUIDATION_ROLE on BorrowModule");
  }

  // Grant LIQUIDATION_ROLE on CollateralVault (for seize)
  const hadLiqVault = await vault.hasRole(LIQUIDATION_ROLE, deployer.address);
  if (!hadLiqVault) {
    await (await vault.grantRole(LIQUIDATION_ROLE, deployer.address)).wait();
    console.log("  ✅ LIQUIDATION_ROLE on CollateralVault");
  }

  // ──────────────────────────────────────────────
  // Step 3: Clear both wallets
  // ──────────────────────────────────────────────
  for (const who of [TARGET, DEPLOYER_ADDR]) {
    const label = who === TARGET ? "Target" : "Deployer";
    console.log(`\n=== Clearing ${label} (${who.slice(0, 10)}) ===`);

    // 3a: Reduce debt
    const debt = await borrow.totalDebt(who);
    if (debt > 0n) {
      await (await borrow.reduceDebt(who, debt + ethers.parseEther("10"))).wait();
      console.log(`  ✅ Debt cleared: ${ethers.formatEther(debt)} mUSD`);
    }

    // 3b: Seize vault collateral
    for (const t of [ADDRS.WETH, ADDRS.WBTC]) {
      const dep = await vault.deposits(who, t);
      if (dep > 0n) {
        await (await vault.seize(who, t, dep, deployer.address)).wait();
        console.log(`  ✅ Seized ${ethers.formatEther(dep)} ${t === ADDRS.WETH ? "WETH" : "WBTC"}`);
      }
    }

    // 3c: Burn mUSD (only works if deployer is msg.sender and target is deployer, or via allowance)
    // For the deployer's own mUSD, we can burn directly
    if (who === deployer.address) {
      const musdBal = await musd.balanceOf(who);
      if (musdBal > 0n) {
        await (await musd.burn(who, musdBal)).wait();
        console.log(`  ✅ Burned ${ethers.formatEther(musdBal)} mUSD`);
      }
    }

    // 3d: sMUSD — check balance
    const smusdBal = await smusd.balanceOf(who);
    if (smusdBal > 0n) {
      console.log(`  ⚠️  ${ethers.formatUnits(smusdBal, 18)} sMUSD (requires wallet signature to unstake)`);
    }
  }

  // ──────────────────────────────────────────────
  // Step 4: Also clear TreasuryV2 / DirectMint balances
  // ──────────────────────────────────────────────
  console.log("\n=== Checking Treasury/DirectMint ===");
  const treasury = await ethers.getContractAt("TreasuryV2", ADDRS.TreasuryV2);
  try {
    const tvTotal = await treasury.totalValue();
    console.log(`  TreasuryV2 totalValue: ${ethers.formatUnits(tvTotal, 6)} USDC`);
  } catch (e: any) {
    console.log(`  TreasuryV2 totalValue: error (${e.message?.slice(0, 80)})`);
  }

  // ──────────────────────────────────────────────
  // Step 5: Revoke temp roles
  // ──────────────────────────────────────────────
  console.log("\n=== Revoking Temp Roles ===");
  if (!hadBridge) {
    await (await musd.revokeRole(BRIDGE_ROLE, deployer.address)).wait();
    console.log("  ✅ Revoked BRIDGE_ROLE on MUSD");
  }
  if (!hadLiqBorrow) {
    await (await borrow.revokeRole(LIQUIDATION_ROLE, deployer.address)).wait();
    console.log("  ✅ Revoked LIQUIDATION_ROLE on BorrowModule");
  }
  if (!hadLiqVault) {
    await (await vault.revokeRole(LIQUIDATION_ROLE, deployer.address)).wait();
    console.log("  ✅ Revoked LIQUIDATION_ROLE on CollateralVault");
  }

  // ──────────────────────────────────────────────
  // Final report
  // ──────────────────────────────────────────────
  console.log("\n=== Final State ===");
  for (const who of [{ name: "Target", addr: TARGET }, { name: "Deployer", addr: DEPLOYER_ADDR }]) {
    console.log(`\n${who.name} (${who.addr.slice(0, 10)}):`);
    for (const t of tokens) {
      const c = new ethers.Contract(t.addr, ERC20_ABI, deployer);
      const bal = await c.balanceOf(who.addr);
      const dec = await c.decimals();
      console.log(`  ${t.name}: ${ethers.formatUnits(bal, dec)}`);
    }
    const wethDep = await vault.deposits(who.addr, ADDRS.WETH);
    const wbtcDep = await vault.deposits(who.addr, ADDRS.WBTC);
    console.log(`  WETH vault: ${ethers.formatEther(wethDep)}`);
    console.log(`  WBTC vault: ${ethers.formatEther(wbtcDep)}`);
    const debt = await borrow.totalDebt(who.addr);
    console.log(`  Debt: ${ethers.formatEther(debt)} mUSD`);
  }

  console.log("\n🧹 All balances cleared!");
}

main().catch(console.error);
