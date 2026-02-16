import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * @title PriceAggregator Test Suite
 * @notice TEST-C-02: Comprehensive tests for the PriceAggregator (UUPS upgradeable)
 * @dev Tests adapter management, price aggregation, cross-validation, deviation checks
 */
describe("PriceAggregator", function () {
  async function deployFixture() {
    const [admin, oracleAdmin, timelockSigner, user1] = await ethers.getSigners();

    // Deploy MockOracleAdapters — we need these to simulate price feeds
    const MockOracleAdapter = await ethers.getContractFactory("MockOracleAdapter");
    const adapter1 = await MockOracleAdapter.deploy("Chainlink", 2000_00000000n); // $2000 (8 dec)
    const adapter2 = await MockOracleAdapter.deploy("Pyth", 2010_00000000n);      // $2010
    const adapter3 = await MockOracleAdapter.deploy("TWAP", 1990_00000000n);      // $1990

    const PriceAggregator = await ethers.getContractFactory("PriceAggregator");
    const aggregator = await upgrades.deployProxy(
      PriceAggregator,
      [admin.address, timelockSigner.address],
      { kind: "uups", initializer: "initialize" }
    );

    await aggregator.grantRole(await aggregator.ORACLE_ADMIN_ROLE(), oracleAdmin.address);

    return { aggregator, adapter1, adapter2, adapter3, admin, oracleAdmin, timelockSigner, user1 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("initializes correctly", async function () {
      const { aggregator } = await loadFixture(deployFixture);
      expect(await aggregator.adapterCount()).to.equal(0);
    });

    it("grants ORACLE_ADMIN_ROLE", async function () {
      const { aggregator, oracleAdmin } = await loadFixture(deployFixture);
      expect(await aggregator.hasRole(await aggregator.ORACLE_ADMIN_ROLE(), oracleAdmin.address)).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADAPTER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  describe("Adapter Management", function () {
    it("adds adapter", async function () {
      const { aggregator, adapter1, oracleAdmin } = await loadFixture(deployFixture);
      await expect(aggregator.connect(oracleAdmin).addAdapter(await adapter1.getAddress()))
        .to.emit(aggregator, "AdapterAdded");
      expect(await aggregator.adapterCount()).to.equal(1);
    });

    it("adds up to MAX_ADAPTERS", async function () {
      const { aggregator, adapter1, adapter2, adapter3, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).addAdapter(await adapter1.getAddress());
      await aggregator.connect(oracleAdmin).addAdapter(await adapter2.getAddress());
      await aggregator.connect(oracleAdmin).addAdapter(await adapter3.getAddress());
      expect(await aggregator.adapterCount()).to.equal(3);
    });

    it("removes adapter", async function () {
      const { aggregator, adapter1, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).addAdapter(await adapter1.getAddress());
      await expect(aggregator.connect(oracleAdmin).removeAdapter(await adapter1.getAddress()))
        .to.emit(aggregator, "AdapterRemoved");
      expect(await aggregator.adapterCount()).to.equal(0);
    });

    it("reverts adding zero address", async function () {
      const { aggregator, oracleAdmin } = await loadFixture(deployFixture);
      await expect(aggregator.connect(oracleAdmin).addAdapter(ethers.ZeroAddress)).to.be.reverted;
    });

    it("reverts from unauthorized caller", async function () {
      const { aggregator, adapter1, user1 } = await loadFixture(deployFixture);
      await expect(aggregator.connect(user1).addAdapter(await adapter1.getAddress())).to.be.reverted;
    });

    it("sets adapters in batch", async function () {
      const { aggregator, adapter1, adapter2, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).setAdapters([
        await adapter1.getAddress(),
        await adapter2.getAddress(),
      ]);
      expect(await aggregator.adapterCount()).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PRICE QUERIES
  // ═══════════════════════════════════════════════════════════════════

  describe("Price Queries", function () {
    it("returns price from single adapter", async function () {
      const { aggregator, adapter1, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).addAdapter(await adapter1.getAddress());
      const wethAddr = ethers.Wallet.createRandom().address; // dummy token addr
      const price = await aggregator.getPrice(wethAddr);
      expect(price).to.be.gt(0);
    });

    it("reverts with no adapters", async function () {
      const { aggregator } = await loadFixture(deployFixture);
      await expect(aggregator.getPrice(ethers.ZeroAddress)).to.be.reverted;
    });

    it("getAllPrices returns prices from all adapters", async function () {
      const { aggregator, adapter1, adapter2, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).addAdapter(await adapter1.getAddress());
      await aggregator.connect(oracleAdmin).addAdapter(await adapter2.getAddress());
      const [prices, sources] = await aggregator.getAllPrices(ethers.Wallet.createRandom().address);
      expect(prices.length).to.equal(2);
      expect(sources.length).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DEVIATION
  // ═══════════════════════════════════════════════════════════════════

  describe("Deviation", function () {
    it("sets max deviation", async function () {
      const { aggregator, oracleAdmin } = await loadFixture(deployFixture);
      await expect(aggregator.connect(oracleAdmin).setMaxDeviation(300))
        .to.emit(aggregator, "MaxDeviationUpdated");
    });

    it("toggles cross-validation", async function () {
      const { aggregator, oracleAdmin } = await loadFixture(deployFixture);
      await aggregator.connect(oracleAdmin).setCrossValidation(true);
      await expect(aggregator.connect(oracleAdmin).setCrossValidation(false))
        .to.emit(aggregator, "CrossValidationToggled");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UUPS UPGRADE
  // ═══════════════════════════════════════════════════════════════════

  describe("UUPS Upgrade", function () {
    it("blocks upgrade from non-timelock", async function () {
      const { aggregator, user1 } = await loadFixture(deployFixture);
      const PriceAggregator = await ethers.getContractFactory("PriceAggregator");
      await expect(
        upgrades.upgradeProxy(await aggregator.getAddress(), PriceAggregator.connect(user1), { kind: "uups" })
      ).to.be.reverted;
    });
  });
});
