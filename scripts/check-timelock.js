/**
 * Check Timelock contract configuration and schedule addCollateral for smUSD
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
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const TIMELOCK = "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410";
  const COLLATERAL_VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const SMUSD = "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540";

  const timelockArtifact = loadArtifact("MintedTimelockController");
  const timelock = new ethers.Contract(TIMELOCK, timelockArtifact.abi, wallet);

  // Check basic config
  const minDelay = await timelock.getMinDelay();
  console.log("Timelock minDelay:", minDelay.toString(), "seconds =", Number(minDelay) / 3600, "hours");

  // Check roles
  const PROPOSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));
  const EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("EXECUTOR_ROLE"));
  const CANCELLER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CANCELLER_ROLE"));
  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";

  console.log("\nDeployer roles on Timelock:");
  console.log("  PROPOSER_ROLE:", await timelock.hasRole(PROPOSER_ROLE, wallet.address));
  console.log("  EXECUTOR_ROLE:", await timelock.hasRole(EXECUTOR_ROLE, wallet.address));
  console.log("  CANCELLER_ROLE:", await timelock.hasRole(CANCELLER_ROLE, wallet.address));
  console.log("  DEFAULT_ADMIN:", await timelock.hasRole(DEFAULT_ADMIN, wallet.address));

  // Check if anyone can execute (address(0) has EXECUTOR_ROLE)
  console.log("  EXECUTOR_ROLE for address(0):", await timelock.hasRole(EXECUTOR_ROLE, ethers.ZeroAddress));

  // Try to schedule the addCollateral call
  // Encode the call: vault.addCollateral(SMUSD, 9000, 9300, 400)
  const vaultArtifact = loadArtifact("CollateralVault");
  const vaultIface = new ethers.Interface(vaultArtifact.abi);
  const callData = vaultIface.encodeFunctionData("addCollateral", [SMUSD, 9000, 9300, 400]);
  console.log("\nEncoded addCollateral call:", callData);

  // If deployer is proposer, schedule it
  const isProposer = await timelock.hasRole(PROPOSER_ROLE, wallet.address);
  if (isProposer) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("register-smusd-collateral-" + Date.now()));
    const predecessor = ethers.ZeroHash;
    
    console.log("\nScheduling addCollateral via Timelock...");
    const tx = await timelock.schedule(
      COLLATERAL_VAULT,  // target
      0,                 // value
      callData,         // data
      predecessor,      // predecessor
      salt,             // salt
      minDelay          // delay
    );
    await tx.wait();
    console.log("Scheduled! Execute after", Number(minDelay) / 3600, "hours");
    console.log("Salt:", salt);
    
    // Compute operation ID for later execution
    const opId = await timelock.hashOperation(COLLATERAL_VAULT, 0, callData, predecessor, salt);
    console.log("Operation ID:", opId);
  } else {
    console.log("\n⚠ Deployer is NOT a proposer. Cannot schedule directly.");
    console.log("Checking if deployer has DEFAULT_ADMIN to grant PROPOSER_ROLE...");
    
    const hasAdmin = await timelock.hasRole(DEFAULT_ADMIN, wallet.address);
    if (hasAdmin) {
      console.log("Deployer has DEFAULT_ADMIN! Granting PROPOSER_ROLE + EXECUTOR_ROLE...");
      
      let tx = await timelock.grantRole(PROPOSER_ROLE, wallet.address);
      await tx.wait();
      console.log("PROPOSER_ROLE granted");
      
      tx = await timelock.grantRole(EXECUTOR_ROLE, wallet.address);
      await tx.wait();
      console.log("EXECUTOR_ROLE granted");
      
      // Now schedule
      const salt = ethers.keccak256(ethers.toUtf8Bytes("register-smusd-collateral-" + Date.now()));
      const predecessor = ethers.ZeroHash;
      
      console.log("\nScheduling addCollateral via Timelock...");
      tx = await timelock.schedule(
        COLLATERAL_VAULT,
        0,
        callData,
        predecessor,
        salt,
        minDelay
      );
      await tx.wait();
      console.log("Scheduled! Execute after", Number(minDelay) / 3600, "hours");
      console.log("Salt:", salt);
      
      const opId = await timelock.hashOperation(COLLATERAL_VAULT, 0, callData, predecessor, salt);
      console.log("Operation ID:", opId);
    } else {
      console.log("Deployer doesn't have DEFAULT_ADMIN either. Need another approach.");
    }
  }
}

main().catch(console.error);
