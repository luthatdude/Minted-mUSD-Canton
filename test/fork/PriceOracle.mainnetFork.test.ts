import { expect } from "chai";
import { ethers, network } from "hardhat";
import { PriceOracle } from "../../typechain-types";

describe("PriceOracle mainnet fork", function () {
  const FORK_URL = process.env.MAINNET_FORK_RPC_URL;
  const FORK_BLOCK = process.env.MAINNET_FORK_BLOCK
    ? Number(process.env.MAINNET_FORK_BLOCK)
    : undefined;

  const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const WBTC_MAINNET = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
  const ETH_USD_FEED_MAINNET = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
  const BTC_USD_FEED_MAINNET = "0xf4030086522a5beea4988f8ca5b36dbc97bee88c";

  before(async function () {
    this.timeout(120_000);
    if (!FORK_URL) {
      this.skip();
    }

    const forking = FORK_BLOCK
      ? { jsonRpcUrl: FORK_URL, blockNumber: FORK_BLOCK }
      : { jsonRpcUrl: FORK_URL };

    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking }],
    });
  });

  it("reads live Chainlink prices and normalizes token values on mainnet fork", async function () {
    this.timeout(120_000);

    const [admin] = await ethers.getSigners();
    const OracleFactory = await ethers.getContractFactory("PriceOracle");
    const oracle = (await OracleFactory.deploy()) as PriceOracle;
    await oracle.waitForDeployment();

    await oracle.grantRole(await oracle.ORACLE_ADMIN_ROLE(), admin.address);

    // 7-day stale window for deterministic fork stability.
    const stalePeriod = 7 * 24 * 60 * 60;
    await oracle.setFeed(WETH_MAINNET, ETH_USD_FEED_MAINNET, stalePeriod, 18);
    await oracle.setFeed(WBTC_MAINNET, BTC_USD_FEED_MAINNET, stalePeriod, 8);

    const ethPrice = await oracle.getPrice(WETH_MAINNET);
    const btcPrice = await oracle.getPrice(WBTC_MAINNET);

    expect(ethPrice).to.be.gt(ethers.parseEther("100"));
    expect(ethPrice).to.be.lt(ethers.parseEther("20000"));
    expect(btcPrice).to.be.gt(ethers.parseEther("1000"));
    expect(btcPrice).to.be.lt(ethers.parseEther("300000"));

    const oneEthValue = await oracle.getValueUsd(WETH_MAINNET, ethers.parseEther("1"));
    const oneBtcValue = await oracle.getValueUsd(WBTC_MAINNET, 100_000_000n); // 1 BTC, 8 decimals

    expect(oneEthValue).to.equal(ethPrice);
    expect(oneBtcValue).to.equal(btcPrice);
    expect(await oracle.isFeedHealthy(WETH_MAINNET)).to.equal(true);
    expect(await oracle.isFeedHealthy(WBTC_MAINNET)).to.equal(true);
  });
});
