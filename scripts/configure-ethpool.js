const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  
  const TIMELOCK_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TIMELOCK_ROLE"));
  const DEFAULT_ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
  
  const ethPool = new ethers.Contract("0x870878BfDF8CDf424F658473d472079962D36CF5", [
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)",
    "function addStablecoin(address,uint8)",
    "function acceptedStablecoins(address) view returns (bool)",
  ], wallet);

  const hasTimelock = await ethPool.hasRole(TIMELOCK_ROLE, wallet.address);
  const hasAdmin = await ethPool.hasRole(DEFAULT_ADMIN, wallet.address);
  console.log("Deployer has TIMELOCK_ROLE:", hasTimelock);
  console.log("Deployer has DEFAULT_ADMIN:", hasAdmin);

  if (!hasTimelock && hasAdmin) {
    console.log("Granting TIMELOCK_ROLE to deployer...");
    const tx = await ethPool.grantRole(TIMELOCK_ROLE, wallet.address);
    await tx.wait();
    console.log("Granted");
  }

  console.log("Adding USDC...");
  const tx1 = await ethPool.addStablecoin("0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474", 6);
  await tx1.wait();
  console.log("USDC added");

  console.log("Adding USDT...");
  const tx2 = await ethPool.addStablecoin("0xA0a4FAE8DA7892E216dE610cb2E6e800ffeb51D2", 6);
  await tx2.wait();
  console.log("USDT added");
  
  // Verify
  console.log("USDC accepted:", await ethPool.acceptedStablecoins("0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474"));
  console.log("USDT accepted:", await ethPool.acceptedStablecoins("0xA0a4FAE8DA7892E216dE610cb2E6e800ffeb51D2"));
}

main().catch(console.error);
