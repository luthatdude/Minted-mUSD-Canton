const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf-8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const USER = "0x33f9440071a7ebc0c96d491bcc1c42de3dd5dda5"; // user wallet

  const VAULT = "0xf7746f860aB57582e77550aa5d8663FEa2c8256A";
  const BORROW = "0x58568ea61d414077eC2260448194D49E792D33Dd";
  const ORACLE = "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";

  const vaultA = loadArtifact("CollateralVault");
  const borrowA = loadArtifact("BorrowModule");
  const oracleA = loadArtifact("PriceOracle");

  const vault = new ethers.Contract(VAULT, vaultA.abi, provider);
  const borrow = new ethers.Contract(BORROW, borrowA.abi, provider);
  const oracle = new ethers.Contract(ORACLE, oracleA.abi, provider);

  console.log("=== Oracle Prices ===");
  try {
    const wethPrice = await oracle.getPrice(WETH);
    console.log("WETH price (18 dec):", wethPrice.toString(), "=", ethers.formatUnits(wethPrice, 18), "USD");
  } catch (e) { console.log("WETH price error:", e.message); }

  try {
    const smusdPrice = await oracle.getPrice(SMUSD);
    console.log("smUSD price (18 dec):", smusdPrice.toString(), "=", ethers.formatUnits(smusdPrice, 18), "USD");
  } catch (e) { console.log("smUSD price error:", e.message); }

  console.log("\n=== User Position ===");
  const debt = await borrow.totalDebt(USER);
  console.log("Total debt:", ethers.formatUnits(debt, 18), "mUSD");

  try {
    const hf = await borrow.healthFactor(USER);
    console.log("Health factor (bps):", hf.toString(), "= " + (Number(hf) / 10000).toFixed(4) + "x");
  } catch (e) { console.log("Health factor error:", e.message); }

  try {
    const mb = await borrow.maxBorrow(USER);
    console.log("Max borrowable:", ethers.formatUnits(mb, 18), "mUSD");
  } catch (e) { console.log("Max borrow error:", e.message); }

  console.log("\n=== Deposits ===");
  const wethDep = await vault.deposits(USER, WETH);
  console.log("WETH deposited:", ethers.formatUnits(wethDep, 18));
  const smusdDep = await vault.deposits(USER, SMUSD);
  console.log("smUSD deposited:", ethers.formatUnits(smusdDep, 18));

  console.log("\n=== WETH Feed Config ===");
  try {
    const feedConfig = await oracle.feeds(WETH);
    console.log("Feed:", feedConfig[0]); // feed address
    console.log("StalePeriod:", feedConfig[1].toString());
    console.log("TokenDecimals:", feedConfig[2].toString());
    console.log("FeedDecimals:", feedConfig[3].toString());
    console.log("Enabled:", feedConfig[4]);
  } catch (e) { console.log("Feed error:", e.message); }
}

main().catch(console.error);
