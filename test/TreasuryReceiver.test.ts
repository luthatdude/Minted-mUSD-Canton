import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("TreasuryReceiver", function () {
  const BASE_CHAIN_ID = 30;
  const ARBITRUM_CHAIN_ID = 23;

  async function deployFixture() {
    const [admin, bridgeAdmin, pauser, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20 for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Deploy Mock Wormhole
    const MockWormhole = await ethers.getContractFactory("MockWormhole");
    const wormhole = await MockWormhole.deploy();

    // Deploy Mock Token Bridge
    const MockWormholeTokenBridge = await ethers.getContractFactory("MockWormholeTokenBridge");
    const tokenBridge = await MockWormholeTokenBridge.deploy();
    await tokenBridge.setUsdc(await usdc.getAddress());

    // Deploy mock mUSD for DirectMint
    const musd = await MockERC20.deploy("Minted USD", "mUSD", 18);

    // Deploy Mock DirectMint
    const MockDirectMint = await ethers.getContractFactory("MockDirectMint");
    const directMint = await MockDirectMint.deploy(await usdc.getAddress(), await musd.getAddress());

    // Deploy mock Treasury
    const treasury = user2; // Just use a signer as treasury

    // Deploy TreasuryReceiver
    const TreasuryReceiver = await ethers.getContractFactory("TreasuryReceiver");
    const receiver = await TreasuryReceiver.deploy(
      await usdc.getAddress(),
      await wormhole.getAddress(),
      await tokenBridge.getAddress(),
      await directMint.getAddress(),
      treasury.address
    );

    // Grant roles
    const BRIDGE_ADMIN_ROLE = await receiver.BRIDGE_ADMIN_ROLE();
    const PAUSER_ROLE = await receiver.PAUSER_ROLE();
    await receiver.connect(admin).grantRole(BRIDGE_ADMIN_ROLE, bridgeAdmin.address);
    await receiver.connect(admin).grantRole(PAUSER_ROLE, pauser.address);

    // Mint USDC to token bridge for simulating transfers
    await usdc.mint(await tokenBridge.getAddress(), ethers.parseUnits("1000000", 6));

    return { receiver, usdc, wormhole, tokenBridge, directMint, admin, bridgeAdmin, pauser, user1, treasury };
  }

  describe("Deployment", function () {
    it("Should set correct initial state", async function () {
      const { receiver, usdc, wormhole, tokenBridge, directMint, treasury } = await loadFixture(deployFixture);

      expect(await receiver.usdc()).to.equal(await usdc.getAddress());
      expect(await receiver.wormhole()).to.equal(await wormhole.getAddress());
      expect(await receiver.tokenBridge()).to.equal(await tokenBridge.getAddress());
      expect(await receiver.directMint()).to.equal(await directMint.getAddress());
      expect(await receiver.treasury()).to.equal(treasury.address);
    });

    it("Should grant roles to deployer", async function () {
      const { receiver, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await receiver.DEFAULT_ADMIN_ROLE();
      const BRIDGE_ADMIN_ROLE = await receiver.BRIDGE_ADMIN_ROLE();
      const PAUSER_ROLE = await receiver.PAUSER_ROLE();

      expect(await receiver.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await receiver.hasRole(BRIDGE_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await receiver.hasRole(PAUSER_ROLE, admin.address)).to.be.true;
    });

    it("Should revert on zero address parameters", async function () {
      const { usdc, wormhole, tokenBridge, directMint, treasury } = await loadFixture(deployFixture);
      const TreasuryReceiver = await ethers.getContractFactory("TreasuryReceiver");

      await expect(
        TreasuryReceiver.deploy(
          ethers.ZeroAddress,
          await wormhole.getAddress(),
          await tokenBridge.getAddress(),
          await directMint.getAddress(),
          treasury.address
        )
      ).to.be.revertedWithCustomError(TreasuryReceiver, "InvalidAddress");

      await expect(
        TreasuryReceiver.deploy(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          await tokenBridge.getAddress(),
          await directMint.getAddress(),
          treasury.address
        )
      ).to.be.revertedWithCustomError(TreasuryReceiver, "InvalidAddress");
    });
  });

  describe("Router Authorization", function () {
    it("Should authorize router", async function () {
      const { receiver, bridgeAdmin } = await loadFixture(deployFixture);

      const routerAddress = ethers.zeroPadValue("0x1234567890123456789012345678901234567890", 32);

      await expect(receiver.connect(bridgeAdmin).authorizeRouter(BASE_CHAIN_ID, routerAddress))
        .to.emit(receiver, "RouterAuthorized")
        .withArgs(BASE_CHAIN_ID, routerAddress);

      expect(await receiver.authorizedRouters(BASE_CHAIN_ID)).to.equal(routerAddress);
    });

    it("Should revoke router", async function () {
      const { receiver, bridgeAdmin } = await loadFixture(deployFixture);

      const routerAddress = ethers.zeroPadValue("0x1234567890123456789012345678901234567890", 32);
      await receiver.connect(bridgeAdmin).authorizeRouter(BASE_CHAIN_ID, routerAddress);

      await expect(receiver.connect(bridgeAdmin).revokeRouter(BASE_CHAIN_ID))
        .to.emit(receiver, "RouterRevoked")
        .withArgs(BASE_CHAIN_ID);

      expect(await receiver.authorizedRouters(BASE_CHAIN_ID)).to.equal(ethers.ZeroHash);
    });

    it("Should revert router authorization for non-bridge-admin", async function () {
      const { receiver, user1 } = await loadFixture(deployFixture);

      const routerAddress = ethers.zeroPadValue("0x1234567890123456789012345678901234567890", 32);

      await expect(receiver.connect(user1).authorizeRouter(BASE_CHAIN_ID, routerAddress))
        .to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("Should track processed VAAs", async function () {
      const { receiver } = await loadFixture(deployFixture);

      const vaaHash = ethers.keccak256(ethers.toUtf8Bytes("test-vaa"));
      expect(await receiver.isVAAProcessed(vaaHash)).to.be.false;
    });

    it("Should return chain ID constants", async function () {
      const { receiver } = await loadFixture(deployFixture);

      expect(await receiver.BASE_CHAIN_ID()).to.equal(30);
      expect(await receiver.ARBITRUM_CHAIN_ID()).to.equal(23);
      expect(await receiver.SOLANA_CHAIN_ID()).to.equal(1);
    });
  });

  describe("Admin Functions", function () {
    it("Should update DirectMint address", async function () {
      const { receiver, admin, user1 } = await loadFixture(deployFixture);

      await expect(receiver.connect(admin).setDirectMint(user1.address))
        .to.emit(receiver, "DirectMintUpdated");

      expect(await receiver.directMint()).to.equal(user1.address);
    });

    it("Should update Treasury address", async function () {
      const { receiver, admin, user1 } = await loadFixture(deployFixture);

      await expect(receiver.connect(admin).setTreasury(user1.address))
        .to.emit(receiver, "TreasuryUpdated");

      expect(await receiver.treasury()).to.equal(user1.address);
    });

    it("Should revert update with zero address", async function () {
      const { receiver, admin } = await loadFixture(deployFixture);

      await expect(receiver.connect(admin).setDirectMint(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(receiver, "InvalidAddress");

      await expect(receiver.connect(admin).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(receiver, "InvalidAddress");
    });

    it("Should revert admin functions for non-admin", async function () {
      const { receiver, user1 } = await loadFixture(deployFixture);

      await expect(receiver.connect(user1).setDirectMint(user1.address))
        .to.be.reverted;

      await expect(receiver.connect(user1).setTreasury(user1.address))
        .to.be.reverted;
    });
  });

  describe("receiveAndMint", function () {
    /**
     * Builds a Wormhole TransferWithPayload (type 3) payload.
     * Layout: payloadID(1) + amount(32) + tokenAddress(32) + tokenChain(2) +
     *         to(32) + toChain(2) + fromAddress(32) + userPayload(variable)
     * Total fixed header = 133 bytes.
     */
    function buildTransferPayload(recipientAddress: string): string {
      // payloadID = 3 (TransferWithPayload)
      const payloadId = "03";
      // amount (32 bytes) — doesn't matter for our mock
      const amount = "0".repeat(64);
      // tokenAddress (32 bytes)
      const tokenAddress = "0".repeat(64);
      // tokenChain (2 bytes)
      const tokenChain = "0001";
      // to (32 bytes)
      const to = "0".repeat(64);
      // toChain (2 bytes)
      const toChain = "0002";
      // fromAddress (32 bytes)
      const fromAddress = "0".repeat(64);
      // userPayload = abi.encode(recipient)
      const userPayload = ethers.AbiCoder.defaultAbiCoder()
        .encode(["address"], [recipientAddress])
        .slice(2); // remove 0x

      return "0x" + payloadId + amount + tokenAddress + tokenChain + to + toChain + fromAddress + userPayload;
    }

    async function setupReceiveAndMint(fixture: Awaited<ReturnType<typeof deployFixture>>) {
      const { receiver, wormhole, tokenBridge, bridgeAdmin, user1 } = fixture;

      const routerAddress = ethers.zeroPadValue("0xDEAD", 32);
      await receiver.connect(bridgeAdmin).authorizeRouter(BASE_CHAIN_ID, routerAddress);

      const vaaHash = ethers.keccak256(ethers.toUtf8Bytes("unique-vaa-1"));
      const payload = buildTransferPayload(user1.address);

      await wormhole.setMockVM(BASE_CHAIN_ID, routerAddress, payload, vaaHash);
      await tokenBridge.setTransferAmount(ethers.parseUnits("1000", 6));

      return { routerAddress, vaaHash, payload };
    }

    it("Should receive bridged USDC and mint mUSD via DirectMint", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver, user1 } = fixture;
      const { vaaHash } = await setupReceiveAndMint(fixture);

      await expect(receiver.receiveAndMint("0x01"))
        .to.emit(receiver, "MUSDMinted")
        .to.emit(receiver, "DepositReceived");

      expect(await receiver.isVAAProcessed(vaaHash)).to.be.true;
    });

    it("Should fallback to treasury when DirectMint fails", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver, directMint, usdc, treasury } = fixture;
      await setupReceiveAndMint(fixture);

      // Make DirectMint fail
      await directMint.setShouldFail(true);

      const treasuryBalBefore = await usdc.balanceOf(treasury.address);

      await expect(receiver.receiveAndMint("0x01"))
        .to.emit(receiver, "MintFallbackToTreasury");

      // USDC should have gone to treasury
      const treasuryBalAfter = await usdc.balanceOf(treasury.address);
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(ethers.parseUnits("1000", 6));
    });

    it("Should reject invalid VAA", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver, wormhole } = fixture;

      await wormhole.setShouldValidate(false);

      await expect(receiver.receiveAndMint("0x01"))
        .to.be.revertedWithCustomError(receiver, "InvalidVAA");
    });

    it("Should reject replay (same VAA hash)", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver } = fixture;
      await setupReceiveAndMint(fixture);

      // First call should succeed
      await receiver.receiveAndMint("0x01");

      // Second call with same VAA should revert
      await expect(receiver.receiveAndMint("0x01"))
        .to.be.revertedWithCustomError(receiver, "VAAAlreadyProcessed");
    });

    it("Should reject unauthorized router", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver, wormhole } = fixture;

      // Set mock VM with an unregistered router
      const unknownRouter = ethers.zeroPadValue("0xBEEF", 32);
      const vaaHash = ethers.keccak256(ethers.toUtf8Bytes("unauth-vaa"));
      const payload = buildTransferPayload(fixture.user1.address);
      await wormhole.setMockVM(ARBITRUM_CHAIN_ID, unknownRouter, payload, vaaHash);

      await expect(receiver.receiveAndMint("0x01"))
        .to.be.revertedWithCustomError(receiver, "UnauthorizedRouter");
    });

    it("Should reject when paused", async function () {
      const fixture = await loadFixture(deployFixture);
      const { receiver, pauser } = fixture;
      await setupReceiveAndMint(fixture);

      await receiver.connect(pauser).pause();

      await expect(receiver.receiveAndMint("0x01"))
        .to.be.revertedWithCustomError(receiver, "EnforcedPause");
    });
  });

  describe("Emergency Controls", function () {
    it("Should pause operations", async function () {
      const { receiver, pauser } = await loadFixture(deployFixture);

      await receiver.connect(pauser).pause();
      expect(await receiver.paused()).to.be.true;
    });

    it("Should unpause operations", async function () {
      const { receiver, admin, pauser } = await loadFixture(deployFixture);

      await receiver.connect(pauser).pause();
      await receiver.connect(admin).unpause();
      expect(await receiver.paused()).to.be.false;
    });

    it("Should require DEFAULT_ADMIN_ROLE for unpause", async function () {
      const { receiver, pauser } = await loadFixture(deployFixture);

      await receiver.connect(pauser).pause();

      await expect(receiver.connect(pauser).unpause())
        .to.be.reverted;
    });

    it("Should allow emergency withdrawal", async function () {
      const { receiver, usdc, admin, user1, pauser } = await loadFixture(deployFixture);

      // Send some USDC to receiver
      await usdc.mint(await receiver.getAddress(), ethers.parseUnits("1000", 6));

      // FIX TR-M01: USDC withdrawal only allowed when paused (true emergency)
      await receiver.connect(pauser).pause();

      await receiver.connect(admin).emergencyWithdraw(
        await usdc.getAddress(),
        user1.address,
        ethers.parseUnits("1000", 6)
      );

      expect(await usdc.balanceOf(user1.address)).to.equal(ethers.parseUnits("1000", 6));
    });

    it("Should revert emergency withdraw for non-admin", async function () {
      const { receiver, usdc, user1 } = await loadFixture(deployFixture);

      await expect(
        receiver.connect(user1).emergencyWithdraw(await usdc.getAddress(), user1.address, 1)
      ).to.be.reverted;
    });
  });
});
