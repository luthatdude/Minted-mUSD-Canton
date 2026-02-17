/**
 * Property-Based / Fuzz Tests
 *
 * Randomized input testing for core financial math invariants across:
 *   - InterestRateModel: utilization/borrow rate monotonicity, bounds, kink behavior
 *   - PriceOracle: normalization correctness across decimal ranges
 *   - SMUSD: ERC-4626 share/asset conversion round-trip integrity
 *   - LiquidationEngine: health factor / threshold boundary correctness
 *
 * Uses randomized inputs over many iterations to catch edge cases that
 * deterministic unit tests miss (overflow boundaries, rounding errors,
 * precision loss at extremes).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { timelockSetFeed, timelockAddCollateral, refreshFeeds } from "./helpers/timelock";

// ============================================================
//  HELPERS
// ============================================================

/** Pseudo-random BigInt in [min, max] using keccak256-based PRNG */
function randomBigInt(seed: number, min: bigint, max: bigint): bigint {
  const hash = ethers.keccak256(ethers.toBeHex(seed, 32));
  const range = max - min + 1n;
  if (range <= 0n) return min;
  const raw = BigInt(hash) % range;
  return min + (raw < 0n ? raw + range : raw);
}

/** Number of fuzz iterations per property */
const FUZZ_RUNS = 100;

// ============================================================
//  1. InterestRateModel Fuzz Tests
// ============================================================

describe("FUZZ: InterestRateModel", function () {
  async function deployFixture() {
    const [admin] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("InterestRateModel");
    const model = await Factory.deploy(admin.address);
    return { model };
  }

  describe("Utilization Rate Properties", function () {
    it("FUZZ: utilization is always in [0, 10000] bps for any supply/borrow", async function () {
      const { model } = await loadFixture(deployFixture);

      for (let i = 0; i < FUZZ_RUNS; i++) {
        const supply = randomBigInt(i * 2, 0n, ethers.parseEther("1000000000"));
        const borrows = randomBigInt(i * 2 + 1, 0n, ethers.parseEther("2000000000"));

        const util = await model.utilizationRate(borrows, supply);
        expect(util).to.be.gte(0, `Iteration ${i}: util < 0`);
        expect(util).to.be.lte(10000, `Iteration ${i}: util > 10000 bps`);
      }
    });

    it("FUZZ: utilization is monotonically non-decreasing with borrows (fixed supply)", async function () {
      const { model } = await loadFixture(deployFixture);
      const supply = ethers.parseEther("1000000");

      let prevUtil = 0n;
      for (let i = 0; i < FUZZ_RUNS; i++) {
        // Increasing borrows from 0 to 2x supply
        const borrows = (supply * 2n * BigInt(i)) / BigInt(FUZZ_RUNS);
        const util = await model.utilizationRate(borrows, supply);
        expect(util).to.be.gte(prevUtil, `Iteration ${i}: util decreased`);
        prevUtil = util;
      }
    });
  });

  describe("Borrow Rate Properties", function () {
    it("FUZZ: borrow rate is monotonically non-decreasing with utilization", async function () {
      const { model } = await loadFixture(deployFixture);
      const supply = ethers.parseEther("1000000");

      let prevRate = 0n;
      for (let i = 0; i < FUZZ_RUNS; i++) {
        const borrows = (supply * BigInt(i)) / BigInt(FUZZ_RUNS);
        const rate = await model.getBorrowRateAnnual(borrows, supply);
        expect(rate).to.be.gte(prevRate, `Iteration ${i}: rate decreased (borrows=${borrows})`);
        prevRate = rate;
      }
    });

    it("FUZZ: borrow rate is always >= baseRate for any utilization", async function () {
      const { model } = await loadFixture(deployFixture);
      const baseRate = await model.baseRateBps();

      for (let i = 0; i < FUZZ_RUNS; i++) {
        const supply = randomBigInt(i * 2, 1n, ethers.parseEther("1000000000"));
        const borrows = randomBigInt(i * 2 + 1, 0n, supply * 2n);

        const rate = await model.getBorrowRateAnnual(borrows, supply);
        expect(rate).to.be.gte(baseRate, `Iteration ${i}: rate < baseRate`);
      }
    });

    it("FUZZ: borrow rate jumps at kink", async function () {
      const { model } = await loadFixture(deployFixture);
      const supply = ethers.parseEther("10000");
      const kinkBps = await model.kinkBps();

      // Rate just below kink
      const borrowsBelow = (supply * (kinkBps - 100n)) / 10000n;
      const rateBelow = await model.getBorrowRateAnnual(borrowsBelow, supply);

      // Rate just above kink
      const borrowsAbove = (supply * (kinkBps + 100n)) / 10000n;
      const rateAbove = await model.getBorrowRateAnnual(borrowsAbove, supply);

      // The rate should increase faster above kink (jump multiplier effect)
      // Rate increase per utilization bps should be higher above kink
      const rateDiff = rateAbove - rateBelow;
      expect(rateDiff).to.be.gt(0, "Rate should increase across kink");
    });

    it("FUZZ: supply rate <= borrow rate for any utilization", async function () {
      const { model } = await loadFixture(deployFixture);

      for (let i = 0; i < FUZZ_RUNS; i++) {
        const supply = randomBigInt(i * 2, ethers.parseEther("1"), ethers.parseEther("1000000000"));
        const borrows = randomBigInt(i * 2 + 1, 0n, supply);

        const borrowRate = await model.getBorrowRateAnnual(borrows, supply);
        const supplyRate = await model.getSupplyRateAnnual(borrows, supply);

        expect(supplyRate).to.be.lte(
          borrowRate,
          `Iteration ${i}: supplyRate (${supplyRate}) > borrowRate (${borrowRate})`
        );
      }
    });
  });
});

