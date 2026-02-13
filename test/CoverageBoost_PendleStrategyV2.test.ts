/**
 * PendleStrategyV2 Coverage Boost Tests
 * Targets: deposit, withdraw, withdrawAll, totalValue, rollover, PT discount,
 * emergency withdraw, recover token, upgrade timelock, shouldRollover, timeToExpiry
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PendleStrategyV2 — Coverage Boost", function () {
  async function deployFixture() {
    const [admin, treasury, strategist, guardian, user1] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy SY with USDC as yield token
    const MockSY = await ethers.getContractFactory("MockSY");
    const sy = await MockSY.deploy(await usdc.getAddress());
    // Add USDC as input/output token
    await sy.addTokenIn(await usdc.getAddress());
    await sy.addTokenOut(await usdc.getAddress());

    const pt = await MockERC20.deploy("PT Token", "PT", 18);
    const yt = await MockERC20.deploy("YT Token", "YT", 18);

    const currentTime = await time.latest();
    const expiry90Days = currentTime + 90 * 24 * 3600;
    const expiry5Days = currentTime + 5 * 24 * 3600;

    const MockPendleMarket = await ethers.getContractFactory("MockPendleMarket");
    const market1 = await MockPendleMarket.deploy(await sy.getAddress(), await pt.getAddress(), await yt.getAddress(), expiry90Days);
    const marketNearExpiry = await MockPendleMarket.deploy(await sy.getAddress(), await pt.getAddress(), await yt.getAddress(), expiry5Days);

    // Deploy PendleMarketSelector
    const PendleMarketSelector = await ethers.getContractFactory("PendleMarketSelector");
    const marketSelector = await upgrades.deployProxy(PendleMarketSelector, [admin.address, admin.address], {
      kind: "uups",
      initializer: "initialize",
    });

    // Deploy PendleStrategyV2
    const PendleStrategyV2 = await ethers.getContractFactory("PendleStrategyV2");
    const strategy = await upgrades.deployProxy(
      PendleStrategyV2,
      [
        await usdc.getAddress(),
        await marketSelector.getAddress(),
        treasury.address,
        admin.address,
        "USD",
        admin.address, // timelock
      ],
      { kind: "uups", initializer: "initialize" }
    );

    // Grant roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    const TREASURY_ROLE = await strategy.TREASURY_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.connect(admin).grantRole(TREASURY_ROLE, treasury.address);

    // Mint USDC to treasury
    await usdc.mint(treasury.address, ethers.parseUnits("1000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    // Whitelist market in selector
    const MARKET_ADMIN_ROLE = await marketSelector.MARKET_ADMIN_ROLE();
    await marketSelector.connect(admin).whitelistMarket(await market1.getAddress(), "USD");

    // Also mint some random tokens for recovery testing
    const randomToken = await MockERC20.deploy("Random", "RND", 18);
    await randomToken.mint(await strategy.getAddress(), ethers.parseUnits("1000", 18));

    return {
      strategy, marketSelector, usdc, market1, marketNearExpiry,
      admin, treasury, strategist, guardian, user1,
      sy, pt, yt, randomToken,
    };
  }

  describe("Initialization", function () {
    it("Should set correct asset", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);
      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });

    it("Should be active after initialization", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.isActive()).to.be.true;
    });

    it("Should have default slippage of 50 bps", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.slippageBps()).to.equal(50);
    });

    it("Should have default PT discount rate of 1000 bps (10%)", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.ptDiscountRateBps()).to.equal(1000);
    });

    it("Should have default rollover threshold of 7 days", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.rolloverThreshold()).to.equal(7 * 24 * 3600);
    });

    it("Should reject zero USDC address in initialize", async function () {
      const { admin, marketSelector, treasury } = await loadFixture(deployFixture);
      const PendleStrategyV2 = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          PendleStrategyV2,
          [ethers.ZeroAddress, await marketSelector.getAddress(), treasury.address, admin.address, "USD", admin.address /* timelock */],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("Should reject zero market selector in initialize", async function () {
      const { admin, usdc, treasury } = await loadFixture(deployFixture);
      const PendleStrategyV2 = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          PendleStrategyV2,
          [await usdc.getAddress(), ethers.ZeroAddress, treasury.address, admin.address, "USD", admin.address /* timelock */],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("totalValue should return 0 when no deposits", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("ptBalance should return 0 initially", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.ptBalance()).to.equal(0);
    });

    it("currentMarket should be zero address initially", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.currentMarket()).to.equal(ethers.ZeroAddress);
    });

    it("shouldRollover should be true with no current market", async function () {
      const { strategy } = await loadFixture(deployFixture);
      // No current market means strategy should rollover to find one
      expect(await strategy.shouldRollover()).to.be.true;
    });

    it("timeToExpiry should be 0 with no market", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.timeToExpiry()).to.equal(0);
    });

    it("marketCategory should return correct category", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.marketCategory()).to.equal("USD");
    });
  });

  describe("Admin Functions", function () {
    it("Should update slippage", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await strategy.connect(strategist).setSlippage(50);
      expect(await strategy.slippageBps()).to.equal(50);
    });

    it("Should reject slippage > MAX_SLIPPAGE_BPS", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await expect(strategy.connect(strategist).setSlippage(101))
        .to.be.revertedWithCustomError(strategy, "InvalidSlippage");
    });

    it("Should update PT discount rate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await strategy.connect(strategist).setPtDiscountRate(50);
      expect(await strategy.ptDiscountRateBps()).to.equal(50);
    });

    it("Should reject PT discount rate > 5000", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await expect(strategy.connect(strategist).setPtDiscountRate(5001))
        .to.be.revertedWith("DISCOUNT_TOO_HIGH");
    });

    it("Should update rollover threshold", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await strategy.connect(strategist).setRolloverThreshold(14 * 24 * 3600);
      expect(await strategy.rolloverThreshold()).to.equal(14 * 24 * 3600);
    });

    it("Should reject rollover threshold < 1 day", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);
      await expect(strategy.connect(strategist).setRolloverThreshold(3600))
        .to.be.revertedWith("INVALID_THRESHOLD");
    });

    it("Should update market selector", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      const newSelector = ethers.Wallet.createRandom().address;
      await strategy.connect(admin).setMarketSelector(newSelector);
      expect(await strategy.marketSelector()).to.equal(newSelector);
    });

    it("Should toggle active status", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);
      await strategy.connect(guardian).setActive(false);
      expect(await strategy.isActive()).to.be.false;

      await strategy.connect(guardian).setActive(true);
      expect(await strategy.isActive()).to.be.true;
    });

    it("Should reject admin functions from unauthorized", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).setSlippage(50)).to.be.reverted;
      await expect(strategy.connect(user1).setPtDiscountRate(50)).to.be.reverted;
      await expect(strategy.connect(user1).setRolloverThreshold(14 * 86400)).to.be.reverted;
      await expect(strategy.connect(user1).setActive(false)).to.be.reverted;
    });
  });

  describe("Emergency Controls", function () {
    it("Should pause from guardian", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      // Deposit should fail when paused
      // (We can't easily test deposit due to router mock, but pause state is verifiable)
    });

    it("Should unpause from admin (DEFAULT_ADMIN_ROLE)", async function () {
      const { strategy, admin, guardian } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();

      // Guardian CANNOT unpause — only DEFAULT_ADMIN_ROLE can
      await expect(strategy.connect(guardian).unpause()).to.be.reverted;

      // Admin can unpause
      await strategy.connect(admin).unpause();
    });

    it("Should allow guardian to emergency withdraw USDC to treasury", async function () {
      const { strategy, guardian, usdc, treasury } = await loadFixture(deployFixture);

      // Send some USDC to strategy directly (simulating stuck funds)
      await usdc.mint(await strategy.getAddress(), ethers.parseUnits("1000", 6));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(guardian).emergencyWithdraw(treasury.address);
      const balAfter = await usdc.balanceOf(treasury.address);

      // emergencyWithdraw sends USDC to treasury (recipient must have TREASURY_ROLE)
      expect(balAfter - balBefore).to.equal(ethers.parseUnits("1000", 6));
    });

    it("Should allow admin to recover non-USDC tokens", async function () {
      const { strategy, admin, randomToken } = await loadFixture(deployFixture);

      const balBefore = await randomToken.balanceOf(admin.address);
      await strategy.connect(admin).recoverToken(
        await randomToken.getAddress(),
        admin.address
      );
      const balAfter = await randomToken.balanceOf(admin.address);

      expect(balAfter - balBefore).to.equal(ethers.parseUnits("1000", 18));
    });

    it("Should reject recover for USDC", async function () {
      const { strategy, admin, usdc } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).recoverToken(await usdc.getAddress(), admin.address)
      ).to.be.revertedWith("Cannot recover USDC");
    });

    it("Should reject recover from non-admin", async function () {
      const { strategy, user1, randomToken } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(user1).recoverToken(await randomToken.getAddress(), user1.address)
      ).to.be.reverted;
    });
  });

  // Upgrade timelock tests removed — _authorizeUpgrade now uses onlyTimelock
  // via MintedTimelockController (no more requestUpgrade/cancelUpgrade).

  describe("Deposit Authorization", function () {
    it("Should reject deposit from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).deposit(1000))
        .to.be.reverted;
    });

    it("Should reject deposit when paused", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      await expect(strategy.connect(treasury).deposit(1000))
        .to.be.reverted;
    });

    it("Should reject deposit of 0", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(0))
        .to.be.reverted;
    });

    it("Should reject withdraw from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).withdraw(1000))
        .to.be.reverted;
    });

    it("Should reject withdrawAll from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).withdrawAll())
        .to.be.reverted;
    });
  });

  describe("Rollover", function () {
    it("Should reject rollToNewMarket from non-strategist", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).rollToNewMarket())
        .to.be.reverted;
    });

    it("Should reject triggerRollover from non-strategist", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);
      await expect(strategy.connect(user1).triggerRollover())
        .to.be.reverted;
    });
  });
});
