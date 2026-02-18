/**
 * Nuclear reset: Clear ALL token balances for target wallet + deployer.
 * Uses unrestricted MockERC20.burn() for WETH/USDC,
 * and admin role manipulation for mUSD/sMUSD.
 */
import { ethers } from "hardhat";

const TARGET = "0x33f97321214B5B8443f6212a05836C8FfE42DDa5";
const DEPLOYER_ADDR = "0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0";

const ADDRS = {
  MUSD: "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  SMUSD: "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  USDC: "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  WETH: "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  WBTC: "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const MOCK_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function burn(address,uint256)",
    "function decimals() view returns (uint8)",
  ];

  const wallets = [
    { name: "Target", addr: TARGET },
    { name: "Deployer", addr: DEPLOYER_ADDR },
  ];

  // ──────────────────────────────────────────────
  // Step 1: Burn Mock tokens (WETH, WBTC, USDC) — unrestricted burn
  // ──────────────────────────────────────────────
  console.log("=== Burning Mock Tokens (unrestricted) ===");
  const mockTokens = [
    { name: "WETH", addr: ADDRS.WETH },
    { name: "WBTC", addr: ADDRS.WBTC },
    { name: "USDC", addr: ADDRS.USDC },
  ];

  for (const wallet of wallets) {
    for (const token of mockTokens) {
      const c = new ethers.Contract(token.addr, MOCK_ABI, deployer);
      const bal = await c.balanceOf(wallet.addr);
      if (bal > 0n) {
        const dec = await c.decimals();
        console.log(`  Burning ${ethers.formatUnits(bal, dec)} ${token.name} from ${wallet.name}`);
        await (await c.burn(wallet.addr, bal)).wait();
        console.log(`  ✅ Done`);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Step 2: Burn sMUSD — redeem for deployer, burn for target
  // ──────────────────────────────────────────────
  console.log("\n=== Clearing sMUSD ===");
  const smusd = await ethers.getContractAt("SMUSD", ADDRS.SMUSD);
  const musd = await ethers.getContractAt("MUSD", ADDRS.MUSD);

  // For deployer: redeem own shares (deployer can sign)
  const deployerSmusd = await smusd.balanceOf(DEPLOYER_ADDR);
  if (deployerSmusd > 0n) {
    console.log(`  Deployer has ${ethers.formatEther(deployerSmusd)} sMUSD`);
    // Check cooldown
    const lastDep = await smusd.lastDeposit(DEPLOYER_ADDR);
    const cooldown = await smusd.WITHDRAW_COOLDOWN();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    if (BigInt(now) >= lastDep + cooldown) {
      try {
        const tx = await smusd.redeem(deployerSmusd, DEPLOYER_ADDR, DEPLOYER_ADDR);
        await tx.wait();
        console.log(`  ✅ Deployer sMUSD redeemed`);
      } catch (e: any) {
        console.log(`  ❌ Redeem failed: ${e.message?.slice(0, 150)}`);
      }
    } else {
      console.log(`  ⚠️  Cooldown active, trying direct ERC20 burn...`);
      // sMUSD is ERC20 — try burning via _burn by deploying a helper or using low-level
    }
  }

  // For target: sMUSD shares can't be redeemed without their signature
  // BUT — the underlying ERC4626 shares are just ERC20 tokens.
  // We can try to transfer them to deployer if we have a mechanism...
  // Actually, sMUSD._update is overridden but still works for admin.
  // No admin transfer function exists. But we can try another approach:
  // Deploy a tiny helper contract that the admin can use.
  const targetSmusd = await smusd.balanceOf(TARGET);
  if (targetSmusd > 0n) {
    console.log(`  Target has ${ethers.formatEther(targetSmusd)} sMUSD`);
    console.log(`  ⚠️  Cannot force-burn sMUSD without wallet signature`);
    console.log(`  The Stake page will show this balance.`);
  }

  // ──────────────────────────────────────────────
  // Step 3: Burn mUSD 
  // ──────────────────────────────────────────────
  console.log("\n=== Clearing mUSD ===");
  const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));

  // Grant BRIDGE_ROLE for burn
  const hadBridge = await musd.hasRole(BRIDGE_ROLE, deployer.address);
  if (!hadBridge) {
    await (await musd.grantRole(BRIDGE_ROLE, deployer.address)).wait();
  }

  // Deployer mUSD
  const deployerMusd = await musd.balanceOf(DEPLOYER_ADDR);
  if (deployerMusd > 0n) {
    // burn(from, amount) — when from == msg.sender, no allowance needed
    await (await musd.burn(DEPLOYER_ADDR, deployerMusd)).wait();
    console.log(`  ✅ Burned ${ethers.formatEther(deployerMusd)} mUSD from Deployer`);
  }

  // Target mUSD — burn(target, amount) requires allowance since from != msg.sender
  const targetMusd = await musd.balanceOf(TARGET);
  if (targetMusd > 0n) {
    console.log(`  Target has ${ethers.formatEther(targetMusd)} mUSD`);
    // Can't burn without allowance. But we can try — if MUSD has any admin override...
    try {
      await (await musd.burn(TARGET, targetMusd)).wait();
      console.log(`  ✅ Burned target mUSD`);
    } catch (e: any) {
      console.log(`  ⚠️  Cannot burn target mUSD without wallet allowance`);
    }
  }

  // Revoke BRIDGE_ROLE
  if (!hadBridge) {
    await (await musd.revokeRole(BRIDGE_ROLE, deployer.address)).wait();
  }

  // ──────────────────────────────────────────────
  // Final state
  // ──────────────────────────────────────────────
  console.log("\n=== Final Balances ===");
  const allTokens = [
    { name: "MUSD", addr: ADDRS.MUSD },
    { name: "sMUSD", addr: ADDRS.SMUSD },
    { name: "USDC", addr: ADDRS.USDC },
    { name: "WETH", addr: ADDRS.WETH },
    { name: "WBTC", addr: ADDRS.WBTC },
  ];
  for (const wallet of wallets) {
    console.log(`\n${wallet.name} (${wallet.addr.slice(0, 10)}):`);
    for (const token of allTokens) {
      const c = new ethers.Contract(token.addr, MOCK_ABI, deployer);
      const bal = await c.balanceOf(wallet.addr);
      const dec = await c.decimals();
      console.log(`  ${token.name}: ${ethers.formatUnits(bal, dec)}`);
    }
  }

  console.log("\n🧹 Done!");
}

main().catch(console.error);
