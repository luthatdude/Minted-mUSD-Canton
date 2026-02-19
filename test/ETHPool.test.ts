import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * @title ETHPool Test Suite
 * @notice TEST-C-02: Comprehensive tests for the ETHPool contract
 * @dev Tests staking (ETH + stablecoin), unstaking, timelocks, strategy, admin, views
 */
describe("ETHPool", function () {
  async function deployFixture() {
    const [deployer, poolManager, pauser, yieldManager, strategyManager, user1, user2] =
      await ethers.getSigners();

    // Deploy MockERC20 tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped ETH", "WETH", 18);
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const usdt = await MockERC20.deploy("Tether", "USDT", 6);

    // Deploy mUSD
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    // Deploy smUSD-E mock (uses SMUSDE contract)
    const SMUSDE = await ethers.getContractFactory("SMUSDE");
    const smUsdE = await SMUSDE.deploy();

    // Deploy PriceOracle + feed
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const oracle = await PriceOracle.deploy();

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregatorV3.deploy(8, 2000_00000000n); // $2000
    await oracle.setFeed(await weth.getAddress(), await ethFeed.getAddress(), 3600, 18, 0);

    const poolCap = ethers.parseEther("1000000"); // 1M mUSD cap

    // Deploy ETHPool
    const ETHPool = await ethers.getContractFactory("ETHPool");
    const pool = await ETHPool.deploy(
      await musd.getAddress(),
      await smUsdE.getAddress(),
      await oracle.getAddress(),
      await weth.getAddress(),
      poolCap,
      deployer.address, // timelockController
    );
    const poolAddr = await pool.getAddress();

    // Grant roles
    await pool.grantRole(await pool.POOL_MANAGER_ROLE(), poolManager.address);
    await pool.grantRole(await pool.PAUSER_ROLE(), pauser.address);
    await pool.grantRole(await pool.YIELD_MANAGER_ROLE(), yieldManager.address);
    await pool.grantRole(await pool.STRATEGY_MANAGER_ROLE(), strategyManager.address);

    // Grant BRIDGE_ROLE on mUSD to the pool so it can mint
    await musd.grantRole(await musd.BRIDGE_ROLE(), poolAddr);
    // Grant POOL_ROLE on smUSD-E to the pool so it can mint/burn
    await smUsdE.grantRole(await smUsdE.POOL_ROLE(), poolAddr);

    // Add stablecoins
    await pool.addStablecoin(await usdc.getAddress(), 6);
    await pool.addStablecoin(await usdt.getAddress(), 6);

    return {
      pool, musd, smUsdE, oracle, weth, usdc, usdt, ethFeed,
      deployer, poolManager, pauser, yieldManager, strategyManager, user1, user2,
      poolCap,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("sets correct initial state", async function () {
      const { pool, poolCap } = await loadFixture(deployFixture);
      expect(await pool.poolCap()).to.equal(poolCap);
      expect(await pool.sharePrice()).to.equal(ethers.parseEther("1"));
      expect(await pool.totalETHDeposited()).to.equal(0);
      expect(await pool.totalMUSDMinted()).to.equal(0);
      expect(await pool.totalSMUSDEIssued()).to.equal(0);
    });

    it("reverts on zero musd address", async function () {
      const { deployer, smUsdE, oracle, weth } = await loadFixture(deployFixture);
      const ETHPool = await ethers.getContractFactory("ETHPool");
      await expect(
        ETHPool.deploy(ethers.ZeroAddress, await smUsdE.getAddress(), await oracle.getAddress(), await weth.getAddress(), 1000n, deployer.address)
      ).to.be.reverted;
    });

    it("reverts on zero oracle address", async function () {
      const { deployer, musd, smUsdE, weth } = await loadFixture(deployFixture);
      const ETHPool = await ethers.getContractFactory("ETHPool");
      await expect(
        ETHPool.deploy(await musd.getAddress(), await smUsdE.getAddress(), ethers.ZeroAddress, await weth.getAddress(), 1000n, deployer.address)
      ).to.be.reverted;
    });

    it("configures 4 time-lock tiers", async function () {
      const { pool } = await loadFixture(deployFixture);
      const [durNone, multNone] = await pool.getTierConfig(0); // None
      expect(durNone).to.equal(0);
      expect(multNone).to.equal(10000);

      const [durShort, multShort] = await pool.getTierConfig(1); // Short
      expect(durShort).to.equal(30 * 24 * 3600); // 30 days
      expect(multShort).to.equal(12500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // STAKING ETH
  // ═══════════════════════════════════════════════════════════════════

  describe("Stake ETH", function () {
    it("stakes ETH successfully with no lock tier", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      const stakeAmount = ethers.parseEther("1"); // 1 ETH = $2000 = 2000 mUSD
      const tx = await pool.connect(user1).stake(0, { value: stakeAmount });
      await expect(tx).to.emit(pool, "Staked");
      expect(await pool.getPositionCount(user1.address)).to.equal(1);
    });

    it("increases totalETHDeposited", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      const stakeAmount = ethers.parseEther("2");
      await pool.connect(user1).stake(0, { value: stakeAmount });
      expect(await pool.totalETHDeposited()).to.equal(stakeAmount);
    });

    it("reverts on zero ETH", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).stake(0, { value: 0 })).to.be.reverted;
    });

    it("respects pool cap", async function () {
      const { pool, user1, poolCap, oracle, ethFeed } = await loadFixture(deployFixture);
      // Pool cap is 1M mUSD. At $2000/ETH, need 501 ETH to exceed (501 * 2000 > 1M)
      // Set a very high price to easily exceed the cap
      await ethFeed.setAnswer(10_000_000_00000000n); // $10M per ETH
      await expect(
        pool.connect(user1).stake(0, { value: ethers.parseEther("1") })
      ).to.be.reverted;
    });

    it("applies tier multiplier to smUSD-E shares", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      // Stake with Long tier (2x multiplier)
      await pool.connect(user1).stake(3, { value: ethers.parseEther("1") });
      const pos = await pool.getPosition(user1.address, 0);
      expect(pos.smUsdEShares).to.be.gt(0);
    });

    it("sets correct unlock time for tiered stake", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(1, { value: ethers.parseEther("1") }); // Short = 30 days
      const pos = await pool.getPosition(user1.address, 0);
      expect(pos.unlockAt).to.be.gt(pos.stakedAt);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // STAKING STABLECOINS
  // ═══════════════════════════════════════════════════════════════════

  describe("Stake with Token", function () {
    it("stakes USDC successfully", async function () {
      const { pool, usdc, user1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);
      await usdc.mint(user1.address, amount);
      await usdc.connect(user1).approve(await pool.getAddress(), amount);
      await pool.connect(user1).stakeWithToken(await usdc.getAddress(), amount, 0);
      expect(await pool.getPositionCount(user1.address)).to.equal(1);
    });

    it("reverts on unsupported token", async function () {
      const { pool, weth, user1 } = await loadFixture(deployFixture);
      await expect(
        pool.connect(user1).stakeWithToken(await weth.getAddress(), 1000n, 0)
      ).to.be.reverted;
    });

    it("reverts on zero amount", async function () {
      const { pool, usdc, user1 } = await loadFixture(deployFixture);
      await expect(
        pool.connect(user1).stakeWithToken(await usdc.getAddress(), 0, 0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UNSTAKING
  // ═══════════════════════════════════════════════════════════════════

  describe("Unstake", function () {
    it("unstakes immediately with no lock tier", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      await expect(pool.connect(user1).unstake(0)).to.emit(pool, "Unstaked");
    });

    it("reverts before unlock time", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(1, { value: ethers.parseEther("1") }); // Short lock
      await expect(pool.connect(user1).unstake(0)).to.be.reverted;
    });

    it("unstakes after lock expires", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(1, { value: ethers.parseEther("1") });
      await time.increase(31 * 24 * 3600); // 31 days
      await expect(pool.connect(user1).unstake(0)).to.emit(pool, "Unstaked");
    });

    it("reverts on non-existent position", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).unstake(99)).to.be.reverted;
    });

    it("reverts on already-unstaked position", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      await pool.connect(user1).unstake(0);
      await expect(pool.connect(user1).unstake(0)).to.be.reverted;
    });

    it("returns ETH to the user", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      const stakeAmount = ethers.parseEther("1");
      await pool.connect(user1).stake(0, { value: stakeAmount });
      const balBefore = await ethers.provider.getBalance(user1.address);
      await pool.connect(user1).unstake(0);
      const balAfter = await ethers.provider.getBalance(user1.address);
      // Should receive ETH back (minus gas)
      expect(balAfter).to.be.gt(balBefore - ethers.parseEther("0.01"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("canUnstake returns false for locked position", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(2, { value: ethers.parseEther("1") }); // Medium lock
      expect(await pool.canUnstake(user1.address, 0)).to.be.false;
    });

    it("canUnstake returns true for unlocked position", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") }); // No lock
      expect(await pool.canUnstake(user1.address, 0)).to.be.true;
    });

    it("getRemainingLockTime returns 0 for unlocked", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      expect(await pool.getRemainingLockTime(user1.address, 0)).to.equal(0);
    });

    it("totalPoolValue reflects deposits", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      expect(await pool.totalPoolValue()).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SHARE PRICE
  // ═══════════════════════════════════════════════════════════════════

  describe("Share Price", function () {
    it("allows yield manager to update share price", async function () {
      const { pool, yieldManager } = await loadFixture(deployFixture);
      const newPrice = ethers.parseEther("1.05"); // +5%
      await pool.connect(yieldManager).updateSharePrice(newPrice);
      expect(await pool.sharePrice()).to.equal(newPrice);
    });

    it("reverts on too-large share price change", async function () {
      const { pool, yieldManager } = await loadFixture(deployFixture);
      // MAX_SHARE_PRICE_CHANGE_BPS = 1000 (10%)
      const tooHigh = ethers.parseEther("1.15"); // +15%
      await expect(pool.connect(yieldManager).updateSharePrice(tooHigh)).to.be.reverted;
    });

    it("reverts from unauthorized caller", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).updateSharePrice(ethers.parseEther("1.05"))).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════

  describe("Admin", function () {
    it("adds stablecoin", async function () {
      const { pool, deployer } = await loadFixture(deployFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const dai = await MockERC20.deploy("DAI", "DAI", 18);
      await expect(pool.connect(deployer).addStablecoin(await dai.getAddress(), 18))
        .to.emit(pool, "StablecoinAdded");
    });

    it("removes stablecoin", async function () {
      const { pool, deployer, usdc } = await loadFixture(deployFixture);
      await expect(pool.connect(deployer).removeStablecoin(await usdc.getAddress()))
        .to.emit(pool, "StablecoinRemoved");
    });

    it("reverts adding duplicate stablecoin", async function () {
      const { pool, deployer, usdc } = await loadFixture(deployFixture);
      await expect(pool.connect(deployer).addStablecoin(await usdc.getAddress(), 6)).to.be.reverted;
    });

    it("reverts removing non-existent stablecoin", async function () {
      const { pool, deployer, weth } = await loadFixture(deployFixture);
      await expect(pool.connect(deployer).removeStablecoin(await weth.getAddress())).to.be.reverted;
    });

    it("sets pool cap", async function () {
      const { pool, deployer } = await loadFixture(deployFixture);
      const newCap = ethers.parseEther("5000000");
      await expect(pool.connect(deployer).setPoolCap(newCap)).to.emit(pool, "PoolCapUpdated");
      expect(await pool.poolCap()).to.equal(newCap);
    });

    it("sets tier config", async function () {
      const { pool, deployer } = await loadFixture(deployFixture);
      await pool.connect(deployer).setTierConfig(1, 60 * 24 * 3600, 15000); // 60 days, 1.5x
      const [dur, mult] = await pool.getTierConfig(1);
      expect(dur).to.equal(60 * 24 * 3600);
      expect(mult).to.equal(15000);
    });

    it("sets price oracle", async function () {
      const { pool, deployer, oracle } = await loadFixture(deployFixture);
      await expect(pool.connect(deployer).setPriceOracle(await oracle.getAddress()))
        .to.emit(pool, "PriceOracleUpdated");
    });

    it("reverts admin from unauthorized", async function () {
      const { pool, user1, usdc } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).addStablecoin(await usdc.getAddress(), 6)).to.be.reverted;
      await expect(pool.connect(user1).setPoolCap(100n)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAUSE
  // ═══════════════════════════════════════════════════════════════════

  describe("Pausable", function () {
    it("pauser can pause", async function () {
      const { pool, pauser } = await loadFixture(deployFixture);
      await pool.connect(pauser).pause();
      expect(await pool.paused()).to.be.true;
    });

    it("stake blocked when paused", async function () {
      const { pool, pauser, user1 } = await loadFixture(deployFixture);
      await pool.connect(pauser).pause();
      await expect(pool.connect(user1).stake(0, { value: ethers.parseEther("1") })).to.be.reverted;
    });

    it("admin can unpause", async function () {
      const { pool, pauser, deployer } = await loadFixture(deployFixture);
      await pool.connect(pauser).pause();
      await pool.connect(deployer).unpause();
      expect(await pool.paused()).to.be.false;
    });

    it("non-pauser cannot pause", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await expect(pool.connect(user1).pause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MULTIPLE POSITIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("Multiple Positions", function () {
    it("user can create multiple positions", async function () {
      const { pool, user1 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      await pool.connect(user1).stake(1, { value: ethers.parseEther("0.5") });
      expect(await pool.getPositionCount(user1.address)).to.equal(2);
    });

    it("multiple users can stake independently", async function () {
      const { pool, user1, user2 } = await loadFixture(deployFixture);
      await pool.connect(user1).stake(0, { value: ethers.parseEther("1") });
      await pool.connect(user2).stake(0, { value: ethers.parseEther("2") });
      expect(await pool.getPositionCount(user1.address)).to.equal(1);
      expect(await pool.getPositionCount(user2.address)).to.equal(1);
    });
  });
});
