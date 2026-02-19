import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PendleStrategyV2", function () {
  async function deployFixture() {
    const [admin, treasury, strategist, guardian, user1] = await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy mock token addresses for PT/SY/YT
    const mockSy = ethers.Wallet.createRandom().address;
    const mockPt = ethers.Wallet.createRandom().address;
    const mockYt = ethers.Wallet.createRandom().address;

    // Calculate expiry 90 days from now
    const currentTime = Math.floor(Date.now() / 1000);
    const expiry90Days = currentTime + 90 * 24 * 60 * 60;

    // Deploy mock Pendle market
    const MockPendleMarket = await ethers.getContractFactory("MockPendleMarket");
    const mockMarket = await MockPendleMarket.deploy(mockSy, mockPt, mockYt, expiry90Days);

    // Deploy PendleMarketSelector as upgradeable
    const PendleMarketSelector = await ethers.getContractFactory("PendleMarketSelector");
    const marketSelector = await upgrades.deployProxy(PendleMarketSelector, [admin.address, admin.address], {
      kind: "uups",
      initializer: "initialize",
    });

    // Deploy PendleStrategyV2 as upgradeable
    const PendleStrategyV2 = await ethers.getContractFactory("PendleStrategyV2");
    const strategy = await upgrades.deployProxy(
      PendleStrategyV2,
      [
        await usdc.getAddress(),
        await marketSelector.getAddress(),
        treasury.address,
        admin.address,
        "USD",
        admin.address, // timelock (use admin for tests)
      ],
      {
        kind: "uups",
        initializer: "initialize",
      }
    );

    // Grant roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    // Mint USDC to treasury
    await usdc.mint(treasury.address, ethers.parseUnits("1000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      strategy,
      marketSelector,
      usdc,
      mockMarket,
      admin,
      treasury,
      strategist,
      guardian,
      user1,
    };
  }

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, marketSelector } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.marketSelector()).to.equal(await marketSelector.getAddress());
      expect(await strategy.marketCategory()).to.equal("USD");
      expect(await strategy.rolloverThreshold()).to.equal(7 * 24 * 60 * 60); // 7 days
      expect(await strategy.slippageBps()).to.equal(50); // 0.5%
      expect(await strategy.active()).to.be.true;
    });

    it("Should grant roles correctly", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await strategy.DEFAULT_ADMIN_ROLE();
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();

      expect(await strategy.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { strategy, usdc, marketSelector, treasury, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await marketSelector.getAddress(),
          treasury.address,
          admin.address,
          "USD",
          admin.address
        )
      ).to.be.reverted;
    });

    it("Should revert on zero address in initialize", async function () {
      const { usdc, marketSelector, treasury, admin } = await loadFixture(deployFixture);

      const PendleStrategyV2 = await ethers.getContractFactory("PendleStrategyV2");

      await expect(
        upgrades.deployProxy(
          PendleStrategyV2,
          [
            ethers.ZeroAddress,
            await marketSelector.getAddress(),
            treasury.address,
            admin.address,
            "USD",
            admin.address,
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.revertedWithCustomError(PendleStrategyV2, "ZeroAddress");
    });
  });

  describe("View Functions", function () {
    it("Should return asset token", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);

      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });

    it("Should return total value (zero when no deposits)", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.totalValue()).to.equal(0);
    });

    it("Should return PT balance (zero when no deposits)", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.ptBalance()).to.equal(0);
    });

    it("Should return current market (zero when not set)", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.currentMarket()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Admin Functions", function () {
    it("Should update slippage", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSlippage(75); // 0.75%
      expect(await strategy.slippageBps()).to.equal(75);
    });

    it("Should revert on invalid slippage (too high)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      // Over 1% max slippage
      await expect(strategy.connect(strategist).setSlippage(150))
        .to.be.revertedWithCustomError(strategy, "InvalidSlippage");
    });

    it("Should update rollover threshold", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newThreshold = 14 * 24 * 60 * 60; // 14 days
      await strategy.connect(strategist).setRolloverThreshold(newThreshold);
      expect(await strategy.rolloverThreshold()).to.equal(newThreshold);
    });

    it("Should set active status", async function () {
      const { strategy, guardian, admin } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);
      expect(await strategy.active()).to.be.false;

      await strategy.connect(guardian).setActive(true);
      expect(await strategy.active()).to.be.true;
    });

    it("Should update market selector", async function () {
      const { strategy, admin, user1 } = await loadFixture(deployFixture);

      await strategy.connect(admin).setMarketSelector(user1.address);
      expect(await strategy.marketSelector()).to.equal(user1.address);
    });

    it("Should revert admin functions for non-strategist", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setSlippage(75))
        .to.be.reverted;

      await expect(strategy.connect(user1).setActive(false))
        .to.be.reverted;
    });
  });

  describe("Emergency Controls", function () {
    it("Should pause operations", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;
    });

    it("Should unpause operations", async function () {
      const { strategy, admin, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      await strategy.connect(admin).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("Should prevent deposits when paused", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      await strategy.connect(admin).pause();

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });

    it("Should prevent deposits when inactive", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "NotActive");
    });
  });

  describe("Deposit Validation", function () {
    it("Should revert deposit with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).deposit(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert deposit from non-treasury", async function () {
      const { strategy, usdc, user1 } = await loadFixture(deployFixture);

      await usdc.mint(user1.address, ethers.parseUnits("1000", 6));
      await usdc.connect(user1).approve(await strategy.getAddress(), ethers.MaxUint256);

      await expect(strategy.connect(user1).deposit(ethers.parseUnits("100", 6)))
        .to.be.reverted;
    });
  });

  describe("Withdraw Validation", function () {
    it("Should revert withdraw with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert withdraw from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).withdraw(ethers.parseUnits("100", 6)))
        .to.be.reverted;
    });
  });

  describe("Upgradeability", function () {
    it("Should be upgradeable by admin", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const PendleStrategyV2Next = await ethers.getContractFactory("PendleStrategyV2", admin);
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), PendleStrategyV2Next);

      expect(await upgraded.getAddress()).to.equal(await strategy.getAddress());
    });

    it("Should not be upgradeable by non-admin", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const PendleStrategyV2Next = await ethers.getContractFactory("PendleStrategyV2", user1);

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), PendleStrategyV2Next)
      ).to.be.reverted;
    });

    it("Should preserve state after upgrade", async function () {
      const { strategy, admin, strategist } = await loadFixture(deployFixture);

      // Set some state
      await strategy.connect(strategist).setSlippage(75);
      expect(await strategy.slippageBps()).to.equal(75);

      // Upgrade via UUPS
      const PendleStrategyV2Next = await ethers.getContractFactory("PendleStrategyV2", admin);
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), PendleStrategyV2Next);

      // Check state preserved
      expect(await upgraded.slippageBps()).to.equal(75);
      expect(await upgraded.marketCategory()).to.equal("USD");
    });
  });

  describe("Additional Admin Functions", function () {
    it("Should update market selector with zero address revert", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(strategy.connect(admin).setMarketSelector(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("Should emit SlippageUpdated event", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSlippage(75))
        .to.emit(strategy, "SlippageUpdated");
    });

    it("Should update rollover threshold", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newThreshold = 10 * 24 * 60 * 60; // 10 days
      await strategy.connect(strategist).setRolloverThreshold(newThreshold);
      expect(await strategy.rolloverThreshold()).to.equal(newThreshold);
    });
  });

  describe("Role Management", function () {
    it("Should allow admin to grant strategist role", async function () {
      const { strategy, admin, user1 } = await loadFixture(deployFixture);

      const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
      await strategy.connect(admin).grantRole(STRATEGIST_ROLE, user1.address);

      expect(await strategy.hasRole(STRATEGIST_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke roles", async function () {
      const { strategy, admin, strategist } = await loadFixture(deployFixture);

      const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
      await strategy.connect(admin).revokeRole(STRATEGIST_ROLE, strategist.address);

      expect(await strategy.hasRole(STRATEGIST_ROLE, strategist.address)).to.be.false;
    });

    it("Should prevent non-admin from granting roles", async function () {
      const { strategy, user1, strategist } = await loadFixture(deployFixture);

      const TREASURY_ROLE = await strategy.TREASURY_ROLE();
      await expect(strategy.connect(strategist).grantRole(TREASURY_ROLE, user1.address))
        .to.be.reverted;
    });
  });

  describe("View Functions Extended", function () {
    it("Should return market category", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.marketCategory()).to.equal("USD");
    });

    it("Should return rollover threshold", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.rolloverThreshold()).to.equal(7 * 24 * 60 * 60);
    });

    it("Should return active status", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.active()).to.be.true;
    });

    it("Should return slippage settings", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.slippageBps()).to.equal(50);
    });

    it("Should return current PT and SY addresses (zero when no market)", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.currentPT()).to.equal(ethers.ZeroAddress);
      expect(await strategy.currentSY()).to.equal(ethers.ZeroAddress);
      expect(await strategy.currentYT()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero slippage setting", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSlippage(0);
      expect(await strategy.slippageBps()).to.equal(0);
    });

    it("Should handle minimum rollover threshold", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const minThreshold = 1 * 24 * 60 * 60; // 1 day
      await strategy.connect(strategist).setRolloverThreshold(minThreshold);
      expect(await strategy.rolloverThreshold()).to.equal(minThreshold);
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — setPtDiscountRate
  // ================================================================

  describe("PT Discount Rate", function () {
    it("Should set PT discount rate as strategist", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setPtDiscountRate(500); // 5%
      expect(await strategy.ptDiscountRateBps()).to.equal(500);
    });

    it("Should emit PtDiscountRateUpdated event", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setPtDiscountRate(750))
        .to.emit(strategy, "PtDiscountRateUpdated")
        .withArgs(1000, 750); // old=1000 (default 10%), new=750
    });

    it("Should reject discount rate above 50%", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setPtDiscountRate(5001)
      ).to.be.revertedWithCustomError(strategy, "DiscountTooHigh");
    });

    it("Should allow zero discount rate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setPtDiscountRate(0);
      expect(await strategy.ptDiscountRateBps()).to.equal(0);
    });

    it("Should allow max 50% discount rate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setPtDiscountRate(5000);
      expect(await strategy.ptDiscountRateBps()).to.equal(5000);
    });

    it("Should reject non-strategist setting discount rate", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setPtDiscountRate(500))
        .to.be.reverted;
    });
  });

  // ================================================================
  //  UUPS UPGRADE AUTHORIZATION
  // ================================================================

  describe("Upgrade Authorization", function () {
    it("Should allow admin to perform UUPS upgrade", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const PendleStrategyV2Next = await ethers.getContractFactory("PendleStrategyV2", admin);
      const upgraded = await upgrades.upgradeProxy(
        await strategy.getAddress(),
        PendleStrategyV2Next
      );

      // Verify state preserved after upgrade
      expect(await upgraded.marketCategory()).to.equal("USD");
      expect(await upgraded.active()).to.be.true;
    });

    it("Should reject upgrade from non-admin", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const PendleStrategyV2Next = await ethers.getContractFactory("PendleStrategyV2", user1);
      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), PendleStrategyV2Next)
      ).to.be.reverted;
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — needsRollover / shouldRollover / timeToExpiry
  // ================================================================

  describe("Rollover View Functions", function () {
    it("Should return true for shouldRollover when no market is set", async function () {
      const { strategy } = await loadFixture(deployFixture);

      // No market set yet → should need rollover
      expect(await strategy.shouldRollover()).to.be.true;
    });

    it("Should return 0 timeToExpiry when no market is set", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.timeToExpiry()).to.equal(0);
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — setActive with guardian role
  // ================================================================

  describe("Guardian setActive", function () {
    it("Should allow guardian to deactivate strategy", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);
      expect(await strategy.active()).to.be.false;
      expect(await strategy.isActive()).to.be.false;
    });

    it("Should allow guardian to reactivate strategy", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);
      await strategy.connect(guardian).setActive(true);
      expect(await strategy.active()).to.be.true;
    });

    it("Should reject setActive from non-guardian", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setActive(false)).to.be.reverted;
    });

    it("Should reject strategist from calling setActive (needs GUARDIAN_ROLE)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      // Strategist has STRATEGIST_ROLE but not GUARDIAN_ROLE
      await expect(strategy.connect(strategist).setActive(false)).to.be.reverted;
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — setRolloverThreshold edge cases
  // ================================================================

  describe("Rollover Threshold Edge Cases", function () {
    it("Should reject zero rollover threshold", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setRolloverThreshold(0)
      ).to.be.revertedWithCustomError(strategy, "InvalidThreshold");
    });

    it("Should allow max rollover threshold (30 days)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const maxThreshold = 30 * 24 * 60 * 60; // 30 days
      await strategy.connect(strategist).setRolloverThreshold(maxThreshold);
      expect(await strategy.rolloverThreshold()).to.equal(maxThreshold);
    });

    it("Should emit RolloverThresholdUpdated event", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const defaultThreshold = 7 * 24 * 60 * 60;
      const newThreshold = 14 * 24 * 60 * 60;

      await expect(strategy.connect(strategist).setRolloverThreshold(newThreshold))
        .to.emit(strategy, "RolloverThresholdUpdated")
        .withArgs(defaultThreshold, newThreshold);
    });

    it("Should reject non-strategist from setting rollover threshold", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).setRolloverThreshold(86400)
      ).to.be.reverted;
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — recoverToken
  // ================================================================

  describe("Recover Token", function () {
    it("Should recover random stuck tokens", async function () {
      const { strategy, admin, usdc } = await loadFixture(deployFixture);

      // Deploy a random token and send it to the strategy
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);
      const amount = ethers.parseEther("100");
      await randomToken.mint(await strategy.getAddress(), amount);

      const balBefore = await randomToken.balanceOf(admin.address);
      await strategy.connect(admin).recoverToken(await randomToken.getAddress(), admin.address);
      const balAfter = await randomToken.balanceOf(admin.address);

      expect(balAfter - balBefore).to.equal(amount);
    });

    it("Should reject recovering USDC", async function () {
      const { strategy, admin, usdc } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).recoverToken(await usdc.getAddress(), admin.address)
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverUsdc");
    });

    it("Should reject non-admin from recovering tokens", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);

      await expect(
        strategy.connect(user1).recoverToken(await randomToken.getAddress(), user1.address)
      ).to.be.reverted;
    });
  });

  // ================================================================
  //  NEW COVERAGE TESTS — isActive view function
  // ================================================================

  describe("isActive View Function", function () {
    it("Should return true when active and not paused", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.isActive()).to.be.true;
    });

    it("Should return false when paused", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.isActive()).to.be.false;
    });

    it("Should return false when inactive", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);
      expect(await strategy.isActive()).to.be.false;
    });

    it("Should return false when both paused and inactive", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).setActive(false);
      await strategy.connect(guardian).pause();
      expect(await strategy.isActive()).to.be.false;
    });
  });
});
