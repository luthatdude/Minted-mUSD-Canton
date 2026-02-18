import { ethers } from "hardhat";

const ADDRS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  BorrowModule: "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  CollateralVault: "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  PriceOracle: "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  WETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  WBTC: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  WETHFeed: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const musd = await ethers.getContractAt("MUSD", ADDRS.MUSD);
  const borrow = await ethers.getContractAt("BorrowModule", ADDRS.BorrowModule);
  const vault = await ethers.getContractAt("CollateralVault", ADDRS.CollateralVault);

  // Check roles
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const LIQUIDATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATOR_ROLE"));
  const DEFAULT_ADMIN = ethers.ZeroHash;

  console.log("\n=== MUSD Roles ===");
  console.log("BorrowModule has BRIDGE_ROLE:", await musd.hasRole(BRIDGE_ROLE, ADDRS.BorrowModule));
  console.log("BorrowModule has LIQUIDATOR_ROLE:", await musd.hasRole(LIQUIDATOR_ROLE, ADDRS.BorrowModule));
  console.log("Deployer has BRIDGE_ROLE:", await musd.hasRole(BRIDGE_ROLE, deployer.address));
  console.log("Deployer has DEFAULT_ADMIN:", await musd.hasRole(DEFAULT_ADMIN, deployer.address));
  
  // Check supply cap
  const supplyCap = await musd.supplyCap();
  const totalSupply = await musd.totalSupply();
  const localCapBps = await musd.localCapBps();
  console.log("\nSupply cap:", ethers.formatEther(supplyCap));
  console.log("Total supply:", ethers.formatEther(totalSupply));
  console.log("Local cap bps:", localCapBps.toString());
  const effectiveCap = (supplyCap * localCapBps) / 10000n;
  console.log("Effective cap:", ethers.formatEther(effectiveCap));
  console.log("Room to mint:", ethers.formatEther(effectiveCap - totalSupply));

  // Check allowances
  const allowance = await musd.allowance(deployer.address, ADDRS.BorrowModule);
  console.log("\nDeployer->BorrowModule allowance:", ethers.formatEther(allowance));
  
  // Check BorrowModule.musd reference
  const borrowMusd = await borrow.musd();
  console.log("BorrowModule.musd:", borrowMusd);
  console.log("Matches MUSD?:", borrowMusd.toLowerCase() === ADDRS.MUSD.toLowerCase());
}

main().catch(console.error);
