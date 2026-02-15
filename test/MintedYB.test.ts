/**
 * MintedYB Core Tests
 * Tests the full Yield Basis port: Factory → addMarket → LT deposit → AMM exchange → LT withdraw
 * Also tests YieldBasisStrategy V2 (LT-based, not lender-based)
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("MintedYB Core", function () {
  // ═══════════════════════════════════════════════════════════════════════
  // Shared State
  // ═══════════════════════════════════════════════════════════════════════

  let stablecoin: any; // 18 decimals (crvUSD-like)
  let wbtc: any;       // 18 decimals (simplified for testing — real WBTC is 8)
  let usdc: any;       // 6 decimals (Treasury asset)
  let curvePool: any;  // MockCurvePool (stablecoin/wbtc)
  let priceAgg: any;   // MockPriceAggregator
  let swapRouter: any; // MockSwapRouter

  let factory: any;
  let lt: any;
  let amm: any;
  let oracle: any;

  let deployer: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let feeReceiver: HardhatEthersSigner;
  let emergencyAdmin: HardhatEthersSigner;

  // Price: 1 WBTC = 60,000 stablecoin (60000e18)
  const BTC_PRICE = ethers.parseEther("60000");
  // Aggregator at peg
  const AGG_PRICE = ethers.parseEther("1");
  // Initial liquidity
  const INITIAL_STABLE = ethers.parseEther("10000000"); // 10M stablecoin
  const INITIAL_BTC = ethers.parseEther("1000");        // 1000 WBTC
  // User deposits
  const USER_BTC_DEPOSIT = ethers.parseEther("10");     // 10 WBTC
  // Factory settings
  const AMM_FEE = ethers.parseEther("0.003");           // 0.3%
  const BORROW_RATE = 31709791983n;                      // ~100% APR
  const DEBT_CEILING = ethers.parseEther("5000000");     // 5M stablecoin

  // ═══════════════════════════════════════════════════════════════════════
  // Setup
  // ═══════════════════════════════════════════════════════════════════════

  beforeEach(async function () {
    [deployer, user1, user2, feeReceiver, emergencyAdmin] = await ethers.getSigners();

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    stablecoin = await MockERC20.deploy("Mock crvUSD", "crvUSD", 18);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 18); // 18 decimals for simplicity
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MockCurvePool (stablecoin = coins(0), wbtc = coins(1))
    const MockCurvePool = await ethers.getContractFactory("MockCurvePool");
    curvePool = await MockCurvePool.deploy(
      await stablecoin.getAddress(),
      await wbtc.getAddress(),
      BTC_PRICE
    );

    // Deploy MockPriceAggregator
    const MockAgg = await ethers.getContractFactory("MockPriceAggregator");
    priceAgg = await MockAgg.deploy(AGG_PRICE);

    // Deploy MockSwapRouter
    const MockRouter = await ethers.getContractFactory("MockYBSwapRouter");
    swapRouter = await MockRouter.deploy();

    // Seed the Curve pool with liquidity (so add_liquidity/remove_liquidity works)
    await stablecoin.mint(deployer.address, INITIAL_STABLE);
    await wbtc.mint(deployer.address, INITIAL_BTC);
    await stablecoin.approve(await curvePool.getAddress(), INITIAL_STABLE);
    await wbtc.approve(await curvePool.getAddress(), INITIAL_BTC);
    await curvePool.add_liquidity(
      [ethers.parseEther("6000000"), ethers.parseEther("100")], // 6M crvUSD + 100 WBTC
      0,
      deployer.address,
      false
    );

    // Deploy Factory
    const FactoryDeploy = await ethers.getContractFactory("MintedYBFactory");
    factory = await FactoryDeploy.deploy(
      await stablecoin.getAddress(),
      deployer.address,
      emergencyAdmin.address,
      feeReceiver.address,
      await priceAgg.getAddress()
    );

    // Fund factory with stablecoins for allocation
    await stablecoin.mint(await factory.getAddress(), DEBT_CEILING);

    // Create market: BTC/stablecoin
    const tx = await factory.addMarket(
      await curvePool.getAddress(),
      AMM_FEE,
      BORROW_RATE,
      DEBT_CEILING
    );
    await tx.wait();

    // Retrieve deployed contracts
    const market = await factory.markets(0);
    lt = await ethers.getContractAt("MintedLT", market.lt);
    amm = await ethers.getContractAt("MintedLevAMM", market.amm);
    oracle = await ethers.getContractAt("MintedLPOracle", market.priceOracle);

    // Fund users with tokens
    await wbtc.mint(user1.address, ethers.parseEther("100"));
    await wbtc.mint(user2.address, ethers.parseEther("100"));
    await stablecoin.mint(user1.address, ethers.parseEther("1000000"));

    // Fund swap router for USDC ↔ WBTC swaps
    await usdc.mint(await swapRouter.getAddress(), ethers.parseUnits("10000000", 6));
    await wbtc.mint(await swapRouter.getAddress(), ethers.parseEther("200"));
    // Set rates: 1 USDC (6 dec) = BTC_PRICE^-1 WBTC (18 dec), but adjusted for decimals
    // 1 USDC = 1e6, we want 1 USDC → 1/60000 WBTC = 1.667e-5 WBTC = 1.667e13 wei
    // Rate for swap: amountOut = amountIn * rate / 1e18
    // For USDC→WBTC: 1e6 * rate / 1e18 = 1.667e13 → rate = 1.667e13 * 1e18 / 1e6 = 1.667e25
    // i.e., rate = 1e18 / 60000 * 1e18 / 1e6 = 1e30 / 60000e6 = ...
    // Simpler: amountIn is in USDC 6-dec, amountOut in WBTC 18-dec
    // amountOut = amountIn * rate / 1e18
    // 100000e6 USDC should → ~1.667 WBTC = 1.667e18
    // rate = 1.667e18 * 1e18 / 100000e6 = 1.667e30 / 1e11 = 1.667e19
    const usdcToBtcRate = ethers.parseEther("1") * ethers.parseEther("1") / (BTC_PRICE / 10n ** 12n);
    // BTC_PRICE = 60000e18, /1e12 = 60000e6, 1e36 / 60000e6 = 1.667e25... too complex
    // Let's just set a simple rate: 1e6 USDC → 1e13 WBTC
    // rate = 1e13 * 1e18 / 1e6 = 1e25
    // But that means 100k USDC → 100000e6 * 1e25 / 1e18 = 1e11 * 1e25 / 1e18 = 1e18 → 1 WBTC ... too much
    // Let's just set rates manually to 1 BTC = 60000 USDC (accounting for decimal difference)
    // Forward: USDC (6dec) → WBTC (18dec): rate such that $60k USDC → 1 WBTC
    // 60000e6 * rate / 1e18 = 1e18 → rate = 1e18 * 1e18 / 60000e6 = 1e36 / 6e10 = 1.667e25
    await swapRouter.setRate(
      await usdc.getAddress(),
      await wbtc.getAddress(),
      ethers.parseEther("1") * ethers.parseEther("1") / (60000n * 10n ** 6n)
    );
    // Reverse: WBTC (18dec) → USDC (6dec): 1 WBTC → $60k USDC
    // 1e18 * rate / 1e18 = 60000e6 → rate = 60000e6
    await swapRouter.setRate(
      await wbtc.getAddress(),
      await usdc.getAddress(),
      60000n * 10n ** 6n
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Factory Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedYBFactory", function () {
    it("should have created a market", async function () {
      expect(await factory.marketCount()).to.equal(1);
    });

    it("should have correct market components", async function () {
      const market = await factory.markets(0);
      expect(market.assetToken).to.equal(await wbtc.getAddress());
      expect(market.cryptopool).to.equal(await curvePool.getAddress());
      expect(market.amm).to.not.equal(ethers.ZeroAddress);
      expect(market.lt).to.not.equal(ethers.ZeroAddress);
      expect(market.priceOracle).to.not.equal(ethers.ZeroAddress);
    });

    it("should set factory as LT admin", async function () {
      expect(await lt.admin()).to.equal(await factory.getAddress());
    });

    it("should reject market creation from non-admin", async function () {
      await expect(
        factory.connect(user1).addMarket(
          await curvePool.getAddress(), AMM_FEE, BORROW_RATE, DEBT_CEILING
        )
      ).to.be.revertedWith("Access");
    });

    it("should allow admin change", async function () {
      await factory.setAdmin(user1.address, emergencyAdmin.address);
      expect(await factory.admin()).to.equal(user1.address);
    });

    it("should allow fee receiver change", async function () {
      await factory.setFeeReceiver(user2.address);
      expect(await factory.feeReceiver()).to.equal(user2.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Oracle Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedLPOracle", function () {
    it("should return non-zero price", async function () {
      const price = await oracle.price();
      expect(price).to.be.gt(0);
    });

    it("should reflect price_scale changes", async function () {
      const priceBefore = await oracle.price();
      // Double the BTC price in the Curve pool
      await curvePool.setPriceScale(BTC_PRICE * 2n);
      const priceAfter = await oracle.price();
      // LP price should increase (roughly sqrt(2) factor on the price_scale component)
      expect(priceAfter).to.be.gt(priceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AMM (MintedLevAMM) Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedLevAMM", function () {
    it("should have correct immutables", async function () {
      expect(await amm.LT_CONTRACT()).to.equal(await lt.getAddress());
      expect(await amm.STABLECOIN()).to.equal(await stablecoin.getAddress());
      expect(await amm.COLLATERAL()).to.equal(await curvePool.getAddress());
      expect(await amm.LEVERAGE()).to.equal(ethers.parseEther("2"));
    });

    it("should have allocated stablecoin balance", async function () {
      const ammBal = await stablecoin.balanceOf(await amm.getAddress());
      expect(ammBal).to.be.gt(0);
    });

    it("should start with zero collateral", async function () {
      expect(await amm.collateralAmount()).to.equal(0);
    });

    it("should reject direct deposits (only LT)", async function () {
      await expect(
        amm.ammDeposit(ethers.parseEther("1"), ethers.parseEther("1"))
      ).to.be.revertedWith("Access");
    });

    it("should reject exchange when empty", async function () {
      await expect(
        amm.exchange(0, 1, ethers.parseEther("1000"), 0, ethers.ZeroAddress)
      ).to.be.revertedWith("Empty AMM");
    });

    it("should compute LEV_RATIO correctly for 2x leverage", async function () {
      // LEV_RATIO = leverage² * 1e18 / (2 * leverage - 1e18)²
      // For 2x: 4e36 * 1e18 / 9e36 = 4e18/9 ≈ 0.4444e18
      const levRatio = await amm.LEV_RATIO();
      const leverage = 2n * 10n ** 18n;
      const denom = 2n * leverage - 10n ** 18n;
      const expected = (leverage * leverage * 10n ** 18n) / (denom * denom);
      expect(levRatio).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LT (MintedLT) Deposit / Withdraw Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedLT Deposit & Withdraw", function () {
    it("should allow a user to deposit WBTC", async function () {
      const depositAmount = ethers.parseEther("1"); // 1 WBTC
      const debtAmount = BTC_PRICE; // Borrow equivalent in stablecoin

      await wbtc.connect(user1).approve(await lt.getAddress(), depositAmount);
      const tx = await lt.connect(user1).deposit(depositAmount, debtAmount, 0, user1.address);
      await tx.wait();

      // User should have LT shares
      const shares = await lt.balanceOf(user1.address);
      expect(shares).to.be.gt(0);

      // AMM should now hold collateral
      const ammColl = await amm.collateralAmount();
      expect(ammColl).to.be.gt(0);
    });

    it("should allow a user to withdraw", async function () {
      // First deposit
      const depositAmount = ethers.parseEther("1");
      const debtAmount = BTC_PRICE;
      await wbtc.connect(user1).approve(await lt.getAddress(), depositAmount);
      await lt.connect(user1).deposit(depositAmount, debtAmount, 0, user1.address);

      const shares = await lt.balanceOf(user1.address);
      const btcBefore = await wbtc.balanceOf(user1.address);

      // Withdraw all
      await lt.connect(user1).withdraw(shares, 0, user1.address);

      const btcAfter = await wbtc.balanceOf(user1.address);
      expect(btcAfter).to.be.gt(btcBefore);

      // Shares should be 0
      expect(await lt.balanceOf(user1.address)).to.equal(0);
    });

    it("should reflect interest accrual in pricePerShare", async function () {
      // Deposit
      const depositAmount = ethers.parseEther("5");
      const debtAmount = BTC_PRICE * 5n;
      await wbtc.connect(user1).approve(await lt.getAddress(), depositAmount);
      await lt.connect(user1).deposit(depositAmount, debtAmount, 0, user1.address);

      const ppsBefore = await lt.pricePerShare();

      // Simulate time passing (interest accrues on debt)
      await time.increase(30 * 24 * 3600); // 30 days (at ~100% APR, debt grows ~8%)

      const ppsAfter = await lt.pricePerShare();
      // Without trading fees to offset, growing debt reduces LP value
      // So pricePerShare should decrease when only interest accrues
      expect(ppsAfter).to.be.lt(ppsBefore);
      // But it should still be positive (not zero)
      expect(ppsAfter).to.be.gt(0);
    });

    it("should reject deposit of zero assets", async function () {
      await expect(
        lt.connect(user1).deposit(0, 0, 0, user1.address)
      ).to.be.reverted;
    });

    it("should reject withdraw of zero shares", async function () {
      await expect(
        lt.connect(user1).withdraw(0, 0, user1.address)
      ).to.be.revertedWith("Withdrawing nothing");
    });

    it("should allow multiple deposits from different users", async function () {
      const amount = ethers.parseEther("2");
      const debt = BTC_PRICE * 2n;

      // User1 deposits
      await wbtc.connect(user1).approve(await lt.getAddress(), amount);
      await lt.connect(user1).deposit(amount, debt, 0, user1.address);

      // User2 deposits
      await wbtc.connect(user2).approve(await lt.getAddress(), amount);
      await lt.connect(user2).deposit(amount, debt, 0, user2.address);

      expect(await lt.balanceOf(user1.address)).to.be.gt(0);
      expect(await lt.balanceOf(user2.address)).to.be.gt(0);
      expect(await lt.totalSupply()).to.be.gt(0);
    });

    it("should support ERC20 transfers", async function () {
      const amount = ethers.parseEther("2");
      const debt = BTC_PRICE * 2n;

      await wbtc.connect(user1).approve(await lt.getAddress(), amount);
      await lt.connect(user1).deposit(amount, debt, 0, user1.address);

      const shares = await lt.balanceOf(user1.address);
      const half = shares / 2n;

      await lt.connect(user1).transfer(user2.address, half);
      expect(await lt.balanceOf(user2.address)).to.equal(half);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AMM Exchange Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedLevAMM Exchange", function () {
    beforeEach(async function () {
      // Seed the AMM with a deposit so exchange has liquidity
      const depositAmount = ethers.parseEther("10");
      const debtAmount = BTC_PRICE * 10n;
      await wbtc.connect(user1).approve(await lt.getAddress(), depositAmount);
      await lt.connect(user1).deposit(depositAmount, debtAmount, 0, user1.address);
    });

    it("should allow buying LP tokens with stablecoin", async function () {
      const buyAmount = ethers.parseEther("10000"); // 10k stablecoin
      await stablecoin.mint(user2.address, buyAmount);
      await stablecoin.connect(user2).approve(await amm.getAddress(), buyAmount);

      const lpBefore = await curvePool.balanceOf(user2.address);
      await amm.connect(user2).exchange(0, 1, buyAmount, 0, ethers.ZeroAddress);
      const lpAfter = await curvePool.balanceOf(user2.address);

      expect(lpAfter).to.be.gt(lpBefore);
    });

    it("should allow selling LP tokens for stablecoin", async function () {
      // First get some LP tokens
      const lpAmount = ethers.parseEther("1");
      // User2 needs LP tokens — get from the Curve pool
      await stablecoin.mint(user2.address, ethers.parseEther("100000"));
      await wbtc.mint(user2.address, ethers.parseEther("1"));
      await stablecoin.connect(user2).approve(await curvePool.getAddress(), ethers.parseEther("100000"));
      await wbtc.connect(user2).approve(await curvePool.getAddress(), ethers.parseEther("1"));
      await curvePool.connect(user2).add_liquidity(
        [ethers.parseEther("60000"), ethers.parseEther("1")],
        0, user2.address, false
      );

      const userLP = await curvePool.balanceOf(user2.address);
      expect(userLP).to.be.gt(0);

      // Sell a small amount of LP to AMM
      const sellAmount = userLP / 10n;
      await curvePool.connect(user2).approve(await amm.getAddress(), sellAmount);

      const stableBefore = await stablecoin.balanceOf(user2.address);
      await amm.connect(user2).exchange(1, 0, sellAmount, 0, ethers.ZeroAddress);
      const stableAfter = await stablecoin.balanceOf(user2.address);

      expect(stableAfter).to.be.gt(stableBefore);
    });

    it("should preview exchange amounts via getDy", async function () {
      const amount = ethers.parseEther("5000");
      const dy = await amm.getDy(0, 1, amount);
      expect(dy).to.be.gt(0);
    });

    it("should reject invalid pair", async function () {
      await expect(
        amm.connect(user2).exchange(0, 0, ethers.parseEther("100"), 0, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid pair");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Emergency Withdraw Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("MintedLT Emergency Withdraw", function () {
    beforeEach(async function () {
      const amount = ethers.parseEther("5");
      const debt = BTC_PRICE * 5n;
      await wbtc.connect(user1).approve(await lt.getAddress(), amount);
      await lt.connect(user1).deposit(amount, debt, 0, user1.address);
    });

    it("should allow emergency withdraw when not killed (owner only)", async function () {
      const shares = await lt.balanceOf(user1.address);
      const btcBefore = await wbtc.balanceOf(user1.address);

      // Approve stablecoin for potential negative net stables
      await stablecoin.connect(user1).approve(await lt.getAddress(), ethers.parseEther("1000000"));

      await lt.connect(user1).emergencyWithdraw(shares, user1.address, user1.address);

      const btcAfter = await wbtc.balanceOf(user1.address);
      expect(btcAfter).to.be.gt(btcBefore);
      expect(await lt.balanceOf(user1.address)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Admin Fee Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin Fees", function () {
    it("should track LiquidityValues", async function () {
      const amount = ethers.parseEther("5");
      const debt = BTC_PRICE * 5n;
      await wbtc.connect(user1).approve(await lt.getAddress(), amount);
      await lt.connect(user1).deposit(amount, debt, 0, user1.address);

      const liq = await lt.liquidity();
      expect(liq.total).to.be.gt(0);
    });

    it("should set fee receiver via factory", async function () {
      expect(await factory.feeReceiver()).to.equal(feeReceiver.address);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // YieldBasisStrategy V2 Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("YieldBasisStrategy (V2 — LT-based)", function () {
    let strategy: any;
    let treasury: any;

    beforeEach(async function () {
      // For strategy tests, we need a simplified TreasuryV2 mock
      // Just use deployer as treasury
      const YBStrategy = await ethers.getContractFactory("YieldBasisStrategy");
      strategy = (await upgrades.deployProxy(YBStrategy, [
        await usdc.getAddress(),
        await lt.getAddress(),
        await swapRouter.getAddress(),
        deployer.address, // treasury
        deployer.address, // admin
        deployer.address, // timelock
        "BTC",
      ])) as any;

      // Grant treasury role
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();
      await strategy.grantRole(TREASURY_ROLE, deployer.address);

      // Fund deployer with USDC
      await usdc.mint(deployer.address, ethers.parseUnits("1000000", 6));
    });

    it("should initialize correctly", async function () {
      expect(await strategy.poolLabel()).to.equal("BTC");
      expect(await strategy.isActive()).to.be.true;
      expect(await strategy.asset()).to.equal(await usdc.getAddress());
      expect(await strategy.baseAsset()).to.equal(await wbtc.getAddress());
    });

    it("should deposit USDC into leveraged LP via LT", async function () {
      const depositAmount = ethers.parseUnits("60000", 6); // 60k USDC → ~1 BTC
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      expect(await strategy.totalDeposited()).to.equal(depositAmount);

      // Strategy should hold LT shares
      const ltShares = await lt.balanceOf(await strategy.getAddress());
      expect(ltShares).to.be.gt(0);
    });

    it("should report totalValue > 0 after deposit", async function () {
      const depositAmount = ethers.parseUnits("60000", 6);
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      const value = await strategy.totalValue();
      expect(value).to.be.gt(0);
    });

    it("should withdraw USDC from leveraged LP", async function () {
      const depositAmount = ethers.parseUnits("60000", 6);
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      const usdcBefore = await usdc.balanceOf(deployer.address);
      await strategy.withdraw(ethers.parseUnits("30000", 6));
      const usdcAfter = await usdc.balanceOf(deployer.address);

      expect(usdcAfter).to.be.gt(usdcBefore);
    });

    it("should withdrawAll from leveraged LP", async function () {
      const depositAmount = ethers.parseUnits("60000", 6);
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      const usdcBefore = await usdc.balanceOf(deployer.address);
      await strategy.withdrawAll();
      const usdcAfter = await usdc.balanceOf(deployer.address);

      expect(usdcAfter).to.be.gt(usdcBefore);
      // LT shares should be 0
      expect(await lt.balanceOf(await strategy.getAddress())).to.equal(0);
    });

    it("should reject zero deposit", async function () {
      await expect(strategy.deposit(0)).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should reject deposit when inactive", async function () {
      await strategy.setActive(false);
      await usdc.approve(await strategy.getAddress(), ethers.parseUnits("1000", 6));
      await expect(strategy.deposit(ethers.parseUnits("1000", 6)))
        .to.be.revertedWithCustomError(strategy, "NotActive");
    });

    it("should reject deposit from non-treasury", async function () {
      await usdc.mint(user1.address, ethers.parseUnits("1000", 6));
      await usdc.connect(user1).approve(await strategy.getAddress(), ethers.parseUnits("1000", 6));
      await expect(strategy.connect(user1).deposit(ethers.parseUnits("1000", 6)))
        .to.be.reverted; // AccessControl revert
    });

    it("should toggle active state", async function () {
      await strategy.setActive(false);
      expect(await strategy.isActive()).to.be.false;
      await strategy.setActive(true);
      expect(await strategy.isActive()).to.be.true;
    });

    it("should track net P&L", async function () {
      const depositAmount = ethers.parseUnits("60000", 6);
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      const pnl = await strategy.netPnL();
      // Initial P&L should be near zero (accounting for slippage/fees)
      expect(pnl).to.be.lte(0); // May be slightly negative due to fees
    });

    it("should harvest and track yield", async function () {
      const depositAmount = ethers.parseUnits("60000", 6);
      await usdc.approve(await strategy.getAddress(), depositAmount);
      await strategy.deposit(depositAmount);

      const STRATEGIST = await strategy.STRATEGIST_ROLE();
      await strategy.grantRole(STRATEGIST, deployer.address);

      await strategy.harvest();
      expect(await strategy.lastHarvest()).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // End-to-End Flow
  // ═══════════════════════════════════════════════════════════════════════

  describe("End-to-End: Factory → Deposit → Trade → Withdraw", function () {
    it("should complete full lifecycle", async function () {
      // 1. Market already created in beforeEach

      // 2. User deposits WBTC into LT
      const depositAmount = ethers.parseEther("5");
      const debtAmount = BTC_PRICE * 5n;
      await wbtc.connect(user1).approve(await lt.getAddress(), depositAmount);
      await lt.connect(user1).deposit(depositAmount, debtAmount, 0, user1.address);
      const shares = await lt.balanceOf(user1.address);
      expect(shares).to.be.gt(0);

      // 3. Another user trades on the AMM (generates fees)
      const tradeAmount = ethers.parseEther("50000");
      await stablecoin.mint(user2.address, tradeAmount);
      await stablecoin.connect(user2).approve(await amm.getAddress(), tradeAmount);
      await amm.connect(user2).exchange(0, 1, tradeAmount, 0, ethers.ZeroAddress);

      // 4. Time passes
      await time.increase(30 * 24 * 3600); // 30 days

      // 5. User withdraws — should get back roughly their WBTC
      const btcBefore = await wbtc.balanceOf(user1.address);
      await lt.connect(user1).withdraw(shares, 0, user1.address);
      const btcAfter = await wbtc.balanceOf(user1.address);

      // User gets WBTC back (may be more or less depending on fees/IL)
      expect(btcAfter).to.be.gt(btcBefore);
      expect(await lt.balanceOf(user1.address)).to.equal(0);
    });
  });
});
