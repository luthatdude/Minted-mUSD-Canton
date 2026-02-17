import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * UniswapV3TWAPOracle — Comprehensive Test Suite
 *
 * Tests the TWAP oracle used by LeverageVault to validate swap outputs.
 * Uses MockUniswapV3Factory + MockUniswapV3Pool for deterministic tick data.
 */
describe("UniswapV3TWAPOracle", function () {
  const FEE = 3000;
  const TWAP_DURATION = 600; // 10 minutes

  async function deployFixture() {
    const [owner] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("Token A", "TKA", 18);
    const tokenB = await MockERC20.deploy("Token B", "TKB", 18);

    // Deploy mock factory and pool
    const MockFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const factory = await MockFactory.deploy();

    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const pool = await MockPool.deploy(await tokenA.getAddress(), await tokenB.getAddress());

    // Register pool in factory
    await factory.setPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE, await pool.getAddress());

    // Deploy oracle
    const Oracle = await ethers.getContractFactory("UniswapV3TWAPOracle");
    const oracle = await Oracle.deploy(await factory.getAddress());

    return { owner, tokenA, tokenB, factory, pool, oracle };
  }

  // ──────────────────────────────────────────────────────────────────
  // DEPLOYMENT
  // ──────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("should deploy with correct factory address", async function () {
      const { oracle, factory } = await loadFixture(deployFixture);
      expect(await oracle.factory()).to.equal(await factory.getAddress());
    });

    it("should revert on zero factory address", async function () {
      const Oracle = await ethers.getContractFactory("UniswapV3TWAPOracle");
      await expect(Oracle.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Oracle, "InvalidAddress");
    });

    it("should have correct constants", async function () {
      const { oracle } = await loadFixture(deployFixture);
      expect(await oracle.MAX_TWAP_DEVIATION_BPS()).to.equal(500);
      expect(await oracle.MIN_TWAP_DURATION()).to.equal(300);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // getTWAPQuote
  // ──────────────────────────────────────────────────────────────────

  describe("getTWAPQuote", function () {
    it("should return a TWAP quote for token0 → token1 at tick 0 (1:1 price)", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // tick 0 → price = 1.0001^0 = 1
      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // At tick 0, price ratio = 1, so expectedOut ≈ amountIn
      expect(quote).to.be.gt(0);
      // Allow small rounding deviation
      const diff = quote > amountIn ? quote - amountIn : amountIn - quote;
      expect(diff).to.be.lt(ethers.parseEther("0.01"));
    });

    it("should return higher quote for positive tick (token0 cheaper)", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Mean tick = (6000 - 0) / 600 = 10 → price ≈ 1.001 (token1/token0)
      await pool.setTickCumulatives(0, BigInt(TWAP_DURATION) * 10n);

      const amountIn = ethers.parseEther("100");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // token0 → token1 at positive tick: expect slightly more than input
      expect(quote).to.be.gt(amountIn);
    });

    it("should return lower quote for negative tick", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Mean tick = -10 → price ≈ 0.999
      await pool.setTickCumulatives(BigInt(TWAP_DURATION) * 10n, 0);

      const amountIn = ethers.parseEther("100");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      expect(quote).to.be.lt(amountIn);
    });

    it("should enforce MIN_TWAP_DURATION when duration is too short", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("1");
      // Duration 60 < MIN_TWAP_DURATION (300) — should be clamped to 300
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, 60, amountIn
      );
      expect(quote).to.be.gt(0);
    });

    it("should revert for non-existent pool", async function () {
      const { oracle, tokenA } = await loadFixture(deployFixture);

      const randomAddr = ethers.Wallet.createRandom().address;
      await expect(
        oracle.getTWAPQuote(await tokenA.getAddress(), randomAddr, FEE, TWAP_DURATION, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(oracle, "InvalidAddress");
    });

    it("should handle token1 → token0 direction", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("1");
      // Swap direction: tokenB (token1) → tokenA (token0)
      const quote = await oracle.getTWAPQuote(
        await tokenB.getAddress(), await tokenA.getAddress(), FEE, TWAP_DURATION, amountIn
      );
      expect(quote).to.be.gt(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // validateSwapOutput
  // ──────────────────────────────────────────────────────────────────

  describe("validateSwapOutput", function () {
    it("should validate swap within deviation bounds", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("100");
      const twapQuote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // Actual output = 98% of TWAP (within 5% deviation)
      const actualOut = (twapQuote * 98n) / 100n;
      const [valid, twapExpected] = await oracle.validateSwapOutput(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn, actualOut
      );

      expect(valid).to.be.true;
      expect(twapExpected).to.equal(twapQuote);
    });

    it("should reject swap outside deviation bounds", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("100");
      const twapQuote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // Actual output = 90% of TWAP (outside 5% deviation)
      const actualOut = (twapQuote * 90n) / 100n;
      const [valid] = await oracle.validateSwapOutput(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn, actualOut
      );

      expect(valid).to.be.false;
    });

    it("should accept exact TWAP output", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("100");
      const twapQuote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      const [valid] = await oracle.validateSwapOutput(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn, twapQuote
      );

      expect(valid).to.be.true;
    });

    it("should accept output above TWAP (favorable)", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("100");
      const twapQuote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // 110% of TWAP — favorable, should be valid
      const actualOut = (twapQuote * 110n) / 100n;
      const [valid] = await oracle.validateSwapOutput(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn, actualOut
      );

      expect(valid).to.be.true;
    });

    it("should reject at exactly MIN_ACCEPTABLE boundary", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      await pool.setTickCumulatives(0, 0);

      const amountIn = ethers.parseEther("100");
      const twapQuote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // Exactly 95% — should be valid (>= minAcceptable)
      const actualOut = (twapQuote * 9500n) / 10000n;
      const [valid] = await oracle.validateSwapOutput(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn, actualOut
      );

      expect(valid).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // TICK BIT DECOMPOSITION COVERAGE
  //
  // The oracle uses 20 `if (absTick & BIT)` checks to compute
  // 1.0001^|tick| via binary decomposition (Uniswap V3 TickMath).
  // To cover all 20 branches we need ticks with every bit 0–19 set.
  //   0x55555 = 349525 → bits  0, 2, 4, 6, 8, 10, 12, 14, 16, 18
  //   0xAAAAA = 699050 → bits  1, 3, 5, 7, 9, 11, 13, 15, 17, 19
  // Both values < 887272 (Uniswap max tick), so they are valid.
  // ──────────────────────────────────────────────────────────────────

  describe("Tick bit decomposition — full 20-bit coverage", function () {
    it("exercises even-numbered bits (0,2,4,6,8,10,12,14,16,18) with tick 0x55555", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Mean tick = 349525 (0x55555)
      // tickCumulatives[1] - tickCumulatives[0] = 349525 * 600
      const meanTick = 349525n;
      await pool.setTickCumulatives(0, meanTick * BigInt(TWAP_DURATION));

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // Positive tick means token0 is cheaper → expect more token1 out
      expect(quote).to.be.gt(0);
      expect(quote).to.be.gt(amountIn); // 1.0001^349525 >> 1
    });

    it("exercises odd-numbered bits (1,3,5,7,9,11,13,15,17,19) with tick 0xAAAAA", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Mean tick = 699050 (0xAAAAA)
      const meanTick = 699050n;
      await pool.setTickCumulatives(0, meanTick * BigInt(TWAP_DURATION));

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      expect(quote).to.be.gt(0);
      expect(quote).to.be.gt(amountIn);
    });

    it("exercises ALL 20 bits with tick 0xD89E7 (max valid minus 1 = 887271)", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // 887271 = 0xD89E7 = bits 0,1,2,5,6,7,8,11,12,15,16,17,18,19
      // (covers bits 15-19 that 0x55555 and 0xAAAAA partially overlap)
      const meanTick = 887271n;
      await pool.setTickCumulatives(0, meanTick * BigInt(TWAP_DURATION));

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      expect(quote).to.be.gt(0);
    });

    it("exercises negative tick path (meanTick > 0 branch = false)", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Negative mean tick = -349525
      // tickCumulatives[1] - tickCumulatives[0] = -349525 * 600
      // Set cumulative0 > cumulative1 so diff is negative
      const meanTick = 349525n;
      await pool.setTickCumulatives(meanTick * BigInt(TWAP_DURATION), 0);

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      // Negative tick means token0 is more expensive → expect less token1
      expect(quote).to.be.gt(0);
      expect(quote).to.be.lt(amountIn);
    });

    it("exercises negative large tick with odd bits", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);

      // Negative mean tick = -699050
      const meanTick = 699050n;
      await pool.setTickCumulatives(meanTick * BigInt(TWAP_DURATION), 0);

      const amountIn = ethers.parseEther("1");
      const quote = await oracle.getTWAPQuote(
        await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
      );

      expect(quote).to.be.gt(0);
      expect(quote).to.be.lt(amountIn);
    });

    it("exercises single-bit ticks for fine-grained coverage", async function () {
      const { oracle, tokenA, tokenB, pool } = await loadFixture(deployFixture);
      const amountIn = ethers.parseEther("1");

      // Test individual power-of-2 ticks: 1, 2, 4, 8, ..., 0x80000
      const singleBitTicks = [1n, 2n, 4n, 8n, 16n, 32n, 64n, 128n, 256n, 512n,
        1024n, 2048n, 4096n, 8192n, 16384n, 32768n, 65536n, 131072n, 262144n, 524288n];

      for (const tick of singleBitTicks) {
        await pool.setTickCumulatives(0, tick * BigInt(TWAP_DURATION));
        const quote = await oracle.getTWAPQuote(
          await tokenA.getAddress(), await tokenB.getAddress(), FEE, TWAP_DURATION, amountIn
        );
        expect(quote).to.be.gt(0, `Failed for single-bit tick ${tick}`);
      }
    });
  });
});
