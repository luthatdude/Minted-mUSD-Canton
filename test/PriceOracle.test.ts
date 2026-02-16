/**
 * PriceOracle Tests
 * Tests: feed management, price normalization, staleness checks, decimal handling
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { PriceOracle, MockAggregatorV3 } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { timelockSetFeed, timelockRemoveFeed, timelockAddCollateral, timelockUpdateCollateral, timelockSetBorrowModule, timelockSetInterestRateModel, timelockSetSMUSD, timelockSetTreasury, timelockSetInterestRate, timelockSetMinDebt, timelockSetCloseFactor, timelockSetFullLiquidationThreshold, timelockAddStrategy, timelockRemoveStrategy, timelockSetFeeConfig, timelockSetReserveBps, timelockSetFees, timelockSetFeeRecipient, refreshFeeds } from "./helpers/timelock";

describe("PriceOracle", function () {
  let oracle: PriceOracle;
  let ethFeed: MockAggregatorV3;
  let btcFeed: MockAggregatorV3;
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  // Mock token addresses (not real contracts, just for feed mapping)
  const WETH_ADDR = "0x0000000000000000000000000000000000000001";
  const WBTC_ADDR = "0x0000000000000000000000000000000000000002";

  const ETH_PRICE = 200000000000n; // $2000 with 8 decimals
  const BTC_PRICE = 5000000000000n; // $50000 with 8 decimals
  const STALE_PERIOD = 3600; // 1 hour

  beforeEach(async function () {
    [deployer, admin, user] = await ethers.getSigners();

    // Deploy mock Chainlink feeds
    const MockFeedFactory = await ethers.getContractFactory("MockAggregatorV3");
    ethFeed = await MockFeedFactory.deploy(8, ETH_PRICE); // 8 decimals like real Chainlink
    btcFeed = await MockFeedFactory.deploy(8, BTC_PRICE);

    // Deploy PriceOracle
    const OracleFactory = await ethers.getContractFactory("PriceOracle");
    oracle = await OracleFactory.deploy();
    await oracle.waitForDeployment();

    // Grant admin role
    await oracle.grantRole(await oracle.ORACLE_ADMIN_ROLE(), admin.address);

    // Configure feeds
    await timelockSetFeed(oracle, deployer, WETH_ADDR, await ethFeed.getAddress(), STALE_PERIOD, 18);
    await timelockSetFeed(oracle, deployer, WBTC_ADDR, await btcFeed.getAddress(), STALE_PERIOD, 8);

    await refreshFeeds(ethFeed, btcFeed);
  });

  // ============================================================
  //  FEED MANAGEMENT
  // ============================================================

  describe("Feed Management", function () {
    it("should add a feed", async function () {
      const [feed, stalePeriod, tokenDecimals, feedDecimals, enabled] = await oracle.feeds(WETH_ADDR);
      expect(enabled).to.be.true;
      expect(stalePeriod).to.equal(STALE_PERIOD);
      expect(tokenDecimals).to.equal(18);
    });

    it("should reject zero token address", async function () {
      await expect(
        oracle.connect(deployer).setFeed(ethers.ZeroAddress, await ethFeed.getAddress(), STALE_PERIOD, 18, 0)
      ).to.be.revertedWithCustomError(oracle, "InvalidToken");
    });

    it("should reject zero feed address", async function () {
      await expect(
        oracle.connect(deployer).setFeed(WETH_ADDR, ethers.ZeroAddress, STALE_PERIOD, 18, 0)
      ).to.be.revertedWithCustomError(oracle, "InvalidFeed");
    });

    it("should reject zero stale period", async function () {
      await expect(
        oracle.connect(deployer).setFeed(WETH_ADDR, await ethFeed.getAddress(), 0, 18, 0)
      ).to.be.revertedWithCustomError(oracle, "InvalidStalePeriod");
    });

    it("should reject tokenDecimals > 18", async function () {
      await expect(
        oracle.connect(deployer).setFeed(WETH_ADDR, await ethFeed.getAddress(), STALE_PERIOD, 19, 0)
      ).to.be.revertedWithCustomError(oracle, "TokenDecimalsTooHigh");
    });

    it("should remove a feed", async function () {
      await timelockRemoveFeed(oracle, deployer, WETH_ADDR);
      const [, , , , enabled] = await oracle.feeds(WETH_ADDR);
      expect(enabled).to.be.false;
    });

    it("should reject remove of non-existent feed", async function () {
      const randomAddr = "0x0000000000000000000000000000000000000099";
      await expect(oracle.connect(deployer).removeFeed(randomAddr)).to.be.revertedWithCustomError(oracle, "FeedNotFound");
    });

    it("should reject unauthorized feed changes", async function () {
      await expect(
        oracle.connect(user).setFeed(WETH_ADDR, await ethFeed.getAddress(), STALE_PERIOD, 18, 0)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  PRICE QUERIES
  // ============================================================

  describe("getPrice", function () {
    it("should return normalized 18-decimal price for ETH", async function () {
      const price = await oracle.getPrice(WETH_ADDR);
      // $2000 normalized to 18 decimals = 2000 * 10^18
      expect(price).to.equal(ethers.parseEther("2000"));
    });

    it("should return normalized price for BTC", async function () {
      const price = await oracle.getPrice(WBTC_ADDR);
      expect(price).to.equal(ethers.parseEther("50000"));
    });

    it("should reject query for disabled feed", async function () {
      await timelockRemoveFeed(oracle, deployer, WETH_ADDR);
      await expect(oracle.getPrice(WETH_ADDR)).to.be.revertedWithCustomError(oracle, "FeedNotEnabled");
    });

    it("should reject stale price", async function () {
      // Fast-forward past stale period
      await time.increase(STALE_PERIOD + 1);
      await expect(oracle.getPrice(WETH_ADDR)).to.be.revertedWithCustomError(oracle, "StalePrice");
    });

    it("should reject zero/negative price", async function () {
      await ethFeed.setAnswer(0);
      await expect(oracle.getPrice(WETH_ADDR)).to.be.revertedWithCustomError(oracle, "InvalidPrice");
    });

    it("should reject negative price", async function () {
      await ethFeed.setAnswer(-1);
      await expect(oracle.getPrice(WETH_ADDR)).to.be.revertedWithCustomError(oracle, "InvalidPrice");
    });
  });

  // ============================================================
  //  VALUE CALCULATIONS
  // ============================================================

  describe("getValueUsd", function () {
    it("should calculate USD value for 18-decimal token (ETH)", async function () {
      const oneETH = ethers.parseEther("1");
      const value = await oracle.getValueUsd(WETH_ADDR, oneETH);
      // 1 ETH * $2000 = $2000 in 18 decimals
      expect(value).to.equal(ethers.parseEther("2000"));
    });

    it("should calculate USD value for 8-decimal token (WBTC)", async function () {
      const oneBTC = 100000000n; // 1 BTC with 8 decimals
      const value = await oracle.getValueUsd(WBTC_ADDR, oneBTC);
      expect(value).to.equal(ethers.parseEther("50000"));
    });

    it("should handle fractional amounts correctly", async function () {
      const halfETH = ethers.parseEther("0.5");
      const value = await oracle.getValueUsd(WETH_ADDR, halfETH);
      expect(value).to.equal(ethers.parseEther("1000"));
    });

    it("should handle zero amount", async function () {
      const value = await oracle.getValueUsd(WETH_ADDR, 0);
      expect(value).to.equal(0);
    });
  });

  // ============================================================
  //  FEED HEALTH
  // ============================================================

  describe("isFeedHealthy", function () {
    it("should return true for healthy feed", async function () {
      expect(await oracle.isFeedHealthy(WETH_ADDR)).to.be.true;
    });

    it("should return false for stale feed", async function () {
      await time.increase(STALE_PERIOD + 1);
      expect(await oracle.isFeedHealthy(WETH_ADDR)).to.be.false;
    });

    it("should return false for disabled feed", async function () {
      await timelockRemoveFeed(oracle, deployer, WETH_ADDR);
      expect(await oracle.isFeedHealthy(WETH_ADDR)).to.be.false;
    });

    it("should return false for zero price", async function () {
      await ethFeed.setAnswer(0);
      expect(await oracle.isFeedHealthy(WETH_ADDR)).to.be.false;
    });
  });
});
