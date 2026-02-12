/**
 * CollateralVault Tests
 * Tests: deposit/withdraw, collateral config, seize (liquidation), role access control
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { CollateralVault, MockERC20 } from "../typechain-types";
import { timelockAddCollateral, timelockUpdateCollateral, timelockSetBorrowModule } from "./helpers/timelock";

describe("CollateralVault", function () {
  let vault: CollateralVault;
  let weth: MockERC20;
  let wbtc: MockERC20;
  let deployer: HardhatEthersSigner;
  let borrowModule: HardhatEthersSigner;
  let liquidator: HardhatEthersSigner;
  let leverageVault: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const WETH_FACTOR = 7500n;       // 75% LTV
  const WETH_LIQ_THRESHOLD = 8000n; // 80%
  const WETH_LIQ_PENALTY = 500n;    // 5%

  beforeEach(async function () {
    [deployer, borrowModule, liquidator, leverageVault, user1, user2] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);
    wbtc = await MockERC20Factory.deploy("Wrapped Bitcoin", "WBTC", 8);

    // Deploy vault
    const VaultFactory = await ethers.getContractFactory("CollateralVault");
    vault = await VaultFactory.deploy();
    await vault.waitForDeployment();

    // Grant roles
    await vault.grantRole(await vault.BORROW_MODULE_ROLE(), borrowModule.address);
    await vault.grantRole(await vault.LIQUIDATION_ROLE(), liquidator.address);
    await vault.grantRole(await vault.LEVERAGE_VAULT_ROLE(), leverageVault.address);

    // Add WETH as collateral
    await timelockAddCollateral(
      vault, deployer,
      await weth.getAddress(),
      WETH_FACTOR,
      WETH_LIQ_THRESHOLD,
      WETH_LIQ_PENALTY
    );

    // Mint and approve tokens
    await weth.mint(user1.address, ethers.parseEther("100"));
    await weth.mint(user2.address, ethers.parseEther("100"));
    await weth.mint(leverageVault.address, ethers.parseEther("100"));
    await weth.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await weth.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);
    await weth.connect(leverageVault).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  // ============================================================
  //  COLLATERAL CONFIG
  // ============================================================

  describe("Collateral Config", function () {
    it("should add collateral with correct parameters", async function () {
      const [enabled, factor, threshold, penalty] = await vault.getConfig(await weth.getAddress());
      expect(enabled).to.be.true;
      expect(factor).to.equal(WETH_FACTOR);
      expect(threshold).to.equal(WETH_LIQ_THRESHOLD);
      expect(penalty).to.equal(WETH_LIQ_PENALTY);
    });

    it("should reject duplicate collateral add", async function () {
      await expect(
        vault.requestAddCollateral(await weth.getAddress(), WETH_FACTOR, WETH_LIQ_THRESHOLD, WETH_LIQ_PENALTY)
      ).to.be.revertedWith("ALREADY_ADDED");
    });

    it("should reject zero address collateral", async function () {
      await expect(
        vault.requestAddCollateral(ethers.ZeroAddress, WETH_FACTOR, WETH_LIQ_THRESHOLD, WETH_LIQ_PENALTY)
      ).to.be.revertedWith("INVALID_TOKEN");
    });

    it("should reject factor >= threshold", async function () {
      await expect(
        vault.requestAddCollateral(await wbtc.getAddress(), 8000n, 8000n, 500n)
      ).to.be.revertedWith("INVALID_FACTOR");
    });

    it("should reject threshold > 95%", async function () {
      await expect(
        vault.requestAddCollateral(await wbtc.getAddress(), 9000n, 9600n, 500n)
      ).to.be.revertedWith("THRESHOLD_TOO_HIGH");
    });

    it("should reject penalty > 20%", async function () {
      await expect(
        vault.requestAddCollateral(await wbtc.getAddress(), 7500n, 8000n, 2100n)
      ).to.be.revertedWith("INVALID_PENALTY");
    });

    it("should cap at 50 supported tokens", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      // Already have 1, add 49 more
      for (let i = 0; i < 49; i++) {
        const token = await MockERC20Factory.deploy(`Token${i}`, `T${i}`, 18);
        await timelockAddCollateral(vault, deployer, await token.getAddress(), 5000n, 6000n, 500n);
      }
      const oneMore = await MockERC20Factory.deploy("TooMany", "TM", 18);
      await expect(
        vault.requestAddCollateral(await oneMore.getAddress(), 5000n, 6000n, 500n)
      ).to.be.revertedWith("TOO_MANY_TOKENS");
    });

    it("should disable and re-enable collateral", async function () {
      const addr = await weth.getAddress();
      await vault.disableCollateral(addr);
      let [enabled] = await vault.getConfig(addr);
      expect(enabled).to.be.false;

      await vault.enableCollateral(addr);
      [enabled] = await vault.getConfig(addr);
      expect(enabled).to.be.true;
    });

    it("should reject deposits on disabled collateral", async function () {
      await vault.disableCollateral(await weth.getAddress());
      await expect(
        vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWith("TOKEN_NOT_SUPPORTED");
    });

    it("should reject unauthorized config changes", async function () {
      await expect(
        vault.connect(user1).requestAddCollateral(await wbtc.getAddress(), 7500n, 8000n, 500n)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  DEPOSITS
  // ============================================================

  describe("Deposits", function () {
    it("should accept deposits", async function () {
      const amount = ethers.parseEther("10");
      await vault.connect(user1).deposit(await weth.getAddress(), amount);
      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(amount);
    });

    it("should reject zero amount deposits", async function () {
      await expect(
        vault.connect(user1).deposit(await weth.getAddress(), 0)
      ).to.be.revertedWith("INVALID_AMOUNT");
    });

    it("should reject deposits for unsupported tokens", async function () {
      await expect(
        vault.connect(user1).deposit(await wbtc.getAddress(), 100000000n)
      ).to.be.revertedWith("TOKEN_NOT_SUPPORTED");
    });

    it("should emit Deposited event", async function () {
      const amount = ethers.parseEther("10");
      await expect(vault.connect(user1).deposit(await weth.getAddress(), amount))
        .to.emit(vault, "Deposited")
        .withArgs(user1.address, await weth.getAddress(), amount);
    });

    it("depositFor: should credit deposit to specified user", async function () {
      const amount = ethers.parseEther("5");
      await vault.connect(leverageVault).depositFor(user1.address, await weth.getAddress(), amount);
      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(amount);
    });

    it("depositFor: should reject from non-LEVERAGE_VAULT_ROLE", async function () {
      await expect(
        vault.connect(user1).depositFor(user2.address, await weth.getAddress(), ethers.parseEther("1"))
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  WITHDRAWALS
  // ============================================================

  describe("Withdrawals", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
    });

    it("should allow withdrawal via BORROW_MODULE_ROLE", async function () {
      const amount = ethers.parseEther("5");
      const balBefore = await weth.balanceOf(user1.address);
      await vault.connect(borrowModule).withdraw(await weth.getAddress(), amount, user1.address);
      expect(await weth.balanceOf(user1.address)).to.equal(balBefore + amount);
      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(ethers.parseEther("5"));
    });

    it("should reject over-withdrawal", async function () {
      await expect(
        vault.connect(borrowModule).withdraw(await weth.getAddress(), ethers.parseEther("20"), user1.address)
      ).to.be.revertedWith("INSUFFICIENT_DEPOSIT");
    });

    it("should reject unauthorized withdrawal", async function () {
      await expect(
        vault.connect(user1).withdraw(await weth.getAddress(), ethers.parseEther("1"), user1.address)
      ).to.be.reverted;
    });

    it("withdrawFor: should send collateral to specified recipient", async function () {
      const amount = ethers.parseEther("5");
      const balBefore = await weth.balanceOf(user2.address);
      // FIX: Add skipHealthCheck parameter (5th param) - true to skip health check for this test
      await vault.connect(leverageVault).withdrawFor(user1.address, await weth.getAddress(), amount, user2.address, true);
      expect(await weth.balanceOf(user2.address)).to.equal(balBefore + amount);
    });

    it("withdrawFor: should reject zero recipient", async function () {
      await expect(
        // FIX: Add skipHealthCheck parameter (5th param)
        vault.connect(leverageVault).withdrawFor(user1.address, await weth.getAddress(), ethers.parseEther("1"), ethers.ZeroAddress, true)
      ).to.be.revertedWith("INVALID_RECIPIENT");
    });
  });

  // ============================================================
  //  SEIZE (LIQUIDATION)
  // ============================================================

  describe("Seize", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
    });

    it("should seize collateral to liquidator", async function () {
      const amount = ethers.parseEther("5");
      const liquidatorBal = await weth.balanceOf(liquidator.address);
      await vault.connect(liquidator).seize(user1.address, await weth.getAddress(), amount, liquidator.address);
      expect(await weth.balanceOf(liquidator.address)).to.equal(liquidatorBal + amount);
      expect(await vault.deposits(user1.address, await weth.getAddress())).to.equal(ethers.parseEther("5"));
    });

    it("should reject seize exceeding deposit", async function () {
      await expect(
        vault.connect(liquidator).seize(user1.address, await weth.getAddress(), ethers.parseEther("20"), liquidator.address)
      ).to.be.revertedWith("INSUFFICIENT_COLLATERAL");
    });

    it("should reject seize without LIQUIDATION_ROLE", async function () {
      await expect(
        vault.connect(user2).seize(user1.address, await weth.getAddress(), ethers.parseEther("1"), user2.address)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("should return correct deposit amount", async function () {
      await vault.connect(user1).deposit(await weth.getAddress(), ethers.parseEther("10"));
      expect(await vault.getDeposit(user1.address, await weth.getAddress())).to.equal(ethers.parseEther("10"));
    });

    it("should return supported tokens list", async function () {
      const tokens = await vault.getSupportedTokens();
      expect(tokens.length).to.equal(1);
      expect(tokens[0]).to.equal(await weth.getAddress());
    });
  });
});
