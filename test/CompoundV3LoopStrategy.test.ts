import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * CompoundV3LoopStrategy — Comprehensive Test Suite
 *
 * Tests for the UUPS-upgradeable Compound V3 leverage-loop strategy.
 * Uses MockComet, MockCometRewards, MockAaveFlashPool, MockSwapRouterV3ForLoop
 * and MockMerklDistributor for deterministic behaviour.
 */
describe("CompoundV3LoopStrategy", function () {
  const USDC_DECIMALS = 6;
  const parseUSDC = (n: string) => ethers.parseUnits(n, USDC_DECIMALS);

  const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
  const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

  async function deployFixture() {
    const [owner, admin, treasury, keeper, guardian, user, timelock] =
      await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    const comp = await MockERC20.deploy("Compound", "COMP", 18);

    // Deploy mock Comet
    const MockComet = await ethers.getContractFactory("MockComet");
    const comet = await MockComet.deploy(await usdc.getAddress());

    // Deploy mock Comet Rewards
    const MockCometRewards = await ethers.getContractFactory("MockCometRewards");
    const cometRewards = await MockCometRewards.deploy(await comp.getAddress());

    // Deploy mock AAVE flash loan pool
    const MockFlash = await ethers.getContractFactory("MockAaveFlashPool");
    const flashPool = await MockFlash.deploy(await usdc.getAddress());

    // Deploy mock Merkl Distributor
    const MockMerkl = await ethers.getContractFactory("contracts/mocks/MockAaveV3Pool.sol:MockMerklDistributor");
    const merklDistributor = await MockMerkl.deploy();

    // Deploy mock Swap Router
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
    const swapRouter = await MockSwapRouter.deploy();

    // Deploy strategy via UUPS proxy
    const Strategy = await ethers.getContractFactory("CompoundV3LoopStrategy");
    const strategy = await upgrades.deployProxy(
      Strategy,
      [
        await usdc.getAddress(),
        await comet.getAddress(),
        await cometRewards.getAddress(),
        await weth.getAddress(),
        await flashPool.getAddress(),
        await merklDistributor.getAddress(),
        await swapRouter.getAddress(),
        treasury.address,
        admin.address,
        timelock.address,
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    );
    await strategy.waitForDeployment();

    // Seed Comet and flash pool with liquidity
    const liquidity = parseUSDC("10000000");
    await usdc.mint(owner.address, liquidity * 2n);
    await usdc.connect(owner).approve(await comet.getAddress(), liquidity);
    await comet.connect(owner).seedLiquidity(liquidity);
    await usdc.connect(owner).approve(await flashPool.getAddress(), liquidity);
    await flashPool.connect(owner).seedLiquidity(liquidity);

    // Mint USDC for treasury
    const treasuryFunds = parseUSDC("1000000");
    await usdc.mint(treasury.address, treasuryFunds);
    await usdc.connect(treasury).approve(await strategy.getAddress(), treasuryFunds);

    // Grant roles
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    return {
      owner, admin, treasury, keeper, guardian, user, timelock,
      usdc, weth, comp, comet, cometRewards, flashPool,
      merklDistributor, swapRouter, strategy,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // DEPLOYMENT & INITIALIZATION
  // ──────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("should deploy with correct initial parameters", async function () {
      const { strategy, usdc, comet } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.comet()).to.equal(await comet.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7000);
      expect(await strategy.targetLoops()).to.equal(3);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.minSwapOutputBps()).to.equal(9500);
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
      const {
        usdc, comet, cometRewards, weth, flashPool,
        merklDistributor, swapRouter, admin, treasury,
      } = await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("CompoundV3LoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          await usdc.getAddress(), await comet.getAddress(),
          await cometRewards.getAddress(), await weth.getAddress(),
          await flashPool.getAddress(), await merklDistributor.getAddress(),
          await swapRouter.getAddress(), treasury.address,
          admin.address, ethers.ZeroAddress,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("should revert if initialized with zero USDC", async function () {
      const {
        comet, cometRewards, weth, flashPool,
        merklDistributor, swapRouter, admin, treasury, timelock,
      } = await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("CompoundV3LoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          ethers.ZeroAddress, await comet.getAddress(),
          await cometRewards.getAddress(), await weth.getAddress(),
          await flashPool.getAddress(), await merklDistributor.getAddress(),
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

  // ──────────────────────────────────────────────────────────────────
  // DEPOSIT
  // ──────────────────────────────────────────────────────────────────

  describe("Deposit", function () {
    it("should accept USDC deposit and supply to Comet", async function () {
      const { strategy, treasury, comet } = await loadFixture(deployFixture);

      const amount = parseUSDC("10000");
      await strategy.connect(treasury).deposit(amount);

      expect(await strategy.totalPrincipal()).to.equal(amount);
      expect(await strategy.totalSupplied()).to.equal(amount);
      const cometBal = await comet.balanceOf(await strategy.getAddress());
      expect(cometBal).to.equal(amount);
    });

    it("should emit Deposited event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(parseUSDC("5000")))
        .to.emit(strategy, "Deposited");
    });

    it("should revert on zero deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should revert when not TREASURY_ROLE", async function () {
      const { strategy, user, usdc } = await loadFixture(deployFixture);
      await usdc.mint(user.address, parseUSDC("1000"));
      await usdc.connect(user).approve(await strategy.getAddress(), parseUSDC("1000"));
      await expect(strategy.connect(user).deposit(parseUSDC("1000")))
        .to.be.reverted;
    });

    it("should revert when inactive", async function () {
      const { strategy, treasury, admin } = await loadFixture(deployFixture);
      await strategy.connect(admin).setActive(false);
      await expect(strategy.connect(treasury).deposit(parseUSDC("1000")))
        .to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("should revert when paused", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      await expect(strategy.connect(treasury).deposit(parseUSDC("1000")))
        .to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // WITHDRAW
  // ──────────────────────────────────────────────────────────────────

  describe("Withdraw", function () {
    it("should withdraw USDC from Comet", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const deposit = parseUSDC("10000");
      await strategy.connect(treasury).deposit(deposit);

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdraw(parseUSDC("5000"));
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.equal(parseUSDC("5000"));
      expect(await strategy.totalPrincipal()).to.equal(parseUSDC("5000"));
    });

    it("should withdraw all via withdrawAll", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.equal(parseUSDC("10000"));
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("should revert on zero withdraw", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("1000"));
      await expect(strategy.connect(treasury).withdraw(0))
        .to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should emit Withdrawn event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("5000"));
      await expect(strategy.connect(treasury).withdraw(parseUSDC("1000")))
        .to.emit(strategy, "Withdrawn");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // VIEWS
  // ──────────────────────────────────────────────────────────────────

  describe("Views", function () {
    it("totalValue should return net position", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      expect(await strategy.totalValue()).to.equal(parseUSDC("10000"));
    });

    it("getHealthFactor should return healthy value", async function () {
      const { strategy } = await loadFixture(deployFixture);
      // No position — should still return healthy
      const hf = await strategy.getHealthFactor();
      expect(hf).to.be.gt(0);
    });

    it("getCurrentLeverage should return 100 with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.getCurrentLeverage()).to.equal(100);
    });

    it("getPosition should return correct values", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(principal).to.equal(parseUSDC("10000"));
      expect(collateral).to.equal(parseUSDC("10000"));
      expect(borrowed).to.equal(0);
      expect(netValue).to.equal(parseUSDC("10000"));
    });

    it("realSharePrice should return WAD with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const [price, trusted] = await strategy.realSharePrice();
      expect(price).to.equal(ethers.parseEther("1"));
      expect(trusted).to.be.true;
    });

    it("realTvl should match totalValue", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("5000"));
      const [tvl, trusted] = await strategy.realTvl();
      expect(tvl).to.equal(parseUSDC("5000"));
      expect(trusted).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ADMIN
  // ──────────────────────────────────────────────────────────────────

  describe("Admin", function () {
    it("should set parameters", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setParameters(5000, 5))
        .to.emit(strategy, "ParametersUpdated")
        .withArgs(5000, 5);
      expect(await strategy.targetLtvBps()).to.equal(5000);
      expect(await strategy.targetLoops()).to.equal(5);
    });

    it("should revert on invalid LTV (too low)", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setParameters(2000, 3))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("should revert on invalid LTV (too high)", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setParameters(9000, 3))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("should set reward tokens", async function () {
      const { strategy, admin, comp } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setRewardToken(await comp.getAddress(), true))
        .to.emit(strategy, "RewardTokenToggled");
      expect(await strategy.allowedRewardTokens(await comp.getAddress())).to.be.true;
    });

    it("should set swap params", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setSwapParams(500, 9700))
        .to.emit(strategy, "SwapParamsUpdated");
      expect(await strategy.defaultSwapFeeTier()).to.equal(500);
      expect(await strategy.minSwapOutputBps()).to.equal(9700);
    });

    it("should toggle active flag", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await strategy.connect(admin).setActive(false);
      expect(await strategy.active()).to.be.false;
    });

    it("should pause and unpause", async function () {
      const { strategy, guardian, timelock } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;
      await strategy.connect(timelock).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("unpause should revert for non-timelock", async function () {
      const { strategy, guardian, admin } = await loadFixture(deployFixture);
      await strategy.connect(guardian).pause();
      await expect(strategy.connect(admin).unpause()).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // LEVERAGE
  // ──────────────────────────────────────────────────────────────────

  describe("Leverage", function () {
    it("adjustLeverage should update targetLtvBps", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await strategy.connect(admin).adjustLeverage(6000, 0);
      expect(await strategy.targetLtvBps()).to.equal(6000);
    });

    it("adjustLeverage should revert for invalid LTV", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).adjustLeverage(2000, 0))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("adjustLeverage should respect minSharePrice", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      // Set minSharePrice very high — should revert
      await expect(
        strategy.connect(admin).adjustLeverage(6000, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(strategy, "SharePriceTooLow");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // REBALANCE
  // ──────────────────────────────────────────────────────────────────

  describe("Rebalance", function () {
    it("should emit Rebalanced event", async function () {
      const { strategy, keeper } = await loadFixture(deployFixture);
      await expect(strategy.connect(keeper).rebalance())
        .to.emit(strategy, "Rebalanced");
    });

    it("should revert for non-keeper", async function () {
      const { strategy, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(user).rebalance()).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EMERGENCY
  // ──────────────────────────────────────────────────────────────────

  describe("Emergency", function () {
    it("emergencyDeleverage should unwind position", async function () {
      const { strategy, treasury, guardian, comet } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      await strategy.connect(guardian).emergencyDeleverage();

      // After emergency deleverage, Comet balance should be reduced
      expect(await comet.balanceOf(await strategy.getAddress())).to.equal(0);
    });

    it("emergencyDeleverage should revert for non-guardian", async function () {
      const { strategy, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(user).emergencyDeleverage()).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UUPS UPGRADE
  // ──────────────────────────────────────────────────────────────────

  describe("UUPS Upgrade", function () {
    it("should reject upgrade from non-timelock", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("CompoundV3LoopStrategy");
      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), V2.connect(admin), {
          unsafeAllow: ["constructor"],
        })
      ).to.be.reverted;
    });
  });
});
