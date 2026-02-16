import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * AaveV3LoopStrategy — Comprehensive Test Suite
 *
 * Tests for the UUPS-upgradeable Aave V3 leverage-loop strategy.
 * Uses MockAaveV3Pool (flash loan, supply, borrow, repay, withdraw)
 * and MockAaveV3DataProvider for deterministic rate data.
 *
 * Strategy overview:
 *   1. Deposits USDC into Aave V3 as collateral
 *   2. Flash loan → supply → borrow → repay flash (single tx leverage)
 *   3. Net APY = (supply rate × leverage) − (borrow rate × (leverage−1))
 */
describe("AaveV3LoopStrategy", function () {
  // ──────────────────────────────────────────────────────────────────────
  // CONSTANTS
  // ──────────────────────────────────────────────────────────────────────

  const USDC_DECIMALS = 6;
  const parseUSDC = (n: string) => ethers.parseUnits(n, USDC_DECIMALS);

  const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
  const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

  // ──────────────────────────────────────────────────────────────────────
  // FIXTURE
  // ──────────────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [owner, admin, treasury, keeper, guardian, user, timelock] =
      await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MockAaveV3Pool + MockAToken + MockVariableDebtToken
    const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
    const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());

    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy(await aavePool.getAddress(), await usdc.getAddress());

    const MockDebtToken = await ethers.getContractFactory("MockVariableDebtToken");
    const debtToken = await MockDebtToken.deploy(await aavePool.getAddress());

    // Deploy MockAaveV3DataProvider
    const MockDataProvider = await ethers.getContractFactory("MockAaveV3DataProvider");
    const dataProvider = await MockDataProvider.deploy(await aavePool.getAddress());

    // Deploy mock Merkl Distributor (from MockAaveV3Pool.sol)
    const MockMerkl = await ethers.getContractFactory("contracts/mocks/MockAaveV3Pool.sol:MockMerklDistributor");
    const merklDistributor = await MockMerkl.deploy();

    // Deploy mock Swap Router (from MockAaveV3Pool.sol — 1:1 swap, no constructor args)
    const MockSwapRouterLoop = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
    const swapRouter = await MockSwapRouterLoop.deploy();

    // Deploy strategy via UUPS proxy
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
        timelock.address,
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    );
    await strategy.waitForDeployment();

    // Seed Aave pool with USDC liquidity for flash loans and borrows
    const poolLiquidity = parseUSDC("10000000"); // 10M
    await usdc.mint(owner.address, poolLiquidity);
    await usdc.connect(owner).approve(await aavePool.getAddress(), poolLiquidity);
    await aavePool.connect(owner).seedLiquidity(poolLiquidity);

    // Mint USDC to treasury for deposits
    const treasuryFunds = parseUSDC("1000000"); // 1M
    await usdc.mint(treasury.address, treasuryFunds);
    await usdc.connect(treasury).approve(await strategy.getAddress(), treasuryFunds);

    // Grant KEEPER_ROLE and GUARDIAN_ROLE
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    return {
      owner, admin, treasury, keeper, guardian, user, timelock,
      usdc, aavePool, aToken, debtToken, dataProvider,
      merklDistributor, swapRouter, strategy,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // DEPLOYMENT & INITIALIZATION
  // ──────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("should deploy with correct initial parameters", async function () {
      const { strategy, usdc, aavePool } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.aavePool()).to.equal(await aavePool.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("should assign correct roles", async function () {
      const { strategy, admin, treasury, keeper, guardian } =
        await loadFixture(deployFixture);

      expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
      expect(await strategy.hasRole(STRATEGIST_ROLE, admin.address)).to.be.true;
      expect(await strategy.hasRole(KEEPER_ROLE, keeper.address)).to.be.true;
      expect(await strategy.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should revert if initialized with zero timelock", async function () {
      const { usdc, aavePool, dataProvider, aToken, debtToken, merklDistributor, swapRouter, admin, treasury } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("AaveV3LoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          await usdc.getAddress(), await aavePool.getAddress(),
          await dataProvider.getAddress(), await aToken.getAddress(),
          await debtToken.getAddress(), await merklDistributor.getAddress(),
          await swapRouter.getAddress(), treasury.address,
          admin.address, ethers.ZeroAddress,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("should revert if initialized with zero USDC address", async function () {
      const { aavePool, dataProvider, aToken, debtToken, merklDistributor, swapRouter, admin, treasury, timelock } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("AaveV3LoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          ethers.ZeroAddress, await aavePool.getAddress(),
          await dataProvider.getAddress(), await aToken.getAddress(),
          await debtToken.getAddress(), await merklDistributor.getAddress(),
          await swapRouter.getAddress(), treasury.address,
          admin.address, timelock.address,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("should report asset() as USDC", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);
      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });

    it("should report isActive() as true initially", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.isActive()).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // DEPOSIT
  // ──────────────────────────────────────────────────────────────────────

  describe("Deposit", function () {
    it("should accept USDC deposit and leverage via flash loan", async function () {
      const { strategy, treasury, aToken, debtToken } =
        await loadFixture(deployFixture);

      const depositAmount = parseUSDC("10000");
      await strategy.connect(treasury).deposit(depositAmount);

      expect(await strategy.totalPrincipal()).to.equal(depositAmount);
      // aToken balance should be > deposit (leveraged supply)
      const aTokenBal = await aToken.balanceOf(await strategy.getAddress());
      expect(aTokenBal).to.be.gt(depositAmount);
      // Should have debt
      const debtBal = await debtToken.balanceOf(await strategy.getAddress());
      expect(debtBal).to.be.gt(0);
    });

    it("should emit Deposited event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(parseUSDC("5000")))
        .to.emit(strategy, "Deposited");
    });

    it("should revert deposit of zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(treasury).deposit(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should revert deposit when strategy is inactive", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);
      await strategy.connect(admin).setActive(false);
      await expect(
        strategy.connect(treasury).deposit(parseUSDC("1000"))
      ).to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("should revert deposit when paused", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      await expect(
        strategy.connect(treasury).deposit(parseUSDC("1000"))
      ).to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });

    it("should revert deposit from non-treasury", async function () {
      const { strategy, user, usdc } = await loadFixture(deployFixture);
      await usdc.mint(user.address, parseUSDC("1000"));
      await usdc.connect(user).approve(await strategy.getAddress(), parseUSDC("1000"));
      await expect(
        strategy.connect(user).deposit(parseUSDC("1000"))
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should track totalPrincipal across multiple deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("5000"));
      await strategy.connect(treasury).deposit(parseUSDC("3000"));
      expect(await strategy.totalPrincipal()).to.equal(parseUSDC("8000"));
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // WITHDRAW
  // ──────────────────────────────────────────────────────────────────────

  describe("Withdraw", function () {
    it("should withdraw USDC by deleveraging via flash loan", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdraw(parseUSDC("5000"));
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await strategy.totalPrincipal()).to.equal(parseUSDC("5000"));
    });

    it("should emit Withdrawn event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(strategy.connect(treasury).withdraw(parseUSDC("5000")))
        .to.emit(strategy, "Withdrawn");
    });

    it("should revert withdraw of zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(
        strategy.connect(treasury).withdraw(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should revert withdraw from non-treasury", async function () {
      const { strategy, treasury, user } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(
        strategy.connect(user).withdraw(parseUSDC("5000"))
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // WITHDRAW ALL
  // ──────────────────────────────────────────────────────────────────────

  describe("WithdrawAll", function () {
    it("should unwind entire position and return all USDC", async function () {
      const { strategy, treasury, usdc, debtToken } =
        await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await debtToken.balanceOf(await strategy.getAddress())).to.equal(0);
    });

    it("should revert withdrawAll from non-treasury", async function () {
      const { strategy, treasury, user } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(
        strategy.connect(user).withdrawAll()
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // VIEW FUNCTIONS
  // ──────────────────────────────────────────────────────────────────────

  describe("View Functions", function () {
    it("should report correct totalValue (collateral − debt)", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const tv = await strategy.totalValue();
      // Net of flash loan fees, close to deposit principal
      expect(tv).to.be.gt(parseUSDC("9000"));
      expect(tv).to.be.lte(parseUSDC("10000"));
    });

    it("should report totalValue = 0 when empty", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.totalValue()).to.equal(0);
    });

    it("should report correct leverage ratio after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const leverage = await strategy.getCurrentLeverage();
      // 75% LTV → ~4x leverage → getCurrentLeverage ≈ 400
      expect(leverage).to.be.gte(350);
      expect(leverage).to.be.lte(420);
    });

    it("should report getPosition with correct values", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(principal).to.equal(parseUSDC("10000"));
      expect(collateral).to.be.gt(parseUSDC("30000")); // Leveraged
      expect(borrowed).to.be.gt(0);
      expect(netValue).to.equal(collateral - borrowed);
    });

    it("should report health factor from Aave", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const hf = await strategy.getHealthFactor();
      // Health factor should be > 1e18 (healthy)
      expect(hf).to.be.gt(ethers.parseEther("1"));
    });

    it("should report realSharePrice ≈ 1.0 after fresh deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const [priceWad, trusted] = await strategy.realSharePrice();
      expect(trusted).to.be.true;
      expect(priceWad).to.be.gte(ethers.parseEther("0.95"));
      expect(priceWad).to.be.lte(ethers.parseEther("1.05"));
    });

    it("should report realTvl net of debt", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const [tvl, trusted] = await strategy.realTvl();
      expect(trusted).to.be.true;
      expect(tvl).to.be.gt(parseUSDC("9000"));
      expect(tvl).to.be.lte(parseUSDC("10000"));
    });

    it("should report checkProfitability data", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const [profitable, supplyRate, borrowRate, netApy] = await strategy.checkProfitability();
      expect(supplyRate).to.be.gte(0);
      expect(borrowRate).to.be.gte(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // REBALANCE
  // ──────────────────────────────────────────────────────────────────────

  describe("Rebalance", function () {
    it("should rebalance position to target LTV", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(strategy.connect(keeper).rebalance()).to.not.be.reverted;
    });

    it("should revert rebalance from non-keeper", async function () {
      const { strategy, treasury, user } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(
        strategy.connect(user).rebalance()
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should revert rebalance when paused", async function () {
      const { strategy, treasury, keeper, guardian } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await strategy.connect(guardian).pause();
      await expect(
        strategy.connect(keeper).rebalance()
      ).to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ADJUST LEVERAGE
  // ──────────────────────────────────────────────────────────────────────

  describe("Adjust Leverage", function () {
    it("should adjust leverage to a new target LTV", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await strategy.connect(admin).adjustLeverage(5000, 0);
      expect(await strategy.targetLtvBps()).to.equal(5000);
    });

    it("should revert if LTV < 3000", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).adjustLeverage(2000, 0)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("should revert if LTV > 9000", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).adjustLeverage(9500, 0)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("should revert adjustLeverage from non-strategist", async function () {
      const { strategy, user } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(user).adjustLeverage(5000, 0)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // ACCESS CONTROL
  // ──────────────────────────────────────────────────────────────────────

  describe("Access Control", function () {
    it("should only allow STRATEGIST_ROLE to setParameters", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setParameters(5000, 3)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setParameters(5000, 3)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should validate setParameters LTV bounds", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setParameters(2000, 4)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
      await expect(
        strategy.connect(admin).setParameters(9500, 4)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("should validate setParameters loops bounds", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setParameters(7500, 0)
      ).to.be.revertedWithCustomError(strategy, "InvalidMaxLoopsParam");
      await expect(
        strategy.connect(admin).setParameters(7500, 21)
      ).to.be.revertedWithCustomError(strategy, "InvalidMaxLoopsParam");
    });

    it("should only allow GUARDIAN_ROLE to pause", async function () {
      const { strategy, guardian, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(guardian).pause()).to.not.be.reverted;
      await expect(
        strategy.connect(user).pause()
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should only allow timelock to unpause", async function () {
      const { strategy, guardian, timelock, admin } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      await expect(strategy.connect(admin).unpause()).to.be.reverted;
      await expect(strategy.connect(timelock).unpause()).to.not.be.reverted;
    });

    it("should only allow STRATEGIST_ROLE to setSafetyBuffer", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setSafetyBuffer(300)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setSafetyBuffer(300)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should validate safety buffer bounds", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setSafetyBuffer(100)
      ).to.be.revertedWithCustomError(strategy, "InvalidBuffer");
      await expect(
        strategy.connect(admin).setSafetyBuffer(3000)
      ).to.be.revertedWithCustomError(strategy, "InvalidBuffer");
    });

    it("should only allow STRATEGIST_ROLE to setProfitabilityParams", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await strategy.connect(admin).setProfitabilityParams(ethers.parseEther("0.10"), ethers.parseEther("0.01"));
      await expect(
        strategy.connect(user).setProfitabilityParams(ethers.parseEther("0.10"), ethers.parseEther("0.01"))
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should reject maxBorrowRate > 50%", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setProfitabilityParams(ethers.parseEther("0.51"), ethers.parseEther("0.01"))
      ).to.be.revertedWithCustomError(strategy, "MaxBorrowRateTooHighErr");
    });

    it("should only allow STRATEGIST_ROLE to setActive", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await strategy.connect(admin).setActive(false);
      expect(await strategy.active()).to.be.false;
      await expect(
        strategy.connect(user).setActive(true)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should only allow STRATEGIST_ROLE to setEMode", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setEMode(1)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setEMode(1)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should only allow STRATEGIST_ROLE to setRewardToken", async function () {
      const { strategy, admin, user, usdc } = await loadFixture(deployFixture);
      await strategy.connect(admin).setRewardToken(await usdc.getAddress(), true);
      expect(await strategy.allowedRewardTokens(await usdc.getAddress())).to.be.true;
      await expect(
        strategy.connect(user).setRewardToken(await usdc.getAddress(), true)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should revert setRewardToken with zero address", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setRewardToken(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("should validate setSwapParams bounds", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await strategy.connect(admin).setSwapParams(500, 9500);
      await expect(
        strategy.connect(user).setSwapParams(500, 9500)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
      await expect(
        strategy.connect(admin).setSwapParams(500, 7000)
      ).to.be.revertedWithCustomError(strategy, "SlippageTooHighErr");
      await expect(
        strategy.connect(admin).setSwapParams(500, 11000)
      ).to.be.revertedWithCustomError(strategy, "SlippageTooHighErr");
    });

    it("should only allow timelock to recoverToken", async function () {
      const { strategy, admin, timelock, usdc } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).recoverToken(await usdc.getAddress(), 0)).to.be.reverted;
      await expect(strategy.connect(timelock).recoverToken(await usdc.getAddress(), 0)).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // EMERGENCY
  // ──────────────────────────────────────────────────────────────────────

  describe("Emergency", function () {
    it("should emergency deleverage and unwind position", async function () {
      const { strategy, treasury, guardian, debtToken } =
        await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      expect(await debtToken.balanceOf(await strategy.getAddress())).to.be.gt(0);

      await expect(strategy.connect(guardian).emergencyDeleverage())
        .to.emit(strategy, "EmergencyDeleveraged");

      expect(await debtToken.balanceOf(await strategy.getAddress())).to.equal(0);
    });

    it("should revert emergencyDeleverage from non-guardian", async function () {
      const { strategy, treasury, user } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await expect(
        strategy.connect(user).emergencyDeleverage()
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should pause and prevent new deposits", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;
      expect(await strategy.isActive()).to.be.false;
      await expect(
        strategy.connect(treasury).deposit(parseUSDC("1000"))
      ).to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // UUPS UPGRADE
  // ──────────────────────────────────────────────────────────────────────

  describe("UUPS Upgrade", function () {
    it("should only allow timelock to authorize upgrade", async function () {
      const { strategy, admin, timelock } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("AaveV3LoopStrategy");

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), F.connect(admin), { unsafeAllow: ["constructor"] })
      ).to.be.reverted;

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), F.connect(timelock), { unsafeAllow: ["constructor"] })
      ).to.not.be.reverted;
    });
  });
});
