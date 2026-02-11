/**
 * SMUSDPriceAdapter Tests
 * Tests: Chainlink AggregatorV3 compatibility, share price derivation,
 *        bounds checking, admin functions, access control
 *
 * Uses MockSMUSD for deterministic price control — the real SMUSD vault
 * has a decimalsOffset that changes share granularity, so we mock the
 * convertToAssets() return value directly to isolate adapter logic.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { SMUSDPriceAdapter } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("SMUSDPriceAdapter", function () {
  let adapter: SMUSDPriceAdapter;
  let mockSmusd: any;
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  /**
   * Helper: set mock share price in USD (e.g. "1.0" → convertToAssets(1e18) returns 1e18)
   * The adapter divides by 1e10 to get 8-decimal Chainlink format.
   */
  async function setSharePrice(usdPrice: string) {
    await mockSmusd.setAssetsPerShare(ethers.parseEther(usdPrice));
  }

  beforeEach(async function () {
    [deployer, admin, user1] = await ethers.getSigners();

    // Deploy MockSMUSD with 1.0 USD share price
    const MockSMUSDFactory = await ethers.getContractFactory("MockSMUSD");
    mockSmusd = await MockSMUSDFactory.deploy(ethers.parseEther("1.0"));
    await mockSmusd.waitForDeployment();

    // Deploy SMUSDPriceAdapter
    const AdapterFactory = await ethers.getContractFactory("SMUSDPriceAdapter");
    adapter = await AdapterFactory.deploy(
      await mockSmusd.getAddress(),
      admin.address
    );
    await adapter.waitForDeployment();
  });

  // ============================================================
  //  DEPLOYMENT
  // ============================================================

  describe("Deployment", function () {
    it("should set correct smusd address", async function () {
      expect(await adapter.smusd()).to.equal(await mockSmusd.getAddress());
    });

    it("should set initial round ID to 1", async function () {
      const [roundId] = await adapter.latestRoundData();
      expect(roundId).to.equal(1);
    });

    it("should set default price bounds", async function () {
      expect(await adapter.minSharePrice()).to.equal(ethers.parseUnits("0.95", 8));
      expect(await adapter.maxSharePrice()).to.equal(ethers.parseUnits("2.0", 8));
    });

    it("should grant admin roles", async function () {
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      const ADAPTER_ADMIN_ROLE = await adapter.ADAPTER_ADMIN_ROLE();
      expect(await adapter.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await adapter.hasRole(ADAPTER_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should revert with zero address for smusd", async function () {
      const AdapterFactory = await ethers.getContractFactory("SMUSDPriceAdapter");
      await expect(
        AdapterFactory.deploy(ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(adapter, "SMUSDZeroAddress");
    });
  });

  // ============================================================
  //  CHAINLINK AGGREGATOR V3 INTERFACE
  // ============================================================

  describe("AggregatorV3 Interface", function () {
    it("should return 8 decimals", async function () {
      expect(await adapter.decimals()).to.equal(8);
    });

    it("should return correct description", async function () {
      expect(await adapter.description()).to.equal("sMUSD / USD");
    });

    it("should return version 1", async function () {
      expect(await adapter.version()).to.equal(1);
    });
  });

  // ============================================================
  //  SHARE PRICE DERIVATION
  // ============================================================

  describe("Share Price", function () {
    it("should return 1.0 USD for 1:1 share price", async function () {
      const [, answer] = await adapter.latestRoundData();
      // convertToAssets(1e18) = 1e18 → 1e18 / 1e10 = 1e8 = $1.00
      expect(answer).to.equal(ethers.parseUnits("1.0", 8));
    });

    it("should reflect increased share price after yield", async function () {
      await setSharePrice("1.1");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.1", 8));
    });

    it("should handle 1.50 USD share price", async function () {
      await setSharePrice("1.5");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.5", 8));
    });

    it("should return consistent data between latestRoundData and getRoundData", async function () {
      const latest = await adapter.latestRoundData();
      const round = await adapter.getRoundData(1);

      expect(latest.answer).to.equal(round.answer);
      expect(latest.roundId).to.equal(round.roundId);
      expect(latest.answeredInRound).to.equal(round.answeredInRound);
    });

    it("should set timestamps to block.timestamp", async function () {
      const [, , startedAt, updatedAt] = await adapter.latestRoundData();
      const blockTimestamp = BigInt(await time.latest());

      expect(startedAt).to.equal(blockTimestamp);
      expect(updatedAt).to.equal(blockTimestamp);
    });

    it("should set answeredInRound equal to roundId", async function () {
      const [roundId, , , , answeredInRound] = await adapter.latestRoundData();
      expect(answeredInRound).to.equal(roundId);
    });

    it("should update price when vault share price changes", async function () {
      let [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.0", 8));

      await setSharePrice("1.05");
      [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.05", 8));

      await setSharePrice("1.10");
      [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.10", 8));
    });
  });

  // ============================================================
  //  PRICE BOUNDS
  // ============================================================

  describe("Price Bounds", function () {
    it("should clamp when share price is below minimum (0.95 USD)", async function () {
      await setSharePrice("0.90");
      const [, answer] = await adapter.latestRoundData();
      // FIX SPA-M03: price is clamped to minSharePrice instead of reverting
      expect(answer).to.equal(ethers.parseUnits("0.95", 8));
    });

    it("should clamp when share price exceeds maximum (2.0 USD)", async function () {
      await setSharePrice("2.5");
      const [, answer] = await adapter.latestRoundData();
      // FIX SPA-M03: price is clamped to maxSharePrice instead of reverting
      expect(answer).to.equal(ethers.parseUnits("2.0", 8));
    });

    it("should accept price right at minimum bound (0.95 USD)", async function () {
      await setSharePrice("0.95");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("0.95", 8));
    });

    it("should accept price right at maximum bound (2.0 USD)", async function () {
      await setSharePrice("2.0");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("2.0", 8));
    });

    it("should clamp when price is just below minimum", async function () {
      await setSharePrice("0.94");
      const [, answer] = await adapter.latestRoundData();
      // FIX SPA-M03: price is clamped to minSharePrice
      expect(answer).to.equal(ethers.parseUnits("0.95", 8));
    });

    it("should clamp when price is just above maximum", async function () {
      await setSharePrice("2.01");
      const [, answer] = await adapter.latestRoundData();
      // FIX SPA-M03: price is clamped to maxSharePrice
      expect(answer).to.equal(ethers.parseUnits("2.0", 8));
    });

    it("should respect updated bounds", async function () {
      await adapter.connect(admin).setSharePriceBounds(
        ethers.parseUnits("0.50", 8),
        ethers.parseUnits("5.0", 8)
      );

      // 0.60 would fail with default bounds but passes with widened
      await setSharePrice("0.60");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("0.60", 8));
    });

    it("should clamp with tightened bounds", async function () {
      await adapter.connect(admin).setSharePriceBounds(
        ethers.parseUnits("1.05", 8),
        ethers.parseUnits("2.0", 8)
      );

      // 1.0 is below the new 1.05 min — clamps to 1.05
      await setSharePrice("1.0");
      const [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.05", 8));
    });

    it("should clamp on getRoundData when price out of bounds", async function () {
      await setSharePrice("0.50");
      const [, answer] = await adapter.getRoundData(1);
      // FIX SPA-M03: clamps to minSharePrice instead of reverting
      expect(answer).to.equal(ethers.parseUnits("0.95", 8));
    });
  });

  // ============================================================
  //  ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    describe("setSharePriceBounds", function () {
      it("should update price bounds", async function () {
        await adapter.connect(admin).setSharePriceBounds(
          ethers.parseUnits("0.90", 8),
          ethers.parseUnits("3.0", 8)
        );

        expect(await adapter.minSharePrice()).to.equal(ethers.parseUnits("0.90", 8));
        expect(await adapter.maxSharePrice()).to.equal(ethers.parseUnits("3.0", 8));
      });

      it("should emit SharePriceBoundsUpdated event", async function () {
        await expect(
          adapter.connect(admin).setSharePriceBounds(
            ethers.parseUnits("0.80", 8),
            ethers.parseUnits("5.0", 8)
          )
        )
          .to.emit(adapter, "SharePriceBoundsUpdated")
          .withArgs(ethers.parseUnits("0.80", 8), ethers.parseUnits("5.0", 8));
      });

      it("should revert if min is zero", async function () {
        await expect(
          adapter.connect(admin).setSharePriceBounds(0, ethers.parseUnits("2.0", 8))
        ).to.be.revertedWith("MIN_ZERO");
      });

      it("should revert if max <= min", async function () {
        await expect(
          adapter.connect(admin).setSharePriceBounds(
            ethers.parseUnits("2.0", 8),
            ethers.parseUnits("1.0", 8)
          )
        ).to.be.revertedWith("MAX_LTE_MIN");
      });

      it("should revert if max equals min", async function () {
        await expect(
          adapter.connect(admin).setSharePriceBounds(
            ethers.parseUnits("1.0", 8),
            ethers.parseUnits("1.0", 8)
          )
        ).to.be.revertedWith("MAX_LTE_MIN");
      });

      it("should revert if max exceeds $10 cap", async function () {
        await expect(
          adapter.connect(admin).setSharePriceBounds(
            ethers.parseUnits("1.0", 8),
            ethers.parseUnits("11.0", 8)
          )
        ).to.be.revertedWith("MAX_TOO_HIGH");
      });

      it("should accept max at exactly $10 cap", async function () {
        await adapter.connect(admin).setSharePriceBounds(
          ethers.parseUnits("0.50", 8),
          ethers.parseUnits("10.0", 8)
        );
        expect(await adapter.maxSharePrice()).to.equal(ethers.parseUnits("10.0", 8));
      });

      it("should revert when called by non-admin", async function () {
        await expect(
          adapter.connect(user1).setSharePriceBounds(
            ethers.parseUnits("0.90", 8),
            ethers.parseUnits("3.0", 8)
          )
        ).to.be.reverted;
      });
    });

    describe("incrementRound", function () {
      it("should increment roundId", async function () {
        const [roundBefore] = await adapter.latestRoundData();
        await adapter.connect(admin).incrementRound();
        const [roundAfter] = await adapter.latestRoundData();

        expect(roundAfter).to.equal(roundBefore + 1n);
      });

      it("should increment multiple times", async function () {
        await adapter.connect(admin).incrementRound();
        await adapter.connect(admin).incrementRound();
        await adapter.connect(admin).incrementRound();

        const [roundId] = await adapter.latestRoundData();
        expect(roundId).to.equal(4); // started at 1, incremented 3 times
      });

      it("should revert when called by non-admin", async function () {
        await expect(
          adapter.connect(user1).incrementRound()
        ).to.be.reverted;
      });
    });
  });

  // ============================================================
  //  INTEGRATION
  // ============================================================

  describe("Integration", function () {
    it("should track price changes as vault accrues yield over time", async function () {
      let [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.0", 8));

      await setSharePrice("1.05");
      [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.05", 8));

      await setSharePrice("1.10");
      [, answer] = await adapter.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits("1.10", 8));
    });

    it("should work correctly with the PriceOracle feed format", async function () {
      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await adapter.latestRoundData();

      // Chainlink consumer invariants
      expect(roundId).to.be.gt(0);
      expect(answer).to.be.gt(0);
      expect(startedAt).to.be.gt(0);
      expect(updatedAt).to.be.gt(0);
      expect(answeredInRound).to.equal(roundId);
    });

    it("should work with incrementRound and changing prices", async function () {
      let [roundId, answer] = await adapter.latestRoundData();
      expect(roundId).to.equal(1);
      expect(answer).to.equal(ethers.parseUnits("1.0", 8));

      await adapter.connect(admin).incrementRound();
      await setSharePrice("1.15");

      [roundId, answer] = await adapter.latestRoundData();
      expect(roundId).to.equal(2);
      expect(answer).to.equal(ethers.parseUnits("1.15", 8));
    });
  });
});
