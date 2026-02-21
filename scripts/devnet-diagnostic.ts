/**
 * Devnet Diagnostic — Check the state of all deployed contracts on Sepolia
 * Usage: npx hardhat run scripts/devnet-diagnostic.ts --network sepolia
 */
import { ethers } from "hardhat";

const ADDR = {
  deployer: "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0",
  bridge: "0x708957bFfA312D1730BdF87467E695D3a9F26b0f",
  musd: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  usdc: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  weth: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  wbtc: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  vault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  borrow: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  oracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  liquidation: "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
  directMint: "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
  treasury: "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  timelock: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  smusd: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  leverageVault: "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
  depositRouter: "0x531e95585bcDfcB2303511483F232EEF4a0Cd2de",
  pause: "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F",
};

async function main() {
  const [signer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(signer.address);

  console.log("═".repeat(70));
  console.log("  DEVNET DIAGNOSTIC — Sepolia");
  console.log("═".repeat(70));
  console.log(`  Deployer:  ${signer.address}`);
  console.log(`  Balance:   ${ethers.formatEther(bal)} ETH`);
  console.log();

  // ── MUSD ──
  console.log("── MUSD ──");
  const musd = await ethers.getContractAt("MUSD", ADDR.musd);
  console.log(`  totalSupply: ${ethers.formatUnits(await musd.totalSupply(), 18)} mUSD`);
  console.log(`  deployer bal: ${ethers.formatUnits(await musd.balanceOf(signer.address), 18)} mUSD`);
  const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
  const LIQUIDATOR_ROLE = await musd.LIQUIDATOR_ROLE();
  console.log(`  bridge has BRIDGE_ROLE: ${await musd.hasRole(BRIDGE_ROLE, ADDR.bridge)}`);
  console.log(`  borrow has BRIDGE_ROLE: ${await musd.hasRole(BRIDGE_ROLE, ADDR.borrow)}`);
  console.log(`  directMint has BRIDGE_ROLE: ${await musd.hasRole(BRIDGE_ROLE, ADDR.directMint)}`);
  console.log(`  liquidation has LIQUIDATOR_ROLE: ${await musd.hasRole(LIQUIDATOR_ROLE, ADDR.liquidation)}`);
  console.log(`  deployer has BRIDGE_ROLE: ${await musd.hasRole(BRIDGE_ROLE, signer.address)}`);
  console.log();

  // ── MockUSDC ──
  console.log("── MockUSDC ──");
  const usdc = await ethers.getContractAt("MockERC20", ADDR.usdc);
  console.log(`  deployer bal: ${ethers.formatUnits(await usdc.balanceOf(signer.address), 6)} USDC`);
  console.log();

  // ── MockWETH / MockWBTC ──
  console.log("── Mock Collateral ──");
  const weth = await ethers.getContractAt("MockERC20", ADDR.weth);
  const wbtc = await ethers.getContractAt("MockERC20", ADDR.wbtc);
  console.log(`  deployer WETH: ${ethers.formatUnits(await weth.balanceOf(signer.address), 18)}`);
  console.log(`  deployer WBTC: ${ethers.formatUnits(await wbtc.balanceOf(signer.address), 18)}`);
  console.log();

  // ── BLEBridgeV9 ──
  console.log("── BLEBridgeV9 ──");
  const bridge = await ethers.getContractAt("BLEBridgeV9", ADDR.bridge);
  const ADMIN_ROLE = await bridge.DEFAULT_ADMIN_ROLE();
  const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
  console.log(`  deployer is ADMIN: ${await bridge.hasRole(ADMIN_ROLE, signer.address)}`);
  console.log(`  deployer is VALIDATOR: ${await bridge.hasRole(VALIDATOR_ROLE, signer.address)}`);
  try {
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();
    console.log(`  RELAYER_ROLE hash: ${RELAYER_ROLE}`);
    console.log(`  deployer is RELAYER: ${await bridge.hasRole(RELAYER_ROLE, signer.address)}`);
  } catch {
    console.log(`  RELAYER_ROLE: NOT DEFINED in on-chain version (upgrade pending)`);
  }
  try {
    const nonce = await bridge.currentNonce();
    console.log(`  currentNonce: ${nonce}`);
  } catch { console.log(`  currentNonce: N/A`); }
  try {
    const paused = await bridge.paused();
    console.log(`  paused: ${paused}`);
  } catch { console.log(`  paused: N/A`); }
  console.log();

  // ── PriceOracle ──
  console.log("── PriceOracle ──");
  const oracle = await ethers.getContractAt("PriceOracle", ADDR.oracle);
  for (const [name, addr] of [["WETH", ADDR.weth], ["WBTC", ADDR.wbtc], ["USDC", ADDR.usdc]]) {
    try {
      const p = await oracle.getPrice(addr);
      console.log(`  ${name}: $${ethers.formatUnits(p, 18)}`);
    } catch {
      console.log(`  ${name}: price NOT SET`);
    }
  }
  // Check who can set prices
  try {
    const ORACLE_ROLE = await oracle.ORACLE_ROLE();
    console.log(`  deployer has ORACLE_ROLE: ${await oracle.hasRole(ORACLE_ROLE, signer.address)}`);
  } catch {
    try {
      const UPDATER_ROLE = await oracle.UPDATER_ROLE();
      console.log(`  deployer has UPDATER_ROLE: ${await oracle.hasRole(UPDATER_ROLE, signer.address)}`);
    } catch {
      console.log(`  Could not determine oracle role`);
    }
  }
  console.log();

  // ── CollateralVault ──
  console.log("── CollateralVault ──");
  const vault = await ethers.getContractAt("CollateralVault", ADDR.vault);
  console.log(`  deployer WETH deposit: ${ethers.formatUnits(await vault.getDeposit(signer.address, ADDR.weth), 18)}`);
  console.log(`  deployer WBTC deposit: ${ethers.formatUnits(await vault.getDeposit(signer.address, ADDR.wbtc), 18)}`);
  try {
    const tokens = await vault.getSupportedTokens();
    console.log(`  supported tokens: ${tokens.length} — ${tokens.join(", ")}`);
  } catch { console.log(`  supported tokens: unable to read`); }
  try {
    const cfg = await vault.getConfig(ADDR.weth);
    console.log(`  WETH config — active:${cfg.active}, ltv:${cfg.collateralFactorBps}bps, liqThreshold:${cfg.liquidationThresholdBps}bps, penalty:${cfg.liquidationPenaltyBps}bps`);
  } catch (e: any) { console.log(`  WETH config: ${e.message?.slice(0,60)}`); }
  console.log();

  // ── BorrowModule ──
  console.log("── BorrowModule ──");
  const borrow = await ethers.getContractAt("BorrowModule", ADDR.borrow);
  console.log(`  deployer debt: ${ethers.formatUnits(await borrow.totalDebt(signer.address), 18)} mUSD`);
  try {
    const cap = await borrow.globalDebtCeiling();
    console.log(`  globalDebtCeiling: ${ethers.formatUnits(cap, 18)} mUSD`);
  } catch { console.log(`  globalDebtCeiling: N/A`); }
  console.log();

  // ── LiquidationEngine ──
  console.log("── LiquidationEngine ──");
  const liq = await ethers.getContractAt("LiquidationEngine", ADDR.liquidation);
  try {
    const cf = await liq.closeFactorBps();
    console.log(`  closeFactorBps: ${cf}`);
  } catch { console.log(`  closeFactorBps: N/A`); }
  console.log();

  // ── TreasuryV2 ──
  console.log("── TreasuryV2 ──");
  const treasury = await ethers.getContractAt("TreasuryV2", ADDR.treasury);
  const stratCount = await treasury.strategyCount();
  console.log(`  active strategies: ${stratCount}`);
  const STRATEGIST_ROLE = await treasury.STRATEGIST_ROLE();
  console.log(`  deployer has STRATEGIST: ${await treasury.hasRole(STRATEGIST_ROLE, signer.address)}`);
  const usdcBal = await usdc.balanceOf(ADDR.treasury);
  console.log(`  treasury USDC bal: ${ethers.formatUnits(usdcBal, 6)}`);
  console.log();

  // ── DirectMintV2 ──
  console.log("── DirectMintV2 ──");
  const dm = await ethers.getContractAt("DirectMintV2", ADDR.directMint);
  try {
    const dCap = await dm.dailyCap();
    console.log(`  dailyCap: ${ethers.formatUnits(dCap, 18)} mUSD`);
  } catch { console.log(`  dailyCap: N/A`); }
  console.log();

  // ── GlobalPauseRegistry ──
  console.log("── GlobalPauseRegistry ──");
  const pause = await ethers.getContractAt("GlobalPauseRegistry", ADDR.pause);
  try { console.log(`  paused: ${await pause.paused()}`); } catch { console.log("  paused: unable to query"); }
  console.log();

  console.log("═".repeat(70));
  console.log("  DIAGNOSTIC COMPLETE");
  console.log("═".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
