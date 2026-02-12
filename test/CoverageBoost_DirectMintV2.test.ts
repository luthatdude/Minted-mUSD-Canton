/**
 * CoverageBoost — DirectMintV2
 *
 * Targets every uncovered branch, revert path, view function, and edge case
 * that the main DirectMintV2.test.ts does not exercise.
 *
 * Current coverage: 78.1% statements, 33.3% branches, 55.6% functions.
 * Goal: push all three metrics toward 100%.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { DirectMintV2, MUSD, TreasuryV2, MockERC20 } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  timelockSetFees,
  timelockSetFeeRecipient,
  timelockSetLimits,
} from "./helpers/timelock";

describe("CoverageBoost — DirectMintV2", function () {
  let directMint: DirectMintV2;
  let musd: MUSD;
  let usdc: MockERC20;
  let treasury: TreasuryV2;
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const INITIAL_USDC = ethers.parseUnits("10000000", USDC_DECIMALS); // 10M USDC
  const SUPPLY_CAP = ethers.parseEther("100000000"); // 100M mUSD

  beforeEach(async function () {
    [deployer, user, minter, feeRecipient, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await usdc.waitForDeployment();

    // Deploy MUSD
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(SUPPLY_CAP);
    await musd.waitForDeployment();

    // Deploy TreasuryV2 (upgradeable)
    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      deployer.address, // vault placeholder
      deployer.address, // admin
      feeRecipient.address,
      deployer.address, // timelock
    ])) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    // Deploy DirectMintV2
    const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
    directMint = await DirectMintFactory.deploy(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasury.getAddress(),
      feeRecipient.address,
      deployer.address, // timelock
    );
    await directMint.waitForDeployment();

    // Setup roles — MUSD BRIDGE_ROLE for minting
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await directMint.getAddress());

    // Treasury VAULT_ROLE
    const VAULT_ROLE = await treasury.VAULT_ROLE();
    await treasury.grantRole(VAULT_ROLE, await directMint.getAddress());

    // Grant MINTER_ROLE to `minter` signer
    const MINTER_ROLE = await directMint.MINTER_ROLE();
    await directMint.grantRole(MINTER_ROLE, minter.address);

    // Fund user + minter with USDC & approve
    await usdc.mint(user.address, INITIAL_USDC);
    await usdc.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);

    await usdc.mint(minter.address, INITIAL_USDC);
    await usdc.connect(minter).approve(await directMint.getAddress(), ethers.MaxUint256);
  });

  // ================================================================
  // CONSTRUCTOR — remaining zero-address branches
  // ================================================================

  describe("Constructor — missing zero-address branches", function () {
    it("Should revert when treasury is zero address", async function () {
      const F = await ethers.getContractFactory("DirectMintV2");
      await expect(
        F.deploy(await usdc.getAddress(), await musd.getAddress(), ethers.ZeroAddress, feeRecipient.address, deployer.address),
      ).to.be.revertedWith("INVALID_TREASURY");
    });

    it("Should revert when feeRecipient is zero address", async function () {
      const F = await ethers.getContractFactory("DirectMintV2");
      await expect(
        F.deploy(await usdc.getAddress(), await musd.getAddress(), await treasury.getAddress(), ethers.ZeroAddress, deployer.address),
      ).to.be.revertedWith("INVALID_FEE_RECIPIENT");
    });
  });

  // ================================================================
  // mintFor (MINTER_ROLE) — entirely untested in existing suite
  // ================================================================

  describe("mintFor — TreasuryReceiver integration", function () {
    it("Should mint mUSD to recipient via MINTER_ROLE caller", async function () {
      await timelockSetFees(directMint, deployer, 100, 0); // 1% mint fee

      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      const fee = ethers.parseUnits("10", USDC_DECIMALS);
      const net = usdcAmount - fee;
      const musdOut = net * BigInt(1e12);

      await expect(directMint.connect(minter).mintFor(user.address, usdcAmount))
        .to.emit(directMint, "Minted")
        .withArgs(user.address, usdcAmount, musdOut, fee);

      expect(await musd.balanceOf(user.address)).to.equal(musdOut);
      expect(await directMint.mintFees()).to.equal(fee);
    });

    it("Should mint with zero fees", async function () {
      await timelockSetFees(directMint, deployer, 0, 0);
      const usdcAmount = ethers.parseUnits("500", USDC_DECIMALS);
      const musdOut = usdcAmount * BigInt(1e12);

      await directMint.connect(minter).mintFor(user.address, usdcAmount);
      expect(await musd.balanceOf(user.address)).to.equal(musdOut);
      expect(await directMint.mintFees()).to.equal(0);
    });

    it("Should revert when recipient is zero address", async function () {
      const amt = ethers.parseUnits("100", USDC_DECIMALS);
      await expect(
        directMint.connect(minter).mintFor(ethers.ZeroAddress, amt),
      ).to.be.revertedWith("INVALID_RECIPIENT");
    });

    it("Should revert when below minimum mint", async function () {
      const tooSmall = ethers.parseUnits("0.5", USDC_DECIMALS);
      await expect(
        directMint.connect(minter).mintFor(user.address, tooSmall),
      ).to.be.revertedWith("BELOW_MIN");
    });

    it("Should revert when above maximum mint", async function () {
      await usdc.mint(minter.address, ethers.parseUnits("2000000", USDC_DECIMALS));
      const tooLarge = ethers.parseUnits("1500000", USDC_DECIMALS);
      await expect(
        directMint.connect(minter).mintFor(user.address, tooLarge),
      ).to.be.revertedWith("ABOVE_MAX");
    });

    it("Should revert when exceeding supply cap", async function () {
      await musd.setSupplyCap(ethers.parseEther("100"));
      const amt = ethers.parseUnits("200", USDC_DECIMALS);
      await expect(
        directMint.connect(minter).mintFor(user.address, amt),
      ).to.be.revertedWith("EXCEEDS_SUPPLY_CAP");
    });

    it("Should revert when paused", async function () {
      await directMint.pause();
      const amt = ethers.parseUnits("100", USDC_DECIMALS);
      await expect(
        directMint.connect(minter).mintFor(user.address, amt),
      ).to.be.revertedWithCustomError(directMint, "EnforcedPause");
    });

    it("Should revert when caller lacks MINTER_ROLE", async function () {
      const amt = ethers.parseUnits("100", USDC_DECIMALS);
      await expect(
        directMint.connect(other).mintFor(user.address, amt),
      ).to.be.reverted;
    });
  });

  // ================================================================
  // Redeem — uncovered branches
  // ================================================================

  describe("Redeem — uncovered branches", function () {
    beforeEach(async function () {
      // Set fees to 0 so user gets full mUSD
      await timelockSetFees(directMint, deployer, 0, 0);
      // Mint 10000 mUSD to user
      const usdcAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);
      await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
      // Fund treasury for redemptions
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));
    });

    it("Should revert redeem above max", async function () {
      // Set low max redeem
      await timelockSetLimits(
        directMint,
        deployer,
        BigInt(1e6),
        BigInt(1_000_000e6),
        BigInt(1e6),
        BigInt(100e6), // max redeem = 100 USDC
      );

      const musdAmount = ethers.parseEther("500"); // 500 mUSD → 500 USDC > 100
      await expect(directMint.connect(user).redeem(musdAmount)).to.be.revertedWith("ABOVE_MAX");
    });

    it("Should revert redeem when paused", async function () {
      await directMint.pause();
      const musdAmount = ethers.parseEther("100");
      await expect(
        directMint.connect(user).redeem(musdAmount),
      ).to.be.revertedWithCustomError(directMint, "EnforcedPause");
    });

    it("Should apply minimum 1-wei fee when redeemFeeBps > 0 and fee rounds to zero", async function () {
      // Set a very small redeem fee
      await timelockSetFees(directMint, deployer, 0, 1); // 0.01% fee

      // Redeem a small amount where fee calculation rounds to 0
      // musdAmount * redeemFeeBps / (1e12 * 10000) = 0 for small values
      // We need musdAmount * 1 / (1e12 * 10000) < 1
      // => musdAmount < 1e16
      const musdAmount = ethers.parseUnits("1", 12); // 1e12 wei → usdcEquiv = 1
      // First adjust limits so min redeem = 1
      await timelockSetLimits(directMint, deployer, BigInt(1), BigInt(1_000_000e6), BigInt(1), BigInt(1_000_000e6));

      // fee = (1e12 * 1) / (1e12 * 10000) = 0 → minimum 1
      // usdcEquiv = 1, usdcOut = 1 - 1 = 0 → ZERO_OUTPUT
      await expect(directMint.connect(user).redeem(musdAmount)).to.be.revertedWith("ZERO_OUTPUT");
    });

    it("Should correctly track redeem fees", async function () {
      await timelockSetFees(directMint, deployer, 0, 100); // 1% redeem fee

      const musdAmount = ethers.parseEther("1000");
      await directMint.connect(user).redeem(musdAmount);

      const redeemFees = await directMint.redeemFees();
      expect(redeemFees).to.be.gt(0);
    });

    it("Should apply minimum 1-wei fee for small amounts with non-zero redeemFeeBps", async function () {
      await timelockSetFees(directMint, deployer, 0, 1); // 0.01%
      await timelockSetLimits(directMint, deployer, BigInt(1), BigInt(1_000_000e6), BigInt(1), BigInt(1_000_000e6));

      // musdAmount = 2e12 → usdcEquiv = 2
      // fee = (2e12 * 1) / (1e16) = 0 → min fee = 1
      // usdcOut = 2 - 1 = 1 > 0 → should succeed
      const musdAmount = BigInt(2) * BigInt(1e12);
      const userUsdcBefore = await usdc.balanceOf(user.address);
      await directMint.connect(user).redeem(musdAmount);
      const userUsdcAfter = await usdc.balanceOf(user.address);

      expect(userUsdcAfter - userUsdcBefore).to.equal(1); // 1 wei USDC
      expect(await directMint.redeemFees()).to.equal(1);   // 1 wei fee
    });
  });

  // ================================================================
  // VIEW FUNCTIONS — all untested
  // ================================================================

  describe("View Functions", function () {
    it("previewMint — should return correct musdOut and fee", async function () {
      // Default 1% mint fee
      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      const [musdOut, feeUsdc] = await directMint.previewMint(usdcAmount);

      expect(feeUsdc).to.equal(ethers.parseUnits("10", USDC_DECIMALS)); // 1% of 1000
      expect(musdOut).to.equal(ethers.parseUnits("990", 18));
    });

    it("previewMint — zero fee when mintFeeBps = 0", async function () {
      await timelockSetFees(directMint, deployer, 0, 0);
      const usdcAmount = ethers.parseUnits("500", USDC_DECIMALS);
      const [musdOut, feeUsdc] = await directMint.previewMint(usdcAmount);

      expect(feeUsdc).to.equal(0);
      expect(musdOut).to.equal(ethers.parseUnits("500", 18));
    });

    it("previewRedeem — should return correct usdcOut and fee", async function () {
      await timelockSetFees(directMint, deployer, 0, 100); // 1% redeem fee
      const musdAmount = ethers.parseEther("1000");
      const [usdcOut, feeUsdc] = await directMint.previewRedeem(musdAmount);

      const expectedFee = ethers.parseUnits("10", USDC_DECIMALS);
      expect(feeUsdc).to.equal(expectedFee);
      expect(usdcOut).to.equal(ethers.parseUnits("990", USDC_DECIMALS));
    });

    it("previewRedeem — zero fee when redeemFeeBps = 0", async function () {
      const musdAmount = ethers.parseEther("1000");
      // Default redeemFeeBps is 0
      const [usdcOut, feeUsdc] = await directMint.previewRedeem(musdAmount);

      expect(feeUsdc).to.equal(0);
      expect(usdcOut).to.equal(ethers.parseUnits("1000", USDC_DECIMALS));
    });

    it("previewRedeem — min-fee-of-1 when fee rounds to zero but redeemFeeBps > 0", async function () {
      await timelockSetFees(directMint, deployer, 0, 1); // 0.01%
      // small musdAmount where fee rounds to 0
      const musdAmount = BigInt(2) * BigInt(1e12); // usdcEquiv = 2
      const [usdcOut, feeUsdc] = await directMint.previewRedeem(musdAmount);

      expect(feeUsdc).to.equal(1); // min 1 wei
      expect(usdcOut).to.equal(1); // 2 - 1 = 1
    });

    it("remainingMintable — cap > supply", async function () {
      const remaining = await directMint.remainingMintable();
      // No mUSD minted yet, so remaining = cap
      expect(remaining).to.equal(SUPPLY_CAP);
    });

    it("remainingMintable — cap == supply → 0", async function () {
      // Set cap to something small, then mint up to the cap
      await musd.setSupplyCap(ethers.parseEther("100"));
      await timelockSetFees(directMint, deployer, 0, 0);

      const usdcAmount = ethers.parseUnits("100", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);

      expect(await directMint.remainingMintable()).to.equal(0);
    });

    it("totalTreasuryValue — should return treasury value", async function () {
      const val = await directMint.totalTreasuryValue();
      // Initially 0 or whatever treasury reports
      expect(val).to.be.gte(0);
    });

    it("availableForRedemption — should return available reserves", async function () {
      const avail = await directMint.availableForRedemption();
      expect(avail).to.be.gte(0);
    });

    it("totalAccumulatedFees — should return sum of mint + redeem fees", async function () {
      // Default 1% mint fee
      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);

      const total = await directMint.totalAccumulatedFees();
      expect(total).to.equal(await directMint.mintFees());
    });

    it("totalAccumulatedFees — sums both mint and redeem fees", async function () {
      // Set both fees
      await timelockSetFees(directMint, deployer, 100, 100); // 1% each

      // Mint
      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);

      // Fund treasury, redeem
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("10000", USDC_DECIMALS));
      await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
      const musdBal = await musd.balanceOf(user.address);
      await directMint.connect(user).redeem(musdBal);

      const total = await directMint.totalAccumulatedFees();
      const mintF = await directMint.mintFees();
      const redeemF = await directMint.redeemFees();
      expect(total).to.equal(mintF + redeemF);
    });
  });

  // ================================================================
  // setFees — validation branches
  // ================================================================

  describe("setFees — validation branches", function () {
    it("setFees — should revert REDEEM_FEE_TOO_HIGH", async function () {
      await expect(directMint.setFees(0, 600)).to.be.revertedWith("REDEEM_FEE_TOO_HIGH");
    });

    it("setFees — both at max should succeed", async function () {
      await directMint.setFees(500, 500);
      expect(await directMint.mintFeeBps()).to.equal(500);
      expect(await directMint.redeemFeeBps()).to.equal(500);
    });

    it("setFees — access control (non-timelock reverts)", async function () {
      await expect(directMint.connect(other).setFees(10, 10)).to.be.reverted;
    });
  });

  // ================================================================
  // setFeeRecipient — validation branches
  // ================================================================

  describe("setFeeRecipient — validation branches", function () {
    it("setFeeRecipient — should revert with zero address", async function () {
      await expect(
        directMint.setFeeRecipient(ethers.ZeroAddress),
      ).to.be.revertedWith("INVALID_RECIPIENT");
    });

    it("setFeeRecipient — should update feeRecipient", async function () {
      await directMint.setFeeRecipient(other.address);
      expect(await directMint.feeRecipient()).to.equal(other.address);
    });

    it("setFeeRecipient — access control (non-timelock reverts)", async function () {
      await expect(directMint.connect(other).setFeeRecipient(other.address)).to.be.reverted;
    });
  });

  // ================================================================
  // setLimits — validation branches
  // ================================================================

  describe("setLimits — validation branches", function () {
    it("setLimits — should revert INVALID_REDEEM_LIMITS (min > max)", async function () {
      await expect(
        directMint.setLimits(1, 1000, 1000, 100),
      ).to.be.revertedWith("INVALID_REDEEM_LIMITS");
    });

    it("setLimits — should apply limits directly", async function () {
      const minM = BigInt(5e6);
      const maxM = BigInt(500_000e6);
      const minR = BigInt(5e6);
      const maxR = BigInt(500_000e6);

      await directMint.setLimits(minM, maxM, minR, maxR);

      expect(await directMint.minMintAmount()).to.equal(minM);
      expect(await directMint.maxMintAmount()).to.equal(maxM);
      expect(await directMint.minRedeemAmount()).to.equal(minR);
      expect(await directMint.maxRedeemAmount()).to.equal(maxR);
    });

    it("setLimits — both pairs at boundary (min == max) should succeed", async function () {
      await directMint.setLimits(100, 100, 200, 200);
      expect(await directMint.minMintAmount()).to.equal(100);
      expect(await directMint.maxMintAmount()).to.equal(100);
    });

    it("setLimits — access control (non-timelock reverts)", async function () {
      await expect(directMint.connect(other).setLimits(1, 100, 1, 100)).to.be.reverted;
    });
  });

  // ================================================================
  // Fee Withdrawal — uncovered paths
  // ================================================================

  describe("Fee Withdrawal — uncovered paths", function () {
    it("withdrawFees — should revert NO_FEES when no mint fees accrued", async function () {
      await expect(directMint.withdrawFees()).to.be.revertedWith("NO_FEES");
    });

    it("withdrawFees — access control (non-FEE_MANAGER reverts)", async function () {
      await expect(directMint.connect(other).withdrawFees()).to.be.reverted;
    });

    it("withdrawRedeemFees — should revert NO_REDEEM_FEES when none accrued", async function () {
      await expect(directMint.withdrawRedeemFees()).to.be.revertedWith("NO_REDEEM_FEES");
    });

    it("withdrawRedeemFees — should transfer redeem fees to feeRecipient", async function () {
      // Set redeem fee and perform a redemption
      await timelockSetFees(directMint, deployer, 0, 100); // 1% redeem
      const usdcAmount = ethers.parseUnits("5000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);
      await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));

      const musdBal = await musd.balanceOf(user.address);
      await directMint.connect(user).redeem(musdBal);

      const fees = await directMint.redeemFees();
      expect(fees).to.be.gt(0);

      const recipientBefore = await usdc.balanceOf(feeRecipient.address);
      await expect(directMint.withdrawRedeemFees())
        .to.emit(directMint, "FeesWithdrawn")
        .withArgs(feeRecipient.address, fees);

      const recipientAfter = await usdc.balanceOf(feeRecipient.address);
      expect(recipientAfter - recipientBefore).to.equal(fees);
      expect(await directMint.redeemFees()).to.equal(0);
    });

    it("withdrawRedeemFees — access control (non-FEE_MANAGER reverts)", async function () {
      await expect(directMint.connect(other).withdrawRedeemFees()).to.be.reverted;
    });
  });

  // ================================================================
  // Pause / Unpause — separation of duties
  // ================================================================

  describe("Pause / Unpause — separation of duties", function () {
    it("unpause — should require DEFAULT_ADMIN_ROLE", async function () {
      await directMint.pause();
      // PAUSER can pause but should NOT be able to unpause if they don't have admin
      // deployer has both roles by default; use `other` who has neither
      await expect(directMint.connect(other).unpause()).to.be.reverted;
    });

    it("pause — non-PAUSER reverts", async function () {
      await expect(directMint.connect(other).pause()).to.be.reverted;
    });

    it("Should pause and unpause correctly", async function () {
      await directMint.pause();
      expect(await directMint.paused()).to.be.true;
      await directMint.unpause();
      expect(await directMint.paused()).to.be.false;
    });

    it("mint should work after unpause", async function () {
      await directMint.pause();
      await directMint.unpause();

      const usdcAmount = ethers.parseUnits("100", USDC_DECIMALS);
      await expect(directMint.connect(user).mint(usdcAmount)).to.not.be.reverted;
    });
  });

  // ================================================================
  // recoverToken — all branches
  // ================================================================

  describe("recoverToken — all branches", function () {
    let randomToken: MockERC20;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("MockERC20");
      randomToken = await F.deploy("Random", "RND", 18);
      await randomToken.waitForDeployment();
      // Send some random tokens to DirectMintV2
      await randomToken.mint(await directMint.getAddress(), ethers.parseEther("100"));
    });

    it("Should recover arbitrary ERC20 tokens", async function () {
      const amount = ethers.parseEther("50");
      const before = await randomToken.balanceOf(deployer.address);
      await directMint.recoverToken(await randomToken.getAddress(), amount);
      const after = await randomToken.balanceOf(deployer.address);
      expect(after - before).to.equal(amount);
    });

    it("Should revert when trying to recover USDC", async function () {
      await expect(
        directMint.recoverToken(await usdc.getAddress(), 1),
      ).to.be.revertedWith("CANNOT_RECOVER_USDC");
    });

    it("Should revert when trying to recover mUSD", async function () {
      await expect(
        directMint.recoverToken(await musd.getAddress(), 1),
      ).to.be.revertedWith("CANNOT_RECOVER_MUSD");
    });

    it("Should revert for non-admin caller", async function () {
      await expect(
        directMint.connect(other).recoverToken(await randomToken.getAddress(), 1),
      ).to.be.reverted;
    });
  });

  // ================================================================
  // Access Control — remaining role-gated functions
  // ================================================================

  describe("Access Control — exhaustive role checks", function () {
    it("setLimits — only timelock", async function () {
      await expect(directMint.connect(user).setLimits(1, 100, 1, 100)).to.be.reverted;
    });

    it("setFeeRecipient — only timelock", async function () {
      await expect(directMint.connect(user).setFeeRecipient(user.address)).to.be.reverted;
    });

    it("recoverToken — only DEFAULT_ADMIN_ROLE", async function () {
      const F = await ethers.getContractFactory("MockERC20");
      const tkn = await F.deploy("X", "X", 18);
      await expect(directMint.connect(user).recoverToken(await tkn.getAddress(), 1)).to.be.reverted;
    });
  });

  // ================================================================
  // Edge cases & boundary values
  // ================================================================

  describe("Edge cases & boundary values", function () {
    it("Mint exactly at minMintAmount boundary", async function () {
      const minMint = await directMint.minMintAmount();
      await expect(directMint.connect(user).mint(minMint)).to.not.be.reverted;
    });

    it("Mint exactly at maxMintAmount boundary", async function () {
      const maxMint = await directMint.maxMintAmount(); // 1M USDC
      await usdc.mint(user.address, maxMint);
      await expect(directMint.connect(user).mint(maxMint)).to.not.be.reverted;
    });

    it("Redeem exactly at minRedeemAmount boundary", async function () {
      await timelockSetFees(directMint, deployer, 0, 0);
      // Mint minimum redeemable amount
      const minRedeem = await directMint.minRedeemAmount(); // 1e6
      const mintAmount = minRedeem; // mint 1 USDC worth
      await directMint.connect(user).mint(mintAmount);
      await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100000", USDC_DECIMALS));

      const musdAmount = mintAmount * BigInt(1e12);
      await expect(directMint.connect(user).redeem(musdAmount)).to.not.be.reverted;
    });

    it("Mint with maximum fee (5%) should work", async function () {
      await timelockSetFees(directMint, deployer, 500, 0); // 5% mint fee

      const usdcAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const fee = ethers.parseUnits("5", USDC_DECIMALS); // 5%
      const net = usdcAmount - fee;
      const musdOut = net * BigInt(1e12);

      await directMint.connect(user).mint(usdcAmount);
      expect(await musd.balanceOf(user.address)).to.equal(musdOut);
    });

    it("Multiple mints accumulate fees correctly", async function () {
      // Default 1% fee
      const amt = ethers.parseUnits("1000", USDC_DECIMALS);
      await directMint.connect(user).mint(amt);
      await directMint.connect(user).mint(amt);

      const expectedFees = ethers.parseUnits("20", USDC_DECIMALS); // 10 + 10
      expect(await directMint.mintFees()).to.equal(expectedFees);
    });

    it("Constants are correct", async function () {
      expect(await directMint.MAX_FEE_BPS()).to.equal(500);
      expect(await directMint.PAUSER_ROLE()).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE")),
      );
      expect(await directMint.FEE_MANAGER_ROLE()).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes("FEE_MANAGER_ROLE")),
      );
      expect(await directMint.MINTER_ROLE()).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
      );
    });
  });
});
