import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * @title YieldVerifier Test Suite
 * @notice TEST-C-02: Comprehensive tests for the YieldVerifier contract
 * @dev Tests adapter registration, verification, batch verification, tolerance
 */
describe("YieldVerifier", function () {
  async function deployFixture() {
    const [admin, manager, user1] = await ethers.getSigners();

    const YieldVerifier = await ethers.getContractFactory("YieldVerifier");
    const verifier = await YieldVerifier.deploy(admin.address);

    // Deploy a mock yield adapter
    // We'll create a minimal mock inline since no MockYieldAdapter exists
    const MockYieldAdapterFactory = await ethers.getContractFactory("MockYieldAdapter");
    const adapter1 = await MockYieldAdapterFactory.deploy(1, "Aave V3", 500, 300, 1_000_000_000000n, 7500, true);
    const adapter2 = await MockYieldAdapterFactory.deploy(2, "Compound V3", 400, 250, 500_000_000000n, 6000, true);
    const adapter3 = await MockYieldAdapterFactory.deploy(3, "Morpho", 600, 350, 200_000_000000n, 8000, true);

    return { verifier, adapter1, adapter2, adapter3, admin, manager, user1 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("sets admin correctly", async function () {
      const { verifier, admin } = await loadFixture(deployFixture);
      const MANAGER_ROLE = await verifier.MANAGER_ROLE();
      expect(await verifier.hasRole(MANAGER_ROLE, admin.address)).to.be.true;
    });

    it("starts with zero adapters", async function () {
      const { verifier } = await loadFixture(deployFixture);
      expect(await verifier.adapterCount()).to.equal(0);
    });

    it("reverts on zero admin address", async function () {
      const YieldVerifier = await ethers.getContractFactory("YieldVerifier");
      await expect(YieldVerifier.deploy(ethers.ZeroAddress)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADAPTER REGISTRATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Adapter Registration", function () {
    it("registers adapter", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await expect(verifier.connect(admin).registerAdapter(1, await adapter1.getAddress()))
        .to.emit(verifier, "AdapterRegistered");
      expect(await verifier.adapterCount()).to.equal(1);
      expect(await verifier.hasAdapter(1)).to.be.true;
    });

    it("registers multiple adapters", async function () {
      const { verifier, adapter1, adapter2, adapter3, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      await verifier.connect(admin).registerAdapter(2, await adapter2.getAddress());
      await verifier.connect(admin).registerAdapter(3, await adapter3.getAddress());
      expect(await verifier.adapterCount()).to.equal(3);
    });

    it("deactivates adapter", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      await verifier.connect(admin).deactivateAdapter(1);
    });

    it("reverts registration from unauthorized", async function () {
      const { verifier, adapter1, user1 } = await loadFixture(deployFixture);
      await expect(verifier.connect(user1).registerAdapter(1, await adapter1.getAddress())).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Verification", function () {
    it("verifies within tolerance", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      // Adapter returns 500 BPS supply APY. Expected = 500, tolerance = 750 BPS (7.5%)
      const result = await verifier.verify(1, ethers.ZeroAddress, ethers.ZeroHash, 500);
      expect(result.passed).to.be.true;
      expect(result.liveSupplyApyBps).to.equal(500);
    });

    it("quickVerify returns bool", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      const passed = await verifier.quickVerify(1, ethers.ZeroAddress, ethers.ZeroHash, 500);
      expect(passed).to.be.true;
    });

    it("fails verification when APY deviates too much", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      // Adapter returns 500 BPS but we expect 1000 BPS — 50% deviation exceeds 7.5% tolerance
      const result = await verifier.verify(1, ethers.ZeroAddress, ethers.ZeroHash, 1000);
      expect(result.passed).to.be.false;
    });

    it("returns passed=false for unregistered adapter", async function () {
      const { verifier } = await loadFixture(deployFixture);
      const result = await verifier.verify(99, ethers.ZeroAddress, ethers.ZeroHash, 500);
      expect(result.passed).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BATCH VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Batch Verification", function () {
    it("batch verifies multiple adapters", async function () {
      const { verifier, adapter1, adapter2, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      await verifier.connect(admin).registerAdapter(2, await adapter2.getAddress());

      const items = [
        { protocolId: 1, venue: ethers.ZeroAddress, extraData: ethers.ZeroHash, expectedApyBps: 500 },
        { protocolId: 2, venue: ethers.ZeroAddress, extraData: ethers.ZeroHash, expectedApyBps: 400 },
      ];
      const [results, passCount] = await verifier.batchVerify(items);
      expect(results.length).to.equal(2);
      expect(passCount).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // TOLERANCE
  // ═══════════════════════════════════════════════════════════════════

  describe("Tolerance", function () {
    it("sets custom tolerance", async function () {
      const { verifier, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).setTolerance(1, 500); // 5%
      expect(await verifier.getTolerance(1)).to.equal(500);
    });

    it("returns default tolerance for unset protocols", async function () {
      const { verifier } = await loadFixture(deployFixture);
      // DEFAULT_TOLERANCE_BPS = 750
      expect(await verifier.getTolerance(99)).to.equal(750);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // READ LIVE
  // ═══════════════════════════════════════════════════════════════════

  describe("Read Live", function () {
    it("reads live data from adapter", async function () {
      const { verifier, adapter1, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      const [available, supplyApy, borrowApy, tvl, utilization, isAvailable] =
        await verifier.readLive(1, ethers.ZeroAddress, ethers.ZeroHash);
      expect(supplyApy).to.equal(500);
      expect(borrowApy).to.equal(300);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET ADAPTERS
  // ═══════════════════════════════════════════════════════════════════

  describe("Get Adapters", function () {
    it("returns all registered adapters", async function () {
      const { verifier, adapter1, adapter2, admin } = await loadFixture(deployFixture);
      await verifier.connect(admin).registerAdapter(1, await adapter1.getAddress());
      await verifier.connect(admin).registerAdapter(2, await adapter2.getAddress());
      const [ids, infos] = await verifier.getAdapters();
      expect(ids.length).to.equal(2);
    });
  });
});