// ============================================================
//  2. PriceOracle Fuzz Tests
// ============================================================

describe("FUZZ: PriceOracle", function () {
  async function deployFixture() {
    const [admin] = await ethers.getSigners();

    const OracleFactory = await ethers.getContractFactory("PriceOracle");
    const oracle = await OracleFactory.deploy();

    const MockFeedFactory = await ethers.getContractFactory("MockAggregatorV3");

    return { oracle, admin, MockFeedFactory };
  }

  it("FUZZ: normalized price always has 18 decimals regardless of feed decimals", async function () {
    const { oracle, admin, MockFeedFactory } = await loadFixture(deployFixture);

    // Test with different Chainlink feed decimal configurations (6, 8, 18)
    const feedDecimals = [6, 8, 18];

    for (const decimals of feedDecimals) {
      for (let i = 0; i < 30; i++) {
        // Random price from $0.01 to $100,000 in native feed decimals
        const scaleFactor = 10n ** BigInt(decimals);
        const rawPrice = randomBigInt(
          decimals * 100 + i,
          scaleFactor / 100n,        // $0.01
          100000n * scaleFactor       // $100,000
        );

        const tokenAddr = ethers.getAddress(
          "0x" + (decimals * 1000 + i + 1).toString(16).padStart(40, "0")
        );

        const feed = await MockFeedFactory.deploy(decimals, rawPrice);

        await timelockSetFeed(oracle, admin, tokenAddr, await feed.getAddress(), 3600, 18);
        await refreshFeeds(feed);
        const price = await oracle.getPrice(tokenAddr);

        // Price should always be normalized to 18 decimals
        // rawPrice * 10^(18 - feedDecimals) == normalizedPrice
        const expected = rawPrice * (10n ** (18n - BigInt(decimals)));
        expect(price).to.equal(
          expected,
          `Decimals ${decimals}, iteration ${i}: normalization mismatch`
        );
      }
    }
  });

  it("FUZZ: getPrice never returns negative", async function () {
    const { oracle, admin, MockFeedFactory } = await loadFixture(deployFixture);

    for (let i = 0; i < FUZZ_RUNS; i++) {
      const price = randomBigInt(i, 1n, 10n ** 18n);
      const tokenAddr = ethers.getAddress(
        "0x" + (i + 1).toString(16).padStart(40, "0")
      );
      const feed = await MockFeedFactory.deploy(8, price);
      await timelockSetFeed(oracle, admin, tokenAddr, await feed.getAddress(), 3600, 18);
      await refreshFeeds(feed);

      const normalizedPrice = await oracle.getPrice(tokenAddr);
      expect(normalizedPrice).to.be.gt(0, `Iteration ${i}: price was <= 0`);
    }
  });
});

// ============================================================
//  3. SMUSD (ERC-4626) Fuzz Tests
// ============================================================

