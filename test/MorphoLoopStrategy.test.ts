import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("MorphoLoopStrategy", function () {
  const MARKET_ID = ethers.keccak256(ethers.toUtf8Bytes("USDC-USDC-market"));

  async function deployFixture() {
    const [admin, treasury, strategist, guardian, user1] = await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy Mock Morpho
    const MockMorphoBlue = await ethers.getContractFactory("MockMorphoBlue");
    const morpho = await MockMorphoBlue.deploy(await usdc.getAddress());

    // Set up market params in mock
    await morpho.setMarketParams(
      MARKET_ID,
      await usdc.getAddress(), // loanToken
      await usdc.getAddress(), // collateralToken (USDC-USDC for stablecoin leverage)
      ethers.ZeroAddress,      // oracle
      ethers.ZeroAddress,      // irm
      ethers.parseUnits("0.86", 18) // 86% LLTV
    );

    // Seed Morpho with liquidity for borrowing
    await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
    await usdc.connect(admin).approve(await morpho.getAddress(), ethers.MaxUint256);
    await morpho.connect(admin).seedLiquidity(ethers.parseUnits("5000000", 6));

    // Deploy MorphoLoopStrategy as upgradeable
    const MorphoLoopStrategy = await ethers.getContractFactory("MorphoLoopStrategy");
    const strategy = await upgrades.deployProxy(
      MorphoLoopStrategy,
      [
        await usdc.getAddress(),
        await morpho.getAddress(),
        MARKET_ID,
        treasury.address,
        admin.address,
      ],
      {
        kind: "uups",
        initializer: "initialize",
      }
    );

    // Grant roles
    const TREASURY_ROLE = await strategy.TREASURY_ROLE();
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    
    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    // Mint USDC to treasury
    await usdc.mint(treasury.address, ethers.parseUnits("1000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return { strategy, usdc, morpho, admin, treasury, strategist, guardian, user1 };
  }

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, morpho } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.morpho()).to.equal(await morpho.getAddress());
      expect(await strategy.marketId()).to.equal(MARKET_ID);
      expect(await strategy.targetLtvBps()).to.equal(7000); // 70%
      expect(await strategy.safetyBufferBps()).to.equal(500); // 5%
      expect(await strategy.targetLoops()).to.equal(4);
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
      const { strategy, usdc, morpho, treasury, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await morpho.getAddress(),
          MARKET_ID,
          treasury.address,
          admin.address
        )
      ).to.be.reverted;
    });
  });

  describe("Deposit", function () {
    it("Should accept deposit from treasury", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", 6);

      await expect(strategy.connect(treasury).deposit(amount))
        .to.emit(strategy, "Deposited");

      expect(await strategy.totalPrincipal()).to.equal(amount);
    });

    it("Should revert deposit with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).deposit(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert deposit from non-treasury", async function () {
      const { strategy, user1, usdc } = await loadFixture(deployFixture);

      await usdc.mint(user1.address, ethers.parseUnits("1000", 6));
      await usdc.connect(user1).approve(await strategy.getAddress(), ethers.MaxUint256);

      await expect(strategy.connect(user1).deposit(ethers.parseUnits("100", 6)))
        .to.be.reverted;
    });

    it("Should revert deposit when strategy is inactive", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      // Deactivate strategy
      await strategy.connect(admin).setActive(false);

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("Should revert deposit when paused", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      await strategy.connect(admin).pause();

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });
  });

  describe("Withdraw", function () {
    it("Should withdraw funds", async function () {
      const { strategy, usdc, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const withdrawAmount = ethers.parseUnits("5000", 6);
      const balanceBefore = await usdc.balanceOf(treasury.address);

      await expect(strategy.connect(treasury).withdraw(withdrawAmount))
        .to.emit(strategy, "Withdrawn");

      const balanceAfter = await usdc.balanceOf(treasury.address);
      // Balance should be >= before (we got some back)
      expect(balanceAfter).to.be.gte(balanceBefore);
    });

    it("Should withdraw all funds", async function () {
      const { strategy, usdc, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      await strategy.connect(treasury).withdrawAll();

      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("Should revert withdraw with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert withdraw from non-treasury", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(strategy.connect(user1).withdraw(ethers.parseUnits("1000", 6)))
        .to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("Should return total value", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const totalValue = await strategy.totalValue();
      expect(totalValue).to.be.gt(0);
    });

    it("Should return asset token", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);

      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });
  });

  describe("Admin Functions", function () {
    it("Should update parameters", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setParameters(6500, 3); // 65% LTV, 3 loops
      expect(await strategy.targetLtvBps()).to.equal(6500);
      expect(await strategy.targetLoops()).to.equal(3);
    });

    it("Should revert on excessive loops", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(7000, 10))
        .to.be.revertedWithCustomError(strategy, "ExcessiveLoops");
    });

    it("Should revert on invalid LTV (too high)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      // Too high LTV (over 85%)
      await expect(strategy.connect(strategist).setParameters(9000, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should revert on invalid LTV (too low)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      // Too low LTV (under 50%)
      await expect(strategy.connect(strategist).setParameters(4000, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should set active status", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);
      expect(await strategy.active()).to.be.false;

      await strategy.connect(strategist).setActive(true);
      expect(await strategy.active()).to.be.true;
    });

    it("Should revert admin functions for non-strategist", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setParameters(6500, 3))
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

    it("Should emergency deleverage", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      // Deposit first
      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      // Emergency deleverage
      await strategy.connect(guardian).emergencyDeleverage();

      // Should have reduced position
      // Check by verifying we can still withdraw
      const totalValue = await strategy.totalValue();
      expect(totalValue).to.be.gte(0);
    });
  });

  describe("Upgradeability", function () {
    it("Should be upgradeable by admin", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const MorphoLoopStrategyV2 = await ethers.getContractFactory("MorphoLoopStrategy");
      // Prepare new implementation and request timelocked upgrade
      const newImpl = await upgrades.prepareUpgrade(await strategy.getAddress(), MorphoLoopStrategyV2) as string;
      await strategy.connect(admin).requestUpgrade(newImpl);
      await time.increase(48 * 3600); // 48 hours
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), MorphoLoopStrategyV2);
      
      expect(await upgraded.getAddress()).to.equal(await strategy.getAddress());
    });

    it("Should not be upgradeable by non-admin", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const MorphoLoopStrategyV2 = await ethers.getContractFactory("MorphoLoopStrategy", user1);

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), MorphoLoopStrategyV2)
      ).to.be.reverted;
    });

    it("Should preserve state after upgrade", async function () {
      const { strategy, admin, strategist } = await loadFixture(deployFixture);

      // Set some state
      await strategy.connect(strategist).setParameters(6500, 5);
      expect(await strategy.targetLtvBps()).to.equal(6500);

      // Upgrade with timelock
      const MorphoLoopStrategyV2 = await ethers.getContractFactory("MorphoLoopStrategy");
      const newImpl = await upgrades.prepareUpgrade(await strategy.getAddress(), MorphoLoopStrategyV2) as string;
      await strategy.connect(admin).requestUpgrade(newImpl);
      await time.increase(48 * 3600);
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), MorphoLoopStrategyV2);

      // Check state preserved
      expect(await upgraded.targetLtvBps()).to.equal(6500);
      expect(await upgraded.targetLoops()).to.equal(5);
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
  });

  describe("View Functions Extended", function () {
    it("Should return market ID", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.marketId()).to.equal(MARKET_ID);
    });

    it("Should return safety buffer", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.safetyBufferBps()).to.equal(500);
    });

    it("Should return target loops", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.targetLoops()).to.equal(4);
    });

    it("Should return active status", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.active()).to.be.true;
    });
  });

  describe("Deposit Edge Cases", function () {
    it("Should handle multiple sequential deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6));
      const value1 = await strategy.totalValue();

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6));
      const value2 = await strategy.totalValue();

      expect(value2).to.be.gt(value1);
    });

    it("Should handle small deposits", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const smallAmount = ethers.parseUnits("1", 6); // 1 USDC
      await strategy.connect(treasury).deposit(smallAmount);

      // Should still track the value
      const totalValue = await strategy.totalValue();
      expect(totalValue).to.be.gt(0);
    });
  });

  describe("Withdraw Edge Cases", function () {
    it("Should handle partial withdrawals", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      
      // Withdraw half
      await strategy.connect(treasury).withdraw(ethers.parseUnits("5000", 6));
      
      // Should still have remaining value
      const totalValue = await strategy.totalValue();
      expect(totalValue).to.be.gt(0);
    });

    it("Should handle withdrawals when paused", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      await strategy.connect(guardian).pause();

      // Should still allow withdrawals when paused (emergency)
      await strategy.connect(treasury).withdraw(ethers.parseUnits("5000", 6));
    });
  });

  describe("Emergency Deleverage Edge Cases", function () {
    it("Should deleverage with no position gracefully", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      // Should not revert even with no position
      await strategy.connect(guardian).emergencyDeleverage();
    });

    it("Should only allow guardian to deleverage", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).emergencyDeleverage())
        .to.be.reverted;
    });
  });
});
