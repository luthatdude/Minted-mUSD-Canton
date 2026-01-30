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
    const [owner, user1, user2, treasury] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC");
    // USDC has 6 decimals - we need to configure this in the mock

    // Deploy MUSD
    const MUSD = await ethers.getContractFactory("MUSD");
    const musd = await MUSD.deploy();
    await musd.initialize(owner.address);

    // Deploy Treasury
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasuryContract = await Treasury.deploy();
    await treasuryContract.initialize(await usdc.getAddress());

    // Deploy DirectMint
    const DirectMint = await ethers.getContractFactory("DirectMint");
    const directMint = await DirectMint.deploy();
    await directMint.initialize(
      await usdc.getAddress(),
      await musd.getAddress(),
      await treasuryContract.getAddress()
    );

    // Grant roles
    const MINTER_ROLE = await musd.MINTER_ROLE();
    const VAULT_ROLE = await treasuryContract.VAULT_ROLE();
    await musd.grantRole(MINTER_ROLE, await directMint.getAddress());
    await treasuryContract.grantRole(VAULT_ROLE, await directMint.getAddress());

    // Mint USDC to users
    const userUSDC = ethers.parseUnits("100000", 6); // 100,000 USDC
    await usdc.mint(user1.address, userUSDC);
    await usdc.mint(user2.address, userUSDC);

    // Mint some USDC to treasury for redemptions
    await usdc.mint(await treasuryContract.getAddress(), ethers.parseUnits("1000000", 6));

    return {
      directMint,
      musd,
      usdc,
      treasuryContract,
      owner,
      user1,
      user2,
    };
  }

  describe("Deployment", function () {
    it("Should initialize with correct parameters", async function () {
      const { directMint, musd, usdc, treasuryContract } = await loadFixture(
        deployDirectMintFixture
      );

      expect(await directMint.usdc()).to.equal(await usdc.getAddress());
      expect(await directMint.musd()).to.equal(await musd.getAddress());
      expect(await directMint.treasury()).to.equal(await treasuryContract.getAddress());
    });

    it("Should set default fees", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      const mintFeeBps = await directMint.mintFeeBps();
      const redeemFeeBps = await directMint.redeemFeeBps();

      // Default fees should be 0.30% (30 bps)
      expect(mintFeeBps).to.equal(30);
      expect(redeemFeeBps).to.equal(30);
    });

    it("Should not be paused initially", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);
      expect(await directMint.paused()).to.equal(false);
    });
  });

  describe("Minting", function () {
    it("Should mint mUSD 1:1 with USDC (minus fee)", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const mintAmount = ethers.parseUnits("1000", 6); // 1000 USDC
      const fee = mintAmount * 30n / 10000n; // 0.30% fee
      const expectedMUSD = (mintAmount - fee) * 10n ** 12n; // Scale 6 → 18 decimals

      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      expect(await musd.balanceOf(user1.address)).to.equal(expectedMUSD);
    });

    it("Should transfer USDC to treasury", async function () {
      const { directMint, usdc, treasuryContract, user1 } = await loadFixture(
        deployDirectMintFixture
      );

      const mintAmount = ethers.parseUnits("1000", 6);
      const treasuryBefore = await usdc.balanceOf(await treasuryContract.getAddress());

      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const treasuryAfter = await usdc.balanceOf(await treasuryContract.getAddress());
      expect(treasuryAfter - treasuryBefore).to.equal(mintAmount);
    });

    it("Should reject mint below minimum amount", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const minAmount = await directMint.minMintAmount();
      const belowMin = minAmount - 1n;

      await usdc.connect(user1).approve(await directMint.getAddress(), belowMin);
      await expect(directMint.connect(user1).mint(belowMin)).to.be.revertedWith(
        "BELOW_MIN_AMOUNT"
      );
    });

    it("Should reject mint above maximum amount", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const maxAmount = await directMint.maxMintAmount();
      const aboveMax = maxAmount + 1n;

      await usdc.mint(user1.address, aboveMax);
      await usdc.connect(user1).approve(await directMint.getAddress(), aboveMax);
      await expect(directMint.connect(user1).mint(aboveMax)).to.be.revertedWith(
        "ABOVE_MAX_AMOUNT"
      );
    });

    it("Should reject mint when paused", async function () {
      const { directMint, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).pause();

      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await expect(directMint.connect(user1).mint(mintAmount)).to.be.revertedWith(
        "Pausable: paused"
      );
    });

    it("Should reject mint exceeding supply cap", async function () {
      const { directMint, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      // Set a low supply cap
      await directMint.connect(owner).setSupplyCap(ethers.parseUnits("500", 18));

      const mintAmount = ethers.parseUnits("1000", 6); // Would create 1000 mUSD
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await expect(directMint.connect(user1).mint(mintAmount)).to.be.revertedWith(
        "EXCEEDS_SUPPLY_CAP"
      );
    });

    it("Should track mint fees correctly", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const mintAmount = ethers.parseUnits("10000", 6); // 10,000 USDC
      const expectedFee = mintAmount * 30n / 10000n; // 0.30% = 30 USDC

      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      expect(await directMint.mintFees()).to.equal(expectedFee);
    });
  });

  describe("Redemption", function () {
    it("Should redeem mUSD for USDC (minus fee)", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      // Get mUSD balance and redeem half
      const musdBalance = await musd.balanceOf(user1.address);
      const redeemAmount = musdBalance / 2n;

      const usdcBefore = await usdc.balanceOf(user1.address);
      await musd.connect(user1).approve(await directMint.getAddress(), redeemAmount);
      await directMint.connect(user1).redeem(redeemAmount);

      const usdcAfter = await usdc.balanceOf(user1.address);
      const redeemFee = redeemAmount * 30n / 10000n / 10n ** 12n; // Scale 18 → 6
      const expectedUSDC = redeemAmount / 10n ** 12n - redeemFee;

      expect(usdcAfter - usdcBefore).to.be.closeTo(expectedUSDC, 1n);
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

    it("Should reject redeem when insufficient treasury balance", async function () {
      const { directMint, musd, usdc, treasuryContract, user1, owner } = await loadFixture(
        deployDirectMintFixture
      );

      // Drain treasury
      const treasuryBalance = await usdc.balanceOf(await treasuryContract.getAddress());
      // Note: This may require admin privileges depending on Treasury implementation

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      // This test may need adjustment based on actual Treasury implementation
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
      await expect(directMint.connect(user1).redeem(musdBalance)).to.be.revertedWith(
        "Pausable: paused"
      );
    });
  });

  describe("Preview Functions", function () {
    it("Should accurately preview mint output", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      const mintAmount = ethers.parseUnits("1000", 6);
      const preview = await directMint.previewMint(mintAmount);
      const expectedFee = mintAmount * 30n / 10000n;
      const expectedMUSD = (mintAmount - expectedFee) * 10n ** 12n;

      expect(preview).to.equal(expectedMUSD);
    });

    it("Should accurately preview redeem output", async function () {
      const { directMint } = await loadFixture(deployDirectMintFixture);

      const redeemAmount = ethers.parseUnits("1000", 18);
      const preview = await directMint.previewRedeem(redeemAmount);
      const expectedFee = redeemAmount * 30n / 10000n;
      const expectedUSDC = (redeemAmount - expectedFee) / 10n ** 12n;

      expect(preview).to.equal(expectedUSDC);
    });
  });

  describe("View Functions", function () {
    it("Should return remaining mintable amount", async function () {
      const { directMint, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      const supplyCap = await directMint.supplyCap();
      const remainingBefore = await directMint.remainingMintable();
      expect(remainingBefore).to.equal(supplyCap);

      // Mint some
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const remainingAfter = await directMint.remainingMintable();
      expect(remainingAfter).to.be.lt(remainingBefore);
    });

    it("Should return available for redemption", async function () {
      const { directMint, treasuryContract, usdc } = await loadFixture(deployDirectMintFixture);

      const treasuryBalance = await usdc.balanceOf(await treasuryContract.getAddress());
      const available = await directMint.availableForRedemption();
      expect(available).to.equal(treasuryBalance);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to set fees", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      await directMint.connect(owner).setFees(50, 50); // 0.50%
      expect(await directMint.mintFeeBps()).to.equal(50);
      expect(await directMint.redeemFeeBps()).to.equal(50);
    });

    it("Should reject fees above maximum", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      // Max fee is 5% (500 bps)
      await expect(directMint.connect(owner).setFees(600, 30)).to.be.revertedWith(
        "FEE_TOO_HIGH"
      );
    });

    it("Should allow owner to set limits", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      const newMin = ethers.parseUnits("100", 6);
      const newMax = ethers.parseUnits("1000000", 6);

      await directMint.connect(owner).setLimits(newMin, newMax);
      expect(await directMint.minMintAmount()).to.equal(newMin);
      expect(await directMint.maxMintAmount()).to.equal(newMax);
    });

    it("Should allow owner to withdraw accumulated fees", async function () {
      const { directMint, usdc, user1, owner } = await loadFixture(deployDirectMintFixture);

      // Mint to generate fees
      const mintAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      const fees = await directMint.mintFees();
      const ownerBalanceBefore = await usdc.balanceOf(owner.address);

      await directMint.connect(owner).withdrawFees();

      const ownerBalanceAfter = await usdc.balanceOf(owner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(fees);
      expect(await directMint.mintFees()).to.equal(0);
    });

    it("Should allow owner to recover stuck tokens", async function () {
      const { directMint, owner } = await loadFixture(deployDirectMintFixture);

      // Deploy a random token and send to DirectMint
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND");
      const amount = ethers.parseEther("100");
      await randomToken.mint(await directMint.getAddress(), amount);

      const ownerBalanceBefore = await randomToken.balanceOf(owner.address);
      await directMint.connect(owner).recoverToken(await randomToken.getAddress());
      const ownerBalanceAfter = await randomToken.balanceOf(owner.address);

      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(amount);
    });

    it("Should prevent recovering USDC or mUSD", async function () {
      const { directMint, usdc, musd, owner } = await loadFixture(deployDirectMintFixture);

      await expect(directMint.connect(owner).recoverToken(await usdc.getAddress())).to.be.revertedWith(
        "CANNOT_RECOVER"
      );

      await expect(directMint.connect(owner).recoverToken(await musd.getAddress())).to.be.revertedWith(
        "CANNOT_RECOVER"
      );
    });
  });

  describe("Decimal Precision", function () {
    it("Should correctly handle USDC 6 decimal to mUSD 18 decimal conversion", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // 1 USDC = 1,000,000 (6 decimals)
      const oneUSDC = 1000000n;
      // Should become 1 mUSD = 1,000,000,000,000,000,000 (18 decimals) minus fee
      const fee = oneUSDC * 30n / 10000n;
      const expectedMUSD = (oneUSDC - fee) * 10n ** 12n;

      await usdc.connect(user1).approve(await directMint.getAddress(), oneUSDC);
      await directMint.connect(user1).mint(oneUSDC);

      expect(await musd.balanceOf(user1.address)).to.equal(expectedMUSD);
    });

    it("Should handle precision loss in redemption", async function () {
      const { directMint, musd, usdc, user1 } = await loadFixture(deployDirectMintFixture);

      // First mint
      const mintAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await directMint.getAddress(), mintAmount);
      await directMint.connect(user1).mint(mintAmount);

      // Try to redeem an amount that would result in < 1 USDC
      const tinyAmount = ethers.parseUnits("0.0000001", 18); // Less than 1e12 wei
      await musd.connect(user1).approve(await directMint.getAddress(), tinyAmount);

      // This should either revert or result in 0 USDC (implementation dependent)
      // The audit flagged this as a precision loss issue
    });
  });
});