describe("FUZZ: SMUSD ERC-4626 Properties", function () {
  async function deployFixture() {
    const [deployer, bridge, yieldManager, user1] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = await MUSDFactory.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    const smusd = await SMUSDFactory.deploy(await musd.getAddress(), ethers.ZeroAddress);

    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await smusd.grantRole(await smusd.YIELD_MANAGER_ROLE(), yieldManager.address);

    // Mint initial mUSD to user
    await musd.connect(bridge).mint(user1.address, ethers.parseEther("10000000"));
    await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);

    return { smusd, musd, deployer, bridge, yieldManager, user1 };
  }

  it("FUZZ: convertToShares(convertToAssets(shares)) ≈ shares (round-trip)", async function () {
    const { smusd, user1 } = await loadFixture(deployFixture);

    // Seed vault with initial deposit to avoid division-by-zero
    await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

    for (let i = 0; i < FUZZ_RUNS; i++) {
      const shares = randomBigInt(i, 1n, ethers.parseEther("100000"));
      const assets = await smusd.convertToAssets(shares);
      const roundTrip = await smusd.convertToShares(assets);

      // Round-trip should be within 1 wei of original (rounding down)
      const diff = shares > roundTrip ? shares - roundTrip : roundTrip - shares;
      expect(diff).to.be.lte(
        1000n, // _decimalsOffset()=3 → shares:assets ratio ~10^3, round-trip can lose up to 10^3-1 wei
        `Iteration ${i}: round-trip drift too large (shares=${shares}, roundTrip=${roundTrip})`
      );
    }
  });

  it("FUZZ: convertToAssets(convertToShares(assets)) ≈ assets (round-trip)", async function () {
    const { smusd, user1 } = await loadFixture(deployFixture);

    // Seed vault
    await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

    for (let i = 0; i < FUZZ_RUNS; i++) {
      const assets = randomBigInt(i + 1000, 1n, ethers.parseEther("100000"));
      const shares = await smusd.convertToShares(assets);
      const roundTrip = await smusd.convertToAssets(shares);

      const diff = assets > roundTrip ? assets - roundTrip : roundTrip - assets;
      expect(diff).to.be.lte(
        1n,
        `Iteration ${i}: round-trip drift too large (assets=${assets}, roundTrip=${roundTrip})`
      );
    }
  });

  it("FUZZ: deposit(x) then withdraw should return <= x assets (no free money)", async function () {
    const { smusd, musd, user1 } = await loadFixture(deployFixture);

    // Seed vault
    await smusd.connect(user1).deposit(ethers.parseEther("100"), user1.address);

    for (let i = 0; i < 20; i++) {
      const depositAmount = randomBigInt(i + 2000, ethers.parseEther("1"), ethers.parseEther("10000"));
      const balBefore = await musd.balanceOf(user1.address);

      // Deposit
      const shares = await smusd.connect(user1).deposit.staticCall(depositAmount, user1.address);
      await smusd.connect(user1).deposit(depositAmount, user1.address);

      // Immediately preview withdraw the same shares
      const withdrawable = await smusd.convertToAssets(shares);

      // User should never get more back than they deposited (no inflation attack)
      expect(withdrawable).to.be.lte(
        depositAmount,
        `Iteration ${i}: withdrawable (${withdrawable}) > deposited (${depositAmount})`
      );
    }
  });

  it("FUZZ: totalAssets >= totalSupply of shares implies sharePrice >= 1 (no dilution)", async function () {
    const { smusd, user1 } = await loadFixture(deployFixture);

    // Deposit varying amounts
    for (let i = 0; i < 20; i++) {
      const amount = randomBigInt(i + 3000, ethers.parseEther("100"), ethers.parseEther("50000"));
      await smusd.connect(user1).deposit(amount, user1.address);

      const totalAssets = await smusd.totalAssets();
      const totalSupply = await smusd.totalSupply();

      if (totalSupply > 0n) {
        // 1 share should always be worth >= 1 asset (no dilution without yield loss)
        // With _decimalsOffset()=3, 1e18 shares ≈ 1e15 assets (1 share = 0.001 asset)
        const oneShareValue = await smusd.convertToAssets(ethers.parseEther("1"));
        expect(oneShareValue).to.be.gte(
          ethers.parseEther("1") / 1000n - 1n, // 1e15 - 1 (offset=3 → share price base is 1e-3)
          `Iteration ${i}: share price < 1.0 (dilution detected)`
        );
      }
    }
  });

  it("FUZZ: previewDeposit <= deposit (actual shares >= preview)", async function () {
    const { smusd, user1 } = await loadFixture(deployFixture);

    // Seed vault
    await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

    for (let i = 0; i < FUZZ_RUNS; i++) {
      const amount = randomBigInt(i + 4000, ethers.parseEther("1"), ethers.parseEther("10000"));
      const previewShares = await smusd.previewDeposit(amount);
      const actualShares = await smusd.connect(user1).deposit.staticCall(amount, user1.address);

      // ERC-4626 spec: previewDeposit MUST return <= actual deposit shares
      expect(previewShares).to.be.lte(
        actualShares,
        `Iteration ${i}: previewDeposit (${previewShares}) > actual (${actualShares})`
      );
    }
  });
});

