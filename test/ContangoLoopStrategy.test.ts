import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * ContangoLoopStrategy — Comprehensive Test Suite
 *
 * Tests for the UUPS-upgradeable Contango Core-V2 leverage-loop strategy.
 * Uses MockContango, MockContangoVault, MockContangoLens, MockPositionNFT
 * for deterministic testing.
 *
 * Strategy overview:
 *   1. Opens leveraged position on Contango via trade()
 *   2. Contango handles flash loan → supply → borrow internally
 *   3. Manages position via Contango positionId (ERC721 NFT)
 *   4. Harvests Merkl rewards and compounds into position
 */
describe("ContangoLoopStrategy", function () {
  // ──────────────────────────────────────────────────────────────────────
  // CONSTANTS
  // ──────────────────────────────────────────────────────────────────────

  const USDC_DECIMALS = 6;
  const parseUSDC = (n: string) => ethers.parseUnits(n, USDC_DECIMALS);

  const TREASURY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_ROLE"));
  const STRATEGIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STRATEGIST_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

  const INSTRUMENT_SYMBOL = ethers.encodeBytes32String("USDCUSDC");

  // ──────────────────────────────────────────────────────────────────────
  // FIXTURE
  // ──────────────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [owner, admin, treasury, keeper, guardian, user, timelock] =
      await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MockPositionNFT
    const MockPositionNFT = await ethers.getContractFactory("MockPositionNFT");
    const positionNFT = await MockPositionNFT.deploy();

    // Deploy MockContangoVault
    const MockContangoVault = await ethers.getContractFactory("MockContangoVault");
    const contangoVault = await MockContangoVault.deploy();

    // Deploy MockContango
    const MockContango = await ethers.getContractFactory("MockContango");
    const contango = await MockContango.deploy(
      await usdc.getAddress(),
      await positionNFT.getAddress(),
      await contangoVault.getAddress()
    );

    // Deploy MockContangoLens
    const MockContangoLens = await ethers.getContractFactory("MockContangoLens");
    const contangoLens = await MockContangoLens.deploy(await contango.getAddress());

    // Deploy mock Merkl Distributor (from MockAaveV3Pool.sol)
    const MockMerkl = await ethers.getContractFactory("contracts/mocks/MockAaveV3Pool.sol:MockMerklDistributor");
    const merklDistributor = await MockMerkl.deploy();

    // Deploy mock Swap Router (from MockAaveV3Pool.sol — 1:1 swap, no constructor args)
    const MockSwapRouterLoop = await ethers.getContractFactory("MockSwapRouterV3ForLoop");
    const swapRouter = await MockSwapRouterLoop.deploy();

    // Deploy strategy via UUPS proxy
    const ContangoLoopStrategy = await ethers.getContractFactory("ContangoLoopStrategy");
    const strategy = await upgrades.deployProxy(
      ContangoLoopStrategy,
      [
        await usdc.getAddress(),
        await contango.getAddress(),
        await contangoVault.getAddress(),
        await contangoLens.getAddress(),
        await merklDistributor.getAddress(),
        await swapRouter.getAddress(),
        INSTRUMENT_SYMBOL,
        treasury.address,
        admin.address,
        timelock.address,
      ],
      { kind: "uups", unsafeAllow: ["constructor"] }
    );
    await strategy.waitForDeployment();

    // Mint USDC to treasury for deposits
    const treasuryFunds = parseUSDC("1000000"); // 1M
    await usdc.mint(treasury.address, treasuryFunds);
    await usdc.connect(treasury).approve(await strategy.getAddress(), treasuryFunds);

    // Seed Contango Vault with USDC liquidity for withdrawals
    const vaultLiquidity = parseUSDC("5000000");
    await usdc.mint(owner.address, vaultLiquidity);
    await usdc.connect(owner).approve(await contangoVault.getAddress(), vaultLiquidity);
    await contangoVault.connect(owner).depositTo(
      await usdc.getAddress(),
      await contango.getAddress(),
      vaultLiquidity
    );

    // Grant KEEPER_ROLE and GUARDIAN_ROLE
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);

    return {
      owner, admin, treasury, keeper, guardian, user, timelock,
      usdc, contango, contangoVault, contangoLens, positionNFT,
      merklDistributor, swapRouter, strategy,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // DEPLOYMENT & INITIALIZATION
  // ──────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("should deploy with correct initial parameters", async function () {
      const { strategy, usdc, contango } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.contango()).to.equal(await contango.getAddress());
      expect(await strategy.targetLtvBps()).to.equal(7500);
      expect(await strategy.targetLoops()).to.equal(4);
      expect(await strategy.safetyBufferBps()).to.equal(500);
      expect(await strategy.active()).to.be.true;
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.instrumentSymbol()).to.equal(INSTRUMENT_SYMBOL);
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
      const { usdc, contango, contangoVault, contangoLens, merklDistributor, swapRouter, admin, treasury } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("ContangoLoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          await usdc.getAddress(), await contango.getAddress(),
          await contangoVault.getAddress(), await contangoLens.getAddress(),
          await merklDistributor.getAddress(), await swapRouter.getAddress(),
          INSTRUMENT_SYMBOL, treasury.address, admin.address,
          ethers.ZeroAddress,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("should revert if initialized with zero USDC address", async function () {
      const { contango, contangoVault, contangoLens, merklDistributor, swapRouter, admin, treasury, timelock } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("ContangoLoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          ethers.ZeroAddress, await contango.getAddress(),
          await contangoVault.getAddress(), await contangoLens.getAddress(),
          await merklDistributor.getAddress(), await swapRouter.getAddress(),
          INSTRUMENT_SYMBOL, treasury.address, admin.address,
          timelock.address,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("should revert if initialized with zero Contango address", async function () {
      const { usdc, contangoVault, contangoLens, merklDistributor, swapRouter, admin, treasury, timelock } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("ContangoLoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          await usdc.getAddress(), ethers.ZeroAddress,
          await contangoVault.getAddress(), await contangoLens.getAddress(),
          await merklDistributor.getAddress(), await swapRouter.getAddress(),
          INSTRUMENT_SYMBOL, treasury.address, admin.address,
          timelock.address,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "InvalidContangoAddress");
    });

    it("should revert if initialized with zero instrument symbol", async function () {
      const { usdc, contango, contangoVault, contangoLens, merklDistributor, swapRouter, admin, treasury, timelock } =
        await loadFixture(deployFixture);

      const F = await ethers.getContractFactory("ContangoLoopStrategy");
      await expect(
        upgrades.deployProxy(F, [
          await usdc.getAddress(), await contango.getAddress(),
          await contangoVault.getAddress(), await contangoLens.getAddress(),
          await merklDistributor.getAddress(), await swapRouter.getAddress(),
          ethers.ZeroHash, treasury.address, admin.address,
          timelock.address,
        ], { kind: "uups", unsafeAllow: ["constructor"] })
      ).to.be.revertedWithCustomError(F, "InvalidInstrumentSymbol");
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
    it("should accept USDC deposit and open Contango position", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const depositAmount = parseUSDC("10000");
      await strategy.connect(treasury).deposit(depositAmount);

      expect(await strategy.totalPrincipal()).to.equal(depositAmount);
      // Position ID should be set
      const posId = await strategy.positionId();
      expect(posId).to.not.equal(ethers.ZeroHash);
    });

    it("should emit Deposited event", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(parseUSDC("5000")))
        .to.emit(strategy, "Deposited");
    });

    it("should emit PositionOpened on first deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await expect(strategy.connect(treasury).deposit(parseUSDC("5000")))
        .to.emit(strategy, "PositionOpened");
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

    it("should reuse positionId on subsequent deposits", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("5000"));
      const posId1 = await strategy.positionId();
      await strategy.connect(treasury).deposit(parseUSDC("3000"));
      const posId2 = await strategy.positionId();
      // Same position should be used
      expect(posId1).to.equal(posId2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // WITHDRAW
  // ──────────────────────────────────────────────────────────────────────

  describe("Withdraw", function () {
    it("should withdraw USDC by reducing Contango position", async function () {
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
    it("should close entire Contango position and return USDC", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter).to.be.gt(balBefore);
      expect(await strategy.totalPrincipal()).to.equal(0);
      expect(await strategy.positionId()).to.equal(ethers.ZeroHash);
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
    it("should report totalValue when no position exists", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const tv = await strategy.totalValue();
      expect(tv).to.be.gte(0);
    });

    it("should report totalValue after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      const tv = await strategy.totalValue();
      expect(tv).to.be.gt(0);
    });

    it("should report getPosition with correct principal", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
      expect(principal).to.equal(parseUSDC("10000"));
      expect(collateral).to.be.gte(0);
    });

    it("should report health factor (max when no position)", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const hf = await strategy.getHealthFactor();
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it("should report getCurrentLeverage = 100 when no principal", async function () {
      const { strategy } = await loadFixture(deployFixture);
      expect(await strategy.getCurrentLeverage()).to.equal(100);
    });

    it("should report realSharePrice = 1e18 when no principal", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const [priceWad, trusted] = await strategy.realSharePrice();
      expect(trusted).to.be.true;
      expect(priceWad).to.equal(ethers.parseEther("1"));
    });

    it("should report getContangoPositionId", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);
      expect(await strategy.getContangoPositionId()).to.equal(ethers.ZeroHash);

      await strategy.connect(treasury).deposit(parseUSDC("5000"));
      expect(await strategy.getContangoPositionId()).to.not.equal(ethers.ZeroHash);
    });

    it("should report checkProfitability", async function () {
      const { strategy } = await loadFixture(deployFixture);
      const [profitable, borrowRate, lendingRate, netRate] = await strategy.checkProfitability();
      // No position — should default to profitable
      expect(profitable).to.be.true;
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

    it("should only allow STRATEGIST_ROLE to setPreferredMoneyMarket", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      await expect(strategy.connect(admin).setPreferredMoneyMarket(1)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setPreferredMoneyMarket(1)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should only allow STRATEGIST_ROLE to setDefaultSwapRouter", async function () {
      const { strategy, admin, user, swapRouter } = await loadFixture(deployFixture);
      const addr = await swapRouter.getAddress();
      await expect(strategy.connect(admin).setDefaultSwapRouter(addr, addr)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setDefaultSwapRouter(addr, addr)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should revert setDefaultSwapRouter with zero address", async function () {
      const { strategy, admin, swapRouter } = await loadFixture(deployFixture);
      const addr = await swapRouter.getAddress();
      await expect(
        strategy.connect(admin).setDefaultSwapRouter(ethers.ZeroAddress, addr)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
      await expect(
        strategy.connect(admin).setDefaultSwapRouter(addr, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("should only allow STRATEGIST_ROLE to setInstrumentSymbol", async function () {
      const { strategy, admin, user } = await loadFixture(deployFixture);
      const newSymbol = ethers.encodeBytes32String("ETHUSDC");
      await expect(strategy.connect(admin).setInstrumentSymbol(newSymbol)).to.not.be.reverted;
      await expect(
        strategy.connect(user).setInstrumentSymbol(newSymbol)
      ).to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount");
    });

    it("should revert setInstrumentSymbol with zero bytes32", async function () {
      const { strategy, admin } = await loadFixture(deployFixture);
      await expect(
        strategy.connect(admin).setInstrumentSymbol(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(strategy, "InvalidInstrumentSymbol");
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
  // REBALANCE
  // ──────────────────────────────────────────────────────────────────────

  describe("Rebalance", function () {
    it("should rebalance position via Contango", async function () {
      const { strategy, treasury, keeper } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));
      // Should not revert (may be no-op if already at target)
      await expect(strategy.connect(keeper).rebalance()).to.not.be.reverted;
    });

    it("should no-op rebalance when no position exists", async function () {
      const { strategy, keeper } = await loadFixture(deployFixture);
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
  // EMERGENCY
  // ──────────────────────────────────────────────────────────────────────

  describe("Emergency", function () {
    it("should emergency deleverage and close Contango position", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);
      await strategy.connect(treasury).deposit(parseUSDC("10000"));

      const posIdBefore = await strategy.positionId();
      expect(posIdBefore).to.not.equal(ethers.ZeroHash);

      await expect(strategy.connect(guardian).emergencyDeleverage())
        .to.emit(strategy, "EmergencyDeleveraged");

      // Position should be cleared
      expect(await strategy.positionId()).to.equal(ethers.ZeroHash);
    });

    it("should no-op emergencyDeleverage when no position", async function () {
      const { strategy, guardian } = await loadFixture(deployFixture);
      await expect(strategy.connect(guardian).emergencyDeleverage()).to.not.be.reverted;
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
      const F = await ethers.getContractFactory("ContangoLoopStrategy");

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), F.connect(admin), { unsafeAllow: ["constructor"] })
      ).to.be.reverted;

      await expect(
        upgrades.upgradeProxy(await strategy.getAddress(), F.connect(timelock), { unsafeAllow: ["constructor"] })
      ).to.not.be.reverted;
    });
  });
});
