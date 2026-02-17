import { ethers, upgrades } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying PendleStrategyV2...");
  console.log("Deployer:", deployer.address);

  const Factory = await ethers.getContractFactory("PendleStrategyV2");
  const proxy = await upgrades.deployProxy(
    Factory,
    [
      "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474", // USDC
      "0x17Fb251e4580891590633848f3ea9d8d99DA77F6", // PendleMarketSelector
      "0xf2051bDfc738f638668DF2f8c00d01ba6338C513", // TreasuryV2
      deployer.address,                              // admin
      "USDC-YIELD",                                  // category
      "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410", // timelock
    ],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await proxy.waitForDeployment();
  const addr = await proxy.getAddress();
  console.log("✅ PendleStrategyV2:", addr);

  // Grant TREASURY_ROLE
  const TREASURY_ROLE = await proxy.TREASURY_ROLE();
  const hasTR = await proxy.hasRole(TREASURY_ROLE, "0xf2051bDfc738f638668DF2f8c00d01ba6338C513");
  if (!hasTR) {
    await (await proxy.grantRole(TREASURY_ROLE, "0xf2051bDfc738f638668DF2f8c00d01ba6338C513")).wait();
    console.log("✅ TREASURY_ROLE granted");
  } else {
    console.log("✅ TREASURY_ROLE already set");
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