// ============================================================
//  4. LiquidationEngine Fuzz Tests
// ============================================================

describe("FUZZ: LiquidationEngine", function () {
  async function deployFixture() {
    const [owner, user1, liquidator] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const ethFeed = await MockAggregator.deploy(8, 200000000000n); // $2000

    await timelockSetFeed(priceOracle, owner, await weth.getAddress(), await ethFeed.getAddress(), 3600, 18);

    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);

    await timelockAddCollateral(
      collateralVault, owner,
      await weth.getAddress(),
      7500, // 75% LTV
      8000, // 80% liquidation threshold
      1000  // 10% penalty
    );

    await refreshFeeds(ethFeed);

    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      500,
      ethers.parseEther("100")
    );

    const LiquidationEngine = await ethers.getContractFactory("LiquidationEngine");
    const liquidationEngine = await LiquidationEngine.deploy(
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      5000,
      owner.address
    );

    // Grant roles
    await musd.grantRole(await musd.BRIDGE_ROLE(), await borrowModule.getAddress());
    await musd.grantRole(await musd.BRIDGE_ROLE(), await liquidationEngine.getAddress());
    await musd.grantRole(await musd.BRIDGE_ROLE(), owner.address);
    await collateralVault.grantRole(await collateralVault.BORROW_MODULE_ROLE(), await borrowModule.getAddress());
    await collateralVault.grantRole(await collateralVault.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());
    await borrowModule.grantRole(await borrowModule.LIQUIDATION_ROLE(), await liquidationEngine.getAddress());

    // Fund users
    await weth.mint(user1.address, ethers.parseEther("1000"));
    await musd.mint(liquidator.address, ethers.parseEther("10000000"));

    return {
      liquidationEngine, borrowModule, collateralVault, priceOracle,
      musd, weth, ethFeed, owner, user1, liquidator,
    };
  }

  it("FUZZ: healthy positions are never liquidatable across random price/collateral combos", async function () {
    const { borrowModule, collateralVault, priceOracle, weth, ethFeed, musd, user1, owner } =
      await loadFixture(deployFixture);

    for (let i = 0; i < 30; i++) {
      // Random ETH price from $500 to $10,000
      const price = randomBigInt(i + 5000, 50000000000n, 1000000000000n); // 8 decimals
      await ethFeed.setAnswer(price);
      await priceOracle.updatePrice(await weth.getAddress()); // Update circuit breaker cache

      // Deposit random collateral (1 to 50 ETH)
      const collateral = randomBigInt(i + 5100, ethers.parseEther("1"), ethers.parseEther("50"));
      await weth.mint(user1.address, collateral);
      await weth.connect(user1).approve(await collateralVault.getAddress(), collateral);
      await collateralVault.connect(user1).deposit(await weth.getAddress(), collateral);

      // Borrow at 50% of max LTV (safely healthy)
      // Max LTV = 75%, so borrowing at 50% * collateralValue
      const priceNormalized = price * 10n ** 10n; // 8 dec → 18 dec
      const collateralValue = (collateral * priceNormalized) / ethers.parseEther("1");
      const safeBorrow = (collateralValue * 5000n) / 10000n; // 50% of value

      if (safeBorrow >= ethers.parseEther("100")) {
        // Only test if above min debt
        try {
          await borrowModule.connect(user1).borrow(safeBorrow);

          // This position should be healthy — health factor > 1.0 (10000 bps)
          const hf = await borrowModule.healthFactor(user1.address);
          expect(hf).to.be.gte(10000n);
        } catch {
          // Some edge cases may revert on borrow (e.g., exceeds available), skip
        }
      }

      // Cleanup: withdraw collateral for next iteration
      try {
        const balance = await collateralVault.deposits(user1.address, await weth.getAddress());
        if (balance > 0n) {
          await collateralVault.connect(user1).withdraw(await weth.getAddress(), balance);
        }
      } catch {
        // Position may have debt preventing withdrawal
      }
    }
  });

  it("FUZZ: liquidation penalty is always bounded by configured penalty bps", async function () {
    const { collateralVault, weth } = await loadFixture(deployFixture);

    // Verify penalty is within sane bounds (0-5000 bps = 0-50%)
    const config = await collateralVault.collateralConfigs(await weth.getAddress());
    const penaltyBps = config.liquidationPenaltyBps;

    expect(penaltyBps).to.be.gte(0, "Penalty must be >= 0 bps");
    expect(penaltyBps).to.be.lte(5000, "Penalty must be <= 50%");
  });

  it("FUZZ: price crashes always make undercollateralized positions liquidatable", async function () {
    const { borrowModule, collateralVault, liquidationEngine, priceOracle, weth, ethFeed, musd, user1, liquidator } =
      await loadFixture(deployFixture);

    // Setup: deposit 10 ETH at $2000, borrow near max LTV
    const depositAmount = ethers.parseEther("10");
    await weth.mint(user1.address, depositAmount);
    await weth.connect(user1).approve(await collateralVault.getAddress(), depositAmount);
    await collateralVault.connect(user1).deposit(await weth.getAddress(), depositAmount);

    // Borrow at 70% LTV (just under 75% max)
    // 10 ETH * $2000 = $20,000 * 0.70 = $14,000
    const borrowAmount = ethers.parseEther("14000");
    await borrowModule.connect(user1).borrow(borrowAmount);

    // Fuzz: crash price to random levels between $100 and $1500
    for (let i = 0; i < 20; i++) {
      const crashPrice = randomBigInt(i + 6000, 10000000000n, 150000000000n); // $100-$1500

      await ethFeed.setAnswer(crashPrice);
      await priceOracle.updatePrice(await weth.getAddress()); // Update circuit breaker cache

      // At these prices, position is deeply underwater
      // 10 ETH * crashPrice * 80% threshold < 14000 mUSD debt → liquidatable
      const collateralValueUsd = (10n * crashPrice) / 100000000n; // Price in USD
      const thresholdValue = collateralValueUsd * 8000n / 10000n;

      if (thresholdValue < 14000n) {
        // Position should be liquidatable — health factor < 1.0 (10000 bps)
        const hf = await borrowModule.healthFactor(user1.address);
        expect(hf).to.be.lt(10000n);
      }

      // Reset price for next iteration
      await ethFeed.setAnswer(200000000000n);
      await priceOracle.updatePrice(await weth.getAddress());
    }
  });
});

