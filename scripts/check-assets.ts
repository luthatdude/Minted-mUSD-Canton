import { ethers } from "hardhat";

async function main() {
  const vault = await ethers.getContractAt("CollateralVault", "0x155d6618dcdeb2F4145395CA57C80e6931D7941e");
  const tokens: string[] = await vault.getSupportedTokens();
  console.log(`Supported collateral tokens: ${tokens.length}`);
  for (const addr of tokens) {
    try {
      const erc20 = new ethers.Contract(addr, [
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
      ], ethers.provider);
      const sym = await erc20.symbol();
      const dec = await erc20.decimals();
      console.log(`  ${addr} = ${sym} (${dec} decimals)`);

      // Check config
      const config = await vault.getConfig(addr);
      console.log(`    enabled=${config[0]} factorBps=${config[1]} liqThreshold=${config[2]} liqPenalty=${config[3]}`);
    } catch (e: any) {
      console.log(`  ${addr} = error: ${e.message?.slice(0, 80)}`);
    }
  }

  // Check oracle prices
  const oracle = await ethers.getContractAt("PriceOracle", "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025");
  for (const addr of tokens) {
    try {
      const price = await oracle.getPrice(addr);
      console.log(`  Oracle price for ${addr}: $${ethers.formatUnits(price, 18)}`);
    } catch (e: any) {
      console.log(`  Oracle price for ${addr}: ERROR - ${e.message?.slice(0, 80)}`);
    }
  }

  // Check DirectMintV2 - what asset does it accept?
  const dm = await ethers.getContractAt("DirectMintV2", "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7");
  const mintAsset = await dm.paymentToken();
  console.log(`\nDirectMintV2 payment token: ${mintAsset}`);
  const erc20 = new ethers.Contract(mintAsset, ["function symbol() view returns (string)"], ethers.provider);
  console.log(`  = ${await erc20.symbol()}`);
}

main();
