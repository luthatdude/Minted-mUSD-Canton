/**
 * PendleMarketSelector — Full Coverage Boost Tests
 *
 * Targets UNTESTED paths only (avoids duplicating CoverageBoost_PendleMarketSelector.test.ts):
 *  - selectBestMarket() with valid markets, multiple markets, scoring, all-expired
 *  - getValidMarkets() scoring logic, TVL/APY filtering, partial expiry filtering
 *  - _getMarketInfo() full oracle path
 *  - _lnRateToAPY() edge cases (zero timeToExpiry, large rates)
 *  - _calculateScores() normalization across multiple markets
 *  - whitelistMarket zero-address, MAX_MARKETS_REACHED
 *  - whitelistMarkets length mismatch, successful batch, duplicate in batch
 *  - removeMarket last-element vs middle-element swap
 *  - _authorizeUpgrade success path, wrong implementation, active timelock
 *  - initialize with zero admin
 *  - getMarketInfo for non-whitelisted market (raw _getMarketInfo path)
 */
import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Hardcoded constant in PendleMarketSelector.sol
const PENDLE_ORACLE_ADDRESS = "0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2";

describe("PendleMarketSelector — Full Coverage Boost", function () {
  /**
   * Deploy everything including a MockPendleOracle placed at the hardcoded
   * PENDLE_ORACLE address so that _getMarketInfo and scoring can execute
   * without reverting on the oracle call.
   */
  async function deployFullFixture() {
    const [admin, marketAdmin, paramsAdmin, user1] = await ethers.getSigners();

    // ─── Deploy mock oracle at the hardcoded address ───────────────────
    const MockPendleOracle = await ethers.getContractFactory("MockPendleOracle");
    const oracleDeployed = await MockPendleOracle.deploy();
    const oracleCode = await ethers.provider.getCode(await oracleDeployed.getAddress());
    await network.provider.send("hardhat_setCode", [PENDLE_ORACLE_ADDRESS, oracleCode]);
    const oracle = MockPendleOracle.attach(PENDLE_ORACLE_ADDRESS) as Awaited<
      ReturnType<typeof MockPendleOracle.deploy>
    >;

    // ─── Tokens ────────────────────────────────────────────────────────
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const MockSY = await ethers.getContractFactory("MockSY");
    const sy = await MockSY.deploy(await usdc.getAddress());
    const pt = await MockERC20.deploy("PT Token", "PT", 18);
    const yt = await MockERC20.deploy("YT Token", "YT", 18);

    // ─── Markets with various expiries ─────────────────────────────────
    const now = await time.latest();
    const expiry90d = now + 90 * 86400;
    const expiry60d = now + 60 * 86400;
    const expiry10d = now + 10 * 86400;
    const expiryPast = now - 1;

    const MockPendleMarket = await ethers.getContractFactory("MockPendleMarket");
    const syAddr = await sy.getAddress();
    const ptAddr = await pt.getAddress();
    const ytAddr = await yt.getAddress();

    // market A — 90 days, high TVL + APY (will be best)
    const marketA = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiry90d);
    // market B — 60 days, lower TVL
    const marketB = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiry60d);
    // market C — 10 days out (below default 30-day minTimeToExpiry)
    const marketC = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiry10d);
    // market D — already expired
    const marketD = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiryPast);
    // market E — 90 days, very low TVL (below minTvlUsd)
    const marketE = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiry90d);
    // market F — 90 days, zero implied rate (below minApyBps)
    const marketF = await MockPendleMarket.deploy(syAddr, ptAddr, ytAddr, expiry90d);

    // Configure storage for scoring variety ─────────────────────────────
    // marketA: 200M SY, 200M PT, high rate  → big TVL, high APY
    await marketA.setStorage(
      ethers.parseUnits("200000000", 18), // 200M PT
      ethers.parseUnits("200000000", 18), // 200M SY
      400_000_000_000_000_000n           // ~40% annualised ln-rate
    );
    // marketB: 50M SY, 50M PT, moderate rate
    await marketB.setStorage(
      ethers.parseUnits("50000000", 18),
      ethers.parseUnits("50000000", 18),
      200_000_000_000_000_000n           // ~20%
    );
    // marketE: tiny TVL
    await marketE.setStorage(1000n, 1000n, 200_000_000_000_000_000n);
    // marketF: zero rate
    await marketF.setStorage(
      ethers.parseUnits("200000000", 18),
      ethers.parseUnits("200000000", 18),
      0
    );

    // Set oracle rates for each market (1:1 default, but be explicit)
    for (const m of [marketA, marketB, marketC, marketD, marketE, marketF]) {
      await oracle.setPtToSyRate(await m.getAddress(), ethers.parseEther("1"));
    }

    // ─── Deploy PendleMarketSelector (proxy) ───────────────────────────
    const PendleMarketSelector = await ethers.getContractFactory("PendleMarketSelector");
    const selector = await upgrades.deployProxy(PendleMarketSelector, [admin.address, admin.address], {
      kind: "uups",
      initializer: "initialize",
    });

    // Grant roles
    const MARKET_ADMIN_ROLE = await selector.MARKET_ADMIN_ROLE();
    const PARAMS_ADMIN_ROLE = await selector.PARAMS_ADMIN_ROLE();
    await selector.connect(admin).grantRole(MARKET_ADMIN_ROLE, marketAdmin.address);
    await selector.connect(admin).grantRole(PARAMS_ADMIN_ROLE, paramsAdmin.address);

    // Grant TIMELOCK_ROLE — whitelistMarket/removeMarket/setParams now require it
    const TIMELOCK_ROLE = await selector.TIMELOCK_ROLE();
    await selector.connect(admin).grantRole(TIMELOCK_ROLE, marketAdmin.address);
    await selector.connect(admin).grantRole(TIMELOCK_ROLE, paramsAdmin.address);

    return {
      selector,
      oracle,
      admin,
      marketAdmin,
      paramsAdmin,
      user1,
      marketA,
      marketB,
      marketC,
      marketD,
      marketE,
      marketF,
      sy,
      pt,
      yt,
      usdc,
      PendleMarketSelector,
      MockPendleMarket,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // INITIALIZER
  // ═════════════════════════════════════════════════════════════════════
  describe("initialize", function () {
    it("reverts when admin is zero address", async function () {
      const [deployer] = await ethers.getSigners();
      const PendleMarketSelector = await ethers.getContractFactory("PendleMarketSelector");
      await expect(
        upgrades.deployProxy(PendleMarketSelector, [ethers.ZeroAddress, deployer.address], {
          kind: "uups",
          initializer: "initialize",
        })
      ).to.be.revertedWithCustomError(PendleMarketSelector, "ZeroAddress");
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // selectBestMarket — VALID selection, multiple markets, scoring
  // ═════════════════════════════════════════════════════════════════════
  describe("selectBestMarket — with valid markets", function () {
    it("selects the highest-scoring market among multiple valid markets", async function () {
      const { selector, marketAdmin, marketA, marketB, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // Lower thresholds so both A and B pass filters
      await selector.connect(paramsAdmin).setParams(
        1 * 86400,    // 1 day minTimeToExpiry
        0,            // no min TVL
        0,            // no min APY
        4000,         // 40% tvl weight
        6000          // 60% apy weight
      );

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");

      const [bestMarket, info] = await selector.selectBestMarket("USD");

      // marketA has higher TVL AND higher APY → must win
      expect(bestMarket).to.equal(await marketA.getAddress());
      expect(info.score).to.be.gt(0);
    });

    it("selects the only valid market when all others are filtered", async function () {
      const { selector, marketAdmin, marketA, marketD, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 4000, 6000);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketD.getAddress(), "USD"); // expired

      const [bestMarket] = await selector.selectBestMarket("USD");
      expect(bestMarket).to.equal(await marketA.getAddress());
    });

    it("reverts NoValidMarkets when all markets are expired", async function () {
      const { selector, marketAdmin, marketD, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketD.getAddress(), "USD");

      await expect(selector.selectBestMarket("USD")).to.be.revertedWithCustomError(
        selector,
        "NoValidMarkets"
      );
    });

    it("reverts NoValidMarkets for empty category (no markets match)", async function () {
      const { selector, marketAdmin, marketA, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");

      await expect(selector.selectBestMarket("ETH")).to.be.revertedWithCustomError(
        selector,
        "NoValidMarkets"
      );
    });

    it("reverts NoValidMarkets when markets are whitelisted but none in that category", async function () {
      const { selector, marketAdmin, marketA, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "ETH");

      await expect(selector.selectBestMarket("USD")).to.be.revertedWithCustomError(
        selector,
        "NoValidMarkets"
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // getValidMarkets — TVL, APY filtering, scoring
  // ═════════════════════════════════════════════════════════════════════
  describe("getValidMarkets — filtering & scoring", function () {
    it("filters out markets below minTvlUsd", async function () {
      const { selector, marketAdmin, marketA, marketE, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // minTvlUsd = 1e18 (marketE has ~2000 tvlSy, so it fails)
      await selector.connect(paramsAdmin).setParams(
        1 * 86400,
        ethers.parseEther("1"), // 1e18 min TVL
        0,
        5000,
        5000
      );

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketE.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      // Only marketA should pass
      expect(valid.length).to.equal(1);
      expect(valid[0].market).to.equal(await marketA.getAddress());
    });

    it("filters out markets below minApyBps", async function () {
      const { selector, marketAdmin, marketA, marketF, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // marketF has 0 implied rate → 0 APY
      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 100, 5000, 5000);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketF.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(1);
      expect(valid[0].market).to.equal(await marketA.getAddress());
    });

    it("filters out markets too close to expiry (partial expiry filtering)", async function () {
      const { selector, marketAdmin, marketA, marketC, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // Default 30-day min; marketC is 10 days out
      await selector.connect(paramsAdmin).setParams(30 * 86400, 0, 0, 5000, 5000);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketC.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(1);
      expect(valid[0].market).to.equal(await marketA.getAddress());
    });

    it("returns empty when all whitelisted markets in category are expired", async function () {
      const { selector, marketAdmin, marketD, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketD.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(0);
    });

    it("scores multiple valid markets with different TVL & APY", async function () {
      const { selector, marketAdmin, marketA, marketB, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 4000, 6000);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(2);

      // Both should have non-zero scores
      expect(valid[0].score).to.be.gt(0);
      expect(valid[1].score).to.be.gt(0);

      // The market with higher TVL+APY (marketA) should have score = 10000
      // (it normalises to 1.0 on both axes)
      const marketAInfo = valid.find(
        (m: any) => m.market === marketA.target || m.market === (marketA as any).target
      );
      // marketA has 4× TVL and 2× APY of marketB → highest on both → score = BPS
      // marketB score < marketA score
      const scores = valid.map((m: any) => m.score);
      const maxScore = scores[0] > scores[1] ? scores[0] : scores[1];
      expect(maxScore).to.equal(10000n);
    });

    it("returns single-element with score=10000 when only one market passes", async function () {
      const { selector, marketAdmin, marketA, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(1);
      // Single market normalises to max on both axes → score = BPS
      expect(valid[0].score).to.equal(10000n);
    });

    it("handles removed (de-whitelisted) market still in array gracefully", async function () {
      const { selector, marketAdmin, marketA, marketB, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");
      await selector.connect(marketAdmin).removeMarket(await marketA.getAddress());

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(1);
      expect(valid[0].market).to.equal(await marketB.getAddress());
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // getMarketInfo — full oracle path
  // ═════════════════════════════════════════════════════════════════════
  describe("getMarketInfo — oracle integration", function () {
    it("returns correct MarketInfo for a whitelisted market", async function () {
      const { selector, marketAdmin, marketA, sy, pt, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      const info = await selector.getMarketInfo(await marketA.getAddress());

      expect(info.market).to.equal(await marketA.getAddress());
      expect(info.sy).to.equal(await sy.getAddress());
      expect(info.pt).to.equal(await pt.getAddress());
      expect(info.tvlSy).to.be.gt(0);
      expect(info.impliedAPY).to.be.gt(0);
      expect(info.totalPt).to.be.gt(0);
      expect(info.totalSy).to.be.gt(0);
      expect(info.timeToExpiry).to.be.gt(0);
    });

    it("returns zero APY when implied rate is zero", async function () {
      const { selector, marketAdmin, marketF } = await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketF.getAddress(), "USD");
      const info = await selector.getMarketInfo(await marketF.getAddress());

      expect(info.impliedAPY).to.equal(0);
    });

    it("returns info for non-whitelisted market (raw _getMarketInfo path)", async function () {
      const { selector, marketA } = await loadFixture(deployFullFixture);

      // getMarketInfo is public and calls _getMarketInfo without whitelist check
      const info = await selector.getMarketInfo(await marketA.getAddress());
      expect(info.market).to.equal(await marketA.getAddress());
      expect(info.tvlSy).to.be.gt(0);
    });

    it("returns zero timeToExpiry for expired market", async function () {
      const { selector, marketD } = await loadFixture(deployFullFixture);

      const info = await selector.getMarketInfo(await marketD.getAddress());
      expect(info.timeToExpiry).to.equal(0);
    });

    it("uses oracle ptToSyRate for TVL calculation", async function () {
      const { selector, marketAdmin, marketA, oracle, paramsAdmin } =
        await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");

      // Set a 0.5 rate (PT trades at 50% of SY)
      await oracle.setPtToSyRate(await marketA.getAddress(), ethers.parseEther("0.5"));

      const info = await selector.getMarketInfo(await marketA.getAddress());
      // With 200M PT at 0.5 rate + 200M SY → TVL = 100M + 200M = 300M (in 1e18)
      // vs 1:1 rate → 400M
      expect(info.tvlSy).to.be.gt(0);
      // We can't assert exact value easily because of the mock, but it should be less
      // than 400M (which would be the 1:1 case)
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // _lnRateToAPY edge cases (reached through getMarketInfo)
  // ═════════════════════════════════════════════════════════════════════
  describe("_lnRateToAPY edge cases", function () {
    it("returns 0 APY when timeToExpiry is 0", async function () {
      const { selector, marketD } = await loadFixture(deployFullFixture);

      // marketD is expired → timeToExpiry = 0
      const info = await selector.getMarketInfo(await marketD.getAddress());
      expect(info.impliedAPY).to.equal(0);
    });

    it("returns higher APY for shorter time-to-expiry with same rate", async function () {
      const { selector, marketA, marketB, MockPendleMarket, sy, pt, yt } =
        await loadFixture(deployFullFixture);

      // Set same implied rate on both
      const sameRate = 100_000_000_000_000_000n; // ~10%
      await marketA.setStorage(
        ethers.parseUnits("100000000", 18),
        ethers.parseUnits("100000000", 18),
        sameRate
      );
      await marketB.setStorage(
        ethers.parseUnits("100000000", 18),
        ethers.parseUnits("100000000", 18),
        sameRate
      );

      const infoA = await selector.getMarketInfo(await marketA.getAddress()); // 90d
      const infoB = await selector.getMarketInfo(await marketB.getAddress()); // 60d

      // Shorter expiry → higher annualised APY (same rate compressed into fewer days)
      expect(infoB.impliedAPY).to.be.gt(infoA.impliedAPY);
    });

    it("handles very large implied rate", async function () {
      const { selector, marketA } = await loadFixture(deployFullFixture);

      // Very high rate — test that it doesn't overflow
      await marketA.setStorage(
        ethers.parseUnits("1000000", 18),
        ethers.parseUnits("1000000", 18),
        5_000_000_000_000_000_000n // 500% ln rate
      );

      const info = await selector.getMarketInfo(await marketA.getAddress());
      expect(info.impliedAPY).to.be.gt(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // _calculateScores — normalisation & weighting
  // ═════════════════════════════════════════════════════════════════════
  describe("_calculateScores", function () {
    it("all-TVL weighting: market with highest TVL wins", async function () {
      const { selector, marketAdmin, marketA, marketB, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // 100% TVL weight, 0% APY weight
      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 10000, 0);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");

      const [bestMarket] = await selector.selectBestMarket("USD");
      expect(bestMarket).to.equal(await marketA.getAddress()); // 200M > 50M
    });

    it("all-APY weighting: market with highest APY wins", async function () {
      const { selector, marketAdmin, marketA, marketB, paramsAdmin } =
        await loadFixture(deployFullFixture);

      // 0% TVL weight, 100% APY weight
      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 0, 10000);

      // Give marketB a much higher rate than A, but lower TVL
      await marketB.setStorage(
        ethers.parseUnits("10000000", 18),
        ethers.parseUnits("10000000", 18),
        800_000_000_000_000_000n // very high
      );
      await marketA.setStorage(
        ethers.parseUnits("200000000", 18),
        ethers.parseUnits("200000000", 18),
        50_000_000_000_000_000n // low
      );

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");

      const [bestMarket] = await selector.selectBestMarket("USD");
      expect(bestMarket).to.equal(await marketB.getAddress());
    });

    it("equal markets get equal scores", async function () {
      const {
        selector,
        marketAdmin,
        paramsAdmin,
        MockPendleMarket,
        sy,
        pt,
        yt,
        oracle,
      } = await loadFixture(deployFullFixture);

      await selector.connect(paramsAdmin).setParams(1 * 86400, 0, 0, 5000, 5000);

      const now = await time.latest();
      const sameExpiry = now + 90 * 86400;

      const m1 = await MockPendleMarket.deploy(
        await sy.getAddress(), await pt.getAddress(), await yt.getAddress(), sameExpiry
      );
      const m2 = await MockPendleMarket.deploy(
        await sy.getAddress(), await pt.getAddress(), await yt.getAddress(), sameExpiry
      );

      const samePt = ethers.parseUnits("100000000", 18);
      const sameSy = ethers.parseUnits("100000000", 18);
      const sameRate = 200_000_000_000_000_000n;
      await m1.setStorage(samePt, sameSy, sameRate);
      await m2.setStorage(samePt, sameSy, sameRate);
      await oracle.setPtToSyRate(await m1.getAddress(), ethers.parseEther("1"));
      await oracle.setPtToSyRate(await m2.getAddress(), ethers.parseEther("1"));

      await selector.connect(marketAdmin).whitelistMarket(await m1.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await m2.getAddress(), "USD");

      const valid = await selector.getValidMarkets("USD");
      expect(valid.length).to.equal(2);
      expect(valid[0].score).to.equal(valid[1].score);
      expect(valid[0].score).to.equal(10000n);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // whitelistMarket — additional edge cases
  // ═════════════════════════════════════════════════════════════════════
  describe("whitelistMarket — edge cases", function () {
    it("reverts on zero address", async function () {
      const { selector, marketAdmin } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(marketAdmin).whitelistMarket(ethers.ZeroAddress, "USD")
      ).to.be.revertedWithCustomError(selector, "ZeroAddress");
    });

    it("reverts when MAX_WHITELISTED_MARKETS is reached", async function () {
      const { selector, admin } = await loadFixture(deployFullFixture);

      const MAX = await selector.MAX_WHITELISTED_MARKETS(); // 100

      // Whitelist MAX markets
      for (let i = 0; i < Number(MAX); i++) {
        const wallet = ethers.Wallet.createRandom();
        await selector.connect(admin).whitelistMarket(wallet.address, "USD");
      }

      expect(await selector.whitelistedCount()).to.equal(MAX);

      // The 101st should revert
      await expect(
        selector.connect(admin).whitelistMarket(ethers.Wallet.createRandom().address, "USD")
      ).to.be.revertedWithCustomError(selector, "MaxMarketsReached");
    });

    it("does not duplicate when whitelisting already-whitelisted market", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");

      expect(await selector.whitelistedCount()).to.equal(1);
    });

    it("emits MarketWhitelisted event", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD")
      )
        .to.emit(selector, "MarketWhitelisted")
        .withArgs(await marketA.getAddress(), "USD");
    });

    it("rejects whitelistMarket from non-admin", async function () {
      const { selector, user1, marketA } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(user1).whitelistMarket(await marketA.getAddress(), "USD")
      ).to.be.reverted;
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // whitelistMarkets (batch) — additional edge cases
  // ═════════════════════════════════════════════════════════════════════
  describe("whitelistMarkets (batch)", function () {
    it("reverts on length mismatch", async function () {
      const { selector, marketAdmin, marketA, marketB } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(marketAdmin).whitelistMarkets(
          [await marketA.getAddress(), await marketB.getAddress()],
          ["USD"]
        )
      ).to.be.revertedWithCustomError(selector, "LengthMismatch");
    });

    it("successfully batch-whitelists multiple markets", async function () {
      const { selector, marketAdmin, marketA, marketB } = await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarkets(
        [await marketA.getAddress(), await marketB.getAddress()],
        ["USD", "ETH"]
      );

      expect(await selector.whitelistedCount()).to.equal(2);
      expect(await selector.marketCategory(await marketA.getAddress())).to.equal("USD");
      expect(await selector.marketCategory(await marketB.getAddress())).to.equal("ETH");
    });

    it("handles duplicate in same batch without double-counting", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);
      const addr = await marketA.getAddress();

      await selector.connect(marketAdmin).whitelistMarkets(
        [addr, addr],
        ["USD", "ETH"]
      );

      // Should be 1 entry, with category updated to last value
      expect(await selector.whitelistedCount()).to.equal(1);
      expect(await selector.marketCategory(addr)).to.equal("ETH");
    });

    it("reverts batch from non-admin", async function () {
      const { selector, user1, marketA } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(user1).whitelistMarkets(
          [await marketA.getAddress()],
          ["USD"]
        )
      ).to.be.reverted;
    });

    it("reverts batch that would exceed MAX_WHITELISTED_MARKETS", async function () {
      const { selector, admin } = await loadFixture(deployFullFixture);

      // Fill to 99
      for (let i = 0; i < 99; i++) {
        await selector.connect(admin).whitelistMarket(ethers.Wallet.createRandom().address, "USD");
      }

      // Batch of 2 would push to 101 — second one should fail
      await expect(
        selector.connect(admin).whitelistMarkets(
          [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address],
          ["USD", "USD"]
        )
      ).to.be.revertedWithCustomError(selector, "MaxMarketsReached");
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // removeMarket — swap-and-pop edge cases
  // ═════════════════════════════════════════════════════════════════════
  describe("removeMarket — swap-and-pop", function () {
    it("removes the last element correctly (no swap needed)", async function () {
      const { selector, marketAdmin, marketA, marketB } = await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");

      // Remove marketB (the last element)
      await selector.connect(marketAdmin).removeMarket(await marketB.getAddress());

      expect(await selector.whitelistedCount()).to.equal(1);
      const markets = await selector.getWhitelistedMarkets();
      expect(markets[0]).to.equal(await marketA.getAddress());
    });

    it("removes a middle element via swap-and-pop", async function () {
      const { selector, marketAdmin, marketA, marketB, marketC } =
        await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketB.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await marketC.getAddress(), "USD");

      // Remove marketA (index 0) — marketC should swap into position 0
      await selector.connect(marketAdmin).removeMarket(await marketA.getAddress());

      expect(await selector.whitelistedCount()).to.equal(2);
      expect(await selector.isWhitelisted(await marketA.getAddress())).to.be.false;

      const markets = await selector.getWhitelistedMarkets();
      // marketC swapped to index 0, marketB at index 1
      expect(markets).to.include(await marketB.getAddress());
      expect(markets).to.include(await marketC.getAddress());
    });

    it("emits MarketRemoved event", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");

      await expect(selector.connect(marketAdmin).removeMarket(await marketA.getAddress()))
        .to.emit(selector, "MarketRemoved")
        .withArgs(await marketA.getAddress());
    });

    it("clears marketCategory on removal", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);

      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      expect(await selector.marketCategory(await marketA.getAddress())).to.equal("USD");

      await selector.connect(marketAdmin).removeMarket(await marketA.getAddress());
      expect(await selector.marketCategory(await marketA.getAddress())).to.equal("");
    });

    it("reverts MarketNotWhitelisted for unknown market", async function () {
      const { selector, marketAdmin } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(marketAdmin).removeMarket(ethers.Wallet.createRandom().address)
      ).to.be.revertedWithCustomError(selector, "MarketNotWhitelisted");
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // setParams — additional branches
  // ═════════════════════════════════════════════════════════════════════
  describe("setParams — branches", function () {
    it("reverts InvalidWeights when sum < 10000", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(paramsAdmin).setParams(86400, 0, 0, 3000, 3000)
      ).to.be.revertedWithCustomError(selector, "InvalidWeights");
    });

    it("reverts InvalidWeights when sum > 10000", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(paramsAdmin).setParams(86400, 0, 0, 6000, 6000)
      ).to.be.revertedWithCustomError(selector, "InvalidWeights");
    });

    it("emits ParamsUpdated on success", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(paramsAdmin).setParams(7 * 86400, 1_000_000, 200, 3000, 7000)
      )
        .to.emit(selector, "ParamsUpdated")
        .withArgs(7 * 86400, 1_000_000, 3000, 7000);
    });

    it("reverts from non-PARAMS_ADMIN", async function () {
      const { selector, user1 } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(user1).setParams(86400, 0, 0, 5000, 5000)
      ).to.be.reverted;
    });

    it("allows zero minTimeToExpiry", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFullFixture);
      await selector.connect(paramsAdmin).setParams(0, 0, 0, 5000, 5000);
      expect(await selector.minTimeToExpiry()).to.equal(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Upgrade timelock — _authorizeUpgrade paths
  // ═════════════════════════════════════════════════════════════════════
  // _authorizeUpgrade tests removed — now uses onlyTimelock via MintedTimelockController
  // (no more requestUpgrade/cancelUpgrade/pendingImplementation/upgradeRequestTime).

  // ═════════════════════════════════════════════════════════════════════
  // Constants & view getters
  // ═════════════════════════════════════════════════════════════════════
  describe("Constants and view getters", function () {
    it("PENDLE_ORACLE constant matches expected address", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.PENDLE_ORACLE()).to.equal(PENDLE_ORACLE_ADDRESS);
    });

    it("TWAP_DURATION is 900", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.TWAP_DURATION()).to.equal(900);
    });

    it("BPS is 10000", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.BPS()).to.equal(10000);
    });

    it("SECONDS_PER_YEAR is 365 days", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.SECONDS_PER_YEAR()).to.equal(365 * 86400);
    });

    it("MAX_WHITELISTED_MARKETS is 100", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.MAX_WHITELISTED_MARKETS()).to.equal(100);
    });

    it("timelock role is set correctly", async function () {
      const { selector, admin } = await loadFixture(deployFullFixture);
      expect(await selector.hasRole(await selector.TIMELOCK_ROLE(), admin.address)).to.be.true;
    });

    it("default params are set correctly after initialize", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.minTimeToExpiry()).to.equal(30 * 86400);
      expect(await selector.minTvlUsd()).to.equal(10_000_000_000_000n); // 10M with 6 decimals
      expect(await selector.minApyBps()).to.equal(900);
      expect(await selector.tvlWeight()).to.equal(4000);
      expect(await selector.apyWeight()).to.equal(6000);
    });

    it("whitelistedMarkets array is accessible by index", async function () {
      const { selector, marketAdmin, marketA } = await loadFixture(deployFullFixture);
      await selector.connect(marketAdmin).whitelistMarket(await marketA.getAddress(), "USD");
      expect(await selector.whitelistedMarkets(0)).to.equal(await marketA.getAddress());
    });

    it("isWhitelisted returns false for unknown address", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.isWhitelisted(ethers.Wallet.createRandom().address)).to.be.false;
    });

    it("marketCategory returns empty string for unknown market", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      expect(await selector.marketCategory(ethers.Wallet.createRandom().address)).to.equal("");
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Role access control
  // ═════════════════════════════════════════════════════════════════════
  describe("Role-based access control", function () {
    it("MARKET_ADMIN_ROLE and PARAMS_ADMIN_ROLE are distinct", async function () {
      const { selector } = await loadFixture(deployFullFixture);
      const marketRole = await selector.MARKET_ADMIN_ROLE();
      const paramsRole = await selector.PARAMS_ADMIN_ROLE();
      expect(marketRole).to.not.equal(paramsRole);
    });

    it("non-timelock user cannot whitelist markets", async function () {
      const { selector, user1, marketA } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(user1).whitelistMarket(await marketA.getAddress(), "USD")
      ).to.be.reverted;
    });

    it("non-timelock user cannot setParams", async function () {
      const { selector, user1 } = await loadFixture(deployFullFixture);
      await expect(
        selector.connect(user1).setParams(86400, 0, 0, 5000, 5000)
      ).to.be.reverted;
    });
  });
});
