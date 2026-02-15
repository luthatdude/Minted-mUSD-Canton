// @ts-nocheck — test file uses dynamic contract types from loadFixture
/**
 * FluidLoopStrategy Tests — All 3 Vault Modes
 *
 * Comprehensive tests for the Fluid Protocol leveraged loop strategy covering:
 *
 *   MODE 1 (STABLE):  syrupUSDC / USDC   — VaultT1 (#146)
 *   MODE 2 (LRT):     weETH-ETH / wstETH — VaultT2 (#74)
 *   MODE 3 (LST):     wstETH-ETH / wstETH-ETH — VaultT4 (#44)
 *
 * Test sections:
 *   1. Initialization & role setup (all 3 modes)
 *   2. Flash-loan deposit with leverage
 *   3. Withdraw with deleverage
 *   4. Health factor & leverage monitoring
 *   5. Rebalance & adjustLeverage
 *   6. Merkl reward claiming & compounding
 *   7. Emergency deleverage
 *   8. Access control & admin
 *   9. Edge cases
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("FluidLoopStrategy", function () {

  // ═══════════════════════════════════════════════════════════════════
  //  MODE 1 — STABLE (syrupUSDC / USDC) via VaultT1
  // ═══════════════════════════════════════════════════════════════════

  describe("MODE 1: Stable (syrupUSDC / USDC — VaultT1)", function () {

    async function deployStableFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      // Deploy tokens (6 decimals for USDC-like stables)
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      const syrupUSDC = await MockERC20.deploy("Syrup USDC", "syrupUSDC", 6);
      const rewardToken = await MockERC20.deploy("Fluid Token", "FLUID", 18);

      // Deploy Mock AAVE V3 Pool for flash loans
      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());

      // Seed AAVE pool with USDC
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      // Deploy MockFluidVaultT1
      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(
        await syrupUSDC.getAddress(),
        await usdc.getAddress()
      );

      // Seed Fluid vault with USDC for borrows
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      // Deploy MockFluidVaultFactory
      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();
      await vaultFactory.registerVault(146, await fluidVault.getAddress());

      // Deploy Mock Merkl Distributor
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      // Deploy Mock Swap Router
      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      // Fund swap router for reward → USDC swaps
      await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
      await usdc.approve(await swapRouter.getAddress(), ethers.MaxUint256);
      await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("5000000", 6));

      // Deploy strategy via proxy (FluidLoopStrategyTestable for mock vault reads)
      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const initParams = {
        mode: 1, // MODE_STABLE
        inputAsset: await usdc.getAddress(),
        supplyToken: await syrupUSDC.getAddress(),
        borrowToken: await usdc.getAddress(),
        supplyToken1: ethers.ZeroAddress,
        borrowToken1: ethers.ZeroAddress,
        fluidVault: await fluidVault.getAddress(),
        vaultFactory: await vaultFactory.getAddress(),
        flashLoanPool: await aavePool.getAddress(),
        merklDistributor: await merklDistributor.getAddress(),
        swapRouter: await swapRouter.getAddress(),
        vaultResolver: ethers.ZeroAddress,
        dexResolver: ethers.ZeroAddress,
        dexPool: ethers.ZeroAddress,
        treasury: treasury.address,
        admin: admin.address,
        timelock: timelockSigner.address,
      };

      const strategy = await upgrades.deployProxy(
        Strategy,
        [initParams],
        {
          kind: "uups",
          initializer: "initializeTestable",
          unsafeAllow: ["constructor"],
        }
      );

      // Grant roles
      const STRATEGIST_ROLE = await strategy.STRATEGIST_ROLE();
      const GUARDIAN_ROLE = await strategy.GUARDIAN_ROLE();
      const KEEPER_ROLE = await strategy.KEEPER_ROLE();
      await strategy.grantRole(STRATEGIST_ROLE, strategist.address);
      await strategy.grantRole(GUARDIAN_ROLE, guardian.address);
      await strategy.grantRole(KEEPER_ROLE, keeper.address);

      // Mint syrupUSDC → strategy needs it for supply
      // In production, strategy would swap USDC → syrupUSDC
      // For testing, we mint syrupUSDC directly to simulate 1:1 conversion
      await syrupUSDC.mint(admin.address, ethers.parseUnits("100000000", 6));

      // Mint USDC to treasury
      await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
      await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      // For the T1 vault, the strategy supplies syrupUSDC as collateral.
      // We need syrupUSDC available to the strategy. In test mode,
      // we treat USDC = syrupUSDC (same token for simplicity).
      // Actually: inputAsset is USDC, supplyToken is syrupUSDC. 
      // The strategy calls _supplyToVault which approves supplyToken and sends it.
      // Since the flash loan gives USDC and we supply syrupUSDC,
      // for test simplicity we'll make them the same token.

      // Fund reward distribution
      await rewardToken.mint(admin.address, ethers.parseUnits("100000", 18));
      await rewardToken.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
      await merklDistributor.fund(await rewardToken.getAddress(), ethers.parseUnits("10000", 18));

      await usdc.mint(admin.address, ethers.parseUnits("100000", 6));
      await usdc.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
      await merklDistributor.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

      // Whitelist reward tokens
      await strategy.setRewardToken(await rewardToken.getAddress(), true);
      await strategy.setRewardToken(await usdc.getAddress(), true);

      return {
        strategy, usdc, syrupUSDC, rewardToken,
        aavePool, fluidVault, vaultFactory, merklDistributor, swapRouter,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
      };
    }

    // For this test, we'll use a simplified fixture where inputAsset = supplyToken = borrowToken = USDC
    // This avoids the need for a swap between USDC and syrupUSDC in the flash loan callback
    async function deployStableSimpleFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
      const rewardToken = await MockERC20.deploy("Fluid Token", "FLUID", 18);

      // AAVE pool
      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      // Fluid vault T1 — both supply and borrow are USDC for simplicity
      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(
        await usdc.getAddress(),
        await usdc.getAddress()
      );

      // Seed vault with USDC for borrows
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      // Factory
      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      // Merkl
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      // Swap Router
      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();
      await usdc.mint(admin.address, ethers.parseUnits("10000000", 6));
      await usdc.approve(await swapRouter.getAddress(), ethers.MaxUint256);
      await swapRouter.fund(await usdc.getAddress(), ethers.parseUnits("5000000", 6));

      // Deploy testable strategy
      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const initParams = {
        mode: 1,
        inputAsset: await usdc.getAddress(),
        supplyToken: await usdc.getAddress(), // Same as input for test simplicity
        borrowToken: await usdc.getAddress(),
        supplyToken1: ethers.ZeroAddress,
        borrowToken1: ethers.ZeroAddress,
        fluidVault: await fluidVault.getAddress(),
        vaultFactory: await vaultFactory.getAddress(),
        flashLoanPool: await aavePool.getAddress(),
        merklDistributor: await merklDistributor.getAddress(),
        swapRouter: await swapRouter.getAddress(),
        vaultResolver: ethers.ZeroAddress,
        dexResolver: ethers.ZeroAddress,
        dexPool: ethers.ZeroAddress,
        treasury: treasury.address,
        admin: admin.address,
        timelock: timelockSigner.address,
      };

      const strategy = await upgrades.deployProxy(
        Strategy,
        [initParams],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      // Roles
      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);

      // Fund treasury
      await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
      await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      // Fund merkl with rewards
      await rewardToken.mint(admin.address, ethers.parseUnits("100000", 18));
      await rewardToken.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
      await merklDistributor.fund(await rewardToken.getAddress(), ethers.parseUnits("10000", 18));

      await usdc.mint(admin.address, ethers.parseUnits("100000", 6));
      await usdc.approve(await merklDistributor.getAddress(), ethers.MaxUint256);
      await merklDistributor.fund(await usdc.getAddress(), ethers.parseUnits("10000", 6));

      await strategy.setRewardToken(await rewardToken.getAddress(), true);
      await strategy.setRewardToken(await usdc.getAddress(), true);

      return {
        strategy, usdc, rewardToken,
        aavePool, fluidVault, vaultFactory, merklDistributor, swapRouter,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
      };
    }

    describe("Initialization", function () {
      it("Should set correct vault mode and parameters", async function () {
        const { strategy, usdc } = await loadFixture(deployStableSimpleFixture);

        expect(await strategy.vaultMode()).to.equal(1);
        expect(await strategy.asset()).to.equal(await usdc.getAddress());
        expect(await strategy.isActive()).to.be.true;
        expect(await strategy.targetLtvBps()).to.equal(9000);
        expect(await strategy.targetLoops()).to.equal(4);
        expect(await strategy.safetyBufferBps()).to.equal(200);
        expect(await strategy.swapFeeTier()).to.equal(100);
        expect(await strategy.minSwapOutputBps()).to.equal(9900);
      });

      it("Should grant all roles correctly", async function () {
        const { strategy, admin, treasury, strategist, guardian, keeper } = await loadFixture(deployStableSimpleFixture);

        expect(await strategy.hasRole(await strategy.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
        expect(await strategy.hasRole(await strategy.TREASURY_ROLE(), treasury.address)).to.be.true;
        expect(await strategy.hasRole(await strategy.STRATEGIST_ROLE(), strategist.address)).to.be.true;
        expect(await strategy.hasRole(await strategy.GUARDIAN_ROLE(), guardian.address)).to.be.true;
        expect(await strategy.hasRole(await strategy.KEEPER_ROLE(), keeper.address)).to.be.true;
      });

      it("Should not allow re-initialization", async function () {
        const { strategy, usdc, treasury, admin, timelockSigner } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.initializeTestable({
            mode: 1,
            inputAsset: await usdc.getAddress(),
            supplyToken: await usdc.getAddress(),
            borrowToken: await usdc.getAddress(),
            supplyToken1: ethers.ZeroAddress,
            borrowToken1: ethers.ZeroAddress,
            fluidVault: ethers.ZeroAddress,
            vaultFactory: ethers.ZeroAddress,
            flashLoanPool: ethers.ZeroAddress,
            merklDistributor: ethers.ZeroAddress,
            swapRouter: ethers.ZeroAddress,
            vaultResolver: ethers.ZeroAddress,
            dexResolver: ethers.ZeroAddress,
            dexPool: ethers.ZeroAddress,
            treasury: treasury.address,
            admin: admin.address,
            timelock: timelockSigner.address,
          })
        ).to.be.reverted;
      });

      it("Should reject invalid vault mode", async function () {
        const [admin, treasury, , , , , timelockSigner] = await ethers.getSigners();
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdc = await MockERC20.deploy("USDC", "USDC", 6);

        const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
        await expect(
          upgrades.deployProxy(
            Strategy,
            [{
              mode: 0, // Invalid
              inputAsset: await usdc.getAddress(),
              supplyToken: await usdc.getAddress(),
              borrowToken: await usdc.getAddress(),
              supplyToken1: ethers.ZeroAddress,
              borrowToken1: ethers.ZeroAddress,
              fluidVault: await usdc.getAddress(),
              vaultFactory: await usdc.getAddress(),
              flashLoanPool: await usdc.getAddress(),
              merklDistributor: await usdc.getAddress(),
              swapRouter: await usdc.getAddress(),
              vaultResolver: ethers.ZeroAddress,
              dexResolver: ethers.ZeroAddress,
              dexPool: ethers.ZeroAddress,
              treasury: treasury.address,
              admin: admin.address,
              timelock: timelockSigner.address,
            }],
            { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
          )
        ).to.be.revertedWithCustomError(Strategy, "InvalidVaultMode");
      });

      it("Should report zero totalValue before deposits", async function () {
        const { strategy } = await loadFixture(deployStableSimpleFixture);
        expect(await strategy.totalValue()).to.equal(0);
      });
    });

    describe("Deposit (Flash-Loan Leverage)", function () {
      it("Should deposit with flash-loan leverage via VaultT1", async function () {
        const { strategy, treasury, fluidVault } = await loadFixture(deployStableSimpleFixture);

        const depositAmount = ethers.parseUnits("100000", 6); // 100k USDC
        await strategy.connect(treasury).deposit(depositAmount);

        // At 90% LTV: flash = 100k * 0.9 / 0.1 = 900k
        // Total supplied: 100k + 900k = 1M
        // Debt: 900k + premium
        expect(await strategy.totalPrincipal()).to.equal(depositAmount);

        const positionNftId = await strategy.positionNftId();
        expect(positionNftId).to.be.gt(0);

        const [col, debt] = await fluidVault.getPosition(positionNftId);
        expect(col).to.be.gt(ethers.parseUnits("900000", 6));
        expect(debt).to.be.gt(ethers.parseUnits("800000", 6));
      });

      it("Should create position NFT on first deposit", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        expect(await strategy.positionNftId()).to.equal(0);

        await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

        expect(await strategy.positionNftId()).to.be.gt(0);
      });

      it("Should accumulate principal on multiple deposits", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("50000", 6));
        await strategy.connect(treasury).deposit(ethers.parseUnits("30000", 6));

        expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("80000", 6));
      });

      it("Should revert deposit when not active", async function () {
        const { strategy, treasury, admin } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(admin).setActive(false);

        await expect(
          strategy.connect(treasury).deposit(ethers.parseUnits("1000", 6))
        ).to.be.revertedWithCustomError(strategy, "NotActive");
      });

      it("Should revert deposit with zero amount", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(treasury).deposit(0)
        ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
      });

      it("Should only allow TREASURY_ROLE to deposit", async function () {
        const { strategy, user1 } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(user1).deposit(ethers.parseUnits("1000", 6))
        ).to.be.reverted;
      });
    });

    describe("Withdraw", function () {
      it("Should withdraw partial amount", async function () {
        const { strategy, treasury, usdc } = await loadFixture(deployStableSimpleFixture);

        const depositAmount = ethers.parseUnits("100000", 6);
        await strategy.connect(treasury).deposit(depositAmount);

        const balanceBefore = await usdc.balanceOf(treasury.address);
        await strategy.connect(treasury).withdraw(ethers.parseUnits("50000", 6));
        const balanceAfter = await usdc.balanceOf(treasury.address);

        expect(balanceAfter - balanceBefore).to.be.gt(0);
      });

      it("Should withdrawAll and return everything", async function () {
        const { strategy, treasury, usdc } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const balanceBefore = await usdc.balanceOf(treasury.address);
        await strategy.connect(treasury).withdrawAll();
        const balanceAfter = await usdc.balanceOf(treasury.address);

        expect(balanceAfter).to.be.gt(balanceBefore);
        expect(await strategy.totalPrincipal()).to.equal(0);
      });

      it("Should revert withdraw with zero amount", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(treasury).withdraw(0)
        ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
      });

      it("Should only allow TREASURY_ROLE to withdraw", async function () {
        const { strategy, treasury, user1 } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

        await expect(
          strategy.connect(user1).withdraw(ethers.parseUnits("1000", 6))
        ).to.be.reverted;
      });
    });

    describe("Health Factor & Position", function () {
      it("Should return max health factor with no position", async function () {
        const { strategy } = await loadFixture(deployStableSimpleFixture);

        const hf = await strategy.getHealthFactor();
        expect(hf).to.equal(ethers.MaxUint256);
      });

      it("Should calculate health factor after deposit", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const hf = await strategy.getHealthFactor();
        // With 90% LTV, health factor ≈ 1.11 (col/debt)
        expect(hf).to.be.gt(ethers.parseUnits("1", 18));
        expect(hf).to.be.lt(ethers.parseUnits("2", 18));
      });

      it("Should return correct getPosition data", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const [collateral, borrowed, principal, netValue] = await strategy.getPosition();
        expect(collateral).to.be.gt(0);
        expect(borrowed).to.be.gt(0);
        expect(principal).to.equal(ethers.parseUnits("100000", 6));
        expect(netValue).to.be.gt(0);
      });

      it("Should report realSharePrice around 1.0", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const [priceWad, trusted] = await strategy.realSharePrice();
        // Share price should be close to 1.0 WAD (some loss to flash premium)
        expect(priceWad).to.be.gt(ethers.parseUnits("0.9", 18));
        expect(priceWad).to.be.lte(ethers.parseUnits("1.0", 18));
        expect(trusted).to.be.true;
      });

      it("Should report realTvl matching totalValue", async function () {
        const { strategy, treasury } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const [tvl, trusted] = await strategy.realTvl();
        expect(tvl).to.equal(await strategy.totalValue());
        expect(trusted).to.be.true;
      });
    });

    describe("Rebalance", function () {
      it("Should rebalance when over-leveraged", async function () {
        const { strategy, treasury, keeper, fluidVault } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
        const nftId = await strategy.positionNftId();

        // Simulate interest accrual → over-leveraged
        await fluidVault.simulateInterest(nftId, ethers.parseUnits("50000", 6));

        // Rebalance should reduce debt
        await strategy.connect(keeper).rebalance();

        // Should have executed without revert
        const [, borrowed,,] = await strategy.getPosition();
        expect(borrowed).to.be.gt(0);
      });

      it("Should only allow KEEPER_ROLE to rebalance", async function () {
        const { strategy, user1 } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(user1).rebalance()
        ).to.be.reverted;
      });
    });

    describe("Adjust Leverage", function () {
      it("Should adjust LTV target", async function () {
        const { strategy, strategist } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(strategist).adjustLeverage(8000, 0);

        expect(await strategy.targetLtvBps()).to.equal(8000);
      });

      it("Should reject invalid LTV", async function () {
        const { strategy, strategist } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(strategist).adjustLeverage(2000, 0) // Too low
        ).to.be.revertedWithCustomError(strategy, "InvalidLTV");

        await expect(
          strategy.connect(strategist).adjustLeverage(9600, 0) // Too high
        ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
      });

      it("Should only allow STRATEGIST_ROLE", async function () {
        const { strategy, user1 } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(user1).adjustLeverage(8000, 0)
        ).to.be.reverted;
      });
    });

    describe("Emergency Deleverage", function () {
      it("Should fully unwind position", async function () {
        const { strategy, treasury, guardian } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
        expect(await strategy.positionNftId()).to.be.gt(0);

        await strategy.connect(guardian).emergencyDeleverage();

        // Debt should be zero after full deleverage
        const [, borrowed,,] = await strategy.getPosition();
        expect(borrowed).to.equal(0);
      });

      it("Should only allow GUARDIAN_ROLE", async function () {
        const { strategy, user1 } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(user1).emergencyDeleverage()
        ).to.be.reverted;
      });
    });

    describe("Admin Functions", function () {
      it("Should set parameters", async function () {
        const { strategy, admin } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(admin).setParameters(8500, 3);
        expect(await strategy.targetLtvBps()).to.equal(8500);
        expect(await strategy.targetLoops()).to.equal(3);
      });

      it("Should toggle reward tokens", async function () {
        const { strategy, admin, rewardToken } = await loadFixture(deployStableSimpleFixture);

        expect(await strategy.allowedRewardTokens(await rewardToken.getAddress())).to.be.true;

        await strategy.connect(admin).setRewardToken(await rewardToken.getAddress(), false);
        expect(await strategy.allowedRewardTokens(await rewardToken.getAddress())).to.be.false;
      });

      it("Should set swap fees", async function () {
        const { strategy, admin } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(admin).setSwapFees(500, 10000);
        expect(await strategy.swapFeeTier()).to.equal(500);
        expect(await strategy.rewardSwapFeeTier()).to.equal(10000);
      });

      it("Should pause and unpause", async function () {
        const { strategy, guardian, timelockSigner } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(guardian).pause();
        // Deposit should fail when paused
        // (we don't test the deposit here since the treasury would need to be set up)

        await strategy.connect(timelockSigner).unpause();
        // Should be unpaused now
      });

      it("Should only allow timelock to unpause", async function () {
        const { strategy, guardian, admin } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(guardian).pause();

        await expect(
          strategy.connect(admin).unpause()
        ).to.be.reverted;
      });

      it("Should set active/inactive", async function () {
        const { strategy, admin } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(admin).setActive(false);
        expect(await strategy.isActive()).to.be.false;

        await strategy.connect(admin).setActive(true);
        expect(await strategy.isActive()).to.be.true;
      });

      it("Should recover tokens via timelock", async function () {
        const { strategy, timelockSigner, rewardToken } = await loadFixture(deployStableSimpleFixture);

        // Send reward tokens to strategy
        await rewardToken.mint(await strategy.getAddress(), ethers.parseUnits("100", 18));

        const balBefore = await rewardToken.balanceOf(timelockSigner.address);
        await strategy.connect(timelockSigner).recoverToken(
          await rewardToken.getAddress(),
          ethers.parseUnits("100", 18)
        );
        const balAfter = await rewardToken.balanceOf(timelockSigner.address);

        expect(balAfter - balBefore).to.equal(ethers.parseUnits("100", 18));
      });

      it("Should block recovering active asset with principal", async function () {
        const { strategy, treasury, timelockSigner, usdc } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

        await expect(
          strategy.connect(timelockSigner).recoverToken(await usdc.getAddress(), 1000)
        ).to.be.revertedWithCustomError(strategy, "CannotRecoverActiveAsset");
      });

      it("Should reject setParameters with invalid LTV", async function () {
        const { strategy, admin } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(admin).setParameters(2500, 3)
        ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
      });
    });

    describe("Merkl Rewards", function () {
      it("Should claim USDC rewards and compound", async function () {
        const { strategy, treasury, keeper, usdc, merklDistributor } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

        const rewardAmount = ethers.parseUnits("500", 6);
        const tokens = [await usdc.getAddress()];
        const amounts = [rewardAmount];
        const proofs = [[]]; // Mock accepts empty proofs

        const totalBefore = await strategy.totalRewardsClaimed();
        await strategy.connect(keeper).claimAndCompound(tokens, amounts, proofs);
        const totalAfter = await strategy.totalRewardsClaimed();

        expect(totalAfter).to.be.gt(totalBefore);
      });

      it("Should reject unallowed reward tokens", async function () {
        const { strategy, treasury, keeper } = await loadFixture(deployStableSimpleFixture);

        await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

        const fakeToken = ethers.Wallet.createRandom().address;

        await expect(
          strategy.connect(keeper).claimAndCompound([fakeToken], [1000], [[]])
        ).to.be.revertedWithCustomError(strategy, "RewardTokenNotAllowed");
      });

      it("Should only allow KEEPER_ROLE to claim", async function () {
        const { strategy, user1, usdc } = await loadFixture(deployStableSimpleFixture);

        await expect(
          strategy.connect(user1).claimAndCompound(
            [await usdc.getAddress()], [1000], [[]]
          )
        ).to.be.reverted;
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  MODE 2 — LRT (weETH-ETH / wstETH) via VaultT2
  // ═══════════════════════════════════════════════════════════════════

  describe("MODE 2: LRT (weETH-ETH / wstETH — VaultT2)", function () {

    async function deployLRTFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      // Tokens (18 decimals for ETH-like)
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
      const weETH = await MockERC20.deploy("Wrapped eETH", "weETH", 18);
      const wstETH = await MockERC20.deploy("Wrapped stETH", "wstETH", 18);
      const rewardToken = await MockERC20.deploy("Fluid Token", "FLUID", 18);

      // AAVE pool (flash loan in WETH as input asset)
      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await weth.getAddress());
      await weth.mint(admin.address, ethers.parseEther("100000"));
      await weth.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseEther("50000"));

      // Fluid T2 vault: weETH (col0), WETH (col1) — supply side | wstETH — borrow side
      // For test simplicity, supply and borrow use same token (WETH)
      const MockFluidVaultT2 = await ethers.getContractFactory("MockFluidVaultT2");
      const fluidVault = await MockFluidVaultT2.deploy(
        await weth.getAddress(), // colToken0 (simplified: WETH instead of weETH)
        await weth.getAddress(), // colToken1 (WETH)
        await weth.getAddress()  // debtToken (simplified: WETH instead of wstETH)
      );

      // Seed vault with tokens for borrows
      await weth.mint(admin.address, ethers.parseEther("50000"));
      await weth.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await weth.getAddress(), ethers.parseEther("50000"));

      // Factory
      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      // Merkl + SwapRouter
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      // Deploy strategy
      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const initParams = {
        mode: 2, // MODE_LRT
        inputAsset: await weth.getAddress(),
        supplyToken: await weth.getAddress(), // Simplified
        borrowToken: await weth.getAddress(), // Simplified
        supplyToken1: await weth.getAddress(),
        borrowToken1: ethers.ZeroAddress,
        fluidVault: await fluidVault.getAddress(),
        vaultFactory: await vaultFactory.getAddress(),
        flashLoanPool: await aavePool.getAddress(),
        merklDistributor: await merklDistributor.getAddress(),
        swapRouter: await swapRouter.getAddress(),
        vaultResolver: ethers.ZeroAddress,
        dexResolver: ethers.ZeroAddress,
        dexPool: ethers.ZeroAddress,
        treasury: treasury.address,
        admin: admin.address,
        timelock: timelockSigner.address,
      };

      const strategy = await upgrades.deployProxy(
        Strategy,
        [initParams],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);

      // Fund treasury
      await weth.mint(treasury.address, ethers.parseEther("10000"));
      await weth.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      return {
        strategy, weth, weETH, wstETH, rewardToken,
        aavePool, fluidVault, vaultFactory, merklDistributor, swapRouter,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
      };
    }

    describe("Initialization (LRT)", function () {
      it("Should set MODE_LRT parameters", async function () {
        const { strategy, weth } = await loadFixture(deployLRTFixture);

        expect(await strategy.vaultMode()).to.equal(2);
        expect(await strategy.asset()).to.equal(await weth.getAddress());
        expect(await strategy.targetLtvBps()).to.equal(9200);
        expect(await strategy.targetLoops()).to.equal(4);
      });
    });

    describe("Deposit (LRT)", function () {
      it("Should deposit with T2 operate", async function () {
        const { strategy, treasury, fluidVault } = await loadFixture(deployLRTFixture);

        const depositAmount = ethers.parseEther("10"); // 10 WETH
        await strategy.connect(treasury).deposit(depositAmount);

        expect(await strategy.totalPrincipal()).to.equal(depositAmount);
        expect(await strategy.positionNftId()).to.be.gt(0);

        const nftId = await strategy.positionNftId();
        const [col0, col1, debt] = await fluidVault.getPosition(nftId);
        expect(col0).to.be.gt(ethers.parseEther("50")); // leveraged
        expect(debt).to.be.gt(ethers.parseEther("50"));
      });
    });

    describe("Withdraw (LRT)", function () {
      it("Should withdrawAll from T2 vault", async function () {
        const { strategy, treasury, weth } = await loadFixture(deployLRTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const balBefore = await weth.balanceOf(treasury.address);
        await strategy.connect(treasury).withdrawAll();
        const balAfter = await weth.balanceOf(treasury.address);

        expect(balAfter).to.be.gt(balBefore);
        expect(await strategy.totalPrincipal()).to.equal(0);
      });
    });

    describe("Position Monitoring (LRT)", function () {
      it("Should report health factor > 1", async function () {
        const { strategy, treasury } = await loadFixture(deployLRTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const hf = await strategy.getHealthFactor();
        expect(hf).to.be.gt(ethers.parseUnits("1", 18));
      });

      it("Should report leverage", async function () {
        const { strategy, treasury } = await loadFixture(deployLRTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const leverage = await strategy.getCurrentLeverage();
        expect(leverage).to.be.gte(500);  // > 5x leverage at 92% LTV
      });
    });

    describe("Emergency (LRT)", function () {
      it("Should emergency deleverage T2 position", async function () {
        const { strategy, treasury, guardian } = await loadFixture(deployLRTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));
        await strategy.connect(guardian).emergencyDeleverage();

        const [, borrowed,,] = await strategy.getPosition();
        expect(borrowed).to.equal(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  MODE 3 — LST (wstETH-ETH / wstETH-ETH) via VaultT4
  // ═══════════════════════════════════════════════════════════════════

  describe("MODE 3: LST (wstETH-ETH / wstETH-ETH — VaultT4)", function () {

    async function deployLSTFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
      const wstETH = await MockERC20.deploy("Wrapped stETH", "wstETH", 18);
      const rewardToken = await MockERC20.deploy("Fluid Token", "FLUID", 18);

      // AAVE pool
      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await weth.getAddress());
      await weth.mint(admin.address, ethers.parseEther("100000"));
      await weth.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseEther("50000"));

      // Fluid T4 vault: all tokens WETH for test simplicity (same LP both sides)
      const MockFluidVaultT4 = await ethers.getContractFactory("MockFluidVaultT4");
      const fluidVault = await MockFluidVaultT4.deploy(
        await weth.getAddress(), // colToken0
        await weth.getAddress(), // colToken1
        await weth.getAddress(), // debtToken0
        await weth.getAddress()  // debtToken1
      );

      // Seed vault
      await weth.mint(admin.address, ethers.parseEther("50000"));
      await weth.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await weth.getAddress(), ethers.parseEther("50000"));

      // Factory
      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      // Merkl + Swap
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      // Deploy strategy
      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const initParams = {
        mode: 3, // MODE_LST
        inputAsset: await weth.getAddress(),
        supplyToken: await weth.getAddress(),
        borrowToken: await weth.getAddress(),
        supplyToken1: await weth.getAddress(),
        borrowToken1: await weth.getAddress(),
        fluidVault: await fluidVault.getAddress(),
        vaultFactory: await vaultFactory.getAddress(),
        flashLoanPool: await aavePool.getAddress(),
        merklDistributor: await merklDistributor.getAddress(),
        swapRouter: await swapRouter.getAddress(),
        vaultResolver: ethers.ZeroAddress,
        dexResolver: ethers.ZeroAddress,
        dexPool: ethers.ZeroAddress,
        treasury: treasury.address,
        admin: admin.address,
        timelock: timelockSigner.address,
      };

      const strategy = await upgrades.deployProxy(
        Strategy,
        [initParams],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);

      // Fund treasury
      await weth.mint(treasury.address, ethers.parseEther("10000"));
      await weth.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      return {
        strategy, weth, wstETH, rewardToken,
        aavePool, fluidVault, vaultFactory, merklDistributor, swapRouter,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
      };
    }

    describe("Initialization (LST)", function () {
      it("Should set MODE_LST parameters", async function () {
        const { strategy, weth } = await loadFixture(deployLSTFixture);

        expect(await strategy.vaultMode()).to.equal(3);
        expect(await strategy.asset()).to.equal(await weth.getAddress());
        expect(await strategy.targetLtvBps()).to.equal(9400);
        expect(await strategy.targetLoops()).to.equal(5);
      });
    });

    describe("Deposit (LST)", function () {
      it("Should deposit with T4 operate (smart col + smart debt)", async function () {
        const { strategy, treasury, fluidVault } = await loadFixture(deployLSTFixture);

        const depositAmount = ethers.parseEther("10");
        await strategy.connect(treasury).deposit(depositAmount);

        expect(await strategy.totalPrincipal()).to.equal(depositAmount);
        expect(await strategy.positionNftId()).to.be.gt(0);

        const nftId = await strategy.positionNftId();
        const [col0, col1, dbt0, dbt1] = await fluidVault.getPosition(nftId);
        // At 94% LTV, flash = 10 * 0.94 / 0.06 ≈ 156.67 ETH
        // Total supply ≈ 166.67 ETH
        expect(col0).to.be.gt(ethers.parseEther("100"));
        expect(dbt0).to.be.gt(ethers.parseEther("100"));
      });
    });

    describe("Withdraw (LST)", function () {
      it("Should withdrawAll from T4 vault", async function () {
        const { strategy, treasury, weth } = await loadFixture(deployLSTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const balBefore = await weth.balanceOf(treasury.address);
        await strategy.connect(treasury).withdrawAll();
        const balAfter = await weth.balanceOf(treasury.address);

        expect(balAfter).to.be.gt(balBefore);
        expect(await strategy.totalPrincipal()).to.equal(0);
      });
    });

    describe("Position Monitoring (LST)", function () {
      it("Should report health factor > 1", async function () {
        const { strategy, treasury } = await loadFixture(deployLSTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const hf = await strategy.getHealthFactor();
        expect(hf).to.be.gt(ethers.parseUnits("1", 18));
      });

      it("Should report high leverage for LST loop", async function () {
        const { strategy, treasury } = await loadFixture(deployLSTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));

        const leverage = await strategy.getCurrentLeverage();
        // At 94% LTV: leverage ≈ 16.67x (1667)
        expect(leverage).to.be.gte(1000); // > 10x
      });
    });

    describe("Emergency (LST)", function () {
      it("Should emergency deleverage T4 position", async function () {
        const { strategy, treasury, guardian } = await loadFixture(deployLSTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));
        await strategy.connect(guardian).emergencyDeleverage();

        const [, borrowed,,] = await strategy.getPosition();
        expect(borrowed).to.equal(0);
      });
    });

    describe("Interest Simulation (LST)", function () {
      it("Should detect over-leverage from interest accrual", async function () {
        const { strategy, treasury, keeper, fluidVault } = await loadFixture(deployLSTFixture);

        await strategy.connect(treasury).deposit(ethers.parseEther("10"));
        const nftId = await strategy.positionNftId();

        // Simulate interest on T4 vault
        await fluidVault.simulateInterest(nftId, ethers.parseEther("5"), ethers.parseEther("5"));

        // Rebalance should handle it
        await strategy.connect(keeper).rebalance();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  CROSS-CUTTING TESTS
  // ═══════════════════════════════════════════════════════════════════

  describe("Cross-Cutting", function () {
    async function deploySimpleStable() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(await usdc.getAddress(), await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const strategy = await upgrades.deployProxy(
        Strategy,
        [{
          mode: 1,
          inputAsset: await usdc.getAddress(),
          supplyToken: await usdc.getAddress(),
          borrowToken: await usdc.getAddress(),
          supplyToken1: ethers.ZeroAddress,
          borrowToken1: ethers.ZeroAddress,
          fluidVault: await fluidVault.getAddress(),
          vaultFactory: await vaultFactory.getAddress(),
          flashLoanPool: await aavePool.getAddress(),
          merklDistributor: await merklDistributor.getAddress(),
          swapRouter: await swapRouter.getAddress(),
          vaultResolver: ethers.ZeroAddress,
          dexResolver: ethers.ZeroAddress,
          dexPool: ethers.ZeroAddress,
          treasury: treasury.address,
          admin: admin.address,
          timelock: timelockSigner.address,
        }],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);

      await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
      await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      return { strategy, usdc, fluidVault, admin, treasury, strategist, guardian, keeper, user1, timelockSigner };
    }

    it("Should emit Deposited event on deposit", async function () {
      const { strategy, treasury } = await loadFixture(deploySimpleStable);

      await expect(
        strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6))
      ).to.emit(strategy, "Deposited");
    });

    it("Should emit Withdrawn event on withdraw", async function () {
      const { strategy, treasury } = await loadFixture(deploySimpleStable);

      await strategy.connect(treasury).deposit(ethers.parseUnits("10000", 6));

      await expect(
        strategy.connect(treasury).withdraw(ethers.parseUnits("5000", 6))
      ).to.emit(strategy, "Withdrawn");
    });

    it("Should emit ParametersUpdated on setParameters", async function () {
      const { strategy, admin } = await loadFixture(deploySimpleStable);

      await expect(
        strategy.connect(admin).setParameters(8500, 3)
      ).to.emit(strategy, "ParametersUpdated").withArgs(8500, 3);
    });

    it("Should handle deposit → full withdraw cycle", async function () {
      const { strategy, treasury, usdc } = await loadFixture(deploySimpleStable);

      const initialBalance = await usdc.balanceOf(treasury.address);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("100000", 6));

      await strategy.connect(treasury).withdrawAll();
      expect(await strategy.totalPrincipal()).to.equal(0);

      const finalBalance = await usdc.balanceOf(treasury.address);
      // Some loss due to flash loan premium
      expect(finalBalance).to.be.gt(initialBalance - ethers.parseUnits("1000", 6));
    });

    it("Should handle multiple deposit-withdraw cycles", async function () {
      const { strategy, treasury } = await loadFixture(deploySimpleStable);

      // Cycle 1
      await strategy.connect(treasury).deposit(ethers.parseUnits("50000", 6));
      await strategy.connect(treasury).withdrawAll();

      // Cycle 2
      await strategy.connect(treasury).deposit(ethers.parseUnits("25000", 6));
      expect(await strategy.totalPrincipal()).to.equal(ethers.parseUnits("25000", 6));

      await strategy.connect(treasury).withdrawAll();
      expect(await strategy.totalPrincipal()).to.equal(0);
    });

    it("Should reject setMinSwapOutput out of range", async function () {
      const { strategy, admin } = await loadFixture(deploySimpleStable);

      await expect(
        strategy.connect(admin).setMinSwapOutput(8000)
      ).to.be.revertedWithCustomError(strategy, "InvalidLTV");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  V2: VAULT RESOLVER INTEGRATION TESTS
  // ═══════════════════════════════════════════════════════════════════

  describe("VaultResolver Integration (T1 with live resolver)", function () {

    async function deployWithResolverFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(await usdc.getAddress(), await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      // Deploy MockFluidVaultResolver
      const MockVaultResolver = await ethers.getContractFactory("MockFluidVaultResolver");
      const vaultResolver = await MockVaultResolver.deploy();

      // Deploy MockFluidDexResolver
      const MockDexResolver = await ethers.getContractFactory("MockFluidDexResolver");
      const dexResolver = await MockDexResolver.deploy();

      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const strategy = await upgrades.deployProxy(
        Strategy,
        [{
          mode: 1,
          inputAsset: await usdc.getAddress(),
          supplyToken: await usdc.getAddress(),
          borrowToken: await usdc.getAddress(),
          supplyToken1: ethers.ZeroAddress,
          borrowToken1: ethers.ZeroAddress,
          fluidVault: await fluidVault.getAddress(),
          vaultFactory: await vaultFactory.getAddress(),
          flashLoanPool: await aavePool.getAddress(),
          merklDistributor: await merklDistributor.getAddress(),
          swapRouter: await swapRouter.getAddress(),
          vaultResolver: await vaultResolver.getAddress(),
          dexResolver: await dexResolver.getAddress(),
          dexPool: ethers.ZeroAddress,
          treasury: treasury.address,
          admin: admin.address,
          timelock: timelockSigner.address,
        }],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);

      await usdc.mint(treasury.address, ethers.parseUnits("10000000", 6));
      await usdc.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      return {
        strategy, usdc, fluidVault, vaultResolver, dexResolver,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
      };
    }

    it("Should store vaultResolver address on initialization", async function () {
      const { strategy, vaultResolver } = await loadFixture(deployWithResolverFixture);
      expect(await strategy.vaultResolver()).to.equal(await vaultResolver.getAddress());
    });

    it("Should store dexResolver address on initialization", async function () {
      const { strategy, dexResolver } = await loadFixture(deployWithResolverFixture);
      expect(await strategy.dexResolver()).to.equal(await dexResolver.getAddress());
    });

    it("Should read position via VaultResolver after deposit", async function () {
      const { strategy, treasury, vaultResolver, fluidVault } = await loadFixture(deployWithResolverFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));

      const nftId = await strategy.positionNftId();
      expect(nftId).to.be.gt(0);

      // Register position in mock resolver so it can answer positionByNftId
      await vaultResolver.registerPosition(nftId, await fluidVault.getAddress(), 1);

      // Now totalValue should read from VaultResolver path
      const totalVal = await strategy.totalValue();
      expect(totalVal).to.be.gt(0);
    });

    it("Should return correct health factor via resolver", async function () {
      const { strategy, treasury, vaultResolver, fluidVault } = await loadFixture(deployWithResolverFixture);

      await strategy.connect(treasury).deposit(ethers.parseUnits("100000", 6));
      const nftId = await strategy.positionNftId();
      await vaultResolver.registerPosition(nftId, await fluidVault.getAddress(), 1);

      const hf = await strategy.getHealthFactor();
      // At 90% LTV, HF ≈ 1.11 (1e18 / 0.9)
      expect(hf).to.be.gt(ethers.parseEther("1.0"));
      expect(hf).to.be.lt(ethers.parseEther("1.2"));
    });

    it("Should allow timelock to set new vaultResolver", async function () {
      const { strategy, timelockSigner, vaultResolver } = await loadFixture(deployWithResolverFixture);

      const MockVaultResolver = await ethers.getContractFactory("MockFluidVaultResolver");
      const newResolver = await MockVaultResolver.deploy();

      await strategy.connect(timelockSigner).setVaultResolver(await newResolver.getAddress());
      expect(await strategy.vaultResolver()).to.equal(await newResolver.getAddress());
    });

    it("Should reject non-timelock setting vaultResolver", async function () {
      const { strategy, admin } = await loadFixture(deployWithResolverFixture);

      const MockVaultResolver = await ethers.getContractFactory("MockFluidVaultResolver");
      const newResolver = await MockVaultResolver.deploy();

      await expect(
        strategy.connect(admin).setVaultResolver(await newResolver.getAddress())
      ).to.be.reverted;
    });

    it("Should reject setting vaultResolver to zero address", async function () {
      const { strategy, timelockSigner } = await loadFixture(deployWithResolverFixture);

      await expect(
        strategy.connect(timelockSigner).setVaultResolver(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  V2: DEX SMART COLLATERAL TESTS
  // ═══════════════════════════════════════════════════════════════════

  describe("DEX Smart Collateral (T2 with DEX integration)", function () {

    async function deployDexFixture() {
      const [admin, treasury, strategist, guardian, keeper, user1, timelockSigner] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
      const weETH = await MockERC20.deploy("Wrapped eETH", "weETH", 18);

      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await weth.getAddress());
      await weth.mint(admin.address, ethers.parseEther("100000"));
      await weth.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseEther("50000"));

      const MockFluidVaultT2 = await ethers.getContractFactory("MockFluidVaultT2");
      const fluidVault = await MockFluidVaultT2.deploy(
        await weth.getAddress(), await weth.getAddress(), await weth.getAddress()
      );
      await weth.mint(admin.address, ethers.parseEther("50000"));
      await weth.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await weth.getAddress(), ethers.parseEther("50000"));

      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();

      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();

      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      // Deploy mock resolvers
      const MockVaultResolver = await ethers.getContractFactory("MockFluidVaultResolver");
      const vaultResolver = await MockVaultResolver.deploy();

      const MockDexResolver = await ethers.getContractFactory("MockFluidDexResolver");
      const dexResolver = await MockDexResolver.deploy();

      // Use a mock "DEX pool" address (any non-zero for configuration)
      const dexPoolAddress = await dexResolver.getAddress(); // just a non-zero addr

      // Configure DEX share ratios (1e18 = 1:1 ratio, simplified)
      await dexResolver.setShareRatios(
        dexPoolAddress,
        ethers.parseEther("0.5"),  // 0.5 token0 per supply share
        ethers.parseEther("0.5"),  // 0.5 token1 per supply share
        ethers.parseEther("0.5"),  // 0.5 token0 per borrow share
        ethers.parseEther("0.5")   // 0.5 token1 per borrow share
      );

      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const strategy = await upgrades.deployProxy(
        Strategy,
        [{
          mode: 2, // MODE_LRT
          inputAsset: await weth.getAddress(),
          supplyToken: await weth.getAddress(),
          borrowToken: await weth.getAddress(),
          supplyToken1: await weth.getAddress(),
          borrowToken1: ethers.ZeroAddress,
          fluidVault: await fluidVault.getAddress(),
          vaultFactory: await vaultFactory.getAddress(),
          flashLoanPool: await aavePool.getAddress(),
          merklDistributor: await merklDistributor.getAddress(),
          swapRouter: await swapRouter.getAddress(),
          vaultResolver: ethers.ZeroAddress,  // use mock reads for vault ops
          dexResolver: await dexResolver.getAddress(),
          dexPool: dexPoolAddress,
          treasury: treasury.address,
          admin: admin.address,
          timelock: timelockSigner.address,
        }],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await strategy.grantRole(await strategy.STRATEGIST_ROLE(), strategist.address);
      await strategy.grantRole(await strategy.GUARDIAN_ROLE(), guardian.address);
      await strategy.grantRole(await strategy.KEEPER_ROLE(), keeper.address);

      await weth.mint(treasury.address, ethers.parseEther("10000"));
      await weth.connect(treasury).approve(await strategy.getAddress(), ethers.MaxUint256);

      // Fund strategy with tokens for DEX deposits
      await weth.mint(await strategy.getAddress(), ethers.parseEther("1000"));

      return {
        strategy, weth, weETH, fluidVault, vaultResolver, dexResolver,
        admin, treasury, strategist, guardian, keeper, user1, timelockSigner,
        dexPoolAddress,
      };
    }

    it("Should initialize with DEX enabled", async function () {
      const { strategy, dexPoolAddress } = await loadFixture(deployDexFixture);
      expect(await strategy.dexEnabled()).to.be.true;
      expect(await strategy.dexPool()).to.equal(dexPoolAddress);
    });

    it("Should deposit DEX collateral via strategist", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);

      // First create a normal position
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // Now deposit DEX smart collateral
      await expect(
        strategy.connect(strategist).depositDexCollateral(
          ethers.parseEther("10"),
          ethers.parseEther("10"),
          1 // min 1 share
        )
      ).to.emit(strategy, "DexCollateralDeposited");
    });

    it("Should reject DEX deposit on T1 (stable) vault", async function () {
      // Deploy a T1 strategy with DEX enabled (should still reject)
      const [admin, treasury, , , , , timelockSigner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(await usdc.getAddress(), await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();
      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const strategy = await upgrades.deployProxy(
        Strategy,
        [{
          mode: 1, // STABLE — no DEX
          inputAsset: await usdc.getAddress(),
          supplyToken: await usdc.getAddress(),
          borrowToken: await usdc.getAddress(),
          supplyToken1: ethers.ZeroAddress,
          borrowToken1: ethers.ZeroAddress,
          fluidVault: await fluidVault.getAddress(),
          vaultFactory: await vaultFactory.getAddress(),
          flashLoanPool: await aavePool.getAddress(),
          merklDistributor: await merklDistributor.getAddress(),
          swapRouter: await swapRouter.getAddress(),
          vaultResolver: ethers.ZeroAddress,
          dexResolver: ethers.ZeroAddress,
          dexPool: admin.address, // non-zero to make dexEnabled = true
          treasury: treasury.address,
          admin: admin.address,
          timelock: timelockSigner.address,
        }],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await expect(
        strategy.depositDexCollateral(ethers.parseUnits("100", 6), 0, 1)
      ).to.be.revertedWithCustomError(strategy, "InvalidVaultMode");
    });

    it("Should reject DEX deposit from non-strategist", async function () {
      const { strategy, treasury, user1 } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      await expect(
        strategy.connect(user1).depositDexCollateral(ethers.parseEther("10"), 0, 1)
      ).to.be.reverted;
    });

    it("Should allow timelock to toggle dexPool", async function () {
      const { strategy, timelockSigner, admin } = await loadFixture(deployDexFixture);

      // Disable DEX
      await strategy.connect(timelockSigner).setDexPool(ethers.ZeroAddress, false);
      expect(await strategy.dexEnabled()).to.be.false;

      // Re-enable with a new address
      await strategy.connect(timelockSigner).setDexPool(admin.address, true);
      expect(await strategy.dexEnabled()).to.be.true;
      expect(await strategy.dexPool()).to.equal(admin.address);
    });

    it("Should reject DEX deposit when dexEnabled is false", async function () {
      const { strategy, treasury, strategist, timelockSigner } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // Disable DEX
      await strategy.connect(timelockSigner).setDexPool(ethers.ZeroAddress, false);

      await expect(
        strategy.connect(strategist).depositDexCollateral(ethers.parseEther("10"), 0, 1)
      ).to.be.revertedWithCustomError(strategy, "NotActive");
    });

    it("Should reject DEX deposit with zero amounts", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      await expect(
        strategy.connect(strategist).depositDexCollateral(0, 0, 1)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should emit DexCollateralDeposited with correct args", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      const t0 = ethers.parseEther("10");
      const t1 = ethers.parseEther("5");
      await expect(
        strategy.connect(strategist).depositDexCollateral(t0, t1, 1)
      ).to.emit(strategy, "DexCollateralDeposited").withArgs(t0, t1);
    });

    it("Should deposit single-sided DEX collateral (token0 only)", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // token0 = 10e18, token1 = 0
      await expect(
        strategy.connect(strategist).depositDexCollateral(ethers.parseEther("10"), 0, 1)
      ).to.emit(strategy, "DexCollateralDeposited").withArgs(ethers.parseEther("10"), 0);
    });

    it("Should deposit single-sided DEX collateral (token1 only)", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // token0 = 0, token1 = 5e18 — at least one must be non-zero
      await expect(
        strategy.connect(strategist).depositDexCollateral(0, ethers.parseEther("5"), 1)
      ).to.emit(strategy, "DexCollateralDeposited").withArgs(0, ethers.parseEther("5"));
    });

    it("Should withdraw DEX collateral via strategist", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // First deposit some DEX collateral
      await strategy.connect(strategist).depositDexCollateral(
        ethers.parseEther("10"), ethers.parseEther("10"), 1
      );

      // Now withdraw it
      await expect(
        strategy.connect(strategist).withdrawDexCollateral(
          ethers.parseEther("5"), // sharesToBurn
          0, // minToken0
          0  // minToken1
        )
      ).to.emit(strategy, "DexCollateralWithdrawn").withArgs(ethers.parseEther("5"));
    });

    it("Should reject withdrawDexCollateral from non-strategist", async function () {
      const { strategy, treasury, strategist, user1 } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      await strategy.connect(strategist).depositDexCollateral(
        ethers.parseEther("10"), ethers.parseEther("10"), 1
      );

      await expect(
        strategy.connect(user1).withdrawDexCollateral(ethers.parseEther("5"), 0, 0)
      ).to.be.reverted;
    });

    it("Should reject withdrawDexCollateral with zero shares", async function () {
      const { strategy, treasury, strategist } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      await expect(
        strategy.connect(strategist).withdrawDexCollateral(0, 0, 0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("Should reject withdrawDexCollateral when dexEnabled is false", async function () {
      const { strategy, treasury, strategist, timelockSigner } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // Disable DEX
      await strategy.connect(timelockSigner).setDexPool(ethers.ZeroAddress, false);

      await expect(
        strategy.connect(strategist).withdrawDexCollateral(ethers.parseEther("5"), 0, 0)
      ).to.be.revertedWithCustomError(strategy, "NotActive");
    });

    it("Should reject withdrawDexCollateral on T1 (stable) vault", async function () {
      // Deploy a T1 strategy with DEX enabled
      const [admin, treasury, , , , , timelockSigner] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const MockAaveV3Pool = await ethers.getContractFactory("MockAaveV3Pool");
      const aavePool = await MockAaveV3Pool.deploy(await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("100000000", 6));
      await usdc.approve(await aavePool.getAddress(), ethers.MaxUint256);
      await aavePool.seedLiquidity(ethers.parseUnits("50000000", 6));

      const MockFluidVaultT1 = await ethers.getContractFactory("MockFluidVaultT1");
      const fluidVault = await MockFluidVaultT1.deploy(await usdc.getAddress(), await usdc.getAddress());
      await usdc.mint(admin.address, ethers.parseUnits("50000000", 6));
      await usdc.approve(await fluidVault.getAddress(), ethers.MaxUint256);
      await fluidVault.seedLiquidity(await usdc.getAddress(), ethers.parseUnits("50000000", 6));

      const MockFactory = await ethers.getContractFactory("MockFluidVaultFactory");
      const vaultFactory = await MockFactory.deploy();
      const MockMerklDistributor = await ethers.getContractFactory("MockMerklDistributor");
      const merklDistributor = await MockMerklDistributor.deploy();
      const MockSwapRouter = await ethers.getContractFactory("MockSwapRouterCrossStable");
      const swapRouter = await MockSwapRouter.deploy();

      const Strategy = await ethers.getContractFactory("FluidLoopStrategyTestable");
      const strategy = await upgrades.deployProxy(
        Strategy,
        [{
          mode: 1, // STABLE
          inputAsset: await usdc.getAddress(),
          supplyToken: await usdc.getAddress(),
          borrowToken: await usdc.getAddress(),
          supplyToken1: ethers.ZeroAddress,
          borrowToken1: ethers.ZeroAddress,
          fluidVault: await fluidVault.getAddress(),
          vaultFactory: await vaultFactory.getAddress(),
          flashLoanPool: await aavePool.getAddress(),
          merklDistributor: await merklDistributor.getAddress(),
          swapRouter: await swapRouter.getAddress(),
          vaultResolver: ethers.ZeroAddress,
          dexResolver: ethers.ZeroAddress,
          dexPool: admin.address,
          treasury: treasury.address,
          admin: admin.address,
          timelock: timelockSigner.address,
        }],
        { kind: "uups", initializer: "initializeTestable", unsafeAllow: ["constructor"] }
      );

      await expect(
        strategy.withdrawDexCollateral(ethers.parseUnits("100", 6), 0, 0)
      ).to.be.revertedWithCustomError(strategy, "InvalidVaultMode");
    });

    it("Should emit DexPoolUpdated on setDexPool", async function () {
      const { strategy, timelockSigner, admin } = await loadFixture(deployDexFixture);

      await expect(
        strategy.connect(timelockSigner).setDexPool(admin.address, true)
      ).to.emit(strategy, "DexPoolUpdated").withArgs(admin.address, true);
    });

    it("Should allow timelock to set new dexResolver", async function () {
      const { strategy, timelockSigner } = await loadFixture(deployDexFixture);

      const MockDexResolver = await ethers.getContractFactory("MockFluidDexResolver");
      const newResolver = await MockDexResolver.deploy();

      await strategy.connect(timelockSigner).setDexResolver(await newResolver.getAddress());
      expect(await strategy.dexResolver()).to.equal(await newResolver.getAddress());
    });

    it("Should reject non-timelock setting dexResolver", async function () {
      const { strategy, admin } = await loadFixture(deployDexFixture);

      const MockDexResolver = await ethers.getContractFactory("MockFluidDexResolver");
      const newResolver = await MockDexResolver.deploy();

      await expect(
        strategy.connect(admin).setDexResolver(await newResolver.getAddress())
      ).to.be.reverted;
    });

    it("Should reject setting dexResolver to zero address", async function () {
      const { strategy, timelockSigner } = await loadFixture(deployDexFixture);

      await expect(
        strategy.connect(timelockSigner).setDexResolver(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("Should reject DEX deposit when paused", async function () {
      const { strategy, treasury, strategist, guardian } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));

      // Pause the contract
      await strategy.connect(guardian).pause();

      await expect(
        strategy.connect(strategist).depositDexCollateral(ethers.parseEther("10"), 0, 1)
      ).to.be.reverted; // EnforcedPause
    });

    it("Should reject DEX withdrawal when paused", async function () {
      const { strategy, treasury, strategist, guardian } = await loadFixture(deployDexFixture);
      await strategy.connect(treasury).deposit(ethers.parseEther("100"));
      await strategy.connect(strategist).depositDexCollateral(
        ethers.parseEther("10"), ethers.parseEther("10"), 1
      );

      // Pause the contract
      await strategy.connect(guardian).pause();

      await expect(
        strategy.connect(strategist).withdrawDexCollateral(ethers.parseEther("5"), 0, 0)
      ).to.be.reverted; // EnforcedPause
    });
  });
});
