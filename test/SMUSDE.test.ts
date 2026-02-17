import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * @title SMUSDE Test Suite
 * @notice TEST-C-02: Comprehensive tests for the smUSD-E (Staked mUSD ETH Pool) token
 * @dev Tests mint/burn, blacklist, pause, access control
 */
describe("SMUSDE", function () {
  async function deployFixture() {
    const [deployer, pool, compliance, pauser, user1, user2] = await ethers.getSigners();

    const SMUSDE = await ethers.getContractFactory("SMUSDE");
    const token = await SMUSDE.deploy();

    // Grant roles
    await token.grantRole(await token.POOL_ROLE(), pool.address);
    await token.grantRole(await token.COMPLIANCE_ROLE(), compliance.address);
    await token.grantRole(await token.PAUSER_ROLE(), pauser.address);

    return { token, deployer, pool, compliance, pauser, user1, user2 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("has correct name and symbol", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("Staked mUSD ETH Pool");
      expect(await token.symbol()).to.equal("smUSD-E");
    });

    it("starts with zero supply", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MINT / BURN
  // ═══════════════════════════════════════════════════════════════════

  describe("Mint & Burn", function () {
    it("pool can mint", async function () {
      const { token, pool, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(pool).mint(user1.address, ethers.parseEther("1000")))
        .to.emit(token, "Minted");
      expect(await token.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
    });

    it("pool can burn", async function () {
      const { token, pool, user1 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await expect(token.connect(pool).burn(user1.address, ethers.parseEther("500")))
        .to.emit(token, "Burned");
      expect(await token.balanceOf(user1.address)).to.equal(ethers.parseEther("500"));
    });

    it("reverts mint to zero address", async function () {
      const { token, pool } = await loadFixture(deployFixture);
      await expect(token.connect(pool).mint(ethers.ZeroAddress, 1000n)).to.be.reverted;
    });

    it("reverts mint of zero amount", async function () {
      const { token, pool, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(pool).mint(user1.address, 0)).to.be.reverted;
    });

    it("reverts burn exceeding balance", async function () {
      const { token, pool, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(pool).burn(user1.address, ethers.parseEther("1"))).to.be.reverted;
    });

    it("non-pool cannot mint", async function () {
      const { token, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(user1).mint(user1.address, 1000n)).to.be.reverted;
    });

    it("non-pool cannot burn", async function () {
      const { token, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(user1).burn(user1.address, 1000n)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BLACKLIST
  // ═══════════════════════════════════════════════════════════════════

  describe("Blacklist", function () {
    it("compliance can blacklist", async function () {
      const { token, compliance, user1 } = await loadFixture(deployFixture);
      await token.connect(compliance).setBlacklist(user1.address, true);
      expect(await token.isBlacklisted(user1.address)).to.be.true;
    });

    it("blocks transfers from blacklisted", async function () {
      const { token, pool, compliance, user1, user2 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await token.connect(compliance).setBlacklist(user1.address, true);
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("blocks transfers to blacklisted", async function () {
      const { token, pool, compliance, user1, user2 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await token.connect(compliance).setBlacklist(user2.address, true);
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("non-compliance cannot blacklist", async function () {
      const { token, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(user1).setBlacklist(user1.address, true)).to.be.reverted;
    });

    it("reverts blacklisting zero address", async function () {
      const { token, compliance } = await loadFixture(deployFixture);
      await expect(token.connect(compliance).setBlacklist(ethers.ZeroAddress, true)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAUSABLE
  // ═══════════════════════════════════════════════════════════════════

  describe("Pausable", function () {
    it("pauser can pause", async function () {
      const { token, pauser } = await loadFixture(deployFixture);
      await token.connect(pauser).pause();
      expect(await token.paused()).to.be.true;
    });

    it("transfers blocked when paused", async function () {
      const { token, pool, pauser, user1, user2 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await token.connect(pauser).pause();
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("admin can unpause", async function () {
      const { token, pauser, deployer } = await loadFixture(deployFixture);
      await token.connect(pauser).pause();
      await token.connect(deployer).unpause();
      expect(await token.paused()).to.be.false;
    });

    it("non-pauser cannot pause", async function () {
      const { token, user1 } = await loadFixture(deployFixture);
      await expect(token.connect(user1).pause()).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TRANSFERS
  // ═══════════════════════════════════════════════════════════════════

  describe("Transfers", function () {
    it("standard transfer works", async function () {
      const { token, pool, user1, user2 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await token.connect(user1).transfer(user2.address, ethers.parseEther("300"));
      expect(await token.balanceOf(user2.address)).to.equal(ethers.parseEther("300"));
    });

    it("transferFrom with approval works", async function () {
      const { token, pool, user1, user2 } = await loadFixture(deployFixture);
      await token.connect(pool).mint(user1.address, ethers.parseEther("1000"));
      await token.connect(user1).approve(user2.address, ethers.parseEther("500"));
      await token.connect(user2).transferFrom(user1.address, user2.address, ethers.parseEther("500"));
      expect(await token.balanceOf(user2.address)).to.equal(ethers.parseEther("500"));
    });
  });
});
