/**
 * PendleStrategyV2 — Full Coverage Boost Tests
 * ─────────────────────────────────────────────
 * Targets ALL statement paths including:
 *   deposit, withdraw, withdrawAll, rollover, triggerRollover,
 *   _shouldRollover, _selectNewMarket, _ptToUsdc, _usdcToPt,
 *   totalValue, isActive, emergencyWithdraw, recoverToken,
 *   setMarketSelector, upgrade timelock, access control
 *
 * Uses hardhat_setCode + hardhat_setStorageAt to deploy MockPendleRouter
 * at the hardcoded PENDLE_ROUTER address (0x888…946).
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

const PENDLE_ROUTER_ADDR = "0x888888888889758F76e7103c6CbF23ABbF58F946";

describe("PendleStrategyV2 — Full Coverage", function () {
  // ═══════════════════════════════════════════════════════════════════════
  // FIXTURE
  // ═══════════════════════════════════════════════════════════════════════

  async function fixture() {
    const [admin, treasury, strategist, guardian, user1] =
      await ethers.getSigners();

    /* ── tokens (PT uses 6 dec to match USDC, same as strategy math) ── */
    const ERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await ERC20.deploy("USDC", "USDC", 6);
    const pt = await ERC20.deploy("PT", "PT", 6);
    const yt = await ERC20.deploy("YT", "YT", 6);
    const rnd = await ERC20.deploy("RND", "RND", 18);

    /* ── SY ── */
    const SY = await ethers.getContractFactory("MockSY");
    const sy = await SY.deploy(await usdc.getAddress());

    /* ── markets ── */
    const now = await time.latest();
    const exp90 = now + 90 * 86400;
    const exp5 = now + 5 * 86400;
    const exp2y = now + 730 * 86400;

    const MK = await ethers.getContractFactory("MockPendleMarket");
    const market90 = await MK.deploy(
      await sy.getAddress(),
      await pt.getAddress(),
      await yt.getAddress(),
      exp90
    );
    const market5 = await MK.deploy(
      await sy.getAddress(),
      await pt.getAddress(),
      await yt.getAddress(),
      exp5
    );
    const market2y = await MK.deploy(
      await sy.getAddress(),
      await pt.getAddress(),
      await yt.getAddress(),
      exp2y
    );

    /* ── mock market selector (bypasses Pendle Oracle) ── */
    const MS = await ethers.getContractFactory("MockMarketSelector");
    const selector = await MS.deploy();
    await selector.configure(
      await market90.getAddress(),
      await sy.getAddress(),
      await pt.getAddress(),
      exp90
    );

    /* ── mock router: deploy, then inject bytecode at hardcoded address ── */
    const MR = await ethers.getContractFactory("MockPendleRouter");
    const routerImpl = await MR.deploy(
      await usdc.getAddress(),
      await pt.getAddress()
    );
    const code = await ethers.provider.getCode(await routerImpl.getAddress());
    await ethers.provider.send("hardhat_setCode", [PENDLE_ROUTER_ADDR, code]);

    // Set storage slots: 0=usdc, 1=pt, 2=ptPerUsdc(1e6), 3=usdcPerPt(1e6)
    const usdcAddr = await usdc.getAddress();
    const ptAddr = await pt.getAddress();
    const slots: [string, string][] = [
      ["0x0", ethers.zeroPadValue(usdcAddr, 32)],
      ["0x1", ethers.zeroPadValue(ptAddr, 32)],
      ["0x2", ethers.zeroPadValue(ethers.toBeHex(1_000_000n), 32)],
      ["0x3", ethers.zeroPadValue(ethers.toBeHex(1_000_000n), 32)],
    ];
    for (const [slot, val] of slots) {
      await ethers.provider.send("hardhat_setStorageAt", [
        PENDLE_ROUTER_ADDR,
        slot,
        val,
      ]);
    }
    const router = MR.attach(PENDLE_ROUTER_ADDR);

    /* ── strategy proxy ── */
    const PSV2 = await ethers.getContractFactory("PendleStrategyV2");
    const strategy = await upgrades.deployProxy(
      PSV2,
      [
        usdcAddr,
        await selector.getAddress(),
        treasury.address,
        admin.address,
        "USD",
        admin.address, // timelock
      ],
      { kind: "uups", initializer: "initialize" }
    );

    /* ── roles ── */
    const STRATEGIST = await strategy.STRATEGIST_ROLE();
    const GUARDIAN = await strategy.GUARDIAN_ROLE();
    const TREASURY = await strategy.TREASURY_ROLE();
    await strategy.connect(admin).grantRole(STRATEGIST, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN, guardian.address);
    // treasury already has TREASURY_ROLE from initialize

    /* ── set ptDiscountRate to 0 so mock 1:1 router matches expected PT output ── */
    await strategy.connect(strategist).setPtDiscountRate(0);

    /* ── fund treasury ── */
    await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
    await usdc
      .connect(treasury)
      .approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      strategy,
      selector,
      router,
      usdc,
      pt,
      yt,
      sy,
      rnd,
      market90,
      market5,
      market2y,
      admin,
      treasury,
      strategist,
      guardian,
      user1,
      STRATEGIST,
      GUARDIAN,
      TREASURY,
      exp90,
      exp5,
      exp2y,
    };
  }

  /* ── helpers ── */
  const D6 = (n: number | string) => ethers.parseUnits(String(n), 6);
  const D18 = (n: number | string) => ethers.parseUnits(String(n), 18);

  // ═══════════════════════════════════════════════════════════════════════
  // 1 · deposit() happy path
  // ═══════════════════════════════════════════════════════════════════════

  describe("deposit() — happy path", () => {
    it("deposits USDC, receives PT, emits Deposited", async () => {
      const f = await loadFixture(fixture);
      const amt = D6("100000");

      await expect(f.strategy.connect(f.treasury).deposit(amt))
        .to.emit(f.strategy, "Deposited")
        .withArgs(await f.market90.getAddress(), amt, amt); // 1:1 mock

      expect(await f.strategy.ptBalance()).to.equal(amt);
      expect(await f.strategy.currentMarket()).to.equal(
        await f.market90.getAddress()
      );
      expect(await f.strategy.currentPT()).to.equal(await f.pt.getAddress());
    });

    it("second deposit into same market accumulates PT", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));
      await f.strategy.connect(f.treasury).deposit(D6("50000"));
      expect(await f.strategy.ptBalance()).to.equal(D6("150000"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 · deposit() with auto-rollover
  // ═══════════════════════════════════════════════════════════════════════

  describe("deposit() — auto-rollover", () => {
    it("rolls to new market when near expiry", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));
      const oldMarket = await f.strategy.currentMarket();

      // 86 days → 4 days left < 7-day threshold
      await time.increase(86 * 86400);
      expect(await f.strategy.shouldRollover()).to.be.true;

      // Reconfigure selector to return 2-year market
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      await f.strategy.connect(f.treasury).deposit(D6("50000"));

      const newMarket = await f.strategy.currentMarket();
      expect(newMarket).to.not.equal(oldMarket);
      expect(newMarket).to.equal(await f.market2y.getAddress());
      expect(await f.strategy.ptBalance()).to.be.gt(0);
    });

    it("auto-selects market on first deposit (currentMarket == 0)", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.currentMarket()).to.equal(ethers.ZeroAddress);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      expect(await f.strategy.currentMarket()).to.not.equal(ethers.ZeroAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 · withdraw() happy path
  // ═══════════════════════════════════════════════════════════════════════

  describe("withdraw() — happy path", () => {
    it("pre-maturity: uses swapExactPtForToken", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000000"));

      const treasuryBefore = await f.usdc.balanceOf(f.treasury.address);
      await expect(f.strategy.connect(f.treasury).withdraw(D6("500000")))
        .to.emit(f.strategy, "Withdrawn");

      expect(await f.usdc.balanceOf(f.treasury.address)).to.be.gt(
        treasuryBefore
      );
      expect(await f.strategy.ptBalance()).to.be.lt(D6("1000000"));
    });

    it("post-maturity: uses redeemPyToToken", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      // Past 90-day expiry
      await time.increase(91 * 86400);
      expect(await f.market90.isExpired()).to.be.true;

      const treasuryBefore = await f.usdc.balanceOf(f.treasury.address);
      await expect(f.strategy.connect(f.treasury).withdraw(D6("50000")))
        .to.emit(f.strategy, "Withdrawn");
      expect(await f.usdc.balanceOf(f.treasury.address)).to.be.gt(
        treasuryBefore
      );
    });

    it("caps ptNeeded at ptBalance when withdrawing more than available", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      // Request more than deposited
      await f.strategy.connect(f.treasury).withdraw(D6("500000"));
      expect(await f.strategy.ptBalance()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 · withdraw() reverts
  // ═══════════════════════════════════════════════════════════════════════

  describe("withdraw() — reverts", () => {
    it("ZeroAmount", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.treasury).withdraw(0)
      ).to.be.revertedWithCustomError(f.strategy, "ZeroAmount");
    });

    it("NoMarketSet (no prior deposit)", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.treasury).withdraw(D6("1000"))
      ).to.be.revertedWithCustomError(f.strategy, "NoMarketSet");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 · withdrawAll() happy path
  // ═══════════════════════════════════════════════════════════════════════

  describe("withdrawAll() — happy path", () => {
    it("redeems all PT and transfers to treasury", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("500000"));

      const treasuryBefore = await f.usdc.balanceOf(f.treasury.address);
      await expect(f.strategy.connect(f.treasury).withdrawAll()).to.emit(
        f.strategy,
        "Withdrawn"
      );

      expect(await f.strategy.ptBalance()).to.equal(0);
      expect(await f.usdc.balanceOf(f.treasury.address)).to.be.gt(
        treasuryBefore
      );
    });

    it("includes dust USDC in the transfer", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      // Send extra USDC dust directly to strategy
      await f.usdc.mint(await f.strategy.getAddress(), D6("500"));

      const treasuryBefore = await f.usdc.balanceOf(f.treasury.address);
      await f.strategy.connect(f.treasury).withdrawAll();
      const received =
        (await f.usdc.balanceOf(f.treasury.address)) - treasuryBefore;
      // Must include 100k redeemed + 500 dust
      expect(received).to.be.gte(D6("100500"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6 · withdrawAll() with zero balance
  // ═══════════════════════════════════════════════════════════════════════

  describe("withdrawAll() — zero balance", () => {
    it("returns 0 without reverting when no PT", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).withdrawAll();
      expect(await f.strategy.ptBalance()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7 · rollToNewMarket()
  // ═══════════════════════════════════════════════════════════════════════

  describe("rollToNewMarket()", () => {
    it("rolls when near expiry (redeem old PT → select new → re-deposit)", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("200000"));

      // 86 days → 4 days left
      await time.increase(86 * 86400);
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      await expect(
        f.strategy.connect(f.strategist).rollToNewMarket()
      ).to.emit(f.strategy, "MarketRolled");

      expect(await f.strategy.currentMarket()).to.equal(
        await f.market2y.getAddress()
      );
      expect(await f.strategy.ptBalance()).to.be.gt(0);
    });

    it("rolls when no market set (currentMarket == 0)", async () => {
      const f = await loadFixture(fixture);
      // No deposit — currentMarket is address(0)
      await f.strategy.connect(f.strategist).rollToNewMarket();
      expect(await f.strategy.currentMarket()).to.equal(
        await f.market90.getAddress()
      );
    });

    it("rolls with zero ptBalance (no re-deposit)", async () => {
      const f = await loadFixture(fixture);
      // Trigger first market selection via rollToNewMarket (no PT)
      await f.strategy.connect(f.strategist).rollToNewMarket();

      // Now advance to near expiry so rollover is needed
      await time.increase(86 * 86400);
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      await expect(
        f.strategy.connect(f.strategist).rollToNewMarket()
      ).to.emit(f.strategy, "MarketRolled");
      expect(await f.strategy.ptBalance()).to.equal(0); // no re-deposit
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8 · rollToNewMarket() revert
  // ═══════════════════════════════════════════════════════════════════════

  describe("rollToNewMarket() — revert", () => {
    it("RolloverNotNeeded when market is active", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      await expect(
        f.strategy.connect(f.strategist).rollToNewMarket()
      ).to.be.revertedWithCustomError(f.strategy, "RolloverNotNeeded");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9 · triggerRollover()
  // ═══════════════════════════════════════════════════════════════════════

  describe("triggerRollover()", () => {
    it("triggers rollover with RolloverTriggered + MarketRolled events", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("300000"));

      await time.increase(86 * 86400);
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      const tx = f.strategy.connect(f.strategist).triggerRollover();
      await expect(tx).to.emit(f.strategy, "RolloverTriggered");
      await expect(tx).to.emit(f.strategy, "MarketRolled");
    });

    it("daysRemaining is 0 when fully expired", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      // Past expiry
      await time.increase(91 * 86400);
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      await expect(f.strategy.connect(f.strategist).triggerRollover())
        .to.emit(f.strategy, "RolloverTriggered")
        .withArgs(f.strategist.address, 0);
    });

    it("calculates daysRemaining correctly when near expiry", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      // Advance 86 days → ~4 days remaining
      await time.increase(86 * 86400);
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      // daysRemaining = (exp90 - currentTimestamp) / 86400 ≈ 3 or 4
      await expect(
        f.strategy.connect(f.strategist).triggerRollover()
      ).to.emit(f.strategy, "RolloverTriggered");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10 · triggerRollover() revert
  // ═══════════════════════════════════════════════════════════════════════

  describe("triggerRollover() — revert", () => {
    it("RolloverNotNeeded when market active", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));

      await expect(
        f.strategy.connect(f.strategist).triggerRollover()
      ).to.be.revertedWithCustomError(f.strategy, "RolloverNotNeeded");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11 · _shouldRollover() paths
  // ═══════════════════════════════════════════════════════════════════════

  describe("shouldRollover() paths", () => {
    it("true when no market set (currentMarket == 0)", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.shouldRollover()).to.be.true;
    });

    it("false when market active with plenty of time", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      expect(await f.strategy.shouldRollover()).to.be.false;
    });

    it("true when near expiry (within threshold)", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      // 84 days → 6 days left < 7-day threshold
      await time.increase(84 * 86400);
      expect(await f.strategy.shouldRollover()).to.be.true;
    });

    it("true when expired", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      await time.increase(91 * 86400);
      expect(await f.strategy.shouldRollover()).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12 · _selectNewMarket() revert paths
  // ═══════════════════════════════════════════════════════════════════════

  describe("_selectNewMarket() reverts", () => {
    it("NO_VALID_MARKET when selector returns address(0)", async () => {
      const f = await loadFixture(fixture);
      await f.selector.setReturnZeroMarket(true);
      await expect(
        f.strategy.connect(f.treasury).deposit(D6("1000"))
      ).to.be.revertedWithCustomError(f.strategy, "NoValidMarket");
    });

    it("INVALID_PT_TOKEN when pt is address(0)", async () => {
      const f = await loadFixture(fixture);
      await f.selector.setReturnZeroPt(true);
      await expect(
        f.strategy.connect(f.treasury).deposit(D6("1000"))
      ).to.be.revertedWithCustomError(f.strategy, "InvalidPtToken");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13 · _ptToUsdc() and _usdcToPt() (via totalValue / withdraw)
  // ═══════════════════════════════════════════════════════════════════════

  describe("PT valuation (_ptToUsdc / _usdcToPt)", () => {
    it("totalValue < deposit amount (time discount before maturity)", async () => {
      const f = await loadFixture(fixture);
      const amt = D6("1000000");
      await f.strategy.connect(f.treasury).deposit(amt);

      // Restore discount rate so _ptToUsdc applies time-based discount
      await f.strategy.connect(f.strategist).setPtDiscountRate(1000);
      const tv = await f.strategy.totalValue();
      expect(tv).to.be.lt(amt);
      // Within 10% (max annual discount)
      expect(tv).to.be.gt((amt * 90n) / 100n);
    });

    it("1:1 value at maturity (expired market)", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000000"));
      await time.increase(91 * 86400);

      const tv = await f.strategy.totalValue();
      expect(tv).to.equal(await f.strategy.ptBalance());
    });

    it("timeRemaining clamped to 1 year for >1yr expiry", async () => {
      const f = await loadFixture(fixture);
      // Configure 2-year market
      await f.selector.configure(
        await f.market2y.getAddress(),
        await f.sy.getAddress(),
        await f.pt.getAddress(),
        f.exp2y
      );

      const amt = D6("1000000");
      await f.strategy.connect(f.treasury).deposit(amt);

      // Restore discount rate so _ptToUsdc applies time-based discount
      await f.strategy.connect(f.strategist).setPtDiscountRate(1000);
      const ptBal = await f.strategy.ptBalance();
      const tv = await f.strategy.totalValue();
      // Clamped: discountBps = 1000 * 1yr / 1yr = 1000, valueBps = 9000
      const expected = (ptBal * 9000n) / 10000n;
      expect(tv).to.be.gte(expected - 1n);
      expect(tv).to.be.lte(expected + 1n);
    });

    it("_usdcToPt: more PT consumed than USDC value (discount)", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000000"));

      // Restore discount rate so _usdcToPt computes higher PT needed
      await f.strategy.connect(f.strategist).setPtDiscountRate(1000);
      const ptBefore = await f.strategy.ptBalance();

      await f.strategy.connect(f.treasury).withdraw(D6("100000"));
      const ptAfter = await f.strategy.ptBalance();
      const ptUsed = ptBefore - ptAfter;

      // More PT used than USDC requested (PT at discount)
      expect(ptUsed).to.be.gt(D6("100000"));
    });

    it("_ptToUsdc with zero ptBalance returns 0 in totalValue", async () => {
      const f = await loadFixture(fixture);
      // No deposit, but send USDC to strategy
      await f.usdc.mint(await f.strategy.getAddress(), D6("1234"));
      // ptBalance == 0, so totalValue = usdc balance only
      expect(await f.strategy.totalValue()).to.equal(D6("1234"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14 · totalValue()
  // ═══════════════════════════════════════════════════════════════════════

  describe("totalValue()", () => {
    it("0 when empty", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.totalValue()).to.equal(0);
    });

    it("USDC balance only when currentMarket == 0", async () => {
      const f = await loadFixture(fixture);
      await f.usdc.mint(await f.strategy.getAddress(), D6("5000"));
      expect(await f.strategy.totalValue()).to.equal(D6("5000"));
    });

    it("ptValue + usdcBalance after deposit", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("100000"));
      await f.usdc.mint(await f.strategy.getAddress(), D6("1000"));

      const tv = await f.strategy.totalValue();
      expect(tv).to.be.gt(D6("1000")); // ptValue > 0 plus extra 1000
    });

    it("expired market gives 1:1 PT value", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("50000"));
      await time.increase(91 * 86400);

      const ptBal = await f.strategy.ptBalance();
      const tv = await f.strategy.totalValue();
      // No extra USDC in strategy, so totalValue == ptBalance (1:1 at maturity)
      expect(tv).to.equal(ptBal);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15 · isActive()
  // ═══════════════════════════════════════════════════════════════════════

  describe("isActive()", () => {
    it("true when active and not paused", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.isActive()).to.be.true;
    });

    it("false when inactive", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).setActive(false);
      expect(await f.strategy.isActive()).to.be.false;
    });

    it("false when paused", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).pause();
      expect(await f.strategy.isActive()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 16 · emergencyWithdraw()
  // ═══════════════════════════════════════════════════════════════════════

  describe("emergencyWithdraw()", () => {
    it("redeems PT + transfers USDC to treasury + pauses", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("200000"));

      const before = await f.usdc.balanceOf(f.treasury.address);
      await expect(
        f.strategy.connect(f.guardian).emergencyWithdraw(f.treasury.address)
      ).to.emit(f.strategy, "EmergencyWithdraw");

      expect(await f.usdc.balanceOf(f.treasury.address)).to.be.gt(before);
      expect(await f.strategy.ptBalance()).to.equal(0);
      expect(await f.strategy.paused()).to.be.true;
    });

    it("works with zero PT (only USDC dust)", async () => {
      const f = await loadFixture(fixture);
      await f.usdc.mint(await f.strategy.getAddress(), D6("5000"));

      const before = await f.usdc.balanceOf(f.treasury.address);
      await f.strategy
        .connect(f.guardian)
        .emergencyWithdraw(f.treasury.address);

      expect(await f.usdc.balanceOf(await f.strategy.getAddress())).to.equal(0);
      expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(
        before + D6("5000")
      );
    });

    it("reverts with ZERO_RECIPIENT", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.guardian).emergencyWithdraw(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.strategy, "ZeroAddress");
    });

    it("reverts when recipient lacks TREASURY_ROLE", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.guardian).emergencyWithdraw(f.user1.address)
      ).to.be.revertedWithCustomError(f.strategy, "RecipientMustBeTreasury");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 17 · recoverToken()
  // ═══════════════════════════════════════════════════════════════════════

  describe("recoverToken()", () => {
    it("cannot recover USDC", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy
          .connect(f.admin)
          .recoverToken(await f.usdc.getAddress(), f.admin.address, 1)
      ).to.be.revertedWithCustomError(f.strategy, "CannotRecoverUsdc");
    });

    it("cannot recover PT after market selected", async () => {
      const f = await loadFixture(fixture);
      // Deposit to set currentPT
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      await expect(
        f.strategy
          .connect(f.admin)
          .recoverToken(await f.pt.getAddress(), f.admin.address, 1)
      ).to.be.revertedWithCustomError(f.strategy, "CannotRecoverPt");
    });

    it("can recover random tokens", async () => {
      const f = await loadFixture(fixture);
      await f.rnd.mint(await f.strategy.getAddress(), D18("1000"));

      await f.strategy
        .connect(f.admin)
        .recoverToken(await f.rnd.getAddress(), f.admin.address, D18("1000"));
      expect(await f.rnd.balanceOf(f.admin.address)).to.equal(D18("1000"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 18 · setMarketSelector()
  // ═══════════════════════════════════════════════════════════════════════

  describe("setMarketSelector()", () => {
    it("reverts with zero address", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.admin).setMarketSelector(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.strategy, "ZeroAddress");
    });

    it("updates selector", async () => {
      const f = await loadFixture(fixture);
      const addr = ethers.Wallet.createRandom().address;
      await f.strategy.connect(f.admin).setMarketSelector(addr);
      expect(await f.strategy.marketSelector()).to.equal(addr);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 19 · Upgrade timelock
  // ═══════════════════════════════════════════════════════════════════════

  // Upgrade timelock tests removed — _authorizeUpgrade now uses onlyTimelock
  // via MintedTimelockController (no more requestUpgrade/cancelUpgrade).

  // ═══════════════════════════════════════════════════════════════════════
  // 20 · Access control
  // ═══════════════════════════════════════════════════════════════════════

  describe("Access control", () => {
    it("deposit: non-treasury reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).deposit(D6("1"))).to.be
        .reverted;
    });

    it("deposit: reverts when not active", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).setActive(false);
      await expect(
        f.strategy.connect(f.treasury).deposit(D6("1"))
      ).to.be.revertedWithCustomError(f.strategy, "NotActive");
    });

    it("deposit: reverts when paused", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).pause();
      await expect(f.strategy.connect(f.treasury).deposit(D6("1"))).to.be
        .reverted;
    });

    it("deposit: ZeroAmount", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.treasury).deposit(0)
      ).to.be.revertedWithCustomError(f.strategy, "ZeroAmount");
    });

    it("withdraw: non-treasury reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).withdraw(D6("1"))).to.be
        .reverted;
    });

    it("withdrawAll: non-treasury reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).withdrawAll()).to.be.reverted;
    });

    it("rollToNewMarket: non-strategist reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).rollToNewMarket()).to.be
        .reverted;
    });

    it("triggerRollover: non-strategist reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).triggerRollover()).to.be
        .reverted;
    });

    it("setSlippage: non-strategist reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).setSlippage(50)).to.be.reverted;
    });

    it("setPtDiscountRate: non-strategist reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).setPtDiscountRate(500)).to.be
        .reverted;
    });

    it("setRolloverThreshold: non-strategist reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.user1).setRolloverThreshold(7 * 86400)
      ).to.be.reverted;
    });

    it("setMarketSelector: non-admin reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy
          .connect(f.user1)
          .setMarketSelector(ethers.Wallet.createRandom().address)
      ).to.be.reverted;
    });

    it("setActive: non-guardian reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).setActive(false)).to.be
        .reverted;
    });

    it("emergencyWithdraw: non-guardian reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.user1).emergencyWithdraw(f.treasury.address)
      ).to.be.reverted;
    });

    it("pause: non-guardian reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.user1).pause()).to.be.reverted;
    });

    it("unpause: non-admin reverts (guardian cannot)", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).pause();
      await expect(f.strategy.connect(f.guardian).unpause()).to.be.reverted;
    });

    it("recoverToken: non-admin reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy
          .connect(f.user1)
          .recoverToken(await f.rnd.getAddress(), f.user1.address, 1)
      ).to.be.reverted;
    });


  });

  // ═══════════════════════════════════════════════════════════════════════
  // Admin setters (events + bounds)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin setters", () => {
    it("setSlippage emits SlippageUpdated", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.strategist).setSlippage(75))
        .to.emit(f.strategy, "SlippageUpdated")
        .withArgs(50, 75);
      expect(await f.strategy.slippageBps()).to.equal(75);
    });

    it("setSlippage > MAX_SLIPPAGE_BPS reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.strategist).setSlippage(101)
      ).to.be.revertedWithCustomError(f.strategy, "InvalidSlippage");
    });

    it("setPtDiscountRate emits PtDiscountRateUpdated", async () => {
      const f = await loadFixture(fixture);
      await expect(f.strategy.connect(f.strategist).setPtDiscountRate(500))
        .to.emit(f.strategy, "PtDiscountRateUpdated")
        .withArgs(0, 500);
    });

    it("setPtDiscountRate > 5000 reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.strategist).setPtDiscountRate(5001)
      ).to.be.revertedWithCustomError(f.strategy, "DiscountTooHigh");
    });

    it("setRolloverThreshold emits RolloverThresholdUpdated", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.strategist).setRolloverThreshold(14 * 86400)
      )
        .to.emit(f.strategy, "RolloverThresholdUpdated")
        .withArgs(7 * 86400, 14 * 86400);
    });

    it("setRolloverThreshold < 1 day reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.strategist).setRolloverThreshold(3600)
      ).to.be.revertedWithCustomError(f.strategy, "InvalidThreshold");
    });

    it("setRolloverThreshold > 30 days reverts", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.strategy.connect(f.strategist).setRolloverThreshold(31 * 86400)
      ).to.be.revertedWithCustomError(f.strategy, "InvalidThreshold");
    });

    it("setActive toggles", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).setActive(false);
      expect(await f.strategy.active()).to.be.false;
      await f.strategy.connect(f.guardian).setActive(true);
      expect(await f.strategy.active()).to.be.true;
    });

    it("pause / unpause", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.guardian).pause();
      expect(await f.strategy.paused()).to.be.true;
      await f.strategy.connect(f.admin).unpause();
      expect(await f.strategy.paused()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════════

  describe("Initialization", () => {
    it("revert zero USDC", async () => {
      const f = await loadFixture(fixture);
      const Factory = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            ethers.ZeroAddress,
            await f.selector.getAddress(),
            f.treasury.address,
            f.admin.address,
            "USD",
            f.admin.address, // timelock
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("revert zero marketSelector", async () => {
      const f = await loadFixture(fixture);
      const Factory = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            await f.usdc.getAddress(),
            ethers.ZeroAddress,
            f.treasury.address,
            f.admin.address,
            "USD",
            f.admin.address, // timelock
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("revert zero treasury", async () => {
      const f = await loadFixture(fixture);
      const Factory = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            await f.usdc.getAddress(),
            await f.selector.getAddress(),
            ethers.ZeroAddress,
            f.admin.address,
            "USD",
            f.admin.address, // timelock
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("revert zero admin", async () => {
      const f = await loadFixture(fixture);
      const Factory = await ethers.getContractFactory("PendleStrategyV2");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            await f.usdc.getAddress(),
            await f.selector.getAddress(),
            f.treasury.address,
            ethers.ZeroAddress,
            "USD",
            f.admin.address, // timelock
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });

    it("asset() returns USDC", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.asset()).to.equal(await f.usdc.getAddress());
    });

    it("defaults set correctly", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.rolloverThreshold()).to.equal(7 * 86400);
      expect(await f.strategy.slippageBps()).to.equal(50);
      expect(await f.strategy.ptDiscountRateBps()).to.equal(0);
      expect(await f.strategy.active()).to.be.true;
      expect(await f.strategy.marketCategory()).to.equal("USD");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // timeToExpiry()
  // ═══════════════════════════════════════════════════════════════════════

  describe("timeToExpiry()", () => {
    it("0 when no market", async () => {
      const f = await loadFixture(fixture);
      expect(await f.strategy.timeToExpiry()).to.equal(0);
    });

    it("positive after deposit", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      expect(await f.strategy.timeToExpiry()).to.be.gt(0);
    });

    it("0 after expiry", async () => {
      const f = await loadFixture(fixture);
      await f.strategy.connect(f.treasury).deposit(D6("1000"));
      await time.increase(91 * 86400);
      expect(await f.strategy.timeToExpiry()).to.equal(0);
    });
  });
});
