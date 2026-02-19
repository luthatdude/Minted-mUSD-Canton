/**
 * Redeploy the full lending stack for Sepolia testnet.
 * 
 * Deploys:
 * 1. CollateralVault (deployer keeps TIMELOCK_ROLE for testnet)
 * 2. BorrowModule (vault, oracle, musd, 5% interest, 100 mUSD min debt)
 * 3. LiquidationEngine (vault, borrow, oracle, musd, 50% close factor)
 * 
 * Configures:
 * - BORROW_MODULE_ROLE + LIQUIDATION_ROLE on vault
 * - setBorrowModule on vault
 * - WETH collateral: 75% LTV, 80% liq threshold, 5% penalty
 * - smUSD collateral: 90% LTV, 93% liq threshold, 4% penalty
 * - BRIDGE_ROLE on MUSD for new BorrowModule (mint/burn)
 * - LIQUIDATOR_ROLE on MUSD for new LiquidationEngine (burn)
 * - Price feed for smUSD already set on PriceOracle
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function main() {
  const RPC_URL = process.env.RPC_URL;
  const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PRIVATE_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH\n");

  // Existing contract addresses
  const MUSD = "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B";
  const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
  const PRICE_ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";

  // ──────────────────────────────────────────────
  // Step 1: Deploy CollateralVault
  // ──────────────────────────────────────────────
  console.log("=== Step 1: Deploy CollateralVault ===");
  const vaultArtifact = loadArtifact("CollateralVault");
  const VaultFactory = new ethers.ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, wallet);
  // Constructor: (address _globalPauseRegistry) - use address(0) to skip global pause for testnet
  const vault = await VaultFactory.deploy(ethers.ZeroAddress);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("CollateralVault:", vaultAddress);

  // ──────────────────────────────────────────────
  // Step 2: Deploy BorrowModule
  // ──────────────────────────────────────────────
  console.log("\n=== Step 2: Deploy BorrowModule ===");
  const borrowArtifact = loadArtifact("BorrowModule");
  const BorrowFactory = new ethers.ContractFactory(borrowArtifact.abi, borrowArtifact.bytecode, wallet);
  // Constructor: (vault, oracle, musd, interestRateBps, minDebt)
  const interestRateBps = 500; // 5% APR
  const minDebt = ethers.parseUnits("100", 18); // 100 mUSD minimum
  const borrowModule = await BorrowFactory.deploy(vaultAddress, PRICE_ORACLE, MUSD, interestRateBps, minDebt);
  await borrowModule.waitForDeployment();
  const borrowAddress = await borrowModule.getAddress();
  console.log("BorrowModule:", borrowAddress);

  // ──────────────────────────────────────────────
  // Step 3: Deploy LiquidationEngine
  // ──────────────────────────────────────────────
  console.log("\n=== Step 3: Deploy LiquidationEngine ===");
  const liqArtifact = loadArtifact("LiquidationEngine");
  const LiqFactory = new ethers.ContractFactory(liqArtifact.abi, liqArtifact.bytecode, wallet);
  // Constructor: (vault, borrowModule, oracle, musd, closeFactorBps, timelockController)
  const closeFactorBps = 5000; // 50% close factor
  const liq = await LiqFactory.deploy(vaultAddress, borrowAddress, PRICE_ORACLE, MUSD, closeFactorBps, wallet.address);
  await liq.waitForDeployment();
  const liqAddress = await liq.getAddress();
  console.log("LiquidationEngine:", liqAddress);

  // ──────────────────────────────────────────────
  // Step 4: Configure roles on CollateralVault
  // ──────────────────────────────────────────────
  console.log("\n=== Step 4: Configure Vault Roles ===");
  const BORROW_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BORROW_MODULE_ROLE"));
  const LIQUIDATION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATION_ROLE"));

  let tx = await vault.grantRole(BORROW_MODULE_ROLE, borrowAddress);
  await tx.wait();
  console.log("BORROW_MODULE_ROLE granted to BorrowModule");

  tx = await vault.grantRole(LIQUIDATION_ROLE, liqAddress);
  await tx.wait();
  console.log("LIQUIDATION_ROLE granted to LiquidationEngine");

  // setBorrowModule on vault (requires TIMELOCK_ROLE - deployer has it)
  tx = await vault.setBorrowModule(borrowAddress);
  await tx.wait();
  console.log("setBorrowModule set on vault");

  // ──────────────────────────────────────────────
  // Step 5: Add collateral tokens
  // ──────────────────────────────────────────────
  console.log("\n=== Step 5: Add Collateral Tokens ===");

  // WETH: 75% LTV, 80% liq threshold, 5% penalty
  tx = await vault.addCollateral(WETH, 7500, 8000, 500);
  await tx.wait();
  console.log("WETH added: 75% LTV, 80% threshold, 5% penalty");

  // smUSD: 90% LTV, 93% liq threshold, 4% penalty
  tx = await vault.addCollateral(SMUSD, 9000, 9300, 400);
  await tx.wait();
  console.log("smUSD added: 90% LTV, 93% threshold, 4% penalty");

  // Verify
  const tokens = await vault.getSupportedTokens();
  console.log("Supported tokens:", tokens);

  // ──────────────────────────────────────────────
  // Step 6: Grant MUSD roles to new contracts
  // ──────────────────────────────────────────────
  console.log("\n=== Step 6: Grant MUSD Roles ===");
  const musdArtifact = loadArtifact("MUSD");
  const musd = new ethers.Contract(MUSD, musdArtifact.abi, wallet);

  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"));

  tx = await musd.grantRole(BRIDGE_ROLE, borrowAddress);
  await tx.wait();
  console.log("BRIDGE_ROLE granted to BorrowModule on MUSD");

  tx = await musd.grantRole(LIQUIDATOR_ROLE, liqAddress);
  await tx.wait();
  console.log("LIQUIDATOR_ROLE granted to LiquidationEngine on MUSD");

  // ──────────────────────────────────────────────
  // Step 7: Configure BorrowModule (SMUSD, Treasury)
  // ──────────────────────────────────────────────
  console.log("\n=== Step 7: Configure BorrowModule ===");
  // Grant TIMELOCK_ROLE to deployer on BorrowModule (BorrowModule doesn't lock it)
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  tx = await borrowModule.grantRole(TIMELOCK_ROLE, wallet.address);
  await tx.wait();
  console.log("TIMELOCK_ROLE granted to deployer on BorrowModule");

  // Set SMUSD for interest routing
  tx = await borrowModule.setSMUSD(SMUSD);
  await tx.wait();
  console.log("SMUSD set on BorrowModule for interest routing");

  // Set Treasury (optional but prevents fallback issues)
  const TREASURY = "0xf2051bDfc738f638668DF2f8c00d01ba6338C513";
  tx = await borrowModule.setTreasury(TREASURY);
  await tx.wait();
  console.log("Treasury set on BorrowModule");

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("✅ LENDING STACK DEPLOYED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("CollateralVault:", vaultAddress);
  console.log("BorrowModule:", borrowAddress);
  console.log("LiquidationEngine:", liqAddress);
  console.log("\nCollateral:");
  console.log("  WETH:", WETH, "- 75% LTV");
  console.log("  smUSD:", SMUSD, "- 90% LTV");
  console.log("\nUpdate frontend .env.local with:");
  console.log("NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=" + vaultAddress);
  console.log("NEXT_PUBLIC_BORROW_MODULE_ADDRESS=" + borrowAddress);
  console.log("NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=" + liqAddress);
}

main().catch((err) => {
  console.error("FAILED:", err.message || err);
  process.exit(1);
});
