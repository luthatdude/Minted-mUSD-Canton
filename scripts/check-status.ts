import { ethers } from "hardhat";
async function main() {
  const tl = await ethers.getContractAt("MintedTimelockController", "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410");
  const opId = "0xb2693f1d561b08b889b568927f2930793111ee06eafe82142d40fed18b11afe4";
  console.log("Op pending:", await tl.isOperationPending(opId));
  console.log("Op ready:", await tl.isOperationReady(opId));
  const ts = await tl.getTimestamp(opId);
  console.log("Executable at:", new Date(Number(ts)*1000).toISOString());
  console.log("Now:", new Date().toISOString());
  const now = BigInt(Math.floor(Date.now()/1000));
  if (ts > now) console.log("Remaining:", Number(ts - now), "seconds =", ((Number(ts-now))/3600).toFixed(1), "hours");
  else console.log("READY TO EXECUTE!");

  // Check oracle
  const oracle = await ethers.getContractAt("PriceOracle", "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025");
  const ORACLE_ADMIN = await oracle.ORACLE_ADMIN_ROLE();
  const [signer] = await ethers.getSigners();
  console.log("\nOracle admin role:", ORACLE_ADMIN);
  console.log("Deployer has ORACLE_ADMIN:", await oracle.hasRole(ORACLE_ADMIN, signer.address));
  console.log("Timelock has ORACLE_ADMIN:", await oracle.hasRole(ORACLE_ADMIN, "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410"));

  // Check if oracle has setPrice/setManualPrice
  try { const fn = oracle.interface.getFunction("setPrice"); console.log("setPrice exists:", !!fn); } catch { console.log("setPrice: not found"); }
  try { const fn = oracle.interface.getFunction("setManualPrice"); console.log("setManualPrice exists:", !!fn); } catch { console.log("setManualPrice: not found"); }
  try { const fn = oracle.interface.getFunction("setFeed"); console.log("setFeed exists:", !!fn); } catch { console.log("setFeed: not found"); }

  // Check MUSD supply cap
  const musd = await ethers.getContractAt("MUSD", "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B");
  try { const cap = await musd.supplyCap(); console.log("\nMUSD supplyCap:", ethers.formatUnits(cap, 18)); } catch { console.log("supplyCap: N/A"); }

  // Check BLE bridge
  const bridge = await ethers.getContractAt("BLEBridgeV9", "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125");
  try { const min = await bridge.bridgeOutMinAmount(); console.log("bridgeOutMinAmount:", ethers.formatUnits(min, 18)); } catch { console.log("bridgeOutMinAmount: N/A"); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
