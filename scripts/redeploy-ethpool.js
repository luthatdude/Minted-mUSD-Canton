const { ethers } = require("ethers");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH\n");

  const SMUSDE_ADDR = "0x6B8e8A0C376E592F35642418581Ec272623cF75E"; // Already deployed
  const POOL_CAP = ethers.parseEther("1000000");

  // Redeploy ETHPool with deployer as timelockController for testnet
  console.log("Deploying ETHPool (deployer=timelock for testnet)...");
  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../artifacts/contracts/ETHPool.sol/ETHPool.json"), "utf8"
  ));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const ethPool = await factory.deploy(
    "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B", // MUSD
    SMUSDE_ADDR,                                    // smUSD-E
    "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025", // PriceOracle
    "0x7999F2894290F2Ce34a508eeff776126D9a7D46e", // MockWETH
    POOL_CAP,
    wallet.address, // deployer = timelockController (testnet only!)
  );
  await ethPool.waitForDeployment();
  const addr = await ethPool.getAddress();
  console.log("ETHPool deployed to:", addr);

  // Grant POOL_ROLE on SMUSDE to new ETHPool
  console.log("Granting POOL_ROLE on SMUSDE...");
  const smusde = new ethers.Contract(SMUSDE_ADDR, [
    "function grantRole(bytes32,address)",
  ], wallet);
  const POOL_ROLE = ethers.keccak256(ethers.toUtf8Bytes("POOL_ROLE"));
  const tx0 = await smusde.grantRole(POOL_ROLE, addr);
  await tx0.wait();
  console.log("POOL_ROLE granted");

  // Grant BRIDGE_ROLE on MUSD to new ETHPool
  console.log("Granting BRIDGE_ROLE on MUSD...");
  const musd = new ethers.Contract("0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B", [
    "function grantRole(bytes32,address)",
  ], wallet);
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const tx1 = await musd.grantRole(BRIDGE_ROLE, addr);
  await tx1.wait();
  console.log("BRIDGE_ROLE granted");

  // Add stablecoins
  const pool = new ethers.Contract(addr, [
    "function addStablecoin(address,uint8)",
    "function acceptedStablecoins(address) view returns (bool)",
  ], wallet);

  console.log("Adding USDC...");
  const tx2 = await pool.addStablecoin("0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474", 6);
  await tx2.wait();
  console.log("USDC added");

  console.log("Adding USDT...");
  const tx3 = await pool.addStablecoin("0xA0a4FAE8DA7892E216dE610cb2E6e800ffeb51D2", 6);
  await tx3.wait();
  console.log("USDT added");

  console.log("USDC accepted:", await pool.acceptedStablecoins("0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474"));
  console.log("USDT accepted:", await pool.acceptedStablecoins("0xA0a4FAE8DA7892E216dE610cb2E6e800ffeb51D2"));

  console.log("\n✅ ETHPool redeployed:", addr);
  console.log("NEXT_PUBLIC_ETH_POOL_ADDRESS=" + addr);
}

main().catch(console.error);
