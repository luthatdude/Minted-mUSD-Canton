import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("MetaVault", function () {
  async function deployFixture() {
    const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] =
      await ethers.getSigners();

    // Deploy USDC mock
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const usdcAddr = await usdc.getAddress();

    // Deploy 4 MockStrategy instances (representing Pendle, Fluid, Morpho, Euler)
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const pendle = await MockStrategy.deploy(usdcAddr, treasury.address);
    const fluid  = await MockStrategy.deploy(usdcAddr, treasury.address);
    const morpho = await MockStrategy.deploy(usdcAddr, treasury.address);
    const euler  = await MockStrategy.deploy(usdcAddr, treasury.address);

    // Deploy MetaVault
    const MetaVault = await ethers.getContractFactory("MetaVault");
    const vault = await upgrades.deployProxy(
      MetaVault,
      [usdcAddr, treasury.address, admin.address, timelockSigner.address],
      { kind: "uups", initializer: "initialize" }
    );
    const vaultAddr = await vault.getAddress();

    // Grant roles
    const STRATEGIST_ROLE = await vault.STRATEGIST_ROLE();
    const GUARDIAN_ROLE   = await vault.GUARDIAN_ROLE();
    const KEEPER_ROLE     = await vault.KEEPER_ROLE();
    await vault.connect(admin).grantRole(STRATEGIST_ROLE, strategist.address);
    await vault.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    await vault.connect(admin).grantRole(KEEPER_ROLE, keeper.address);

    // Mint USDC to treasury and approve MetaVault
    await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6)); // 10M
    await usdc.connect(treasury).approve(vaultAddr, ethers.MaxUint256);

    return {
      vault, usdc, pendle, fluid, morpho, euler,
      admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
    };
  }

  /** Helper: add all 4 sub-strategies with default weights */
  async function addFourStrategies(
    vault: any, strategist: any,
    pendle: any, fluid: any, morpho: any, euler: any,
  ) {
    await vault.connect(strategist).addSubStrategy(await pendle.getAddress(), 3000, 0); // 30%
    await vault.connect(strategist).addSubStrategy(await fluid.getAddress(),  3500, 0); // 35%
    await vault.connect(strategist).addSubStrategy(await morpho.getAddress(), 2000, 0); // 20%
    await vault.connect(strategist).addSubStrategy(await euler.getAddress(),  1500, 0); // 15%
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Initialization", function () {
    it("sets correct initial state", async function () {
      const { vault, usdc } = await loadFixture(deployFixture);
      expect(await vault.active()).to.be.true;
      expect(await vault.asset()).to.equal(await usdc.getAddress());
      expect(await vault.isActive()).to.be.true;
      expect(await vault.subStrategyCount()).to.equal(0);
      expect(await vault.driftThresholdBps()).to.equal(500);
      expect(await vault.totalPrincipal()).to.equal(0);
    });

    it("reverts on zero addresses in initialize", async function () {
      const MetaVault = await ethers.getContractFactory("MetaVault");
      await expect(
        upgrades.deployProxy(MetaVault, [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress], { kind: "uups", initializer: "initialize" })
      ).to.be.reverted;
    });

    it("grants TREASURY_ROLE to treasury address", async function () {
      const { vault, treasury } = await loadFixture(deployFixture);
      const TREASURY_ROLE = await vault.TREASURY_ROLE();
      expect(await vault.hasRole(TREASURY_ROLE, treasury.address)).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  SUB-STRATEGY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Sub-strategy management", function () {
    it("adds 4 sub-strategies with correct weights summing to 10000", async function () {
      const { vault, strategist, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      expect(await vault.subStrategyCount()).to.equal(4);

      const [addr0, w0, , enabled0] = await vault.getSubStrategy(0);
      expect(addr0).to.equal(await pendle.getAddress());
      expect(w0).to.equal(3000);
      expect(enabled0).to.be.true;

      const [addr1, w1] = await vault.getSubStrategy(1);
      expect(addr1).to.equal(await fluid.getAddress());
      expect(w1).to.equal(3500);
    });

    it("reverts deposit when weights don't sum to 10000", async function () {
      const { vault, strategist, treasury, pendle } = await loadFixture(deployFixture);
      await vault.connect(strategist).addSubStrategy(await pendle.getAddress(), 5000, 0);

      await expect(
        vault.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(vault, "WeightSumNot10000");
    });

    it("reverts when adding more than 4 strategies", async function () {
      const { vault, strategist, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const extra = await MockStrategy.deploy(await usdc.getAddress(), strategist.address);

      await expect(
        vault.connect(strategist).addSubStrategy(await extra.getAddress(), 0, 0)
      ).to.be.revertedWithCustomError(vault, "TooManyStrategies");
    });

    it("reverts when non-strategist tries to add", async function () {
      const { vault, user1, pendle } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user1).addSubStrategy(await pendle.getAddress(), 10000, 0)
      ).to.be.reverted;
    });

    it("removes a sub-strategy and withdraws its funds", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      // Deposit to fill strategies
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const pendleBefore = await usdc.balanceOf(await pendle.getAddress());
      expect(pendleBefore).to.be.gt(0);

      // Remove pendle (index 0)
      await vault.connect(strategist).removeSubStrategy(0);
      expect(await vault.subStrategyCount()).to.equal(3);

      // Pendle funds should now be idle in MetaVault
      expect(await usdc.balanceOf(await pendle.getAddress())).to.equal(0);
    });

    it("updates weights via setWeights", async function () {
      const { vault, strategist, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(strategist).setWeights([2500, 2500, 2500, 2500]);

      const [, w0] = await vault.getSubStrategy(0);
      const [, w1] = await vault.getSubStrategy(1);
      const [, w2] = await vault.getSubStrategy(2);
      const [, w3] = await vault.getSubStrategy(3);
      expect(w0).to.equal(2500);
      expect(w1).to.equal(2500);
      expect(w2).to.equal(2500);
      expect(w3).to.equal(2500);
    });

    it("reverts setWeights with wrong length", async function () {
      const { vault, strategist, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await expect(
        vault.connect(strategist).setWeights([5000, 5000])
      ).to.be.revertedWithCustomError(vault, "LengthMismatch");
    });

    it("toggles sub-strategy (circuit breaker)", async function () {
      const { vault, strategist, guardian, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(guardian).toggleSubStrategy(1, false);
      const [, , , enabled] = await vault.getSubStrategy(1);
      expect(enabled).to.be.false;

      await vault.connect(guardian).toggleSubStrategy(1, true);
      const [, , , enabled2] = await vault.getSubStrategy(1);
      expect(enabled2).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  DEPOSITS
  // ═══════════════════════════════════════════════════════════════════

  describe("Deposits", function () {
    it("deposits and splits across 4 sub-strategies by weight", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      const amount = ethers.parseUnits("100000", 6); // 100K USDC
      await vault.connect(treasury).deposit(amount);

      // Check each sub-strategy got its share
      const pendleVal = await usdc.balanceOf(await pendle.getAddress());
      const fluidVal  = await usdc.balanceOf(await fluid.getAddress());
      const morphoVal = await usdc.balanceOf(await morpho.getAddress());
      const eulerVal  = await usdc.balanceOf(await euler.getAddress());

      // Pendle: 30% = 30000
      expect(pendleVal).to.equal(ethers.parseUnits("30000", 6));
      // Fluid: 35% = 35000
      expect(fluidVal).to.equal(ethers.parseUnits("35000", 6));
      // Morpho: 20% = 20000
      expect(morphoVal).to.equal(ethers.parseUnits("20000", 6));
      // Euler: 15% = 15000 (gets remainder)
      expect(eulerVal).to.equal(ethers.parseUnits("15000", 6));

      expect(await vault.totalPrincipal()).to.equal(amount);
      expect(await vault.totalValue()).to.equal(amount);
    });

    it("reverts deposit when inactive", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(strategist).setActive(false);

      await expect(
        vault.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(vault, "StrategyNotActive");
    });

    it("reverts deposit of zero", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await expect(
        vault.connect(treasury).deposit(0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts deposit with no sub-strategies", async function () {
      const { vault, treasury } = await loadFixture(deployFixture);
      await expect(
        vault.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.revertedWithCustomError(vault, "NoSubStrategies");
    });

    it("reverts deposit from non-treasury", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user1).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted;
    });

    it("respects per-strategy cap on deposit", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);

      // Add with cap on pendle: max 10K USDC
      await vault.connect(strategist).addSubStrategy(await pendle.getAddress(), 3000, ethers.parseUnits("10000", 6));
      await vault.connect(strategist).addSubStrategy(await fluid.getAddress(),  3500, 0);
      await vault.connect(strategist).addSubStrategy(await morpho.getAddress(), 2000, 0);
      await vault.connect(strategist).addSubStrategy(await euler.getAddress(),  1500, 0);

      // Deposit 100K — pendle should only get 10K (its cap), rest stays idle
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const pendleVal = await usdc.balanceOf(await pendle.getAddress());
      expect(pendleVal).to.equal(ethers.parseUnits("10000", 6));
    });

    it("skips disabled sub-strategies on deposit", async function () {
      const { vault, strategist, guardian, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      // Disable fluid (index 1, weight 35%)
      await vault.connect(guardian).toggleSubStrategy(1, false);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Fluid should have 0
      const fluidVal = await usdc.balanceOf(await fluid.getAddress());
      expect(fluidVal).to.equal(0);

      // Total deployed + idle should equal 100K
      const totalVal = await vault.totalValue();
      expect(totalVal).to.equal(ethers.parseUnits("100000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  WITHDRAWALS
  // ═══════════════════════════════════════════════════════════════════

  describe("Withdrawals", function () {
    it("withdraws pro-rata from all sub-strategies", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      const depositAmt = ethers.parseUnits("100000", 6);
      await vault.connect(treasury).deposit(depositAmt);

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await vault.connect(treasury).withdraw(ethers.parseUnits("50000", 6));
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseUnits("50000", 6));
      expect(await vault.totalValue()).to.equal(ethers.parseUnits("50000", 6));
    });

    it("withdrawAll returns everything to treasury", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await vault.connect(treasury).withdrawAll();
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseUnits("100000", 6));
      expect(await vault.totalPrincipal()).to.equal(0);
      expect(await vault.totalValue()).to.equal(0);
    });

    it("reverts withdraw of zero", async function () {
      const { vault, treasury } = await loadFixture(deployFixture);
      await expect(
        vault.connect(treasury).withdraw(0)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("uses idle USDC first before pulling from sub-strategies", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      // Deposit, then disable fluid causing some future deposit to leave idle
      await vault.connect(treasury).deposit(ethers.parseUnits("80000", 6));

      // Send some idle USDC directly to the vault
      await usdc.mint(await vault.getAddress(), ethers.parseUnits("5000", 6));

      const totalBefore = await vault.totalValue();
      const idleBefore = await vault.idleBalance();
      expect(idleBefore).to.equal(ethers.parseUnits("5000", 6));

      // Withdraw less than idle — should not touch sub-strategies
      await vault.connect(treasury).withdraw(ethers.parseUnits("3000", 6));
      expect(await vault.idleBalance()).to.equal(ethers.parseUnits("2000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  REBALANCE
  // ═══════════════════════════════════════════════════════════════════

  describe("Rebalance", function () {
    it("rebalances when drift exceeds threshold", async function () {
      const { vault, strategist, treasury, keeper, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Simulate drift: add 20K yield to pendle (making it over-allocated)
      await usdc.mint(await pendle.getAddress(), ethers.parseUnits("20000", 6));

      // Set low threshold so rebalance is allowed
      await vault.connect(strategist).setDriftThreshold(200);

      // Wait for cooldown
      await time.increase(3601);

      await vault.connect(keeper).rebalance();

      // After rebalance, allocations should be closer to targets
      const allocs = await vault.currentAllocations();
      // Pendle target = 3000 bps (30%), should be closer now
      const pendleAlloc = Number(allocs[0]);
      expect(pendleAlloc).to.be.closeTo(3000, 200); // within 2%
    });

    it("reverts rebalance if drift below threshold", async function () {
      const { vault, strategist, treasury, keeper, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      await time.increase(3601);

      await expect(
        vault.connect(keeper).rebalance()
      ).to.be.revertedWithCustomError(vault, "DriftBelowThreshold");
    });

    it("reverts rebalance before cooldown elapsed", async function () {
      const { vault, strategist, treasury, keeper, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Create drift
      await usdc.mint(await pendle.getAddress(), ethers.parseUnits("50000", 6));
      await vault.connect(strategist).setDriftThreshold(200);

      await time.increase(3601);
      await vault.connect(keeper).rebalance();

      // Immediately try again (create more drift)
      await usdc.mint(await pendle.getAddress(), ethers.parseUnits("50000", 6));

      await expect(
        vault.connect(keeper).rebalance()
      ).to.be.revertedWithCustomError(vault, "CooldownNotElapsedMV");
    });

    it("reverts rebalance from non-keeper", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user1).rebalance()
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  EMERGENCY
  // ═══════════════════════════════════════════════════════════════════

  describe("Emergency", function () {
    it("emergency withdraws from a single sub-strategy", async function () {
      const { vault, strategist, treasury, guardian, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const pendleBefore = await usdc.balanceOf(await pendle.getAddress());
      expect(pendleBefore).to.be.gt(0);

      await vault.connect(guardian).emergencyWithdrawFrom(0);

      expect(await usdc.balanceOf(await pendle.getAddress())).to.equal(0);
      // Strategy should be disabled
      const [, , , enabled] = await vault.getSubStrategy(0);
      expect(enabled).to.be.false;
    });

    it("emergency withdraws all", async function () {
      const { vault, strategist, treasury, guardian, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      await vault.connect(guardian).emergencyWithdrawAll();

      expect(await usdc.balanceOf(await pendle.getAddress())).to.equal(0);
      expect(await usdc.balanceOf(await fluid.getAddress())).to.equal(0);
      expect(await usdc.balanceOf(await morpho.getAddress())).to.equal(0);
      expect(await usdc.balanceOf(await euler.getAddress())).to.equal(0);

      // All funds should be idle in MetaVault
      expect(await vault.idleBalance()).to.equal(ethers.parseUnits("100000", 6));
    });

    it("reverts emergency from non-guardian", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(user1).emergencyWithdrawFrom(0)
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PAUSE / ADMIN
  // ═══════════════════════════════════════════════════════════════════

  describe("Pause / Admin", function () {
    it("pause blocks deposits", async function () {
      const { vault, strategist, treasury, guardian, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(guardian).pause();

      await expect(
        vault.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.be.reverted;
    });

    it("unpause resumes deposits", async function () {
      const { vault, admin, strategist, treasury, guardian, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(guardian).pause();
      await vault.connect(admin).unpause();

      await expect(
        vault.connect(treasury).deposit(ethers.parseUnits("1000", 6))
      ).to.not.be.reverted;
    });

    it("sets cap on sub-strategy", async function () {
      const { vault, strategist, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);

      await vault.connect(strategist).setSubStrategyCap(0, ethers.parseUnits("50000", 6));
      const [, , cap] = await vault.getSubStrategy(0);
      expect(cap).to.equal(ethers.parseUnits("50000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  VIEW HELPERS
  // ═══════════════════════════════════════════════════════════════════

  describe("View helpers", function () {
    it("currentAllocations returns correct BPS", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const allocs = await vault.currentAllocations();
      expect(allocs[0]).to.equal(3000n); // Pendle 30%
      expect(allocs[1]).to.equal(3500n); // Fluid 35%
      expect(allocs[2]).to.equal(2000n); // Morpho 20%
      expect(allocs[3]).to.equal(1500n); // Euler 15%
    });

    it("currentDrift returns 0 when perfectly balanced", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const drift = await vault.currentDrift();
      expect(drift).to.equal(0);
    });

    it("currentDrift increases when one strategy gets yield", async function () {
      const { vault, strategist, treasury, pendle, fluid, morpho, euler, usdc } = await loadFixture(deployFixture);
      await addFourStrategies(vault, strategist, pendle, fluid, morpho, euler);
      await vault.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      // Add yield to pendle
      await usdc.mint(await pendle.getAddress(), ethers.parseUnits("20000", 6));

      const drift = await vault.currentDrift();
      expect(drift).to.be.gt(0);
    });
  });
});
