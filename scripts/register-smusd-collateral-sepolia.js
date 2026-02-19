/**
 * Register smUSD as collateral in the Minted lending system on Sepolia.
 * 
 * Steps:
 * 1. Deploy SMUSDPriceAdapter (Chainlink-compatible feed for smUSD)
 * 2. Grant TIMELOCK_ROLE on PriceOracle to deployer (if needed)
 * 3. Set SMUSDPriceAdapter as the price feed for smUSD in PriceOracle
 * 4. Call addCollateral on CollateralVault for smUSD (90% LTV, 93% liq threshold, 4% penalty)
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Load artifacts
function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function main() {
  // Config
  const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  if (!PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

  const SMUSD_ADDRESS = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";
  const PRICE_ORACLE_ADDRESS = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const COLLATERAL_VAULT_ADDRESS = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH\n");

  // ──────────────────────────────────────────────────────────
  // Step 1: Deploy SMUSDPriceAdapter
  // ──────────────────────────────────────────────────────────
  console.log("=== Step 1: Deploy SMUSDPriceAdapter ===");
  const adapterArtifact = loadArtifact("SMUSDPriceAdapter");
  const AdapterFactory = new ethers.ContractFactory(adapterArtifact.abi, adapterArtifact.bytecode, wallet);
  
  // Constructor: (address _smusd, address _admin, address _timelockController)
  // Use deployer as both admin and timelock for testnet
  const adapter = await AdapterFactory.deploy(SMUSD_ADDRESS, wallet.address, wallet.address);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log("SMUSDPriceAdapter deployed at:", adapterAddress);

  // Initialize the cached price
  const tx0 = await adapter.updateCachedPrice();
  await tx0.wait();
  console.log("Cached price initialized");

  // Read the price to verify
  const roundData = await adapter.latestRoundData();
  console.log("smUSD price (8 decimals):", roundData[1].toString(), "=", Number(roundData[1]) / 1e8, "USD\n");

  // ──────────────────────────────────────────────────────────
  // Step 2: Grant TIMELOCK_ROLE on PriceOracle (if needed)
  // ──────────────────────────────────────────────────────────
  console.log("=== Step 2: Configure PriceOracle ===");
  const oracleArtifact = loadArtifact("PriceOracle");
  const oracle = new ethers.Contract(PRICE_ORACLE_ADDRESS, oracleArtifact.abi, wallet);
  
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const hasTimelockRole = await oracle.hasRole(TIMELOCK_ROLE, wallet.address);
  console.log("Deployer has TIMELOCK_ROLE on PriceOracle:", hasTimelockRole);

  if (!hasTimelockRole) {
    // PriceOracle constructor doesn't lock TIMELOCK_ROLE admin, so DEFAULT_ADMIN can grant it
    console.log("Granting TIMELOCK_ROLE to deployer...");
    const tx1 = await oracle.grantRole(TIMELOCK_ROLE, wallet.address);
    await tx1.wait();
    console.log("TIMELOCK_ROLE granted on PriceOracle");
  }

  // ──────────────────────────────────────────────────────────
  // Step 3: Set price feed for smUSD in PriceOracle
  // ──────────────────────────────────────────────────────────
  console.log("\n=== Step 3: Register smUSD price feed ===");
  // setFeed(token, feed, stalePeriod, tokenDecimals, assetMaxDeviationBps)
  // smUSD has 18 decimals, stalePeriod 1 hour, 0 = use global deviation
  const tx2 = await oracle.setFeed(
    SMUSD_ADDRESS,        // token
    adapterAddress,       // feed (SMUSDPriceAdapter)
    3600,                 // stalePeriod = 1 hour
    18,                   // tokenDecimals = 18 (smUSD is 18 decimals)
    0                     // assetMaxDeviationBps = 0 (use global)
  );
  await tx2.wait();
  console.log("Price feed set for smUSD in PriceOracle");

  // Verify price reads correctly
  const smusdPrice = await oracle.getPrice(SMUSD_ADDRESS);
  console.log("PriceOracle.getPrice(smUSD):", smusdPrice.toString(), "=", ethers.formatUnits(smusdPrice, 18), "USD\n");

  // ──────────────────────────────────────────────────────────
  // Step 4: Register smUSD as collateral in CollateralVault
  // ──────────────────────────────────────────────────────────
  console.log("=== Step 4: Register smUSD as collateral ===");
  const vaultArtifact = loadArtifact("CollateralVault");
  const vault = new ethers.Contract(COLLATERAL_VAULT_ADDRESS, vaultArtifact.abi, wallet);

  // Check if deployer has TIMELOCK_ROLE
  const hasVaultTimelockRole = await vault.hasRole(TIMELOCK_ROLE, wallet.address);
  console.log("Deployer has TIMELOCK_ROLE on CollateralVault:", hasVaultTimelockRole);

  if (!hasVaultTimelockRole) {
    console.error("ERROR: Deployer does not have TIMELOCK_ROLE on CollateralVault. Cannot add collateral.");
    console.error("The Timelock contract needs to execute addCollateral, or grant TIMELOCK_ROLE to deployer.");
    process.exit(1);
  }

  // Check if already added
  const config = await vault.collateralConfigs(SMUSD_ADDRESS);
  if (config[1] > 0n) { // collateralFactorBps > 0 means already added
    console.log("smUSD is already registered as collateral:");
    console.log("  Enabled:", config[0]);
    console.log("  LTV:", Number(config[1]) / 100, "%");
    console.log("  Liq Threshold:", Number(config[2]) / 100, "%");
    console.log("  Liq Penalty:", Number(config[3]) / 100, "%");
  } else {
    // addCollateral(token, collateralFactorBps, liquidationThresholdBps, liquidationPenaltyBps)
    const tx3 = await vault.addCollateral(
      SMUSD_ADDRESS,
      9000,   // 90% LTV — yield-bearing mUSD stable
      9300,   // 93% liquidation threshold
      400     // 4% liquidation penalty
    );
    await tx3.wait();
    console.log("✅ smUSD registered as collateral!");
    console.log("  LTV: 90%");
    console.log("  Liq Threshold: 93%");
    console.log("  Liq Penalty: 4%");
  }

  // Verify supported tokens
  const tokens = await vault.getSupportedTokens();
  console.log("\nAll supported collateral tokens:", tokens);

  console.log("\n✅ All done! smUSD is now accepted as collateral in the lending system.");
  console.log("SMUSDPriceAdapter:", adapterAddress);
}

main().catch((error) => {
  console.error("Failed:", error.message || error);
  process.exit(1);
});
