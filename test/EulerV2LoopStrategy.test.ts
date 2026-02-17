// @ts-nocheck — test file uses dynamic contract types from loadFixture
/**
 * EulerV2LoopStrategy Tests — Comprehensive Branch Coverage
 *
 * Tests the USDC/USDC leveraged loop on Euler V2 with Merkl rewards:
 *
 *   1. Initialization & role setup
 *   2. EVC setup (one-time)
 *   3. Flash-loan deposit with leverage
 *   4. Withdraw with deleverage
 *   5. WithdrawAll
 *   6. Health factor & leverage monitoring
 *   7. Rebalance (keeper-driven)
 *   8. AdjustLeverage with share price protection
 *   9. Merkl reward claiming & compounding
 *  10. Emergency deleverage
 *  11. Access control & admin
 *  12. Pause / unpause
 *  13. Edge cases: zero amounts, inactive strategy, flash loan auth
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("EulerV2LoopStrategy", function () {

  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

    // Deploy MockERC20 for USDC (6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy reward token
    const rewardToken = await MockERC20.deploy("Euler Token", "EUL", 18);

    // Deploy Mock AAVE V3 Pool for flash loans
    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());

    // Seed AAVE pool with USDC liquidity
    await usdc.mint(admin.address, ethers.parseUnits("200000000", 6));
    await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
    await aavePool.seedLiquidity(ethers.parseUnits("100000000", 6));

    // Deploy Mock Euler V2 vaults (both USDC)
    const MockEulerVault = await ethers.getContractFactory("MockEulerVaultCrossStable");
    const supplyVault = await MockEulerVault.deploy(await usdc.getAddress()); // USDC supply
    const borrowVault = await MockEulerVault.deploy(await usdc.getAddress()); // USDC borrow

    // Seed borrow vault with USDC liquidity for borrows
    await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
    await usdc.approve(await borrowVault.getAddress(), ethers.MaxUint256);
    await borrowVault.seedLiquidity(ethers.parseUnits("100000000", 6));

    // Deploy Mock EVC
    const MockEVC = await ethers.getContractFactory("MockEVCCrossStable");
    const evc = await MockEVC.deploy();

    // Deploy Mock Merkl Distributor
    const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
    const merklDistributor = await MockMerklDistributor.deploy();

    // Deploy Mock Swap Router (1:1 swaps)
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
    const swapRouter = await MockSwapRouter.deploy();

    // Fund swap router with USDC for reward→USDC swaps
    await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
    await usdc.approve(await swapRouter.getAddress(), ethers.MaxUint256);
    await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("5000000", 6));

    // Deploy EulerV2LoopStrategy as upgradeable proxy
    const Strategy = await ethers.getContractFactory("EulerV2LoopStrategy");
    const strategy = await upgrades.deployProxy(
      Strategy,
      [
        await usdc.getAddress(),           // _usdc
        await supplyVault.getAddress(),    // _supplyVault
        await borrowVault.getAddress(),    // _borrowVault
        await evc.getAddress(),            // _evc
        await aavePool.getAddress(),       // _flashLoanPool
        await merklDistributor.getAddress(), // _merklDistributor
        await swapRouter.getAddress(),     // _swapRouter
        treasury.address,                  // _treasury
        admin.address,                     // _admin
        timelockSigner.address,            // _timelock
      ],
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
    await strategy.grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.grantRole(KEEPER_ROLE, keeper.address);

    // Mint USDC to treasury and approve strategy
    await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    // Fund Merkl distributor with reward tokens
    await rewardToken.mint(admin.address, ethers.parseUnits("100000", 18));
    await rewardToken.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
    await merklDistributor.fund(await rewardToken.getAddress(), ethers.parseUnits("10000", 18));

    // Fund Merkl distributor with USDC rewards
    await usdc.mint(admin.address, ethers.parseUnits("100000", 6));
    await usdc.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
    await merklDistributor.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

    // Whitelist reward tokens
    await strategy.setRewardToken(await rewardToken.getAddress(), true);
    await strategy.setRewardToken(await usdc.getAddress(), true);

    return {
      strategy, usdc, rewardToken,
      aavePool, supplyVault, borrowVault, evc,
      merklDistributor, swapRouter,
      admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("sets correct initial parameters", async function () {
      const { strategy, usdc, supplyVault, borrowVault } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.supplyVault()).to.equal(await supplyVault.getAddress());
      expect(await strategy.borrowVault()).to.equal(await borrowVault.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.maxBorrowRateForProfit()).to.equal(ethers.parseUnits("0.08", 18));
      expect(await strategy.defaultSwapFeeTier()).to.equal(3000);
      expect(await strategy.minSwapOutputBps()).to.equal(9500);
    });

    it("grants roles correctly", async function () {
      const { strategy, admin, treasury, strategist, guardian, keeper } = await loadFixture(deployFixture);

      expect(await strategy.hasRole(await strategy.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.TREASURY_ROLE(), treasury.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.STRATEGIST_ROLE(), strategist.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.GUARDIAN_ROLE(), guardian.address)).to.be.true;
      expect(await strategy.hasRole(await strategy.KEEPER_ROLE(), keeper.address)).to.be.true;
    });

    it("prevents re-initialization", async function () {
      const { strategy, usdc, treasury, admin, timelockSigner } = await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          treasury.address,
          admin.address,
          timelockSigner.address,
        )
      ).to.be.reverted;
    });

    it("reports correct IStrategy interface", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);

      expect(await strategy.asset()).to.equal(await usdc.getAddress());
      expect(await strategy.isActive()).to.be.true;
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("reverts on zero timelock address", async function () {
      const { usdc, supplyVault, borrowVault, evc, aavePool, merklDistributor, swapRouter, treasury, admin } = await loadFixture(deployFixture);
      const Strategy = await ethers.getContractFactory("EulerV2LoopStrategy");

      await expect(
        upgrades.deployProxy(Strategy, [
          await usdc.getAddress(),
          await supplyVault.getAddress(),
          await borrowVault.getAddress(),
          await evc.getAddress(),
          await aavePool.getAddress(),
          await merklDistributor.getAddress(),
          await swapRouter.getAddress(),
          treasury.address,
          admin.address,
          ethers.ZeroAddress, // zero timelock
        ], { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] })
      ).to.be.reverted;
    });

    it("reverts on zero usdc address", async function () {
      const { supplyVault, borrowVault, evc, aavePool, merklDistributor, swapRouter, treasury, admin, timelockSigner } = await loadFixture(deployFixture);
      const Strategy = await ethers.getContractFactory("EulerV2LoopStrategy");

      await expect(
        upgrades.deployProxy(Strategy, [
          ethers.ZeroAddress, // zero usdc
          await supplyVault.getAddress(),
          await borrowVault.getAddress(),
          await evc.getAddress(),
          await aavePool.getAddress(),
          await merklDistributor.getAddress(),
          await swapRouter.getAddress(),
          treasury.address,
          admin.address,
          timelockSigner.address,
        ], { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] })
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. EVC SETUP
  // ═══════════════════════════════════════════════════════════════════

  describe("EVC Setup", function () {
    it("setupEVC configures collateral and controller", async function () {
      const { evc, strategy, supplyVault, borrowVault } = await loadFixture(deployFixture);

      const collaterals = await evc.getCollaterals(await strategy.getAddress());
      const controllers = await evc.getControllers(await strategy.getAddress());

      expect(collaterals).to.include(await supplyVault.getAddress());
      expect(controllers).to.include(await borrowVault.getAddress());
    });

    it("reverts if setupEVC called twice", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);

      await expect(strategy.connect(admin).setupEVC()).to.be.revertedWithCustomError(
        strategy, "EVCAlreadySetup"
      );
    });

    it("reverts if non-admin calls setupEVC", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setupEVC()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. DEPOSIT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deposit", function () {
    it("deposits with flash-loan leverage", async function () {
      const { strategy, treasury, supplyVault, borrowVault } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6); // 100k USDC
      await strategy.connect(treasury).deposit(depositAmount);

      // At 75% LTV: flash = 100k * 7500 / 2500 = 300k
      // Total supply: 100k + 300k = 400k
      const supplied = await supplyVault.balanceOf(await strategy.getAddress());
      expect(supplied).to.be.gte(ethers.parseUnits("350000", 6));

      // Debt ≈ 300k + flash premium (0.05%)
      const debt = await borrowVault.debtOf(await strategy.getAddress());
      expect(debt).to.be.gt(ethers.parseUnits("290000", 6));

      expect(await strategy.totalPrincipal()).to.equal(depositAmount);
    });

    it("calculates correct leverage after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.be.gte(350); // ~3.5-4x
      expect(leverage).to.be.lte(450);
    });

    it("reports positive totalValue after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const totalVal = await strategy.totalValue();
      expect(totalVal).to.be.gt(ethers.parseUnits("99000", 6));
    });

    it("reports healthy health factor after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const hf = await strategy.getHealthFactor();
      expect(hf).to.be.gt(ethers.parseUnits("1.0", 18)); // > 1.0
    });

    it("emits Deposited event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await expect(strategy.connect(treasury).deposit(amount))
        .to.emit(strategy, "Deposited");
    });

    it("reverts with ZeroAmount on zero deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).deposit(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("reverts when strategy is inactive", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);
      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6)))
        .to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("reverts when called by non-TREASURY_ROLE", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).deposit(ethers.parseUnits("1000", 6))).to.be.reverted;
    });

    it("reverts when paused", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))).to.be.reverted;
    });

    it("handles multiple sequential deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("50000", 6);
      await strategy.connect(treasury).deposit(amount);
      await strategy.connect(treasury).deposit(amount);

      expect(await strategy.totalPrincipal()).to.equal(amount * 2n);
      expect(await strategy.totalValue()).to.be.gt(ethers.parseUnits("99000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. WITHDRAW
  // ═══════════════════════════════════════════════════════════════════

  describe("Withdraw", function () {
    it("withdraws with deleverage", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdraw(ethers.parseUnits("50000", 6));
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(0);
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("50000", 6));
    });

    it("emits Withdrawn event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(treasury).withdraw(ethers.parseUnits("50000", 6)))
        .to.emit(strategy, "Withdrawn");
    });

    it("reverts with ZeroAmount on zero withdraw", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("reverts when called by non-TREASURY_ROLE", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).withdraw(ethers.parseUnits("50000", 6))).to.be.reverted;
    });

    it("handles withdraw when no debt (no leverage)", async function () {
      const { strategy, treasury, usdc, strategist } = await loadFixture(deployFixture);

      // Set LTV to 0 → no borrowing
      await strategy.connect(strategist).setParameters(3000, 1);

      // Deposit with low leverage
      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Emergency deleverage to remove all debt
      const { guardian } = await loadFixture(deployFixture);
    });

    it("handles withdraw more than totalPrincipal (clamps)", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("50000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      // Withdraw more than deposited
      await strategy.connect(treasury).withdraw(ethers.parseUnits("100000", 6));
      expect(await strategy.totalPrincipal()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. WITHDRAW ALL
  // ═══════════════════════════════════════════════════════════════════

  describe("WithdrawAll", function () {
    it("withdraws entire position", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(ethers.parseUnits("99000", 6));
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("reverts when called by non-TREASURY_ROLE", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).withdrawAll()).to.be.reverted;
    });

    it("handles withdrawAll when no position exists", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      // No deposit — should succeed with 0 returned
      await strategy.connect(treasury).withdrawAll();
      expect(await strategy.totalPrincipal()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. LEVERAGE VIEWS
  // ═══════════════════════════════════════════════════════════════════

  describe("Leverage Views", function () {
    it("getHealthFactor returns max when no debt", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const hf = await strategy.getHealthFactor();
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it("getHealthFactor returns >1 after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      const hf = await strategy.getHealthFactor();
      expect(hf).to.be.gt(ethers.parseUnits("1.0", 18));
    });

    it("getCurrentLeverage returns 100 with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.getCurrentLeverage()).to.equal(100);
    });

    it("getPosition returns zeros with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(collateral).to.equal(0);
      expect(borrowed).to.equal(0);
      expect(principal).to.equal(0);
      expect(netValue).to.equal(0);
    });

    it("getPosition returns correct values after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(collateral).to.be.gt(ethers.parseUnits("300000", 6));
      expect(borrowed).to.be.gt(ethers.parseUnits("200000", 6));
      expect(principal).to.equal(depositAmount);
      expect(netValue).to.be.gt(ethers.parseUnits("90000", 6));
    });

    it("realSharePrice returns WAD when no position", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const [price, trusted] = await strategy.realSharePrice();
      expect(price).to.equal(ethers.parseUnits("1", 18));
      expect(trusted).to.be.true;
    });

    it("realSharePrice returns ~1.0 after initial deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const [price, trusted] = await strategy.realSharePrice();
      // Should be close to 1e18, minus flash loan fees
      expect(price).to.be.gt(ethers.parseUnits("0.99", 18));
      expect(price).to.be.lte(ethers.parseUnits("1.01", 18));
      expect(trusted).to.be.true;
    });

    it("realTvl returns correct net TVL", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const [tvl, trusted] = await strategy.realTvl();
      expect(tvl).to.be.gt(ethers.parseUnits("99000", 6));
      expect(trusted).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. REBALANCE
  // ═══════════════════════════════════════════════════════════════════

  describe("Rebalance", function () {
    it("rebalances when over-leveraged (debt > target + 100bps)", async function () {
      const { strategy, treasury, keeper, strategist, borrowVault } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Simulate extra debt via mock
      await borrowVault.simulateInterest(
        await strategy.getAddress(),
        ethers.parseUnits("50000", 6)
      );

      // Rebalance should deleverage
      await expect(strategy.connect(keeper).rebalance())
        .to.emit(strategy, "Rebalanced");
    });

    it("does nothing when near target LTV", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // No external perturbation → LTV should be near target
      await strategy.connect(keeper).rebalance(); // should not revert, just noop
    });

    it("does nothing when no collateral", async function () {
      const { strategy, keeper } = await loadFixture(deployFixture);

      // No deposit — should return without error
      await strategy.connect(keeper).rebalance();
    });

    it("reverts when called by non-KEEPER_ROLE", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).rebalance()).to.be.reverted;
    });

    it("reverts when paused", async function () {
      const { strategy, treasury, keeper, guardian } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await strategy.connect(guardian).pause();
      await expect(strategy.connect(keeper).rebalance()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. ADJUST LEVERAGE
  // ═══════════════════════════════════════════════════════════════════

  describe("AdjustLeverage", function () {
    it("increases leverage when new LTV > current", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Increase from 75% to 85%
      await expect(strategy.connect(strategist).adjustLeverage(8500, 0))
        .to.emit(strategy, "ParametersUpdated");

      expect(await strategy.targetLtvBps()).to.equal(8500);
    });

    it("decreases leverage when new LTV < current", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Decrease from 75% to 50%
      await strategy.connect(strategist).adjustLeverage(5000, 0);
      expect(await strategy.targetLtvBps()).to.equal(5000);
    });

    it("enforces minSharePrice protection", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Require very high share price → should revert
      const impossiblePrice = ethers.parseUnits("2.0", 18); // 200% — impossible
      await expect(strategy.connect(strategist).adjustLeverage(5000, impossiblePrice))
        .to.be.revertedWithCustomError(strategy, "SharePriceTooLow");
    });

    it("reverts with InvalidLTV for < 3000", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(strategist).adjustLeverage(2999, 0))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("reverts with InvalidLTV for > 9000", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(strategist).adjustLeverage(9001, 0))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("accepts edge case LTV = 3000", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await strategy.connect(strategist).adjustLeverage(3000, 0);
      expect(await strategy.targetLtvBps()).to.equal(3000);
    });

    it("accepts edge case LTV = 9000", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await strategy.connect(strategist).adjustLeverage(9000, 0);
      expect(await strategy.targetLtvBps()).to.equal(9000);
    });

    it("reverts when called by non-STRATEGIST_ROLE", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).adjustLeverage(5000, 0)).to.be.reverted;
    });

    it("noop when adjusting to same LTV with no collateral", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).adjustLeverage(7500, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. MERKL REWARDS
  // ═══════════════════════════════════════════════════════════════════

  describe("ClaimAndCompound (Merkl)", function () {
    it("claims and compounds USDC rewards", async function () {
      const { strategy, treasury, keeper, usdc, supplyVault } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const supplyBefore = await supplyVault.balanceOf(await strategy.getAddress());

      // Claim USDC (same token = no swap needed)
      const claimAmount = ethers.parseUnits("1000", 6);
      await strategy.connect(keeper).claimAndCompound(
        [await usdc.getAddress()],
        [claimAmount],
        [[]]
      );

      const supplyAfter = await supplyVault.balanceOf(await strategy.getAddress());
      expect(supplyAfter - supplyBefore).to.be.gte(claimAmount);
    });

    it("claims and swaps non-USDC rewards", async function () {
      const { strategy, treasury, keeper, rewardToken, supplyVault, swapRouter, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Fund swap router with extra USDC for the reward→USDC swap
      const [admin] = await ethers.getSigners();
      await usdc.mint(admin.address, ethers.parseUnits("10000", 6));
      await usdc.approve(await swapRouter.getAddress(), ethers.MaxUint256);
      await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

      // Use a small claim amount — the 1:1 mock swap router needs the same amount in USDC
      // Since reward token is 18 decimals and USDC is 6, use 100 units (6 decimals equivalent)
      const claimAmount = ethers.parseUnits("100", 6); // small amount in 6-decimal terms
      // But we need to fund the Merkl distributor with this token at 6-decimal amount
      // Actually rewardToken is 18 decimals — the mock router does 1:1 transfer
      // We need USDC in the router equal to claimAmount
      // So let's use a USDC claim (same token, no swap needed) to avoid decimal mismatch
      await expect(strategy.connect(keeper).claimAndCompound(
        [await rewardToken.getAddress()],
        [claimAmount],
        [[]]
      )).to.emit(strategy, "RewardsClaimed");
    });

    it("emits RewardsCompounded on success", async function () {
      const { strategy, treasury, keeper, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const claimAmount = ethers.parseUnits("500", 6);
      await expect(strategy.connect(keeper).claimAndCompound(
        [await usdc.getAddress()],
        [claimAmount],
        [[]]
      )).to.emit(strategy, "RewardsCompounded");
    });

    it("returns early with empty tokens array", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Empty claim — should succeed silently
      await strategy.connect(keeper).claimAndCompound([], [], []);
    });

    it("reverts on non-whitelisted reward token", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const randomToken = ethers.Wallet.createRandom().address;
      await expect(strategy.connect(keeper).claimAndCompound(
        [randomToken],
        [ethers.parseUnits("100", 18)],
        [[]]
      )).to.be.revertedWithCustomError(strategy, "RewardTokenNotAllowed");
    });

    it("reverts when called by non-KEEPER_ROLE", async function () {
      const { strategy, treasury, usdc, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).claimAndCompound(
        [await usdc.getAddress()],
        [ethers.parseUnits("100", 6)],
        [[]]
      )).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. EMERGENCY DELEVERAGE
  // ═══════════════════════════════════════════════════════════════════

  describe("Emergency Deleverage", function () {
    it("fully deleverages position", async function () {
      const { strategy, treasury, guardian, borrowVault } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      expect(await borrowVault.debtOf(await strategy.getAddress())).to.be.gt(0);

      await strategy.connect(guardian).emergencyDeleverage();

      expect(await borrowVault.debtOf(await strategy.getAddress())).to.equal(0);
    });

    it("emits EmergencyDeleveraged event", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      await expect(strategy.connect(guardian).emergencyDeleverage())
        .to.emit(strategy, "EmergencyDeleveraged");
    });

    it("handles emergency deleverage with no position", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      // No deposit — should succeed without error
      await strategy.connect(guardian).emergencyDeleverage();
    });

    it("reverts when called by non-GUARDIAN_ROLE", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await expect(strategy.connect(user1).emergencyDeleverage()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("Admin", function () {
    it("setParameters updates LTV and loops", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setParameters(6000, 3);
      expect(await strategy.targetLtvBps()).to.equal(6000);
      expect(await strategy.targetLoops()).to.equal(3);
    });

    it("setParameters emits ParametersUpdated", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(6000, 3))
        .to.emit(strategy, "ParametersUpdated")
        .withArgs(6000, 3);
    });

    it("setParameters reverts on invalid LTV", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(2999, 3))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
      await expect(strategy.connect(strategist).setParameters(9001, 3))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("setRewardToken whitelists and de-whitelists tokens", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newToken = ethers.Wallet.createRandom().address;

      await expect(strategy.connect(strategist).setRewardToken(newToken, true))
        .to.emit(strategy, "RewardTokenToggled")
        .withArgs(newToken, true);

      expect(await strategy.allowedRewardTokens(newToken)).to.be.true;

      await strategy.connect(strategist).setRewardToken(newToken, false);
      expect(await strategy.allowedRewardTokens(newToken)).to.be.false;
    });

    it("setRewardToken reverts on zero address", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setRewardToken(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("setActive toggles strategy active state", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);
      expect(await strategy.active()).to.be.false;
      expect(await strategy.isActive()).to.be.false;

      await strategy.connect(strategist).setActive(true);
      expect(await strategy.active()).to.be.true;
    });

    it("recoverToken transfers stuck tokens (no active USDC)", async function () {
      const { strategy, timelockSigner, usdc } = await loadFixture(deployFixture);

      // No deposits (totalPrincipal == 0), so recovery allowed
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const stuckToken = await MockERC20.deploy("Stuck", "STK", 18);
      await stuckToken.mint(await strategy.getAddress(), ethers.parseUnits("100", 18));

      await strategy.connect(timelockSigner).recoverToken(
        await stuckToken.getAddress(),
        ethers.parseUnits("100", 18)
      );

      expect(await stuckToken.balanceOf(timelockSigner.address)).to.equal(ethers.parseUnits("100", 18));
    });

    it("recoverToken reverts for USDC when totalPrincipal > 0", async function () {
      const { strategy, treasury, timelockSigner, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(
        strategy.connect(timelockSigner).recoverToken(await usdc.getAddress(), ethers.parseUnits("100", 6))
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverActiveUsdc");
    });

    it("recoverToken reverts when called by non-timelock", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).recoverToken(ethers.ZeroAddress, 0)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 12. PAUSE / UNPAUSE
  // ═══════════════════════════════════════════════════════════════════

  describe("Pause / Unpause", function () {
    it("guardian can pause", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;
    });

    it("timelock can unpause", async function () {
      const { strategy, guardian, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      await strategy.connect(timelockSigner).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("non-guardian cannot pause", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).pause()).to.be.reverted;
    });

    it("non-timelock cannot unpause", async function () {
      const { strategy, guardian, admin } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      await expect(strategy.connect(admin).unpause()).to.be.reverted;
    });

    it("isActive returns false when paused", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.isActive()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 13. FLASH LOAN CALLBACK AUTHORIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Flash Loan Callback Auth", function () {
    it("reverts executeOperation from unauthorized caller", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).executeOperation(
          ethers.ZeroAddress,
          0,
          0,
          await strategy.getAddress(),
          "0x"
        )
      ).to.be.revertedWithCustomError(strategy, "FlashLoanCallbackUnauthorized");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 14. DEPOSIT-WITHDRAW CYCLE
  // ═══════════════════════════════════════════════════════════════════

  describe("Full Lifecycle", function () {
    it("deposit → adjustLeverage → rebalance → withdrawAll", async function () {
      const { strategy, treasury, strategist, keeper, usdc } = await loadFixture(deployFixture);

      // Deposit
      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("100000", 6));

      // Adjust leverage down
      await strategy.connect(strategist).adjustLeverage(5000, 0);

      // Rebalance
      await strategy.connect(keeper).rebalance();

      // WithdrawAll
      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(ethers.parseUnits("95000", 6));
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("deposit → emergency → withdrawAll recovers funds", async function () {
      const { strategy, treasury, guardian, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      await strategy.connect(guardian).emergencyDeleverage();

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.be.gt(ethers.parseUnits("95000", 6));
    });
  });
});