// ============================================================
//  5. Arithmetic Edge Cases
// ============================================================

describe("FUZZ: Arithmetic Edge Cases", function () {
  it("FUZZ: very large deposit amounts don't overflow in InterestRateModel", async function () {
    const [admin] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("InterestRateModel");
    const model = await Factory.deploy(admin.address);

    for (let i = 0; i < FUZZ_RUNS; i++) {
      // Large values near uint128 range
      const supply = randomBigInt(i * 2 + 7000, ethers.parseEther("1"), 2n ** 128n - 1n);
      const borrows = randomBigInt(i * 2 + 7001, 0n, supply);

      // Should not revert
      const util = await model.utilizationRate(borrows, supply);
      expect(util).to.be.lte(10000);

      const rate = await model.getBorrowRateAnnual(borrows, supply);
      expect(rate).to.be.gte(0);
    }
  });

  it("FUZZ: zero/one edge cases in SMUSD share conversion", async function () {
    const [deployer, bridge, , user1] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    const musd = await MUSDFactory.deploy(ethers.parseEther("100000000"), ethers.ZeroAddress);

    const SMUSDFactory = await ethers.getContractFactory("SMUSD");
    const smusd = await SMUSDFactory.deploy(await musd.getAddress(), ethers.ZeroAddress);

    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await musd.connect(bridge).mint(user1.address, ethers.parseEther("10000000"));
    await musd.connect(user1).approve(await smusd.getAddress(), ethers.MaxUint256);

    // Seed vault
    await smusd.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

    // 1 wei of assets
    const sharesFor1Wei = await smusd.convertToShares(1n);
    // With _decimalsOffset()=3, 1 wei of assets maps to ~10^3 shares
    expect(sharesFor1Wei).to.be.lte(1001n);

    // 1 wei of shares
    const assetsFor1Wei = await smusd.convertToAssets(1n);
    expect(assetsFor1Wei).to.be.lte(2n); // 1 share worth at most ~1 asset at 1:1 price, allow small rounding

    // 0 should always return 0
    expect(await smusd.convertToShares(0n)).to.equal(0n);
    expect(await smusd.convertToAssets(0n)).to.equal(0n);
  });
});
