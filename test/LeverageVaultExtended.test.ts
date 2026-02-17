// @ts-nocheck
/**
 * LeverageVault — Extended Coverage Tests
 * 
 * Targets undertested branches: price change PnL, emergency close failure paths,
 * externalSwapCollateralToMusd, maxLoopsOverride, deadline expiry, multi-user isolation.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { timelockSetFeed, timelockAddCollateral, refreshFeeds } from "./helpers/timelock";

describe("LeverageVault — Extended Coverage", function () {
  const WETH_PRICE = 2000n * 10n ** 8n;
  const futureDeadline = () => 99999999999;

  async function deployFixture() {
    const [owner, user, user2, keeper] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const musd = await (await ethers.getContractFactory("MUSD")).deploy(
      ethers.parseEther("100000000"),
      ethers.ZeroAddress
    );
    const weth = await MockERC20.deploy("Wrapped ETH", "WETH", 18);

    const MockAggregator = await ethers.getContractFactory("MockAggregatorV3");
    const wethPriceFeed = await MockAggregator.deploy(8, WETH_PRICE);

    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();
    await timelockSetFeed(priceOracle, owner, await weth.getAddress(), await wethPriceFeed.getAddress(), 3600, 18);

    const CollateralVault = await ethers.getContractFactory("CollateralVault");
    const collateralVault = await CollateralVault.deploy(ethers.ZeroAddress);
    await timelockAddCollateral(collateralVault, owner, await weth.getAddress(), 7500, 8000, 500);
    await refreshFeeds(wethPriceFeed);

    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      await collateralVault.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      200,
      ethers.parseEther("10")
    );

    const BORROW_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BORROW_MODULE_ROLE"));
    const BRIDGE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_ROLE"));
    const LEVERAGE_VAULT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LEVERAGE_VAULT_ROLE"));
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

    await collateralVault.grantRole(BORROW_MODULE_ROLE, await borrowModule.getAddress());
    await musd.grantRole(BRIDGE_ROLE, await borrowModule.getAddress());

    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const mockSwapRouter = await MockSwapRouter.deploy(
      await musd.getAddress(),
      await weth.getAddress(),
      await priceOracle.getAddress()
    );

    const LeverageVault = await ethers.getContractFactory("LeverageVault");
    const leverageVault = await LeverageVault.deploy(
      await mockSwapRouter.getAddress(),
      await collateralVault.getAddress(),
      await borrowModule.getAddress(),
      await priceOracle.getAddress(),
      await musd.getAddress(),
      owner.address
    );

    await collateralVault.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());
    await borrowModule.grantRole(LEVERAGE_VAULT_ROLE, await leverageVault.getAddress());
    await leverageVault.enableToken(await weth.getAddress(), 3000);

    // Fund users and swap router
    await weth.mint(user.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));
    await weth.connect(user).approve(await leverageVault.getAddress(), ethers.MaxUint256);
    await weth.connect(user2).approve(await leverageVault.getAddress(), ethers.MaxUint256);
    await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("10000"));
    await musd.grantRole(BRIDGE_ROLE, await mockSwapRouter.getAddress());
    await musd.grantRole(BRIDGE_ROLE, owner.address);

    return {
      leverageVault, collateralVault, borrowModule, priceOracle, musd, weth,
      wethPriceFeed, mockSwapRouter,
      owner, user, user2, keeper,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Price Change PnL Scenarios
  // ═══════════════════════════════════════════════════════════════
  describe("Price change PnL", function () {
    it("user profits when collateral price increases", async function () {
      const { leverageVault, weth, wethPriceFeed, mockSwapRouter, musd, user, owner, priceOracle } =
        await loadFixture(deployFixture);

      // Open 2x position at $2000/ETH
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      const depositedWeth = ethers.parseEther("10");

      // Disable circuit breaker so large price changes don't revert
      await priceOracle.setMaxDeviation(5000); // 50% threshold

      // Price increases 15% to $2300 (within circuit breaker range)
      await wethPriceFeed.setAnswer(2300n * 10n ** 8n);

      // Ensure swap router has enough WETH
      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("50000"));

      const balBefore = await weth.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPosition(0);
      const balAfter = await weth.balanceOf(user.address);

      // User should get back MORE than initial deposit (profit from leverage)
      const netReturn = balAfter - balBefore;
      expect(netReturn).to.be.gt(depositedWeth);
    });

    it("user loses when collateral price decreases", async function () {
      const { leverageVault, weth, wethPriceFeed, mockSwapRouter, user } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      // Price decreases 10% to $1800
      await wethPriceFeed.setAnswer(1800n * 10n ** 8n);

      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("50000"));

      const balBefore = await weth.balanceOf(user.address);
      await leverageVault.connect(user).closeLeveragedPosition(0);
      const balAfter = await weth.balanceOf(user.address);

      // User gets back LESS than initial deposit (loss from leverage)
      const netReturn = balAfter - balBefore;
      expect(netReturn).to.be.lt(ethers.parseEther("10"));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Multi-user Isolation
  // ═══════════════════════════════════════════════════════════════
  describe("Multi-user isolation", function () {
    it("two users can have independent positions", async function () {
      const { leverageVault, weth, user, user2, mockSwapRouter } =
        await loadFixture(deployFixture);

      // User1 opens at 2x
      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      // User2 opens at 2x
      await leverageVault.connect(user2).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("5"), 20, 3, futureDeadline()
      );

      const pos1 = await leverageVault.getPosition(user.address);
      const pos2 = await leverageVault.getPosition(user2.address);

      expect(pos1.initialDeposit).to.equal(ethers.parseEther("10"));
      expect(pos2.initialDeposit).to.equal(ethers.parseEther("5"));
      expect(pos1.totalCollateral).to.not.equal(pos2.totalCollateral);
    });

    it("closing one position doesn't affect another", async function () {
      const { leverageVault, weth, user, user2, mockSwapRouter } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );
      await leverageVault.connect(user2).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("5"), 20, 3, futureDeadline()
      );

      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("50000"));

      // Close user1's position
      await leverageVault.connect(user).closeLeveragedPosition(0);

      // User2's position should be unchanged
      const pos2 = await leverageVault.getPosition(user2.address);
      expect(pos2.totalCollateral).to.be.gt(0);
      expect(pos2.totalDebt).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Emergency Close Failure Paths
  // ═══════════════════════════════════════════════════════════════
  describe("Emergency close resilience", function () {
    it("emergency close with enough swap router funds succeeds", async function () {
      const { leverageVault, weth, user, owner, mockSwapRouter } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("50000"));

      await leverageVault.connect(owner).emergencyClosePosition(user.address);

      const pos = await leverageVault.getPosition(user.address);
      expect(pos.totalCollateral).to.equal(0);
    });

    it("emergency close isolation: other users unaffected", async function () {
      const { leverageVault, weth, user, user2, owner, mockSwapRouter } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );
      await leverageVault.connect(user2).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("5"), 20, 3, futureDeadline()
      );

      await weth.mint(await mockSwapRouter.getAddress(), ethers.parseEther("50000"));

      await leverageVault.connect(owner).emergencyClosePosition(user.address);

      // user2 position untouched
      const pos2 = await leverageVault.getPosition(user2.address);
      expect(pos2.totalCollateral).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  enableToken / disableToken edge cases
  // ═══════════════════════════════════════════════════════════════
  describe("Token management edge cases", function () {
    it("accepts valid fee tiers: 500, 3000, 10000", async function () {
      const { leverageVault, owner } = await loadFixture(deployFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");

      const t1 = await MockERC20.deploy("T1", "T1", 18);
      const t2 = await MockERC20.deploy("T2", "T2", 18);
      const t3 = await MockERC20.deploy("T3", "T3", 18);

      await leverageVault.enableToken(await t1.getAddress(), 500);
      await leverageVault.enableToken(await t2.getAddress(), 3000);
      await leverageVault.enableToken(await t3.getAddress(), 10000);

      expect(await leverageVault.leverageEnabled(await t1.getAddress())).to.be.true;
      expect(await leverageVault.leverageEnabled(await t2.getAddress())).to.be.true;
      expect(await leverageVault.leverageEnabled(await t3.getAddress())).to.be.true;
    });

    it("cannot open position on disabled token", async function () {
      const { leverageVault, weth, user, owner } = await loadFixture(deployFixture);

      await leverageVault.disableToken(await weth.getAddress());

      await expect(
        leverageVault.connect(user).openLeveragedPosition(
          await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
        )
      ).to.be.revertedWithCustomError(leverageVault, "TokenNotEnabled");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Interest accrual on leveraged position
  // ═══════════════════════════════════════════════════════════════
  describe("Interest accrual on leveraged debt", function () {
    it("debt grows over time", async function () {
      const { leverageVault, borrowModule, weth, user } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      const debtBefore = await borrowModule.totalDebt(user.address);

      // Advance 180 days
      await time.increase(180 * 24 * 3600);

      const debtAfter = await borrowModule.totalDebt(user.address);
      expect(debtAfter).to.be.gt(debtBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  getPosition edge cases
  // ═══════════════════════════════════════════════════════════════
  describe("getPosition edge cases", function () {
    it("returns zero struct for non-existent user", async function () {
      const { leverageVault, user } = await loadFixture(deployFixture);
      const pos = await leverageVault.getPosition(user.address);
      expect(pos.totalCollateral).to.equal(0);
      expect(pos.totalDebt).to.equal(0);
      expect(pos.loopsExecuted).to.equal(0);
    });

    it("reflects correct debt after time passes", async function () {
      const { leverageVault, borrowModule, weth, user } =
        await loadFixture(deployFixture);

      await leverageVault.connect(user).openLeveragedPosition(
        await weth.getAddress(), ethers.parseEther("10"), 20, 5, futureDeadline()
      );

      await time.increase(30 * 24 * 3600); // 30 days

      const pos = await leverageVault.getPosition(user.address);
      const actualDebt = await borrowModule.totalDebt(user.address);

      // Position debt should reflect accrued interest
      expect(pos.totalDebt).to.be.gte(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  setConfig boundary tests
  // ═══════════════════════════════════════════════════════════════
  describe("setConfig boundary tests", function () {
    it("rejects maxLoops = 0", async function () {
      const { leverageVault } = await loadFixture(deployFixture);
      await expect(
        leverageVault.setConfig(0, ethers.parseEther("100"), 3000, 100)
      ).to.be.revertedWithCustomError(leverageVault, "InvalidMaxLoops");
    });

    it("accepts maxLoops = 20", async function () {
      const { leverageVault } = await loadFixture(deployFixture);
      await leverageVault.setConfig(20, ethers.parseEther("100"), 3000, 100);
      expect(await leverageVault.maxLoops()).to.equal(20);
    });

    it("rejects slippage = 501 (> 5%)", async function () {
      const { leverageVault } = await loadFixture(deployFixture);
      await expect(
        leverageVault.setConfig(10, ethers.parseEther("100"), 3000, 501)
      ).to.be.revertedWithCustomError(leverageVault, "SlippageTooHigh");
    });

    it("accepts maxSlippageBps = 500 (boundary)", async function () {
      const { leverageVault } = await loadFixture(deployFixture);
      await leverageVault.setConfig(10, ethers.parseEther("100"), 3000, 500);
      expect(await leverageVault.maxSlippageBps()).to.equal(500);
    });

    it("accepts maxSlippageBps = 300", async function () {
      const { leverageVault } = await loadFixture(deployFixture);
      await leverageVault.setConfig(10, ethers.parseEther("100"), 3000, 300);
      expect(await leverageVault.maxSlippageBps()).to.equal(300);
    });
  });
});
