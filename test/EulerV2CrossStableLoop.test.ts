// @ts-nocheck — test file uses dynamic contract types from loadFixture
/**
 * EulerV2CrossStableLoopStrategy Tests
 *
 * Comprehensive tests for the cross-stablecoin (RLUSD/USDC) Euler V2 leveraged
 * loop strategy with Merkl rewards, depeg circuit breaker, and MetaVault integration:
 *
 *   1. Initialization & role setup
 *   2. Flash-loan cross-stable deposit (USDC → RLUSD supply, USDC borrow)
 *   3. Flash-loan cross-stable withdraw (repay USDC, withdraw RLUSD → USDC)
 *   4. Health factor & leverage monitoring
 *   5. Depeg circuit breaker
 *   6. Merkl reward claiming & cross-stable compounding
 *   7. Rebalance & adjustLeverage with share price protection
 *   8. Emergency deleverage
 *   9. Access control & admin functions
 *  10. TreasuryV2 integration with updated vault allocations
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("EulerV2CrossStableLoopStrategy", function () {
  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

    // Deploy MockERC20 for USDC (6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MockERC20 for RLUSD (6 decimals for testing simplicity)
    const rlusd = await MockERC20.deploy("Ripple USD", "RLUSD", 6);

    // Deploy reward token
    const rewardToken = await MockERC20.deploy("Euler Token", "EUL", 18);

    // Deploy Mock AAVE V3 Pool for flash loans
    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());

    // Seed AAVE pool with USDC liquidity for flash loans
    await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
    await usdc.connect(admin).approve(await aavePool.getAddress(), ethers.MaxUint256);
    await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

    // Deploy Mock Euler V2 vaults
    const MockEulerVault = await ethers.getContractFactory("MockEulerVaultCrossStable");
    const supplyVault = await MockEulerVault.deploy(await rlusd.getAddress()); // RLUSD supply
    const borrowVault = await MockEulerVault.deploy(await usdc.getAddress()); // USDC borrow

    // Seed borrow vault with USDC liquidity
    await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
    await usdc.connect(admin).approve(await borrowVault.getAddress(), ethers.MaxUint256);
    await borrowVault.seedLiquidity(ethers.parseUnits("50000000", 6));

    // Deploy Mock EVC
    const MockEVC = await ethers.getContractFactory("MockEVCCrossStable");
    const evc = await MockEVC.deploy();

    // Deploy Mock Price Feed ($1.00 = 1e8 at 8 decimals)
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeedCrossStable");
    const priceFeed = await MockPriceFeed.deploy(100000000, 8); // $1.00

    // Deploy Mock Merkl Distributor
    const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
    const merklDistributor = await MockMerklDistributor.deploy();

    // Deploy Mock Swap Router (1:1 swaps)
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
    const swapRouter = await MockSwapRouter.deploy();

    // Fund swap router with both tokens for 1:1 swaps
    await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
    await rlusd.mint(admin.address, ethers.parseUnits("50000000", 6));
    await usdc.connect(admin).approve(await swapRouter.getAddress(), ethers.MaxUint256);
    await rlusd.connect(admin).approve(await swapRouter.getAddress(), ethers.MaxUint256);
    await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("25000000", 6));
    await swapRouter.fund(await rlusd.getAddress(), ethers.parseUnits("25000000", 6));

    // Deploy EulerV2CrossStableLoopStrategy as upgradeable proxy
    const Strategy = await ethers.getContractFactory("EulerV2CrossStableLoopStrategy");
    const initParams = {
      usdc: await usdc.getAddress(),
      rlusd: await rlusd.getAddress(),
      supplyVault: await supplyVault.getAddress(),
      borrowVault: await borrowVault.getAddress(),
      evc: await evc.getAddress(),
      flashLoanPool: await aavePool.getAddress(),
      merklDistributor: await merklDistributor.getAddress(),
      swapRouter: await swapRouter.getAddress(),
      rlusdPriceFeed: await priceFeed.getAddress(),
      treasury: treasury.address,
      admin: admin.address,
      timelock: timelockSigner.address,
    };
    const strategy = await upgrades.deployProxy(
      Strategy,
      [initParams],
      {
        kind: "uups",
        initializer: "initialize",
        unsafeAllow: ["constructor"],
      }
    );

    // Setup EVC
    await strategy.connect(admin).setupEVC();

    // Grant roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    const KEEPER_ROLE = await strategy.KEEPER_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);

    // Mint USDC to treasury and approve strategy
    await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    // Fund Merkl distributor with reward tokens
    await rewardToken.mint(admin.address, ethers.parseUnits("100000", 18));
    await rewardToken.connect(admin).approve(await merklDistributor.getAddress(), ethers.MaxUint256);
    await merklDistributor.fund(await rewardToken.getAddress(), ethers.parseUnits("10000", 18));

    // Fund Merkl distributor with USDC rewards too
    await usdc.mint(admin.address, ethers.parseUnits("100000", 6));
    await usdc.connect(admin).approve(await merklDistributor.getAddress(), ethers.MaxUint256);
    await merklDistributor.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

    // Whitelist reward tokens
    await strategy.connect(admin).setRewardToken(await rewardToken.getAddress(), true);
    await strategy.connect(admin).setRewardToken(await usdc.getAddress(), true);

    return {
      strategy, usdc, rlusd, rewardToken,
      aavePool, supplyVault, borrowVault, evc, priceFeed,
      merklDistributor, swapRouter,
      admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, rlusd, supplyVault, borrowVault } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.rlusd()).to.equal(await rlusd.getAddress());
      expect(await strategy.supplyVault()).to.equal(await supplyVault.getAddress());
      expect(await strategy.borrowVault()).to.equal(await borrowVault.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.stableSwapFeeTier()).to.equal(100);
      expect(await strategy.minSwapOutputBps()).to.equal(9900);
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
      const { strategy, usdc, rlusd, treasury, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize({
          usdc: await usdc.getAddress(),
          rlusd: await rlusd.getAddress(),
          supplyVault: ethers.ZeroAddress,
          borrowVault: ethers.ZeroAddress,
          evc: ethers.ZeroAddress,
          flashLoanPool: ethers.ZeroAddress,
          merklDistributor: ethers.ZeroAddress,
          swapRouter: ethers.ZeroAddress,
          rlusdPriceFeed: ethers.ZeroAddress,
          treasury: treasury.address,
          admin: admin.address,
          timelock: admin.address,
        })
      ).to.be.reverted;
    });

    it("Should report correct IStrategy interface", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);

      expect(await strategy.asset()).to.equal(await usdc.getAddress());
      expect(await strategy.isActive()).to.be.true;
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("Should setup EVC collateral and controller", async function () {
      const { evc, strategy, supplyVault, borrowVault } = await loadFixture(deployFixture);

      const collaterals = await evc.getCollaterals(await strategy.getAddress());
      const controllers = await evc.getControllers(await strategy.getAddress());

      expect(collaterals).to.include(await supplyVault.getAddress());
      expect(controllers).to.include(await borrowVault.getAddress());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. CROSS-STABLE DEPOSIT (USDC → RLUSD supply, USDC borrow)
  // ═══════════════════════════════════════════════════════════════════

  describe("Deposit (Cross-Stable Leverage)", function () {
    it("Should deposit with flash-loan cross-stable leverage", async function () {
      const { strategy, treasury, supplyVault, borrowVault } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6); // 100k USDC
      await strategy.connect(treasury).deposit(depositAmount);

      // At 75% LTV: flash = 100k * 0.75 / 0.25 = 300k
      // Total USDC swapped to RLUSD: 100k + 300k = 400k
      // RLUSD in supply vault ≈ 400k (1:1 swap)
      const suppliedRlusd = await supplyVault.balanceOf(await strategy.getAddress());
      expect(suppliedRlusd).to.be.gt(ethers.parseUnits("350000", 6)); // ~400k

      // Debt ≈ 300k + flash premium
      const debt = await borrowVault.debtOf(await strategy.getAddress());
      expect(debt).to.be.gt(ethers.parseUnits("290000", 6));

      expect(await strategy.totalPrincipal()).to.equal(depositAmount);
    });

    it("Should calculate correct leverage after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const leverage = await strategy.getCurrentLeverage();
      // At 75% LTV: leverage ≈ 4x (400 in leverageX100)
      expect(leverage).to.be.gte(380);
      expect(leverage).to.be.lte(420);
    });

    it("Should report positive totalValue after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const totalVal = await strategy.totalValue();
      // Net value ≈ principal (minus flash loan fees)
      expect(totalVal).to.be.gt(ethers.parseUnits("99000", 6));
      expect(totalVal).to.be.lte(depositAmount);
    });

    it("Should revert deposit when not active", async function () {
      const { strategy, treasury, admin } = await loadFixture(deployFixture);

      await strategy.connect(admin).setActive(false);

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("Should revert deposit when paused", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted; // EnforcedPause
    });

    it("Should revert deposit with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(treasury).deposit(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should revert deposit from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted; // AccessControl
    });

    it("Should handle multiple deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("50000", 6));
      await strategy.connect(treasury).deposit(ethers.parseUnits("30000", 6));

      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("80000", 6));
      expect(await strategy.totalValue()).to.be.gt(ethers.parseUnits("78000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. CROSS-STABLE WITHDRAW (repay USDC, withdraw RLUSD → USDC)
  // ═══════════════════════════════════════════════════════════════════

  describe("Withdraw (Cross-Stable Deleverage)", function () {
    it("Should withdraw with flash-loan deleverage", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdraw(ethers.parseUnits("50000", 6));
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(ethers.parseUnits("48000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("50000", 6));
    });

    it("Should withdrawAll and return full position", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(ethers.parseUnits("98000", 6));
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("Should revert withdraw with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(treasury).withdraw(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should handle withdraw larger than principal", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      await strategy.connect(treasury).withdraw(ethers.parseUnits("20000", 6));

      // Should withdraw up to principal
      expect(await strategy.totalPrincipal()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. HEALTH FACTOR & POSITION MONITORING
  // ═══════════════════════════════════════════════════════════════════

  describe("Health Factor & Position", function () {
    it("Should return max health factor with no debt", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.getHealthFactor()).to.equal(ethers.MaxUint256);
    });

    it("Should return correct health factor after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const hf = await strategy.getHealthFactor();
      // At 75% LTV: HF ≈ collateral / debt ≈ 400k / 300k ≈ 1.33 (1.33e18)
      expect(hf).to.be.gte(ethers.parseEther("1.2"));
      expect(hf).to.be.lte(ethers.parseEther("1.5"));
    });

    it("Should return full position data", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(collateral).to.be.gt(0);
      expect(borrowed).to.be.gt(0);
      expect(principal).to.equal(ethers.parseUnits("100000", 6));
      expect(netValue).to.be.gt(0);
      expect(netValue).to.equal(collateral - borrowed);
    });

    it("Should return correct realSharePrice", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const [price, trusted] = await strategy.realSharePrice();
      // Share price should be near 1.0 (slightly less due to flash fees)
      expect(price).to.be.gte(ethers.parseEther("0.98"));
      expect(price).to.be.lte(ethers.parseEther("1.01"));
      expect(trusted).to.be.true;
    });

    it("Should return correct realTvl", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const [tvl, trusted] = await strategy.realTvl();
      expect(tvl).to.be.gt(ethers.parseUnits("98000", 6));
      expect(trusted).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. DEPEG CIRCUIT BREAKER
  // ═══════════════════════════════════════════════════════════════════

  describe("Depeg Circuit Breaker", function () {
    it("Should allow deposit when RLUSD is within peg", async function () {
      const { strategy, treasury, priceFeed } = await loadFixture(deployFixture);

      await priceFeed.setPrice(100000000); // $1.00
      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("10000", 6));
    });

    it("Should revert deposit when RLUSD depegs below 98c", async function () {
      const { strategy, treasury, priceFeed } = await loadFixture(deployFixture);

      await priceFeed.setPrice(97000000); // $0.97 — 3% depeg
      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6))
      ).to.be.revertedWithCustomError(strategy, "DepegDetected");
    });

    it("Should revert deposit when RLUSD depegs above $1.02", async function () {
      const { strategy, treasury, priceFeed } = await loadFixture(deployFixture);

      await priceFeed.setPrice(103000000); // $1.03 — 3% overpeg
      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6))
      ).to.be.revertedWithCustomError(strategy, "DepegDetected");
    });

    it("Should detect stale price as depeg", async function () {
      const { strategy, priceFeed } = await loadFixture(deployFixture);

      await priceFeed.setStalePrice(100000000); // $1.00 but stale
      expect(await strategy.isWithinPeg()).to.be.false;
    });

    it("Should report untrusted when depegged in realSharePrice", async function () {
      const { strategy, treasury, priceFeed } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      // Depeg after deposit
      await priceFeed.setPrice(95000000); // $0.95

      const [, trusted] = await strategy.realSharePrice();
      expect(trusted).to.be.false;
    });

    it("Should allow at exactly 2% depeg boundary", async function () {
      const { strategy, treasury, priceFeed } = await loadFixture(deployFixture);

      await priceFeed.setPrice(98000000); // $0.98 — exactly 2%
      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("10000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. MERKL REWARDS (claim → swap → compound)
  // ═══════════════════════════════════════════════════════════════════

  describe("Merkl Rewards", function () {
    it("Should claim and compound reward tokens", async function () {
      const { strategy, treasury, keeper, rewardToken, swapRouter, usdc, rlusd, admin } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Fund swap router with USDC for reward→USDC swap
      await usdc.mint(admin.address, ethers.parseUnits("10000", 6));
      await usdc.connect(admin).approve(await swapRouter.getAddress(), ethers.MaxUint256);
      await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

      // Fund swap router with RLUSD for USDC→RLUSD compound swap
      await rlusd.mint(admin.address, ethers.parseUnits("10000", 6));
      await rlusd.connect(admin).approve(await swapRouter.getAddress(), ethers.MaxUint256);
      await swapRouter.fund(await rlusd.getAddress(), ethers.parseUnits("10000", 6));

      // Use a small claim amount so the 1:1 mock swap (raw amount) doesn't exceed
      // the router's USDC balance. 100 units in 6-decimal scale.
      const claimAmount = ethers.parseUnits("100", 6);
      const tokens = [await rewardToken.getAddress()];
      const amounts = [claimAmount];
      const proofs = [[]]; // Mock doesn't validate proofs

      const tvlBefore = await strategy.totalValue();
      await strategy.connect(keeper).claimAndCompound(tokens, amounts, proofs);
      const tvlAfter = await strategy.totalValue();

      expect(await strategy.totalRewardsClaimed()).to.be.gt(0);
      expect(tvlAfter).to.be.gt(tvlBefore);
    });

    it("Should revert claim with non-whitelisted token", async function () {
      const { strategy, keeper } = await loadFixture(deployFixture);

      const tokens = [ethers.Wallet.createRandom().address];
      const amounts = [ethers.parseUnits("100", 18)];
      const proofs = [[]];

      await expect(
        strategy.connect(keeper).claimAndCompound(tokens, amounts, proofs)
      ).to.be.revertedWithCustomError(strategy, "RewardTokenNotAllowed");
    });

    it("Should handle empty claims gracefully", async function () {
      const { strategy, keeper } = await loadFixture(deployFixture);

      await strategy.connect(keeper).claimAndCompound([], [], []);
      expect(await strategy.totalRewardsClaimed()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. REBALANCE & LEVERAGE ADJUSTMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Rebalance & Leverage", function () {
    it("Should rebalance when LTV drifts", async function () {
      const { strategy, treasury, keeper, borrowVault } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Simulate interest accrual (debt grows → LTV increases)
      await borrowVault.simulateInterest(await strategy.getAddress(), ethers.parseUnits("5000", 6));

      // Rebalance should deleverage
      await strategy.connect(keeper).rebalance();
    });

    it("Should adjust leverage with share price protection", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Adjust to lower LTV (deleverage)
      await strategy.connect(strategist).adjustLeverage(5000, 0); // 50% LTV

      expect(await strategy.targetLtvBps()).to.equal(5000);
    });

    it("Should revert adjustLeverage with invalid LTV", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).adjustLeverage(2000, 0) // Too low
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");

      await expect(
        strategy.connect(strategist).adjustLeverage(9500, 0) // Too high
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should revert adjustLeverage when depegged", async function () {
      const { strategy, treasury, strategist, priceFeed } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await priceFeed.setPrice(96000000); // $0.96 — 4% depeg

      await expect(
        strategy.connect(strategist).adjustLeverage(5000, 0)
      ).to.be.revertedWithCustomError(strategy, "DepegDetected");
    });

    it("Should set parameters correctly", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await strategy.connect(admin).setParameters(6000, 3);
      expect(await strategy.targetLtvBps()).to.equal(6000);
      expect(await strategy.targetLoops()).to.equal(3);
    });

    it("Should revert setParameters with invalid LTV", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).setParameters(2000, 4)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. EMERGENCY DELEVERAGE
  // ═══════════════════════════════════════════════════════════════════

  describe("Emergency Deleverage", function () {
    it("Should fully deleverage in emergency", async function () {
      const { strategy, treasury, guardian, borrowVault, supplyVault } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      expect(await borrowVault.debtOf(await strategy.getAddress())).to.be.gt(0);
      expect(await supplyVault.balanceOf(await strategy.getAddress())).to.be.gt(0);

      await strategy.connect(guardian).emergencyDeleverage();

      expect(await borrowVault.debtOf(await strategy.getAddress())).to.equal(0);
      expect(await supplyVault.balanceOf(await strategy.getAddress())).to.equal(0);
    });

    it("Should revert emergency deleverage from non-guardian", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).emergencyDeleverage()
      ).to.be.reverted; // AccessControl
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. ACCESS CONTROL & ADMIN
  // ═══════════════════════════════════════════════════════════════════

  describe("Access Control & Admin", function () {
    it("Should toggle reward tokens", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      const newToken = ethers.Wallet.createRandom().address;
      await strategy.connect(admin).setRewardToken(newToken, true);
      expect(await strategy.allowedRewardTokens(newToken)).to.be.true;

      await strategy.connect(admin).setRewardToken(newToken, false);
      expect(await strategy.allowedRewardTokens(newToken)).to.be.false;
    });

    it("Should revert setRewardToken with zero address", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).setRewardToken(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("Should set swap fees", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await strategy.connect(admin).setSwapFees(500, 10000);
      expect(await strategy.stableSwapFeeTier()).to.equal(500);
      expect(await strategy.rewardSwapFeeTier()).to.equal(10000);
    });

    it("Should set min swap output", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await strategy.connect(admin).setMinSwapOutput(9500);
      expect(await strategy.minSwapOutputBps()).to.equal(9500);
    });

    it("Should revert setMinSwapOutput with invalid value", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(admin).setMinSwapOutput(8000)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should activate/deactivate strategy", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await strategy.connect(admin).setActive(false);
      expect(await strategy.isActive()).to.be.false;

      await strategy.connect(admin).setActive(true);
      expect(await strategy.isActive()).to.be.true;
    });

    it("Should pause and unpause (timelock)", async function () {
      const { strategy, guardian, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;

      await strategy.connect(timelockSigner).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("Should recover tokens via timelock", async function () {
      const { strategy, timelockSigner, rewardToken } = await loadFixture(deployFixture);

      // Send reward tokens to strategy
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);
      await randomToken.mint(await strategy.getAddress(), ethers.parseUnits("1000", 18));

      await strategy.connect(timelockSigner).recoverToken(
        await randomToken.getAddress(),
        ethers.parseUnits("1000", 18)
      );
    });

    it("Should revert recoverToken for USDC with active principal", async function () {
      const { strategy, treasury, timelockSigner, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(
        strategy.connect(timelockSigner).recoverToken(await usdc.getAddress(), 1)
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverActiveUsdc");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. TREASURYV2 INTEGRATION — UPDATED VAULT ALLOCATIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("TreasuryV2 Integration (Updated Allocations)", function () {
    async function deployTreasuryFixture() {
      const base = await deployFixture();
      const { admin, timelockSigner, usdc, strategy } = base;

      // Deploy additional mock strategies for the full MetaVault allocation
      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const pendleStrategy = await MockStrategy.deploy(await usdc.getAddress(), admin.address);
      const morphoStrategy = await MockStrategy.deploy(await usdc.getAddress(), admin.address);
      const skyStrategy = await MockStrategy.deploy(await usdc.getAddress(), admin.address);

      // Deploy TreasuryV2
      const TreasuryV2 = await ethers.getContractFactory("TreasuryV2");
      const treasury2 = await upgrades.deployProxy(
        TreasuryV2,
        [
          await usdc.getAddress(),
          admin.address, // vault placeholder
          admin.address,
          admin.address, // fee recipient
          timelockSigner.address,
        ],
        {
          kind: "uups",
          initializer: "initialize",
          unsafeAllow: ["constructor"],
        }
      );

      // Grant TREASURY_ROLE on cross-stable strategy to TreasuryV2
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();
      await strategy.connect(admin).grantRole(TREASURY_ROLE, await treasury2.getAddress());

      // Add strategies with new allocations:
      //   Pendle:        30% (was 40%)
      //   Morpho:        20% (was 30%)
      //   Euler Cross:   25% (NEW — RLUSD/USDC loop)
      //   Sky sUSDS:     15% (was 20%)
      //   Reserve:       10% (unchanged)
      const STRATEGIST_ROLE = await treasury2.STRATEGIST_ROLE();
      await treasury2.connect(admin).addStrategy(
        await pendleStrategy.getAddress(), 3000, 1000, 5000, true
      );
      await treasury2.connect(admin).addStrategy(
        await morphoStrategy.getAddress(), 2000, 500, 4000, true
      );
      await treasury2.connect(admin).addStrategy(
        await strategy.getAddress(), 2500, 500, 4000, true
      );
      await treasury2.connect(admin).addStrategy(
        await skyStrategy.getAddress(), 1500, 500, 3000, true
      );

      // Mint USDC to admin and approve treasury
      await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
      await usdc.connect(admin).approve(await treasury2.getAddress(), ethers.MaxUint256);

      return {
        ...base,
        treasury2, pendleStrategy, morphoStrategy, skyStrategy,
      };
    }

    it("Should add EulerV2CrossStable as a strategy in TreasuryV2", async function () {
      const { treasury2, strategy } = await loadFixture(deployTreasuryFixture);

      expect(await treasury2.isStrategy(await strategy.getAddress())).to.be.true;
      expect(await treasury2.strategyCount()).to.equal(4);
    });

    it("Should auto-allocate deposits with new proportions", async function () {
      const { treasury2, admin, strategy, pendleStrategy, morphoStrategy, skyStrategy } = await loadFixture(deployTreasuryFixture);

      const VAULT_ROLE = await treasury2.VAULT_ROLE();
      await treasury2.connect(admin).grantRole(VAULT_ROLE, admin.address);

      // Deposit 1M USDC via vault interface
      const amount = ethers.parseUnits("1000000", 6);
      await treasury2.connect(admin).depositFromVault(amount);

      // Check allocations:
      //   Reserve: 10% = 100k
      //   Pendle:  30% of 900k = 270k
      //   Morpho:  20% of 900k = 180k
      //   Euler:   25% of 900k = 225k
      //   Sky:     15% of 900k = 135k
      const eulerVal = await strategy.totalValue();
      expect(eulerVal).to.be.gt(ethers.parseUnits("200000", 6));

      const pendleVal = await pendleStrategy.totalValue();
      expect(pendleVal).to.be.gt(ethers.parseUnits("240000", 6));

      const morphoVal = await morphoStrategy.totalValue();
      expect(morphoVal).to.be.gt(ethers.parseUnits("160000", 6));

      const skyVal = await skyStrategy.totalValue();
      expect(skyVal).to.be.gt(ethers.parseUnits("120000", 6));
    });

    it("Should report correct total value with new strategy mix", async function () {
      const { treasury2, admin } = await loadFixture(deployTreasuryFixture);

      const VAULT_ROLE = await treasury2.VAULT_ROLE();
      await treasury2.connect(admin).grantRole(VAULT_ROLE, admin.address);

      const amount = ethers.parseUnits("1000000", 6);
      await treasury2.connect(admin).depositFromVault(amount);

      // Total value should be near deposit amount (minus flash loan fees on Euler strategy)
      const totalVal = await treasury2.totalValue();
      expect(totalVal).to.be.gt(ethers.parseUnits("990000", 6));
      expect(totalVal).to.be.lte(amount);
    });

    it("Should withdraw proportionally across all strategies", async function () {
      const { treasury2, admin, usdc } = await loadFixture(deployTreasuryFixture);

      const VAULT_ROLE = await treasury2.VAULT_ROLE();
      await treasury2.connect(admin).grantRole(VAULT_ROLE, admin.address);

      await treasury2.connect(admin).depositFromVault(ethers.parseUnits("1000000", 6));

      const balBefore = await usdc.balanceOf(admin.address);
      await treasury2.connect(admin).withdrawToVault(ethers.parseUnits("500000", 6));
      const balAfter = await usdc.balanceOf(admin.address);

      expect(balAfter - balBefore).to.be.gte(ethers.parseUnits("490000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. YIELD CALCULATION SUMMARY
  // ═══════════════════════════════════════════════════════════════════

  describe("Yield Estimate Validation", function () {
    it("Should show expected leverage mechanics at 75% LTV", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const deposit = ethers.parseUnits("1000000", 6); // 1M USDC
      await strategy.connect(treasury).deposit(deposit);

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();

      // At 75% LTV:
      // Flash = 1M * 3 = 3M → Total = 4M RLUSD supplied, 3M USDC borrowed
      // Net = 4M - 3M ≈ 1M (minus flash fees)
      expect(collateral).to.be.gt(ethers.parseUnits("3500000", 6)); // ~4M
      expect(borrowed).to.be.gt(ethers.parseUnits("2800000", 6));   // ~3M
      expect(principal).to.equal(deposit);
      expect(netValue).to.be.gt(ethers.parseUnits("900000", 6));    // ~1M

      // Leverage ≈ 4x
      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.be.gte(380);
      expect(leverage).to.be.lte(420);

      // With Euler V2 RLUSD supply ~12% leveraged - USDC borrow ~8% leveraged
      // + Merkl rewards ~2-3% → Net APY estimate: 8-12%
      // (This is a structural test, not a time-based yield simulation)
    });
  });
});
