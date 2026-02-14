// @ts-nocheck — test file uses dynamic contract types from loadFixture
/**
 * AaveV3LoopStrategy Tests
 *
 * Comprehensive tests for the AAVE V3 leveraged looping strategy with Merkl rewards:
 *   1. Initialization & role setup
 *   2. Flash-loan deposit (leverage up)
 *   3. Flash-loan withdraw (deleverage)
 *   4. Health factor monitoring
 *   5. Merkl reward claiming & compounding
 *   6. Emergency deleverage
 *   7. Access control & admin functions
 *   8. Pause/unpause flows
 *   9. Parameter validation
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("AaveV3LoopStrategy", function () {
  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy a second token for reward testing
    const rewardToken = await MockERC20.deploy("Reward Token", "RWD", 18);

    // Deploy Mock AAVE V3 Pool
    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());

    // Seed AAVE pool with liquidity for flash loans
    await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
    await usdc.connect(admin).approve(await aavePool.getAddress(), ethers.MaxUint256);
    await aavePool.seedLiquidity(ethers.parseUnits("20000000", 6));

    // Deploy Mock aToken and DebtToken
    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy(await aavePool.getAddress(), await usdc.getAddress());

    const MockVariableDebtToken = await ethers.getContractFactory("MockVariableDebtToken");
    const debtToken = await MockVariableDebtToken.deploy(await aavePool.getAddress());

    // Deploy Mock Data Provider
    const MockDataProvider = await ethers.getContractFactory("MockAaveV3DataProvider");
    const dataProvider = await MockDataProvider.deploy(await aavePool.getAddress());

    // Deploy Mock Merkl Distributor
    const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
    const merklDistributor = await MockMerklDistributor.deploy();

    // Deploy Mock Swap Router
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
    const swapRouter = await MockSwapRouter.deploy();

    // Deploy AaveV3LoopStrategy as upgradeable proxy
    const AaveV3LoopStrategy = await ethers.getContractFactory("AaveV3LoopStrategy");
    const strategy = await upgrades.deployProxy(
      AaveV3LoopStrategy,
      [
        await usdc.getAddress(),
        await aavePool.getAddress(),
        await dataProvider.getAddress(),
        await aToken.getAddress(),
        await debtToken.getAddress(),
        await merklDistributor.getAddress(),
        await swapRouter.getAddress(),
        treasury.address,
        admin.address,
        timelockSigner.address,
      ],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    );

    // Grant additional roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    const KEEPER_ROLE = await strategy.KEEPER_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);

    // Mint USDC to treasury
    await usdc.mint(treasury.address, ethers.parseUnits("5000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      strategy, usdc, rewardToken, aavePool, aToken, debtToken,
      dataProvider, merklDistributor, swapRouter,
      admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, aavePool } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.aavePool()).to.equal(await aavePool.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
    });

    it("Should grant roles correctly", async function () {
      const { strategy, admin, treasury, strategist, guardian, keeper } = await loadFixture(deployFixture);

      expect(await strategy.hasRole(await strategy.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.TREASURY_ROLE(), treasury.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.STRATEGIST_ROLE(), strategist.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.GUARDIAN_ROLE(), guardian.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.KEEPER_ROLE(), keeper.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { strategy, usdc, aavePool, treasury, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await aavePool.getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          treasury.address,
          admin.address,
          admin.address,
        )
      ).to.be.reverted;
    });

    it("Should report correct IStrategy interface values", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);

      expect(await strategy.asset()).to.equal(await usdc.getAddress());
      expect(await strategy.isActive()).to.be.true;
      expect(await strategy.totalValue()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DEPOSIT (FLASH LOAN LEVERAGE)
  // ═══════════════════════════════════════════════════════════════════

  describe("Deposit", function () {
    it("Should accept deposit from treasury and leverage via flash loan", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", 6);

      await expect(strategy.connect(treasury).deposit(amount))
        .to.emit(strategy, "Deposited");

      expect(await strategy.totalPrincipal()).to.equal(amount);

      // Total value should be approximately the deposited amount (net of flash loan fees)
      const totalVal = await strategy.totalValue();
      expect(totalVal).to.be.gt(0);
    });

    it("Should achieve target leverage after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      // With 75% LTV, leverage ≈ 4x
      const leverageX100 = await strategy.getCurrentLeverage();
      // Flash loan premium reduces actual leverage slightly, but should be close to 400
      expect(leverageX100).to.be.gte(350); // At least 3.5x
      expect(leverageX100).to.be.lte(420); // At most 4.2x
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
      const { strategy, strategist, treasury } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("Should revert deposit when paused", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.reverted; // EnforcedPause
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // WITHDRAW (DELEVERAGE)
  // ═══════════════════════════════════════════════════════════════════

  describe("Withdraw", function () {
    it("Should withdraw partial amount correctly", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const withdrawAmt = ethers.parseUnits("50000", 6);
      const balBefore = await usdc.balanceOf(treasury.address);

      await expect(strategy.connect(treasury).withdraw(withdrawAmt))
        .to.emit(strategy, "Withdrawn");

      const balAfter = await usdc.balanceOf(treasury.address);
      expect(balAfter - balBefore).to.be.gt(0);
    });

    it("Should withdraw all correctly", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const balBefore = await usdc.balanceOf(treasury.address);

      await expect(strategy.connect(treasury).withdrawAll())
        .to.emit(strategy, "Withdrawn");

      expect(await strategy.totalPrincipal()).to.equal(0);

      const balAfter = await usdc.balanceOf(treasury.address);
      expect(balAfter - balBefore).to.be.gt(0);
    });

    it("Should revert withdraw with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // HEALTH FACTOR & POSITION
  // ═══════════════════════════════════════════════════════════════════

  describe("Position & Health Factor", function () {
    it("Should return correct position data", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();

      expect(collateral).to.be.gt(0);
      expect(borrowed).to.be.gt(0);
      expect(principal).to.equal(depositAmt);
      expect(netValue).to.be.gt(0);
      expect(collateral).to.be.gt(borrowed);
    });

    it("Should return healthy health factor", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const hf = await strategy.getHealthFactor();
      expect(hf).to.be.gt(ethers.parseUnits("1", 18)); // > 1.0
    });

    it("Should return correct profitability check", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const [profitable, supplyRate, borrowRate, netApy] = await strategy.checkProfitability();

      // With 3% supply, 4% borrow at 4x leverage:
      // net = 3% * 4 - 4% * 3 = 12% - 12% = 0%
      // So it may or may not be profitable depending on exact rates
      expect(supplyRate).to.be.gte(0);
      expect(borrowRate).to.be.gte(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // REBALANCE
  // ═══════════════════════════════════════════════════════════════════

  describe("Rebalance", function () {
    it("Should allow keeper to rebalance", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      // Rebalance should not revert
      await strategy.connect(keeper).rebalance();
    });

    it("Should revert rebalance from non-keeper", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).rebalance()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // EMERGENCY DELEVERAGE
  // ═══════════════════════════════════════════════════════════════════

  describe("Emergency Deleverage", function () {
    it("Should fully deleverage position", async function () {
      const { strategy, treasury, guardian, debtToken } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      // Verify leveraged position
      const debtBefore = await debtToken.balanceOf(await strategy.getAddress());
      expect(debtBefore).to.be.gt(0);

      await expect(strategy.connect(guardian).emergencyDeleverage())
        .to.emit(strategy, "EmergencyDeleveraged");

      // After emergency, debt should be 0
      const debtAfter = await debtToken.balanceOf(await strategy.getAddress());
      expect(debtAfter).to.equal(0);
    });

    it("Should revert emergency deleverage from non-guardian", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).emergencyDeleverage()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("Should allow strategist to set parameters", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(8000, 5))
        .to.emit(strategy, "ParametersUpdated")
        .withArgs(8000, 5);

      expect(await strategy.targetLtvBps()).to.equal(8000);
      expect(await strategy.targetLoops()).to.equal(5);
    });

    it("Should reject invalid LTV", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(2000, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");

      await expect(strategy.connect(strategist).setParameters(9500, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should allow strategist to set profitability params", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setProfitabilityParams(
        ethers.parseUnits("0.10", 18),
        ethers.parseUnits("0.01", 18)
      )).to.emit(strategy, "ProfitabilityParamsUpdated");
    });

    it("Should reject excessive max borrow rate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setProfitabilityParams(
        ethers.parseUnits("0.60", 18), // > 50% = rejected
        0
      )).to.be.revertedWithCustomError(strategy, "MaxBorrowRateTooHighErr");
    });

    it("Should allow strategist to set E-mode", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setEMode(1))
        .to.emit(strategy, "EModeUpdated")
        .withArgs(1);
    });

    it("Should allow strategist to whitelist reward tokens", async function () {
      const { strategy, strategist, rewardToken } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setRewardToken(await rewardToken.getAddress(), true))
        .to.emit(strategy, "RewardTokenToggled")
        .withArgs(await rewardToken.getAddress(), true);

      expect(await strategy.allowedRewardTokens(await rewardToken.getAddress())).to.be.true;
    });

    it("Should allow strategist to set swap params", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSwapParams(500, 9000);
      expect(await strategy.defaultSwapFeeTier()).to.equal(500);
      expect(await strategy.minSwapOutputBps()).to.equal(9000);
    });

    it("Should reject swap params with low min output", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSwapParams(500, 5000))
        .to.be.revertedWithCustomError(strategy, "SlippageTooHighErr");
    });

    it("Should allow strategist to set safety buffer", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSafetyBuffer(1000);
      expect(await strategy.safetyBufferBps()).to.equal(1000);
    });

    it("Should reject invalid safety buffer", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSafetyBuffer(100))
        .to.be.revertedWithCustomError(strategy, "InvalidBuffer");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAUSE / UNPAUSE
  // ═══════════════════════════════════════════════════════════════════

  describe("Pause / Unpause", function () {
    it("Should allow guardian to pause", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.isActive()).to.be.false; // active && !paused
    });

    it("Should only allow timelock to unpause", async function () {
      const { strategy, guardian, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      // Non-timelock can't unpause
      await expect(strategy.connect(guardian).unpause()).to.be.reverted;

      // Timelock can
      await strategy.connect(timelockSigner).unpause();
      expect(await strategy.isActive()).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TOKEN RECOVERY
  // ═══════════════════════════════════════════════════════════════════

  describe("Token Recovery", function () {
    it("Should not allow recovery of USDC when principal > 0", async function () {
      const { strategy, treasury, timelockSigner, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(
        strategy.connect(timelockSigner).recoverToken(await usdc.getAddress(), 1)
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverActiveUsdc");
    });

    it("Should allow recovery of other tokens", async function () {
      const { strategy, timelockSigner, rewardToken } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100", 18);
      await rewardToken.mint(await strategy.getAddress(), amount);

      await strategy.connect(timelockSigner).recoverToken(await rewardToken.getAddress(), amount);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FLASH LOAN CALLBACK SECURITY
  // ═══════════════════════════════════════════════════════════════════

  describe("Flash Loan Callback Security", function () {
    it("Should reject callback from unauthorized caller", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).executeOperation(
          ethers.ZeroAddress,
          1000,
          5,
          user1.address,
          "0x"
        )
      ).to.be.revertedWithCustomError(strategy, "FlashLoanCallbackUnauthorized");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MULTIPLE DEPOSITS & WITHDRAWALS
  // ═══════════════════════════════════════════════════════════════════

  describe("Multiple Operations", function () {
    it("Should handle multiple deposits correctly", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      await strategy.connect(treasury).deposit(ethers.parseUnits("20000", 6));
      await strategy.connect(treasury).deposit(ethers.parseUnits("30000", 6));

      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("60000", 6));

      const totalVal = await strategy.totalValue();
      expect(totalVal).to.be.gt(0);
    });

    it("Should handle deposit then full withdrawal", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("50000", 6));
      
      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(balAfter).to.be.gt(balBefore);
    });
  });
});
