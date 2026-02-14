import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("ContangoLoopStrategy", function () {
  const INSTRUMENT_SYMBOL = ethers.keccak256(ethers.toUtf8Bytes("USDC-USDC"));

  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] =
      await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MockPositionNFT
    const MockPositionNFT = await ethers.getContractFactory("MockPositionNFT");
    const positionNFT = await MockPositionNFT.deploy();

    // Deploy MockContangoVault
    const MockContangoVault = await ethers.getContractFactory("MockContangoVault");
    const contangoVault = await MockContangoVault.deploy();

    // Deploy MockContango (core)
    const MockContango = await ethers.getContractFactory("MockContango");
    const contango = await MockContango.deploy(
      await usdc.getAddress(),
      await positionNFT.getAddress(),
      await contangoVault.getAddress()
    );

    // Deploy MockContangoLens
    const MockContangoLens = await ethers.getContractFactory("MockContangoLens");
    const contangoLens = await MockContangoLens.deploy(await contango.getAddress());

    // Deploy simple mock swap router for reward swaps
    const MockSwapRouterSimple = await ethers.getContractFactory("MockSwapRouterSimple");
    const swapRouter = await MockSwapRouterSimple.deploy(await usdc.getAddress());

    // Seed contango with liquidity
    await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
    await usdc.connect(admin).approve(await contango.getAddress(), ethers.MaxUint256);
    await contango.connect(admin).seedLiquidity(ethers.parseUnits("5000000", 6));

    // Seed vault with USDC for withdrawals
    await usdc.connect(admin).approve(await contangoVault.getAddress(), ethers.MaxUint256);

    // Deploy ContangoLoopStrategy as upgradeable proxy
    const ContangoLoopStrategy = await ethers.getContractFactory("ContangoLoopStrategy");
    const strategy = await upgrades.deployProxy(
      ContangoLoopStrategy,
      [
        await usdc.getAddress(),
        await contango.getAddress(),
        await contangoVault.getAddress(),
        await contangoLens.getAddress(),
        ethers.ZeroAddress, // merklDistributor (not tested here)
        await swapRouter.getAddress(),
        INSTRUMENT_SYMBOL,
        treasury.address,
        admin.address,
        timelockSigner.address,
      ],
      {
        kind: "uups",
        initializer: "initialize",
      }
    );

    // Grant additional roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    const KEEPER_ROLE = await strategy.KEEPER_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);

    // Mint USDC to treasury and approve strategy
    await usdc.mint(treasury.address, ethers.parseUnits("1000000", 6));
    await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      strategy,
      usdc,
      contango,
      contangoVault,
      contangoLens,
      positionNFT,
      swapRouter,
      admin,
      treasury,
      strategist,
      guardian,
      keeper,
      user1,
      timelockSigner,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, contango, contangoVault, contangoLens } =
        await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.contango()).to.equal(await contango.getAddress());
      expect(await strategy.contangoVault()).to.equal(await contangoVault.getAddress());
      expect(await strategy.contangoLens()).to.equal(await contangoLens.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.instrumentSymbol()).to.equal(INSTRUMENT_SYMBOL);
    });

    it("Should grant roles correctly", async function () {
      const { strategy, admin, treasury, strategist, guardian, keeper } =
        await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await strategy.DEFAULT_ADMIN_ROLE();
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();
      const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
      const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
      const KEEPER_ROLE = await strategy.KEEPER_ROLE();

      expect(await strategy.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
      expect(await strategy.hasRole(STRATEGIST_ROLE, strategist.address)).to.be.true;
      expect(await strategy.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
      expect(await strategy.hasRole(KEEPER_ROLE, keeper.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { strategy, usdc, contango, contangoVault, contangoLens, swapRouter, treasury, admin } =
        await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await contango.getAddress(),
          await contangoVault.getAddress(),
          await contangoLens.getAddress(),
          ethers.ZeroAddress,
          await swapRouter.getAddress(),
          INSTRUMENT_SYMBOL,
          treasury.address,
          admin.address,
          admin.address
        )
      ).to.be.reverted;
    });

    it("Should set profitability defaults", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.maxBorrowRateForProfit()).to.equal(ethers.parseUnits("0.08", 18));
      expect(await strategy.minNetApySpread()).to.equal(ethers.parseUnits("0.005", 18));
      expect(await strategy.defaultSwapFeeTier()).to.equal(3000);
      expect(await strategy.minSwapOutputBps()).to.equal(9500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DEPOSIT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deposit", function () {
    it("Should accept deposit from treasury", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", 6);

      await expect(strategy.connect(treasury).deposit(amount))
        .to.emit(strategy, "Deposited");

      expect(await strategy.totalPrincipal()).to.equal(amount);
    });

    it("Should create Contango position on first deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("10000", 6);
      await strategy.connect(treasury).deposit(amount);

      const posId = await strategy.positionId();
      expect(posId).to.not.equal(ethers.ZeroHash);
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

      await strategy.connect(admin).setActive(false);

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("Should revert deposit when paused", async function () {
      const { strategy, guardian, treasury } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(strategy.connect(treasury).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });

    it("Should handle multiple sequential deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("1000", 6));

      await strategy.connect(treasury).deposit(ethers.parseUnits("2000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("3000", 6));
    });

    it("Should handle small deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const smallAmount = ethers.parseUnits("1", 6);
      await strategy.connect(treasury).deposit(smallAmount);

      const totalValue = await strategy.totalValue();
      expect(totalValue).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // WITHDRAW
  // ═══════════════════════════════════════════════════════════════════

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
      expect(balanceAfter).to.be.gte(balanceBefore);
    });

    it("Should withdraw all funds", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("10000", 6);
      await strategy.connect(treasury).deposit(depositAmount);

      await strategy.connect(treasury).withdrawAll();

      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.positionId()).to.equal(ethers.ZeroHash);
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

    it("Should handle partial withdrawals correctly", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await strategy.connect(treasury).withdraw(ethers.parseUnits("3000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("7000", 6));

      await strategy.connect(treasury).withdraw(ethers.parseUnits("2000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("5000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("Should return total value after deposit", async function () {
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

    it("Should return isActive status", async function () {
      const { strategy } = await loadFixture(deployFixture);

      expect(await strategy.isActive()).to.be.true;
    });

    it("Should return health factor for open position", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      const healthFactor = await strategy.getHealthFactor();
      expect(healthFactor).to.be.gt(0);
    });

    it("Should return max health factor with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const hf = await strategy.getHealthFactor();
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it("Should return current leverage", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.be.gte(100); // At least 1x
    });

    it("Should return position data", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(principal).to.equal(ethers.parseUnits("10000", 6));
      expect(collateral).to.be.gte(0);
    });

    it("Should return Contango position ID", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      expect(await strategy.getContangoPositionId()).to.equal(ethers.ZeroHash);

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6));

      expect(await strategy.getContangoPositionId()).to.not.equal(ethers.ZeroHash);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("Should update parameters", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setParameters(6500, 3);
      expect(await strategy.targetLtvBps()).to.equal(6500);
      expect(await strategy.targetLoops()).to.equal(3);
    });

    it("Should revert invalid LTV (too high)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(9500, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should revert invalid LTV (too low)", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(2000, 4))
        .to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });

    it("Should revert invalid loops", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setParameters(7500, 0))
        .to.be.revertedWithCustomError(strategy, "InvalidMaxLoopsParam");

      await expect(strategy.connect(strategist).setParameters(7500, 25))
        .to.be.revertedWithCustomError(strategy, "InvalidMaxLoopsParam");
    });

    it("Should set safety buffer", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSafetyBuffer(300);
      expect(await strategy.safetyBufferBps()).to.equal(300);
    });

    it("Should revert invalid safety buffer", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSafetyBuffer(100))
        .to.be.revertedWithCustomError(strategy, "InvalidBuffer");

      await expect(strategy.connect(strategist).setSafetyBuffer(3000))
        .to.be.revertedWithCustomError(strategy, "InvalidBuffer");
    });

    it("Should set profitability params", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setProfitabilityParams(
        ethers.parseUnits("0.10", 18),
        ethers.parseUnits("0.01", 18)
      );

      expect(await strategy.maxBorrowRateForProfit()).to.equal(ethers.parseUnits("0.10", 18));
      expect(await strategy.minNetApySpread()).to.equal(ethers.parseUnits("0.01", 18));
    });

    it("Should revert excessive max borrow rate", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setProfitabilityParams(
          ethers.parseUnits("0.60", 18), // > 50%
          ethers.parseUnits("0.01", 18)
        )
      ).to.be.revertedWithCustomError(strategy, "MaxBorrowRateTooHighErr");
    });

    it("Should set preferred money market", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setPreferredMoneyMarket(3);
      expect(await strategy.preferredMoneyMarket()).to.equal(3);
    });

    it("Should set default swap router", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const spender = ethers.Wallet.createRandom().address;
      const router = ethers.Wallet.createRandom().address;

      await strategy.connect(strategist).setDefaultSwapRouter(spender, router);
      expect(await strategy.defaultSwapSpender()).to.equal(spender);
      expect(await strategy.defaultSwapRouter()).to.equal(router);
    });

    it("Should revert swap router with zero address", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const router = ethers.Wallet.createRandom().address;

      await expect(
        strategy.connect(strategist).setDefaultSwapRouter(ethers.ZeroAddress, router)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("Should toggle reward tokens", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const rewardToken = ethers.Wallet.createRandom().address;

      await strategy.connect(strategist).setRewardToken(rewardToken, true);
      expect(await strategy.allowedRewardTokens(rewardToken)).to.be.true;

      await strategy.connect(strategist).setRewardToken(rewardToken, false);
      expect(await strategy.allowedRewardTokens(rewardToken)).to.be.false;
    });

    it("Should set swap params", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSwapParams(500, 9800);
      expect(await strategy.defaultSwapFeeTier()).to.equal(500);
      expect(await strategy.minSwapOutputBps()).to.equal(9800);
    });

    it("Should revert bad slippage params", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).setSwapParams(500, 7000))
        .to.be.revertedWithCustomError(strategy, "SlippageTooHighErr");
    });

    it("Should set instrument symbol", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const newSymbol = ethers.keccak256(ethers.toUtf8Bytes("ETH-USDC"));
      await strategy.connect(strategist).setInstrumentSymbol(newSymbol);
      expect(await strategy.instrumentSymbol()).to.equal(newSymbol);
    });

    it("Should set active status", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);
      expect(await strategy.active()).to.be.false;
      expect(await strategy.isActive()).to.be.false;

      await strategy.connect(strategist).setActive(true);
      expect(await strategy.active()).to.be.true;
    });

    it("Should revert admin functions for non-strategist", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).setParameters(6500, 3))
        .to.be.reverted;
      await expect(strategy.connect(user1).setPreferredMoneyMarket(1))
        .to.be.reverted;
      await expect(strategy.connect(user1).setActive(false))
        .to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // EMERGENCY CONTROLS
  // ═══════════════════════════════════════════════════════════════════

  describe("Emergency Controls", function () {
    it("Should pause operations", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      expect(await strategy.paused()).to.be.true;
    });

    it("Should unpause via timelock", async function () {
      const { strategy, guardian, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();
      await strategy.connect(timelockSigner).unpause();
      expect(await strategy.paused()).to.be.false;
    });

    it("Should revert unpause from non-timelock", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(strategy.connect(guardian).unpause())
        .to.be.reverted;
    });

    it("Should emergency deleverage", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(strategy.connect(guardian).emergencyDeleverage())
        .to.emit(strategy, "EmergencyDeleveraged");

      // Position should be cleared
      expect(await strategy.positionId()).to.equal(ethers.ZeroHash);
    });

    it("Should emergency deleverage with no position gracefully", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);

      // Should not revert
      await strategy.connect(guardian).emergencyDeleverage();
    });

    it("Should only allow guardian to emergency deleverage", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).emergencyDeleverage())
        .to.be.reverted;
    });

    it("Should only allow guardian to pause", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).pause())
        .to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TOKEN RECOVERY
  // ═══════════════════════════════════════════════════════════════════

  describe("Token Recovery", function () {
    it("Should recover stray tokens via timelock", async function () {
      const { strategy, usdc, timelockSigner } = await loadFixture(deployFixture);

      // Send stray tokens directly
      const strayToken = await (await ethers.getContractFactory("MockERC20")).deploy("Stray", "STRAY", 18);
      await strayToken.mint(await strategy.getAddress(), ethers.parseUnits("100", 18));

      await strategy.connect(timelockSigner).recoverToken(
        await strayToken.getAddress(),
        ethers.parseUnits("100", 18)
      );

      expect(await strayToken.balanceOf(timelockSigner.address)).to.equal(ethers.parseUnits("100", 18));
    });

    it("Should not recover active USDC", async function () {
      const { strategy, usdc, treasury, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6));

      await expect(
        strategy.connect(timelockSigner).recoverToken(
          await usdc.getAddress(),
          ethers.parseUnits("100", 6)
        )
      ).to.be.revertedWithCustomError(strategy, "CannotRecoverActiveUsdc");
    });

    it("Should not allow non-timelock to recover", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const strayToken = await (await ethers.getContractFactory("MockERC20")).deploy("Stray", "STRAY", 18);
      await strayToken.mint(await strategy.getAddress(), ethers.parseUnits("100", 18));

      await expect(
        strategy.connect(user1).recoverToken(
          await strayToken.getAddress(),
          ethers.parseUnits("100", 18)
        )
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UPGRADEABILITY
  // ═══════════════════════════════════════════════════════════════════

  describe("Upgradeability", function () {
    it("Should be upgradeable by timelock", async function () {
      const { strategy, timelockSigner } = await loadFixture(deployFixture);

      const ContangoV2 = await ethers.getContractFactory("ContangoLoopStrategy", timelockSigner);
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), ContangoV2);

      expect(await upgraded.getAddress()).to.equal(await strategy.getAddress());
    });

    it("Should not be upgradeable by non-timelock", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const ContangoV2 = await ethers.getContractFactory("ContangoLoopStrategy", user1);

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), ContangoV2)
      ).to.be.reverted;
    });

    it("Should preserve state after upgrade", async function () {
      const { strategy, strategist, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setParameters(6500, 5);
      expect(await strategy.targetLtvBps()).to.equal(6500);

      const ContangoV2 = await ethers.getContractFactory("ContangoLoopStrategy", timelockSigner);
      const upgraded = await upgrades.upgradeProxy(await strategy.getAddress(), ContangoV2);

      expect(await upgraded.targetLtvBps()).to.equal(6500);
      expect(await upgraded.targetLoops()).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ROLE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Role Management", function () {
    it("Should allow admin to grant roles", async function () {
      const { strategy, admin, user1 } = await loadFixture(deployFixture);

      const KEEPER_ROLE = await strategy.KEEPER_ROLE();
      await strategy.connect(admin).grantRole(KEEPER_ROLE, user1.address);

      expect(await strategy.hasRole(KEEPER_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke roles", async function () {
      const { strategy, admin, strategist } = await loadFixture(deployFixture);

      const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
      await strategy.connect(admin).revokeRole(STRATEGIST_ROLE, strategist.address);

      expect(await strategy.hasRole(STRATEGIST_ROLE, strategist.address)).to.be.false;
    });

    it("Should not allow non-admin to grant roles", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      const KEEPER_ROLE = await strategy.KEEPER_ROLE();

      await expect(
        strategy.connect(user1).grantRole(KEEPER_ROLE, user1.address)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PROFITABILITY
  // ═══════════════════════════════════════════════════════════════════

  describe("Profitability", function () {
    it("Should check profitability with no position", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const [profitable] = await strategy.checkProfitability();
      expect(profitable).to.be.true;
    });

    it("Should check profitability with open position", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      const [profitable, borrowRate, lendingRate] = await strategy.checkProfitability();
      expect(borrowRate).to.be.gt(0);
      expect(lendingRate).to.be.gt(0);
    });
  });
});
