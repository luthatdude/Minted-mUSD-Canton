/**
 * Check TIMELOCK_ROLE status on CollateralVault and try to grant it via Timelock
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function main() {
  const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const COLLATERAL_VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";

  const vaultArtifact = loadArtifact("CollateralVault");
  const vault = new ethers.Contract(COLLATERAL_VAULT, vaultArtifact.abi, wallet);

  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

  console.log("Checking CollateralVault roles...");
  console.log("Deployer has TIMELOCK_ROLE:", await vault.hasRole(TIMELOCK_ROLE, wallet.address));
  console.log("Timelock has TIMELOCK_ROLE:", await vault.hasRole(TIMELOCK_ROLE, TIMELOCK));
  console.log("Deployer has DEFAULT_ADMIN:", await vault.hasRole(DEFAULT_ADMIN_ROLE, wallet.address));
  
  // Check role admin for TIMELOCK_ROLE
  const roleAdmin = await vault.getRoleAdmin(TIMELOCK_ROLE);
  console.log("TIMELOCK_ROLE admin:", roleAdmin);
  console.log("TIMELOCK_ROLE admin is itself:", roleAdmin === TIMELOCK_ROLE);

  // Check supported tokens already
  const tokens = await vault.getSupportedTokens();
  console.log("\nCurrent supported tokens:", tokens);

  // Check if smUSD already registered
  const config = await vault.collateralConfigs(SMUSD);
  console.log("smUSD config - factor:", config[1].toString(), "threshold:", config[2].toString());
}

main().catch(console.error);
