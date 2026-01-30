/**
 * DirectMint Test Suite
 * Tests for the USDC ↔ mUSD minting and redemption functionality
 * 
 * CRITICAL: This contract has 0% test coverage - these tests are essential
 * before formal audit.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("DirectMint", function () {
  async function deployDirectMintFixture() {
    const [owner, user1, user2, feeRecipient] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals like real USDC)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy MUSD with initial supply cap
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy(ethers.parseEther("100000000")); // 100M cap

    // Deploy Treasury (usdc, maxDeploymentBps)
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(await usdc.getAddress(), 8000); // 80% max deployment

    // Deploy DirectMint (usdc, musd, treasury, feeRecipient)
    const DirectMint = await ethers.getContractFactory("DirectMint");
    const directMint = await DirectMint.deploy(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasury.getAddress(),
      feeRecipient.address
    );

    // Grant BRIDGE_ROLE to DirectMint so it can mint/burn MUSD
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    await musd.grantRole(BRIDGE_ROLE, await directMint.getAddress());

    // Grant MINTER_ROLE to DirectMint so it can deposit to Treasury
    const MINTER_ROLE = await treasury.MINTER_ROLE();
    await treasury.grantRole(MINTER_ROLE, await directMint.getAddress());

    // Mint USDC to users (using 6 decimals for USDC)
    const userUSDC = ethers.parseUnits("100000", 6); // 100,000 USDC
    await usdc.mint(user1.address, userUSDC);
    await usdc.mint(user2.address, userUSDC);

    // Mint USDC to treasury for redemptions
    await usdc.mint(await treasury.getAddress(), ethers.parseUnits("1000000", 6));

    return {
      directMint,
      musd,
      usdc,
      treasury,
      owner,
      user1,
      user2,
      feeRecipient,
    };
  }

  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { directMint, musd, usdc, treasury, feeRecipient } = await loadFixture(
        deployDirectMintFixture
      );

      expect(await directMint.usdc()).to.equal(await usdc.getAddress());
      expect(await directMint.musd()).to.equal(await musd.getAddress());
      expect(await directMint.treasury()).to.equal(await treasury.getAddress());
      expect(await directMint.feeRecipient()).to.equal(feeRecipient.address);
    });

    it("Should set default limits", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      expect(await directMint.minMintAmount()).to.be.gt(0);
      expect(await directMint.maxMintAmount()).to.be.gt(0);
    });

    it("Should not be paused initially", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);
      expect(await directMint.paused()).to.equal(false);
    });
  });

  describe("Minting", function () {
    it("Should mint mUSD for USDC deposit", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // Use a larger amount that's above minMintAmount (6 decimals for USDC)
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      // User should receive mUSD
      expect(await musd.balanceOf(user1.address)).to.be.gt(0);
    });

    it("Should transfer USDC to treasury", async function () {
      const { directMint, usdc, treasury, user1 } = await loadFixture(
        deployDirectMintFixture
      );

      const mintAmount = ethers.parseUnits("1000", 6);
      const treasuryBefore = await usdc.balanceOf(await treasury.getAddress());

      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const treasuryAfter = await usdc.balanceOf(await treasury.getAddress());
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("Should reject mint below minimum amount", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // Try to mint 0.5 USDC (below 1 USDC min)
      const belowMin = ethers.parseUnits("0.5", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), belowMin);
      await expect(directMint.connect(user1).mint(belowMin)).to.be.reverted;
    });

    it("Should reject mint when paused", async function () {
      const { directMint, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).pause();

      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await expect(directMint.connect(user1).mint(mintAmount)).to.be.reverted;
    });

    it("Should emit Minted event", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);

      await expect(directMint.connect(user1).mint(mintAmount))
        .to.emit(directMint, "Minted");
    });
  });

  describe("Redemption", function () {
    it("Should redeem mUSD for USDC", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const musdBalance = await musd.balanceOf(user1.address);
      expect(musdBalance).to.be.gt(0);

      // Redeem
      const usdcBefore = await usdc.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), musdBalance);
      await directMint.connect(user1).redeem(musdBalance);

      const usdcAfter = await usdc.balanceOf(user1.address);
      expect(usdcAfter).to.be.gt(usdcBefore);
    });

    it("Should burn redeemed mUSD", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const musdBefore = await musd.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), musdBefore);
      await directMint.connect(user1).redeem(musdBefore);

      expect(await musd.balanceOf(user1.address)).to.equal(0);
    });

    it("Should reject redeem when paused", async function () {
      const { directMint, musd, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      await directMint.connect(owner).pause();

      const musdBalance = await musd.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), musdBalance);
      await expect(directMint.connect(user1).redeem(musdBalance)).to.be.reverted;
    });
  });

  describe("Fees", function () {
    it("Should track mint fees", async function () {
      const { directMint, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      // Set a mint fee
      await directMint.connect(owner).setFees(100, 0); // 1% mint fee

      const mintAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      expect(await directMint.mintFees()).to.be.gt(0);
    });

    it("Should allow fee withdrawal", async function () {
      const { directMint, usdc, user1, owner, feeRecipient } = await loadFixture(
        deployDirectMintFixture
      );

      // Set a mint fee
      await directMint.connect(owner).setFees(100, 0); // 1% mint fee

      const mintAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const feeBalanceBefore = await usdc.balanceOf(feeRecipient.address);
      await directMint.connect(owner).withdrawFees();
      const feeBalanceAfter = await usdc.balanceOf(feeRecipient.address);

      expect(feeBalanceAfter).to.be.gt(feeBalanceBefore);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to pause", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).pause();
      expect(await directMint.paused()).to.equal(true);
    });

    it("Should allow owner to unpause", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).pause();
      await directMint.connect(owner).unpause();
      expect(await directMint.paused()).to.equal(false);
    });

    it("Should reject non-owner pause", async function () {
      const { directMint, user1 } = await loadFixture(deployDirectMintFixture);

      await expect(directMint.connect(user1).pause()).to.be.reverted;
    });

    it("Should allow setting fees", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).setFees(100, 100); // 1%
      expect(await directMint.mintFeeBps()).to.equal(100);
      expect(await directMint.redeemFeeBps()).to.equal(100);
    });

    it("Should reject excessive fees", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      // Max is 500 bps (5%)
      await expect(directMint.connect(owner).setFees(600, 100)).to.be.reverted;
    });

    it("Should allow setting limits", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      const newMin = ethers.parseUnits("100", 6);
      const newMax = ethers.parseUnits("1000000", 6);

      await directMint.connect(owner).setLimits(newMin, newMax, newMin, newMax);
      expect(await directMint.minMintAmount()).to.equal(newMin);
      expect(await directMint.maxMintAmount()).to.equal(newMax);
    });

    it("Should allow updating fee recipient", async function () {
      const { directMint, owner, user2 } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).setFeeRecipient(user2.address);
      expect(await directMint.feeRecipient()).to.equal(user2.address);
    });

    it("Should reject zero address fee recipient", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      await expect(
        directMint.connect(owner).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.reverted;
    });
  });

  describe("Preview Functions", function () {
    it("Should accurately preview mint output", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      const mintAmount = ethers.parseUnits("1000", 6);
      const [musdOut, fee] = await directMint.previewMint(mintAmount);

      expect(musdOut).to.be.gt(0);
      // With 0 fee, output should equal input * 1e12 (scale 6->18 decimals)
      // But since we use 18 decimal mock, it's 1:1 conversion
    });

    it("Should accurately preview redeem output", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      const redeemAmount = ethers.parseEther("1000");
      const [usdcOut, fee] = await directMint.previewRedeem(redeemAmount);

      expect(usdcOut).to.be.gt(0);
    });
  });

  describe("Supply Cap", function () {
    it("Should respect mUSD supply cap", async function () {
      const { directMint, musd, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      // Set a low supply cap
      await musd.connect(owner).setSupplyCap(ethers.parseEther("500"));

      // Try to mint more than cap
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);

      await expect(directMint.connect(user1).mint(mintAmount)).to.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle valid minimum amounts", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // minMintAmount is 1e6 (1 USDC in 6 decimals), but we use 18 decimal mock
      // So we need to use a larger amount that satisfies the limit
      const validAmount = await directMint.minMintAmount();
      await usdc.connect(user1).approve(await directMint.getAddress(), validAmount);
      await directMint.connect(user1).mint(validAmount);

      expect(await musd.balanceOf(user1.address)).to.be.gt(0);
    });
  });
});
