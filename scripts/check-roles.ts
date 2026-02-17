import { ethers } from "hardhat";
async function main() {
  const [signer] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("PriceOracle", "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025");
  const TIMELOCK_ROLE = await oracle.TIMELOCK_ROLE();
  const ORACLE_ADMIN = await oracle.ORACLE_ADMIN_ROLE();
  const ADMIN = await oracle.DEFAULT_ADMIN_ROLE();
  console.log("Deployer has TIMELOCK_ROLE:", await oracle.hasRole(TIMELOCK_ROLE, signer.address));
  console.log("Deployer has ORACLE_ADMIN:", await oracle.hasRole(ORACLE_ADMIN, signer.address));
  console.log("Deployer has DEFAULT_ADMIN:", await oracle.hasRole(ADMIN, signer.address));
  console.log("Timelock has TIMELOCK_ROLE:", await oracle.hasRole(TIMELOCK_ROLE, "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410"));

  // BorrowModule roles
  const bm = await ethers.getContractAt("BorrowModule", "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8");
  const TL_ROLE = await bm.TIMELOCK_ROLE();
  console.log("\nBorrowModule — deployer TIMELOCK:", await bm.hasRole(TL_ROLE, signer.address));

  // CollateralVault roles
  const cv = await ethers.getContractAt("CollateralVault", "0x155d6618dcdeb2F4145395CA57C80e6931D7941e");
  const TL2 = await cv.TIMELOCK_ROLE();
  console.log("CollateralVault — deployer TIMELOCK:", await cv.hasRole(TL2, signer.address));

  // Check current WETH feed
  const weth = "0x7999F2894290F2Ce34a508eeff776126D9a7D46e";
  try {
    const cfg = await oracle.feeds(weth);
    console.log("\nWETH feed config:", {
      feed: cfg.feed,
      stalePeriod: Number(cfg.stalePeriod),
      enabled: cfg.enabled,
      feedDecimals: cfg.feedDecimals,
      tokenDecimals: cfg.tokenDecimals,
    });
  } catch(e: any) { console.log("WETH feed config error:", e.message?.slice(0,80)); }

  // Check DirectMintV2 limits
  const dm = await ethers.getContractAt("DirectMintV2", "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7");
  console.log("\nDirectMintV2:");
  console.log("  mintFeeBps:", (await dm.mintFeeBps()).toString());
  console.log("  minMintAmount:", ethers.formatUnits(await dm.minMintAmount(), 6), "USDC");
  console.log("  maxMintAmount:", ethers.formatUnits(await dm.maxMintAmount(), 6), "USDC");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
