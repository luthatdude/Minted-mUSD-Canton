/**
 * DirectMintV2 Comprehensive Tests
 * Tests mint/redeem functionality, fees, limits, and access control
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { DirectMintV2, MUSD, TreasuryV2, MockERC20 } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { timelockSetFees, timelockSetFeeRecipient, timelockSetLimits } from "./helpers/timelock";

describe("DirectMintV2", function () {
  let directMint: DirectMintV2;
  let musd: MUSD;
  let usdc: MockERC20;
  let treasury: TreasuryV2;
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  const USDC_DECIMALS = 6;
  const MUSD_DECIMALS = 18;
  const INITIAL_USDC = ethers.parseUnits("1000000", USDC_DECIMALS); // 1M USDC
  const SUPPLY_CAP = ethers.parseEther("10000000"); // 10M mUSD

  beforeEach(async function () {
    [deployer, user, feeRecipient] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await usdc.waitForDeployment();

    // Deploy MUSD with supply cap
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(SUPPLY_CAP);
    await musd.waitForDeployment();

    // Deploy TreasuryV2 (upgradeable)
    const TreasuryFactory = await ethers.getContractFactory("TreasuryV2");
    treasury = (await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      deployer.address, // vault placeholder
      deployer.address, // admin
      feeRecipient.address
    ])) as unknown as TreasuryV2;
    await treasury.waitForDeployment();

    // Deploy DirectMintV2
    const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
    directMint = await DirectMintFactory.deploy(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasury.getAddress(),
      feeRecipient.address
    );
    await directMint.waitForDeployment();

    // Setup roles - MUSD uses BRIDGE_ROLE for minting
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await directMint.getAddress());

    const VAULT_ROLE = await treasury.VAULT_ROLE();
    await treasury.grantRole(VAULT_ROLE, await directMint.getAddress());

    // Mint USDC to user
    await usdc.mint(user.address, INITIAL_USDC);
    await usdc.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
  });

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await directMint.usdc()).to.equal(await usdc.getAddress());
      expect(await directMint.musd()).to.equal(await musd.getAddress());
      expect(await directMint.treasury()).to.equal(await treasury.getAddress());
      expect(await directMint.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("Should have correct default limits", async function () {
      expect(await directMint.minMintAmount()).to.equal(1e6); // 1 USDC
      expect(await directMint.maxMintAmount()).to.equal(1_000_000n * BigInt(1e6)); // 1M USDC
    });

    it("Should reject zero addresses in constructor", async function () {
      const DirectMintFactory = await ethers.getContractFactory("DirectMintV2");
      
      await expect(
        DirectMintFactory.deploy(ethers.ZeroAddress, await musd.getAddress(), await treasury.getAddress(), feeRecipient.address)
      ).to.be.revertedWith("INVALID_USDC");

      await expect(
        DirectMintFactory.deploy(await usdc.getAddress(), ethers.ZeroAddress, await treasury.getAddress(), feeRecipient.address)
      ).to.be.revertedWith("INVALID_MUSD");
    });
  });

  describe("Minting", function () {
    it("Should mint mUSD for USDC at 1:1 ratio (no fees)", async function () {
      // Reset fees to 0 for this test (default is 1%)
      await timelockSetFees(directMint, deployer, 0, 0);

      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS); // 1000 USDC
      const expectedMusd = ethers.parseUnits("1000", MUSD_DECIMALS); // 1000 mUSD

      await expect(directMint.connect(user).mint(usdcAmount))
        .to.emit(directMint, "Minted")
        .withArgs(user.address, usdcAmount, expectedMusd, 0);

      expect(await musd.balanceOf(user.address)).to.equal(expectedMusd);
    });

    it("Should apply mint fee correctly", async function () {
      // Set 1% mint fee
      await timelockSetFees(directMint, deployer, 100, 0); // 100 bps = 1%

      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS); // 1000 USDC
      const expectedFee = ethers.parseUnits("10", USDC_DECIMALS); // 10 USDC fee
      const netUsdc = usdcAmount - expectedFee; // 990 USDC
      const expectedMusd = netUsdc * BigInt(1e12); // 990 mUSD

      await directMint.connect(user).mint(usdcAmount);

      expect(await musd.balanceOf(user.address)).to.equal(expectedMusd);
      expect(await directMint.mintFees()).to.equal(expectedFee);
    });

    it("Should reject mint below minimum", async function () {
      const tooSmall = ethers.parseUnits("0.5", USDC_DECIMALS); // 0.5 USDC

      await expect(directMint.connect(user).mint(tooSmall))
        .to.be.revertedWith("BELOW_MIN");
    });

    it("Should reject mint above maximum", async function () {
      // Mint more USDC to user first
      await usdc.mint(user.address, ethers.parseUnits("2000000", USDC_DECIMALS));
      const tooLarge = ethers.parseUnits("1500000", USDC_DECIMALS); // 1.5M USDC

      await expect(directMint.connect(user).mint(tooLarge))
        .to.be.revertedWith("ABOVE_MAX");
    });

    it("Should reject mint that exceeds supply cap", async function () {
      // Set a very low supply cap
      const SUPPLY_MANAGER_ROLE = await musd.SUPPLY_MANAGER_ROLE?.() || ethers.keccak256(ethers.toUtf8Bytes("SUPPLY_MANAGER_ROLE"));
      await musd.setSupplyCap(ethers.parseEther("100")); // 100 mUSD cap

      const usdcAmount = ethers.parseUnits("200", USDC_DECIMALS); // Would mint 200 mUSD

      await expect(directMint.connect(user).mint(usdcAmount))
        .to.be.revertedWith("EXCEEDS_SUPPLY_CAP");
    });

    it("Should reject mint when paused", async function () {
      await directMint.pause();

      const usdcAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await expect(directMint.connect(user).mint(usdcAmount))
        .to.be.revertedWithCustomError(directMint, "EnforcedPause");
    });
  });

  describe("Redeeming", function () {
    beforeEach(async function () {
      // Mint some mUSD first
      const usdcAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);
      
      // Approve directMint to burn mUSD
      await musd.connect(user).approve(await directMint.getAddress(), ethers.MaxUint256);
      
      // Fund treasury with USDC for redemptions
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("10000", USDC_DECIMALS));
    });

    it("Should redeem mUSD for USDC at 1:1 ratio (no fees)", async function () {
      // Reset fees to 0 for this test (default mint fee is 1%)
      await timelockSetFees(directMint, deployer, 0, 0);

      const musdAmount = ethers.parseEther("1000"); // 1000 mUSD
      const expectedUsdc = ethers.parseUnits("1000", USDC_DECIMALS); // 1000 USDC

      // User has 9900 mUSD from beforeEach (10000 USDC - 1% fee = 9900 mUSD minted)
      const userMusdBefore = await musd.balanceOf(user.address);
      const userUsdcBefore = await usdc.balanceOf(user.address);

      await expect(directMint.connect(user).redeem(musdAmount))
        .to.emit(directMint, "Redeemed");

      const userUsdcAfter = await usdc.balanceOf(user.address);
      expect(userUsdcAfter - userUsdcBefore).to.equal(expectedUsdc);
      expect(await musd.balanceOf(user.address)).to.equal(userMusdBefore - musdAmount);
    });

    it("Should apply redeem fee correctly", async function () {
      // Set 1% redeem fee
      await timelockSetFees(directMint, deployer, 0, 100); // 100 bps = 1%

      const musdAmount = ethers.parseEther("1000"); // 1000 mUSD
      const grossUsdc = ethers.parseUnits("1000", USDC_DECIMALS); // 1000 USDC
      const expectedFee = ethers.parseUnits("10", USDC_DECIMALS); // 10 USDC fee
      const netUsdc = grossUsdc - expectedFee; // 990 USDC

      const userUsdcBefore = await usdc.balanceOf(user.address);
      await directMint.connect(user).redeem(musdAmount);
      const userUsdcAfter = await usdc.balanceOf(user.address);

      expect(userUsdcAfter - userUsdcBefore).to.equal(netUsdc);
    });

    it("Should reject redeem below minimum", async function () {
      const tooSmall = ethers.parseEther("0.5"); // 0.5 mUSD

      await expect(directMint.connect(user).redeem(tooSmall))
        .to.be.revertedWith("BELOW_MIN");
    });

    it("Should reject zero redeem amount", async function () {
      await expect(directMint.connect(user).redeem(0))
        .to.be.revertedWith("INVALID_AMOUNT");
    });
  });

  describe("Fee Management", function () {
    it("Should allow fee manager to update fees", async function () {
      await directMint.requestFees(50, 75); // 0.5% mint, 0.75% redeem
      await time.increase(48 * 3600);
      await expect(directMint.executeFees())
        .to.emit(directMint, "FeesUpdated")
        .withArgs(50, 75);

      expect(await directMint.mintFeeBps()).to.equal(50);
      expect(await directMint.redeemFeeBps()).to.equal(75);
    });

    it("Should reject fees above maximum", async function () {
      await expect(directMint.requestFees(600, 0)) // 6% > 5% max
        .to.be.revertedWith("MINT_FEE_TOO_HIGH");
    });

    it("Should allow fee withdrawal", async function () {
      // Set fees and mint
      await timelockSetFees(directMint, deployer, 100, 0); // 1% mint fee
      const usdcAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await directMint.connect(user).mint(usdcAmount);

      const fees = await directMint.mintFees();
      expect(fees).to.equal(ethers.parseUnits("100", USDC_DECIMALS)); // 1% of 10k

      // Withdraw fees
      const recipientBefore = await usdc.balanceOf(feeRecipient.address);
      await directMint.withdrawFees();
      const recipientAfter = await usdc.balanceOf(feeRecipient.address);

      expect(recipientAfter - recipientBefore).to.equal(fees);
      expect(await directMint.mintFees()).to.equal(0);
    });

    it("Should update fee recipient", async function () {
      const newRecipient = user.address;

      await directMint.requestFeeRecipient(newRecipient);
      await time.increase(48 * 3600);
      await expect(directMint.executeFeeRecipient())
        .to.emit(directMint, "FeeRecipientUpdated")
        .withArgs(feeRecipient.address, newRecipient);

      expect(await directMint.feeRecipient()).to.equal(newRecipient);
    });
  });

  describe("Limits Management", function () {
    it("Should allow admin to update limits", async function () {
      const newMinMint = ethers.parseUnits("10", USDC_DECIMALS);
      const newMaxMint = ethers.parseUnits("500000", USDC_DECIMALS);
      const newMinRedeem = ethers.parseUnits("10", USDC_DECIMALS);
      const newMaxRedeem = ethers.parseUnits("500000", USDC_DECIMALS);

      await timelockSetLimits(directMint, deployer, newMinMint, newMaxMint, newMinRedeem, newMaxRedeem);

      expect(await directMint.minMintAmount()).to.equal(newMinMint);
      expect(await directMint.maxMintAmount()).to.equal(newMaxMint);
    });

    it("Should reject invalid limits (min > max)", async function () {
      await expect(
        directMint.requestLimits(1000, 100, 1, 1000) // min > max
      ).to.be.revertedWith("INVALID_MINT_LIMITS");
    });
  });

  describe("Access Control", function () {
    it("Should reject pause from non-pauser", async function () {
      await expect(directMint.connect(user).pause())
        .to.be.reverted;
    });

    it("Should reject fee changes from non-fee-manager", async function () {
      await expect(directMint.connect(user).requestFees(100, 100))
        .to.be.reverted;
    });

    it("Should allow pauser to pause/unpause", async function () {
      await directMint.pause();
      expect(await directMint.paused()).to.be.true;

      await directMint.unpause();
      expect(await directMint.paused()).to.be.false;
    });
  });
});
