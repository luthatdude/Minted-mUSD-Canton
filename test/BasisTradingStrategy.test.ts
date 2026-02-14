import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("BasisTradingStrategy", function () {
  const ETH_MARKET = ethers.keccak256(ethers.toUtf8Bytes("ETH-USD"));
  const BTC_MARKET = ethers.keccak256(ethers.toUtf8Bytes("BTC-USD"));

  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] =
      await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy WETH mock for spot asset
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy MockPerpDEX
    const MockPerpDEX = await ethers.getContractFactory("MockPerpDEX");
    const perpDex = await MockPerpDEX.deploy(await usdc.getAddress());

    // Deploy MockSpotExchange
    const MockSpotExchange = await ethers.getContractFactory("MockSpotExchange");
    const spotExchange = await MockSpotExchange.deploy(await usdc.getAddress());

    // Seed DEX with liquidity
    await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
    await usdc.connect(admin).approve(await perpDex.getAddress(), ethers.MaxUint256);
    await perpDex.connect(admin).seedLiquidity(ethers.parseUnits("50000000", 6));

    // Set spot prices
    await spotExchange.setSpotPrice(await weth.getAddress(), ethers.parseUnits("3000", 6));

    // Set funding rates (10% annualized positive = shorts earn)
    await perpDex.setMockFundingRate(ETH_MARKET, ethers.parseUnits("0.10", 18));
    await perpDex.setMockFundingRate(BTC_MARKET, ethers.parseUnits("0.08", 18));

    // Deploy BasisTradingStrategy as upgradeable
    const BasisTradingStrategy = await ethers.getContractFactory("BasisTradingStrategy");
    const strategy = await upgrades.deployProxy(
      BasisTradingStrategy,
      [
        await usdc.getAddress(),
        await perpDex.getAddress(),
        await spotExchange.getAddress(),
        treasury.address,
        admin.address,
        timelockSigner.address,
      ],
      {
        kind: "uups",
        initializer: "initialize",
      }
    );

    // Grant roles
    const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
    const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
    const KEEPER_ROLE = await strategy.KEEPER_ROLE();

    await strategy.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await strategy.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await strategy.connect(admin).grantRole(KEEPER_ROLE, keeper.address);

    // Add ETH market
    await strategy
      .connect(strategist)
      .addMarket(ETH_MARKET, await weth.getAddress(), 6000); // 60% max

    // Mint USDC to treasury and approve
    await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
    await usdc
      .connect(treasury)
      .approve(await strategy.getAddress(), ethers.MaxUint256);

    return {
      strategy,
      usdc,
      weth,
      perpDex,
      spotExchange,
      admin,
      treasury,
      strategist,
      guardian,
      keeper,
      user1,
      timelockSigner,
    };
  }

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { strategy, usdc, perpDex, spotExchange } = await loadFixture(deployFixture);

      expect(await strategy.usdc()).to.equal(await usdc.getAddress());
      expect(await strategy.perpDex()).to.equal(await perpDex.getAddress());
      expect(await strategy.spotExchange()).to.equal(await spotExchange.getAddress());
      expect(await strategy.targetLeverageX100()).to.equal(300); // 3x
      expect(await strategy.minFundingRateWad()).to.equal(ethers.parseUnits("0.02", 18));
      expect(await strategy.maxDrawdownBps()).to.equal(500); // 5%
      expect(await strategy.defaultSlippageBps()).to.equal(50); // 0.5%
      expect(await strategy.active()).to.be.true;
    });

    it("Should grant roles correctly", async function () {
      const { strategy, admin, treasury } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await strategy.DEFAULT_ADMIN_ROLE();
      const TREASURY_ROLE = await strategy.TREASURY_ROLE();

      expect(await strategy.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await strategy.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { strategy, usdc, perpDex, spotExchange, treasury, admin } =
        await loadFixture(deployFixture);

      await expect(
        strategy.initialize(
          await usdc.getAddress(),
          await perpDex.getAddress(),
          await spotExchange.getAddress(),
          treasury.address,
          admin.address,
          admin.address
        )
      ).to.be.reverted;
    });

    it("Should revert on zero addresses", async function () {
      const BasisTradingStrategy = await ethers.getContractFactory("BasisTradingStrategy");

      await expect(
        upgrades.deployProxy(
          BasisTradingStrategy,
          [
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
          ],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.reverted;
    });
  });

  describe("Market Management", function () {
    it("Should add a market", async function () {
      const { strategy, strategist, weth } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).addMarket(BTC_MARKET, await weth.getAddress(), 4000)
      ).to.emit(strategy, "MarketAdded");

      expect(await strategy.marketCount()).to.equal(2); // ETH + BTC
    });

    it("Should reject duplicate markets", async function () {
      const { strategy, strategist, weth } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).addMarket(ETH_MARKET, await weth.getAddress(), 4000)
      ).to.be.revertedWithCustomError(strategy, "MarketAlreadyAdded");
    });

    it("Should enforce MAX_MARKETS limit", async function () {
      const { strategy, strategist, weth } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();

      // Already have 1 market (ETH). Add 4 more to hit the limit of 5
      for (let i = 0; i < 4; i++) {
        const market = ethers.keccak256(ethers.toUtf8Bytes(`MARKET-${i}`));
        await strategy.connect(strategist).addMarket(market, wethAddr, 1000);
      }

      const extraMarket = ethers.keccak256(ethers.toUtf8Bytes("EXTRA"));
      await expect(
        strategy.connect(strategist).addMarket(extraMarket, wethAddr, 1000)
      ).to.be.revertedWithCustomError(strategy, "MaxMarketsExceeded");
    });

    it("Should remove a market", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(strategy.connect(strategist).removeMarket(ETH_MARKET)).to.emit(
        strategy,
        "MarketRemoved"
      );
    });

    it("Should revert removing non-existent market", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      const fakeMarket = ethers.keccak256(ethers.toUtf8Bytes("FAKE"));
      await expect(
        strategy.connect(strategist).removeMarket(fakeMarket)
      ).to.be.revertedWithCustomError(strategy, "NoValidMarket");
    });
  });

  describe("Deposit", function () {
    it("Should accept deposit from treasury", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6); // 100k USDC

      await strategy.connect(treasury).deposit(amount);

      expect(await strategy.totalPrincipal()).to.equal(amount);
    });

    it("Should open basis positions on deposit", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      // Check that margin was deposited to perp DEX
      const strategyAddr = await strategy.getAddress();
      const margin = await perpDex.marginBalance(strategyAddr);
      expect(margin).to.equal(amount); // All capital goes as margin
    });

    it("Should revert deposit with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).deposit(0)).to.be.revertedWithCustomError(
        strategy,
        "ZeroAmount"
      );
    });

    it("Should revert deposit when not active", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setActive(false);

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(strategy, "StrategyNotActive");
    });

    it("Should revert deposit from non-treasury", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).deposit(ethers.parseUnits("1000", 6))).to.be
        .reverted;
    });
  });

  describe("Value Reporting", function () {
    it("Should report correct totalValue after deposit", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      // Value = margin balance (no PnL yet)
      expect(await strategy.totalValue()).to.equal(amount);
    });

    it("Should include unrealized PnL in totalValue", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      // Get the position ID from the strategy
      const pos = await strategy.getPosition(ETH_MARKET);

      // Set mock positive PnL (funding earned)
      await perpDex.setMockPnl(pos.positionId, ethers.parseUnits("5000", 6));

      // Total value should include the PnL
      const value = await strategy.totalValue();
      expect(value).to.equal(amount + ethers.parseUnits("5000", 6));
    });

    it("Should include accrued funding in totalValue", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);
      await perpDex.setMockFunding(pos.positionId, ethers.parseUnits("2000", 6));

      const value = await strategy.totalValue();
      expect(value).to.equal(amount + ethers.parseUnits("2000", 6));
    });

    it("Should handle negative PnL in totalValue", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);
      await perpDex.setMockPnl(pos.positionId, -ethers.parseUnits("3000", 6));

      const value = await strategy.totalValue();
      expect(value).to.equal(amount - ethers.parseUnits("3000", 6));
    });

    it("Should return zero when completely underwater", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);
      // Set PnL worse than total margin
      await perpDex.setMockPnl(pos.positionId, -ethers.parseUnits("200000", 6));

      const value = await strategy.totalValue();
      expect(value).to.equal(0);
    });
  });

  describe("Withdrawal", function () {
    it("Should withdraw partial amount", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const withdrawAmt = ethers.parseUnits("30000", 6);
      const balBefore = await usdc.balanceOf(treasury.address);

      await strategy.connect(treasury).withdraw(withdrawAmt);

      const balAfter = await usdc.balanceOf(treasury.address);
      expect(balAfter - balBefore).to.be.greaterThan(0);
    });

    it("Should withdrawAll and return funds to treasury", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(depositAmt);

      const balBefore = await usdc.balanceOf(treasury.address);
      await strategy.connect(treasury).withdrawAll();
      const balAfter = await usdc.balanceOf(treasury.address);

      expect(balAfter - balBefore).to.equal(depositAmt);
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("Should revert withdraw with zero amount", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      await expect(strategy.connect(treasury).withdraw(0)).to.be.revertedWithCustomError(
        strategy,
        "ZeroAmount"
      );
    });
  });

  describe("Funding Claims", function () {
    it("Should claim and compound funding", async function () {
      const { strategy, treasury, perpDex, keeper } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);

      // Simulate funding accrual
      const fundingAmount = ethers.parseUnits("1000", 6);
      await perpDex.setMockFunding(pos.positionId, fundingAmount);

      await expect(strategy.connect(keeper).claimAndCompoundFunding())
        .to.emit(strategy, "FundingClaimed")
        .to.emit(strategy, "FundingCompounded");

      expect(await strategy.totalFundingEarned()).to.equal(fundingAmount);
    });

    it("Should handle negative funding correctly", async function () {
      const { strategy, treasury, perpDex, keeper } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);

      // Simulate negative funding
      await perpDex.setMockFunding(pos.positionId, -ethers.parseUnits("500", 6));

      await strategy.connect(keeper).claimAndCompoundFunding();

      // totalFundingEarned should not increase for negative funding
      expect(await strategy.totalFundingEarned()).to.equal(0);
    });
  });

  describe("Leverage & Risk", function () {
    it("Should report correct leverage", async function () {
      const { strategy, treasury } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.equal(300); // 3x
    });

    it("Should report 1x leverage with no positions", async function () {
      const { strategy } = await loadFixture(deployFixture);

      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.equal(100); // 1x
    });

    it("Should detect drawdown exceeding threshold", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);

      // 6% drawdown (above 5% threshold)
      await perpDex.setMockPnl(pos.positionId, -ethers.parseUnits("6000", 6));

      const [needsAction, worstDrawdown] = await strategy.checkDrawdown();
      expect(needsAction).to.be.true;
      expect(worstDrawdown).to.be.greaterThan(500); // > 5%
    });

    it("Should not flag drawdown below threshold", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const pos = await strategy.getPosition(ETH_MARKET);

      // 2% drawdown (below 5% threshold)
      await perpDex.setMockPnl(pos.positionId, -ethers.parseUnits("2000", 6));

      const [needsAction] = await strategy.checkDrawdown();
      expect(needsAction).to.be.false;
    });
  });

  describe("Funding Rate Monitoring", function () {
    it("Should return current funding rates", async function () {
      const { strategy, strategist, weth, perpDex } = await loadFixture(deployFixture);

      // Add BTC market
      await strategy
        .connect(strategist)
        .addMarket(BTC_MARKET, await weth.getAddress(), 4000);

      const [marketIds, rates] = await strategy.getCurrentFundingRates();

      expect(marketIds.length).to.equal(2);
      expect(rates[0]).to.equal(ethers.parseUnits("0.10", 18)); // ETH 10%
      expect(rates[1]).to.equal(ethers.parseUnits("0.08", 18)); // BTC 8%
    });

    it("Should estimate APY from positions", async function () {
      const { strategy, treasury, perpDex } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits("100000", 6);
      await strategy.connect(treasury).deposit(amount);

      const apy = await strategy.estimatedApy();
      // With 10% funding rate and 3x leverage, expected ~30% APY
      expect(apy).to.be.greaterThan(0);
    });
  });

  describe("Parameter Management", function () {
    it("Should update leverage", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setParameters(
          200, // 2x leverage
          ethers.parseUnits("0.01", 18),
          300
        )
      ).to.emit(strategy, "LeverageUpdated");

      expect(await strategy.targetLeverageX100()).to.equal(200);
    });

    it("Should reject leverage too high", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setParameters(
          600, // 6x — exceeds MAX_LEVERAGE_X100 (500)
          ethers.parseUnits("0.01", 18),
          300
        )
      ).to.be.revertedWithCustomError(strategy, "InvalidLeverage");
    });

    it("Should reject leverage below 1x", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setParameters(50, ethers.parseUnits("0.01", 18), 300)
      ).to.be.revertedWithCustomError(strategy, "InvalidLeverage");
    });

    it("Should update slippage", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await strategy.connect(strategist).setSlippage(75);
      expect(await strategy.defaultSlippageBps()).to.equal(75);
    });

    it("Should reject excessive slippage", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(strategist).setSlippage(200) // 2% > MAX_SLIPPAGE_BPS (1%)
      ).to.be.revertedWithCustomError(strategy, "SlippageTooHigh");
    });
  });

  describe("Emergency", function () {
    it("Should emergency close all positions", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      await expect(strategy.connect(guardian).emergencyCloseAll()).to.emit(
        strategy,
        "EmergencyCloseAll"
      );
    });

    it("Should pause and prevent deposits", async function () {
      const { strategy, treasury, guardian } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted;
    });

    it("Should require timelock for unpause", async function () {
      const { strategy, guardian, timelockSigner } = await loadFixture(deployFixture);

      await strategy.connect(guardian).pause();

      // Non-timelock should fail
      await expect(strategy.connect(guardian).unpause()).to.be.reverted;

      // Timelock should succeed
      await strategy.connect(timelockSigner).unpause();
    });
  });

  describe("Access Control", function () {
    it("Should reject non-strategist from adding markets", async function () {
      const { strategy, user1, weth } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).addMarket(BTC_MARKET, await weth.getAddress(), 4000)
      ).to.be.reverted;
    });

    it("Should reject non-keeper from claiming funding", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).claimAndCompoundFunding()).to.be.reverted;
    });

    it("Should reject non-guardian from emergency close", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(strategy.connect(user1).emergencyCloseAll()).to.be.reverted;
    });

    it("Should reject non-treasury from deposits", async function () {
      const { strategy, user1 } = await loadFixture(deployFixture);

      await expect(
        strategy.connect(user1).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted;
    });
  });

  describe("IStrategy Interface", function () {
    it("Should report correct asset", async function () {
      const { strategy, usdc } = await loadFixture(deployFixture);
      expect(await strategy.asset()).to.equal(await usdc.getAddress());
    });

    it("Should report isActive correctly", async function () {
      const { strategy, strategist } = await loadFixture(deployFixture);

      expect(await strategy.isActive()).to.be.true;

      await strategy.connect(strategist).setActive(false);
      expect(await strategy.isActive()).to.be.false;
    });
  });

  describe("50/50 Allocation Integration", function () {
    it("Should work with TreasuryV2 allocation pattern (45% of total)", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      // TreasuryV2 50/50 split derived from original allocation:
      //   Original: Pendle 40%, Morpho 30%, Sky 20%, Reserve 10%
      //   Reserve stays 10%, deployable = 90%, split 50/50 = 45% each
      //   Basis gets 45% of total (4500 bps in addStrategy)
      const totalDeposit = ethers.parseUnits("1000000", 6); // $1M total into treasury
      const reserveAmount = totalDeposit * 1000n / 10000n;   // 10% = $100k reserve
      const deployable = totalDeposit - reserveAmount;        // $900k deployable
      const basisAllocation = deployable / 2n;                // 45% of total = $450k

      await strategy.connect(treasury).deposit(basisAllocation);

      expect(await strategy.totalPrincipal()).to.equal(basisAllocation);
      expect(await strategy.totalValue()).to.equal(basisAllocation);

      // With 3x leverage on $450k, notional exposure = $1.35M
      const leverage = await strategy.getCurrentLeverage();
      expect(leverage).to.equal(300); // 3x confirmed

      // Verify the other 45% would go to existing strategies:
      // Pendle: 4/9 × 45% = 20% of total = $200k
      // Morpho: 3/9 × 45% = 15% of total = $150k
      // Sky:    2/9 × 45% = 10% of total = $100k
      const existingAllocation = deployable - basisAllocation; // $450k
      const pendleShare = existingAllocation * 4n / 9n;   // ~$200k
      const morphoShare = existingAllocation * 3n / 9n;   // ~$150k
      const skyShare = existingAllocation - pendleShare - morphoShare; // ~$100k (remainder)

      expect(pendleShare).to.equal(ethers.parseUnits("200000", 6));
      expect(morphoShare).to.equal(ethers.parseUnits("150000", 6));
      expect(skyShare).to.equal(ethers.parseUnits("100000", 6));

      // Confirm total = 100%
      const totalAllocated = reserveAmount + basisAllocation + pendleShare + morphoShare + skyShare;
      expect(totalAllocated).to.equal(totalDeposit);
    });

    it("Should handle proportional withdrawal for rebalancing", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deployFixture);

      // 45% of $1M = $450k to basis strategy
      const deposit = ethers.parseUnits("450000", 6);
      await strategy.connect(treasury).deposit(deposit);

      // Withdraw 20% for rebalancing
      const withdrawAmt = ethers.parseUnits("90000", 6);
      const balBefore = await usdc.balanceOf(treasury.address);

      await strategy.connect(treasury).withdraw(withdrawAmt);

      const balAfter = await usdc.balanceOf(treasury.address);
      const withdrawn = balAfter - balBefore;
      expect(withdrawn).to.be.greaterThan(0);
    });
  });
});
