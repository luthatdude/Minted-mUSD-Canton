/**
 * MUSD Token Tests
 * Tests: supply cap enforcement, blacklisting, pause/unpause, role access control
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { MUSD } from "../typechain-types";

describe("MUSD", function () {
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let bridge: HardhatEthersSigner;
  let compliance: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const SUPPLY_CAP = ethers.parseEther("10000000"); // 10M

  beforeEach(async function () {
    [deployer, bridge, compliance, emergency, user1, user2] = await ethers.getSigners();

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = await MUSDFactory.deploy(SUPPLY_CAP);
    await musd.waitForDeployment();

    // Grant roles
    await musd.grantRole(await musd.BRIDGE_ROLE(), bridge.address);
    await musd.grantRole(await musd.COMPLIANCE_ROLE(), compliance.address);
    await musd.grantRole(await musd.EMERGENCY_ROLE(), emergency.address);

    // Set local cap to 100% so effective cap = supplyCap for supply-cap tests
    await musd.setLocalCapBps(10000);
  });

  // ============================================================
  //  DEPLOYMENT
  // ============================================================

  describe("Deployment", function () {
    it("should set correct name and symbol", async function () {
      expect(await musd.name()).to.equal("Minted USD");
      expect(await musd.symbol()).to.equal("mUSD");
    });

    it("should set initial supply cap", async function () {
      expect(await musd.supplyCap()).to.equal(SUPPLY_CAP);
    });

    it("should revert with zero supply cap", async function () {
      const MUSDFactory = await ethers.getContractFactory("MUSD");
      await expect(MUSDFactory.deploy(0)).to.be.revertedWith("INVALID_SUPPLY_CAP");
    });

    it("should grant DEFAULT_ADMIN_ROLE to deployer", async function () {
      expect(await musd.hasRole(await musd.DEFAULT_ADMIN_ROLE(), deployer.address)).to.be.true;
    });
  });

  // ============================================================
  //  MINTING
  // ============================================================

  describe("Minting", function () {
    it("should mint tokens with BRIDGE_ROLE", async function () {
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("1000"));
      expect(await musd.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
    });

    it("should reject mint without BRIDGE_ROLE", async function () {
      await expect(
        musd.connect(user1).mint(user1.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("should reject mint exceeding supply cap", async function () {
      await expect(
        musd.connect(bridge).mint(user1.address, SUPPLY_CAP + 1n)
      ).to.be.revertedWith("EXCEEDS_LOCAL_CAP");
    });

    it("should allow minting up to exact supply cap", async function () {
      await musd.connect(bridge).mint(user1.address, SUPPLY_CAP);
      expect(await musd.totalSupply()).to.equal(SUPPLY_CAP);
    });

    it("should reject mint of 1 wei over supply cap", async function () {
      await musd.connect(bridge).mint(user1.address, SUPPLY_CAP);
      await expect(
        musd.connect(bridge).mint(user1.address, 1n)
      ).to.be.revertedWith("EXCEEDS_LOCAL_CAP");
    });

    it("should emit Mint event", async function () {
      await expect(musd.connect(bridge).mint(user1.address, ethers.parseEther("100")))
        .to.emit(musd, "Mint")
        .withArgs(user1.address, ethers.parseEther("100"));
    });
  });

  // ============================================================
  //  BURNING
  // ============================================================

  describe("Burning", function () {
    beforeEach(async function () {
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("1000"));
    });

    it("should burn tokens with BRIDGE_ROLE (self burn)", async function () {
      // Bridge burns from self — needs tokens first
      await musd.connect(bridge).mint(bridge.address, ethers.parseEther("500"));
      await musd.connect(bridge).burn(bridge.address, ethers.parseEther("500"));
      expect(await musd.balanceOf(bridge.address)).to.equal(0);
    });

    it("should burn tokens from user with allowance", async function () {
      await musd.connect(user1).approve(bridge.address, ethers.parseEther("500"));
      await musd.connect(bridge).burn(user1.address, ethers.parseEther("500"));
      expect(await musd.balanceOf(user1.address)).to.equal(ethers.parseEther("500"));
    });

    it("should reject burn without allowance", async function () {
      await expect(
        musd.connect(bridge).burn(user1.address, ethers.parseEther("500"))
      ).to.be.reverted;
    });

    it("should emit Burn event", async function () {
      await musd.connect(user1).approve(bridge.address, ethers.parseEther("100"));
      await expect(musd.connect(bridge).burn(user1.address, ethers.parseEther("100")))
        .to.emit(musd, "Burn")
        .withArgs(user1.address, ethers.parseEther("100"));
    });
  });

  // ============================================================
  //  SUPPLY CAP
  // ============================================================

  describe("Supply Cap", function () {
    it("should allow admin to update supply cap", async function () {
      const newCap = ethers.parseEther("20000000");
      await musd.setSupplyCap(newCap);
      expect(await musd.supplyCap()).to.equal(newCap);
    });

    it("should allow CAP_MANAGER_ROLE to update supply cap", async function () {
      await musd.grantRole(await musd.CAP_MANAGER_ROLE(), user1.address);
      const newCap = ethers.parseEther("20000000");
      await musd.connect(user1).setSupplyCap(newCap);
      expect(await musd.supplyCap()).to.equal(newCap);
    });

    it("should reject unauthorized supply cap change", async function () {
      await expect(
        musd.connect(user1).setSupplyCap(ethers.parseEther("1"))
      ).to.be.revertedWith("UNAUTHORIZED");
    });

    it("should reject zero supply cap", async function () {
      await expect(musd.setSupplyCap(0)).to.be.revertedWith("INVALID_SUPPLY_CAP");
    });

    it("should ALLOW cap below current supply (undercollateralization response)", async function () {
      // Mint 5M tokens
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("5000000"));
      
      // Now set cap to 1M (below current supply) - this should SUCCEED
      // and emit SupplyCapBelowSupply event
      const newCap = ethers.parseEther("1000000");
      await expect(musd.setSupplyCap(newCap))
        .to.emit(musd, "SupplyCapBelowSupply")
        .withArgs(newCap, ethers.parseEther("5000000"));
      
      expect(await musd.supplyCap()).to.equal(newCap);
      
      // Now new mints should fail
      await expect(
        musd.connect(bridge).mint(user1.address, ethers.parseEther("1"))
      ).to.be.revertedWith("EXCEEDS_LOCAL_CAP");
    });

    it("should allow cap equal to current supply", async function () {
      const mintAmount = ethers.parseEther("5000000");
      await musd.connect(bridge).mint(user1.address, mintAmount);
      await musd.setSupplyCap(mintAmount);
      expect(await musd.supplyCap()).to.equal(mintAmount);
    });

    it("should emit SupplyCapUpdated event", async function () {
      const newCap = ethers.parseEther("20000000");
      await expect(musd.setSupplyCap(newCap))
        .to.emit(musd, "SupplyCapUpdated")
        .withArgs(SUPPLY_CAP, newCap);
    });
  });

  // ============================================================
  //  BLACKLIST
  // ============================================================

  describe("Blacklist", function () {
    beforeEach(async function () {
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("1000"));
    });

    it("should blacklist an account", async function () {
      await musd.connect(compliance).setBlacklist(user1.address, true);
      expect(await musd.isBlacklisted(user1.address)).to.be.true;
    });

    it("should block transfers from blacklisted sender", async function () {
      await musd.connect(compliance).setBlacklist(user1.address, true);
      await expect(
        musd.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("COMPLIANCE_REJECT");
    });

    it("should block transfers to blacklisted receiver", async function () {
      await musd.connect(compliance).setBlacklist(user2.address, true);
      await expect(
        musd.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("COMPLIANCE_REJECT");
    });

    it("should block minting to blacklisted address", async function () {
      await musd.connect(compliance).setBlacklist(user1.address, true);
      await expect(
        musd.connect(bridge).mint(user1.address, ethers.parseEther("100"))
      ).to.be.revertedWith("COMPLIANCE_REJECT");
    });

    it("should remove from blacklist", async function () {
      await musd.connect(compliance).setBlacklist(user1.address, true);
      await musd.connect(compliance).setBlacklist(user1.address, false);
      await musd.connect(user1).transfer(user2.address, ethers.parseEther("100"));
      expect(await musd.balanceOf(user2.address)).to.equal(ethers.parseEther("100"));
    });

    it("should reject blacklist of zero address", async function () {
      await expect(
        musd.connect(compliance).setBlacklist(ethers.ZeroAddress, true)
      ).to.be.revertedWith("INVALID_ADDRESS");
    });

    it("should reject blacklist without COMPLIANCE_ROLE", async function () {
      await expect(
        musd.connect(user1).setBlacklist(user2.address, true)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //  PAUSABLE
  // ============================================================

  describe("Pausable", function () {
    beforeEach(async function () {
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("1000"));
    });

    it("should allow EMERGENCY_ROLE to pause", async function () {
      await musd.connect(emergency).pause();
      expect(await musd.paused()).to.be.true;
    });

    it("should block transfers when paused", async function () {
      await musd.connect(emergency).pause();
      await expect(
        musd.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("should block minting when paused", async function () {
      await musd.connect(emergency).pause();
      await expect(
        musd.connect(bridge).mint(user1.address, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    it("should require DEFAULT_ADMIN_ROLE to unpause (separation of duties)", async function () {
      await musd.connect(emergency).pause();
      await expect(
        musd.connect(emergency).unpause()
      ).to.be.reverted;
      await musd.connect(deployer).unpause();
      expect(await musd.paused()).to.be.false;
    });

    it("should resume transfers after unpause", async function () {
      await musd.connect(emergency).pause();
      await musd.connect(deployer).unpause();
      await musd.connect(user1).transfer(user2.address, ethers.parseEther("100"));
      expect(await musd.balanceOf(user2.address)).to.equal(ethers.parseEther("100"));
    });

    it("should reject pause without EMERGENCY_ROLE", async function () {
      await expect(musd.connect(user1).pause()).to.be.reverted;
    });
  });

  // ============================================================
  //  TRANSFERS
  // ============================================================

  describe("Transfers", function () {
    beforeEach(async function () {
      await musd.connect(bridge).mint(user1.address, ethers.parseEther("1000"));
    });

    it("should transfer tokens", async function () {
      await musd.connect(user1).transfer(user2.address, ethers.parseEther("500"));
      expect(await musd.balanceOf(user1.address)).to.equal(ethers.parseEther("500"));
      expect(await musd.balanceOf(user2.address)).to.equal(ethers.parseEther("500"));
    });

    it("should handle transferFrom with approval", async function () {
      await musd.connect(user1).approve(user2.address, ethers.parseEther("500"));
      await musd.connect(user2).transferFrom(user1.address, user2.address, ethers.parseEther("500"));
      expect(await musd.balanceOf(user2.address)).to.equal(ethers.parseEther("500"));
    });
  });
});
