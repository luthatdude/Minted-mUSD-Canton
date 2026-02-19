const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf-8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const VAULT = "0x155d6618dcdeb2F4145395CA57C80e6931D7941e";
  const WETH = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  const artifact = loadArtifact("CollateralVault");
  const vault = new ethers.Contract(VAULT, artifact.abi, wallet);
  const config = await vault.collateralConfigs(WETH);
  console.log("WETH: enabled=" + config[0] + " factor=" + config[1] + " threshold=" + config[2] + " penalty=" + config[3]);
  console.log("BorrowModule:", await vault.borrowModule());
}

main().catch(console.error);
