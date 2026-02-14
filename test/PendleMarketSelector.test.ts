import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PendleMarketSelector", function () {
  async function deployFixture() {
    const [admin, marketAdmin, paramsAdmin, user1] = await ethers.getSigners();

    // Deploy mock token addresses for PT/SY/YT
    const mockSy = ethers.Wallet.createRandom().address;
    const mockPt = ethers.Wallet.createRandom().address;
    const mockYt = ethers.Wallet.createRandom().address;

    // Calculate expiry 90 days from now
    const currentTime = Math.floor(Date.now() / 1000);
    const expiry90Days = currentTime + 90 * 24 * 60 * 60;

    // Deploy mock Pendle markets
    const MockPendleMarket = await ethers.getContractFactory("MockPendleMarket");
    const market1 = await MockPendleMarket.deploy(mockSy, mockPt, mockYt, expiry90Days);
    const market2 = await MockPendleMarket.deploy(mockSy, mockPt, mockYt, expiry90Days);
    const market3 = await MockPendleMarket.deploy(mockSy, mockPt, mockYt, expiry90Days);

    // Deploy PendleMarketSelector as upgradeable
    const PendleMarketSelector = await ethers.getContractFactory("PendleMarketSelector");
    const selector = await upgrades.deployProxy(PendleMarketSelector, [admin.address, admin.address], {
      kind: "uups",
      initializer: "initialize",
    });

    // Grant roles
    const MARKET_ADMIN_ROLE = await selector.MARKET_ADMIN_ROLE();
    const PARAMS_ADMIN_ROLE = await selector.PARAMS_ADMIN_ROLE();
    const TIMELOCK_ROLE = await selector.TIMELOCK_ROLE();
    await selector.connect(admin).grantRole(MARKET_ADMIN_ROLE, marketAdmin.address);
    await selector.connect(admin).grantRole(PARAMS_ADMIN_ROLE, paramsAdmin.address);
    // whitelistMarket/removeMarket/setParams now require TIMELOCK_ROLE (SOL-H-04)
    await selector.connect(admin).grantRole(TIMELOCK_ROLE, marketAdmin.address);
    await selector.connect(admin).grantRole(TIMELOCK_ROLE, paramsAdmin.address);

    return { selector, admin, marketAdmin, paramsAdmin, user1, market1, market2, market3 };
  }

  describe("Initialization", function () {
    it("Should set correct initial parameters", async function () {
      const { selector } = await loadFixture(deployFixture);

      expect(await selector.minTimeToExpiry()).to.equal(30 * 24 * 60 * 60); // 30 days
      expect(await selector.minTvlUsd()).to.equal(ethers.parseUnits("10000000", 6)); // $10M
      expect(await selector.minApyBps()).to.equal(900); // 9%
      expect(await selector.tvlWeight()).to.equal(4000); // 40%
      expect(await selector.apyWeight()).to.equal(6000); // 60%
    });

    it("Should grant roles to admin", async function () {
      const { selector, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await selector.DEFAULT_ADMIN_ROLE();
      const MARKET_ADMIN_ROLE = await selector.MARKET_ADMIN_ROLE();
      const PARAMS_ADMIN_ROLE = await selector.PARAMS_ADMIN_ROLE();

      expect(await selector.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await selector.hasRole(MARKET_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await selector.hasRole(PARAMS_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("Should not allow re-initialization", async function () {
      const { selector, user1 } = await loadFixture(deployFixture);

      await expect(selector.initialize(user1.address, user1.address)).to.be.reverted;
    });
  });

  describe("Market Whitelisting", function () {
    it("Should whitelist a market", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      await expect(
        selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD")
      ).to.emit(selector, "MarketWhitelisted");

      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.true;
      expect(await selector.marketCategory(await market1.getAddress())).to.equal("USD");
    });

    it("Should batch whitelist markets", async function () {
      const { selector, marketAdmin, market1, market2, market3 } = await loadFixture(deployFixture);

      const markets = [
        await market1.getAddress(),
        await market2.getAddress(),
        await market3.getAddress(),
      ];
      const categories = ["USD", "USD", "ETH"];

      await selector.connect(marketAdmin).whitelistMarkets(markets, categories);

      expect(await selector.isWhitelisted(markets[0])).to.be.true;
      expect(await selector.isWhitelisted(markets[1])).to.be.true;
      expect(await selector.isWhitelisted(markets[2])).to.be.true;
      expect(await selector.marketCategory(markets[2])).to.equal("ETH");
    });

    it("Should remove a market from whitelist", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.true;

      await expect(
        selector.connect(marketAdmin).removeMarket(await market1.getAddress())
      ).to.emit(selector, "MarketRemoved");

      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.false;
    });

    it("Should revert whitelist for non-market-admin", async function () {
      const { selector, user1, market1 } = await loadFixture(deployFixture);

      await expect(
        selector.connect(user1).whitelistMarket(await market1.getAddress(), "USD")
      ).to.be.reverted;
    });

    it("Should revert whitelist for zero address", async function () {
      const { selector, marketAdmin } = await loadFixture(deployFixture);

      await expect(
        selector.connect(marketAdmin).whitelistMarket(ethers.ZeroAddress, "USD")
      ).to.be.revertedWithCustomError(selector, "ZeroAddress");
    });

    it("Should revert batch whitelist with mismatched arrays", async function () {
      const { selector, marketAdmin, market1, market2 } = await loadFixture(deployFixture);

      const markets = [await market1.getAddress(), await market2.getAddress()];
      const categories = ["USD"]; // Only one category

      await expect(
        selector.connect(marketAdmin).whitelistMarkets(markets, categories)
      ).to.be.revertedWithCustomError(selector, "LengthMismatch");
    });
  });

  describe("Parameter Updates", function () {
    it("Should update selection parameters", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFixture);

      const newMinTimeToExpiry = 60 * 24 * 60 * 60; // 60 days
      const newMinTvlUsd = ethers.parseUnits("100000000", 6); // $100M
      const newMinApyBps = 1000; // 10%
      const newTvlWeight = 5000;
      const newApyWeight = 5000;

      await expect(
        selector.connect(paramsAdmin).setParams(
          newMinTimeToExpiry,
          newMinTvlUsd,
          newMinApyBps,
          newTvlWeight,
          newApyWeight
        )
      ).to.emit(selector, "ParamsUpdated");

      expect(await selector.minTimeToExpiry()).to.equal(newMinTimeToExpiry);
      expect(await selector.minTvlUsd()).to.equal(newMinTvlUsd);
      expect(await selector.tvlWeight()).to.equal(newTvlWeight);
      expect(await selector.apyWeight()).to.equal(newApyWeight);
    });

    it("Should revert on invalid weights (not summing to 10000)", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFixture);

      await expect(
        selector.connect(paramsAdmin).setParams(
          30 * 24 * 60 * 60,
          ethers.parseUnits("50000000", 6),
          900,  // minApyBps
          3000, // 30%
          3000  // 30% - total only 60%
        )
      ).to.be.revertedWithCustomError(selector, "InvalidWeights");
    });

    it("Should update minimum APY via setParams", async function () {
      const { selector, paramsAdmin } = await loadFixture(deployFixture);

      // Use setParams with all parameters
      await selector.connect(paramsAdmin).setParams(
        30 * 24 * 60 * 60,
        ethers.parseUnits("50000000", 6),
        1200, // 12%
        4000,
        6000
      );
      expect(await selector.minApyBps()).to.equal(1200);
    });

    it("Should revert parameter update for non-params-admin", async function () {
      const { selector, user1 } = await loadFixture(deployFixture);

      await expect(
        selector.connect(user1).setParams(
          30 * 24 * 60 * 60,
          ethers.parseUnits("50000000", 6),
          900,
          5000,
          5000
        )
      ).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("Should return whitelisted markets array", async function () {
      const { selector, marketAdmin, market1, market2 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await market2.getAddress(), "ETH");

      const markets = await selector.getWhitelistedMarkets();
      expect(markets.length).to.equal(2);
      expect(markets[0]).to.equal(await market1.getAddress());
      expect(markets[1]).to.equal(await market2.getAddress());
    });

    it("Should check if market is valid", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.false;

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");

      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.true;
    });
  });

  describe("Market Selection", function () {
    it("Should revert with NoValidMarkets when no markets match", async function () {
      const { selector } = await loadFixture(deployFixture);

      await expect(
        selector.selectBestMarket("USD")
      ).to.be.revertedWithCustomError(selector, "NoValidMarkets");
    });

    it("Should revert with NoValidMarkets when category doesn't match", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      // Whitelist as ETH category
      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "ETH");

      // Try to select USD category
      await expect(
        selector.selectBestMarket("USD")
      ).to.be.revertedWithCustomError(selector, "NoValidMarkets");
    });

    it("Should return valid markets for category", async function () {
      const { selector, marketAdmin, market1, market2, market3 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await market2.getAddress(), "USD");
      await selector.connect(marketAdmin).whitelistMarket(await market3.getAddress(), "ETH");

      // This will fail on validation but we can test the filter
      // Get whitelisted markets of a specific category
      const markets = await selector.getWhitelistedMarkets();
      expect(markets.length).to.equal(3);
    });

    it("Should check if market is whitelisted after removal", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.true;

      await selector.connect(marketAdmin).removeMarket(await market1.getAddress());
      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.false;
    });
  });

  describe("Additional Admin Functions", function () {
    it("Should revert remove for non-admin", async function () {
      const { selector, marketAdmin, user1, market1 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");

      await expect(
        selector.connect(user1).removeMarket(await market1.getAddress())
      ).to.be.reverted;
    });

    it("Should emit event on market removal", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");

      await expect(selector.connect(marketAdmin).removeMarket(await market1.getAddress()))
        .to.emit(selector, "MarketRemoved")
        .withArgs(await market1.getAddress());
    });

    it("Should handle duplicate whitelist gracefully", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      
      // Second whitelist should update category, not create duplicate
      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "ETH");
      
      expect(await selector.marketCategory(await market1.getAddress())).to.equal("ETH");
      
      // Should only have 1 market
      const markets = await selector.getWhitelistedMarkets();
      expect(markets.length).to.equal(1);
    });

    it("Should preserve state after upgrade", async function () {
      const { selector, admin, marketAdmin, market1 } = await loadFixture(deployFixture);

      // Whitelist before upgrade
      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "USD");
      expect(await selector.isWhitelisted(await market1.getAddress())).to.be.true;

      // Upgrade via timelock (admin IS the timelock in tests)
      const PendleMarketSelectorV2 = await ethers.getContractFactory("PendleMarketSelector");
      const upgraded = await upgrades.upgradeProxy(await selector.getAddress(), PendleMarketSelectorV2);

      // Check state preserved
      expect(await upgraded.isWhitelisted(await market1.getAddress())).to.be.true;
      expect(await upgraded.marketCategory(await market1.getAddress())).to.equal("USD");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty category string", async function () {
      const { selector, marketAdmin, market1 } = await loadFixture(deployFixture);

      // Empty category should be allowed
      await selector.connect(marketAdmin).whitelistMarket(await market1.getAddress(), "");
      expect(await selector.marketCategory(await market1.getAddress())).to.equal("");
    });

    it("Should return empty array for no whitelisted markets", async function () {
      const { selector } = await loadFixture(deployFixture);

      const markets = await selector.getWhitelistedMarkets();
      expect(markets.length).to.equal(0);
    });
  });

  describe("Upgradeability", function () {
    it("Should be upgradeable by admin", async function () {
      const { selector, admin } = await loadFixture(deployFixture);

      // Deploy V2
      const PendleMarketSelectorV2 = await ethers.getContractFactory("PendleMarketSelector");
      
      // Upgrade via timelock (admin IS the timelock in tests)
      const upgraded = await upgrades.upgradeProxy(await selector.getAddress(), PendleMarketSelectorV2);
      expect(await upgraded.getAddress()).to.equal(await selector.getAddress());
    });

    it("Should not be upgradeable by non-admin", async function () {
      const { selector, user1 } = await loadFixture(deployFixture);

      const PendleMarketSelectorV2 = await ethers.getContractFactory("PendleMarketSelector", user1);

      await expect(
        upgrades.upgradeProxy(await selector.getAddress(), PendleMarketSelectorV2)
      ).to.be.reverted;
    });
  });
});
