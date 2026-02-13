/**
 * BLEBridgeV9 Branch Coverage Boost Tests
 * Targets ONLY untested branches not covered by CoverageBoost_BLEBridgeV9.test.ts
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BLEBridgeV9, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("BLEBridgeV9 — Branch Coverage Boost", function () {
  let bridge: BLEBridgeV9;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];

  const MIN_SIGNATURES = 3;
  const COLLATERAL_RATIO = 11000n; // 110%
  const DAILY_CAP_LIMIT = ethers.parseEther("1000000"); // 1M
  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000"); // 10M

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    emergency = signers[1];
    user = signers[2];
    validators = signers.slice(3, 8);

    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = (await MUSDFactory.deploy(INITIAL_SUPPLY_CAP)) as MUSD;
    await musd.waitForDeployment();

    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
    bridge = (await upgrades.deployProxy(BridgeFactory, [
      MIN_SIGNATURES,
      await musd.getAddress(),
      COLLATERAL_RATIO,
      DAILY_CAP_LIMIT
    ])) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    // Grant roles
    await musd.grantRole(await musd.BRIDGE_ROLE(), await bridge.getAddress());
    await musd.grantRole(await musd.CAP_MANAGER_ROLE(), await bridge.getAddress());
    await musd.grantRole(await musd.BRIDGE_ROLE(), deployer.address);
    await bridge.grantRole(await bridge.EMERGENCY_ROLE(), emergency.address);
    for (const v of validators) {
      await bridge.grantRole(await bridge.VALIDATOR_ROLE(), v.address);
    }

    // Grant TIMELOCK_ROLE to deployer for admin function tests
    await bridge.grantRole(await bridge.TIMELOCK_ROLE(), deployer.address);
  });

  // ── Helpers ──────────────────────────────────────────────────

  async function createSortedSignatures(
    attestation: { id: string; cantonAssets: bigint; nonce: bigint; timestamp: bigint; entropy: string; cantonStateHash: string },
    signers: HardhatEthersSigner[]
  ): Promise<string[]> {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const bridgeAddr = await bridge.getAddress();
    const messageHash = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
      [attestation.id, attestation.cantonAssets, attestation.nonce, attestation.timestamp, attestation.entropy, attestation.cantonStateHash, chainId, bridgeAddr]
    );
    const sigPairs = await Promise.all(
      signers.map(async (s) => ({
        address: s.address,
        sig: await s.signMessage(ethers.getBytes(messageHash)),
      }))
    );
    sigPairs.sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    return sigPairs.map((p) => p.sig);
  }

  // Helper to create attestation with entropy and computed ID
  async function createAttestation(nonce: bigint, cantonAssets: bigint, timestamp: bigint) {
    const entropy = ethers.hexlify(ethers.randomBytes(32));
    const cantonStateHash = ethers.hexlify(ethers.randomBytes(32));
    const id = await bridge.computeAttestationId(nonce, cantonAssets, timestamp, entropy, cantonStateHash);
    return { id, cantonAssets, nonce, timestamp, entropy, cantonStateHash };
  }

  async function submitAttestation(cantonAssets: bigint, nonce: bigint, _idSuffix: string) {
    const now = BigInt(await time.latest());
    const att = await createAttestation(nonce, cantonAssets, now);
    const sigs = await createSortedSignatures(att, validators.slice(0, 3));
    await bridge.processAttestation(att, sigs);
    return att;
  }

  // ── 1. Initialization: dailyCapIncreaseLimit == 0 ───────────

  describe("Initialization", function () {
    it("should revert INVALID_DAILY_LIMIT when _dailyCapIncreaseLimit is 0", async function () {
      const F = await ethers.getContractFactory("BLEBridgeV9");
      await expect(
        upgrades.deployProxy(F, [MIN_SIGNATURES, await musd.getAddress(), COLLATERAL_RATIO, 0])
      ).to.be.revertedWith("INVALID_DAILY_LIMIT");
    });
  });

  // requestSetMUSDToken tests removed — setMUSDToken is now a direct onlyTimelock call.

  // ── 3 & 4. emergencyReduceCap branches ──────────────────────

  describe("emergencyReduceCap", function () {
    it("should revert SUB_SUPPLY_CAP_REQUIRES_ADMIN when cap < totalSupply from non-admin", async function () {
      // Mint mUSD so totalSupply = 5M
      await musd.mint(deployer.address, ethers.parseEther("5000000"));
      // emergency role (not admin) tries to reduce cap below totalSupply
      await expect(
        bridge.connect(emergency).emergencyReduceCap(ethers.parseEther("1000000"), "sub-supply test")
      ).to.be.revertedWith("CAP_BELOW_SUPPLY");
    });

    it("should revert REASON_REQUIRED when reason is empty", async function () {
      await expect(
        bridge.connect(emergency).emergencyReduceCap(ethers.parseEther("5000000"), "")
      ).to.be.revertedWith("REASON_REQUIRED");
    });
  });

  // ── 5. setDailyCapIncreaseLimit: INVALID_LIMIT ──────────────

  describe("setDailyCapIncreaseLimit", function () {
    it("should revert INVALID_LIMIT when _limit is 0", async function () {
      await expect(bridge.setDailyCapIncreaseLimit(0)).to.be.revertedWith("INVALID_LIMIT");
    });
  });

  // ── 6. migrateUsedAttestations: INVALID_PREVIOUS_BRIDGE ─────

  describe("migrateUsedAttestations — zero previous bridge", function () {
    it("should revert INVALID_PREVIOUS_BRIDGE when previousBridge is zero", async function () {
      const ids = [ethers.keccak256(ethers.toUtf8Bytes("migrate-zero"))];
      await expect(bridge.migrateUsedAttestations(ids, ethers.ZeroAddress))
        .to.be.revertedWith("INVALID_PREVIOUS_BRIDGE");
    });
  });

  // ── 7. setCollateralRatio with attestedCantonAssets > 0 ─────

  describe("setCollateralRatio — triggers _updateSupplyCap", function () {
    it("should update supply cap when attestedCantonAssets > 0", async function () {
      // Attestation with 11M assets → cap = 10M (matches initial)
      await submitAttestation(ethers.parseEther("11000000"), 1n, "ratio-att");

      expect(await bridge.attestedCantonAssets()).to.equal(ethers.parseEther("11000000"));

      // Increase ratio to 115% → cap = 11M * 10000 / 11500 ≈ 9.565M (decrease, bypasses rate limit)
      await bridge.setCollateralRatio(11500n);
      const newCap = await bridge.getCurrentSupplyCap();
      expect(newCap).to.be.lt(ethers.parseEther("10000000"));
    });
  });

  // ── 8. pause() cancels pending unpause ──────────────────────

  describe("pause — cancels pending unpause", function () {
    it("should cancel pending unpause and emit UnpauseCancelled", async function () {
      // _pause() has whenNotPaused, so unpauseRequestTime>0 while unpaused is
      // only reachable via storage anomaly. Use hardhat_setStorageAt (slot 12).
      const bridgeAddr = await bridge.getAddress();
      const value = ethers.zeroPadValue(ethers.toBeHex(1000), 32);
      await ethers.provider.send("hardhat_setStorageAt", [bridgeAddr, "0xb", value]);
      expect(await bridge.unpauseRequestTime()).to.equal(1000);

      // Now pause() should hit the if (unpauseRequestTime > 0) branch
      await expect(bridge.connect(emergency).pause()).to.emit(bridge, "UnpauseCancelled");
      expect(await bridge.unpauseRequestTime()).to.equal(0);
    });
  });

  // ── 9. requestUnpause when not paused ───────────────────────

  describe("requestUnpause — not paused", function () {
    it("should revert NOT_PAUSED when bridge is not paused", async function () {
      await expect(bridge.requestUnpause()).to.be.revertedWith("NOT_PAUSED");
    });
  });

  // ── 10. executeUnpause with no request ──────────────────────

  describe("executeUnpause — no pending request", function () {
    it("should revert NO_UNPAUSE_REQUEST when no unpause was requested", async function () {
      await bridge.connect(emergency).pause();
      await expect(bridge.executeUnpause()).to.be.revertedWith("NO_UNPAUSE_REQUEST");
    });
  });

  // ── 11. processAttestation: ZERO_ASSETS ─────────────────────

  describe("processAttestation — zero assets", function () {
    it("should revert ZERO_ASSETS when cantonAssets is 0", async function () {
      const now = BigInt(await time.latest());
      const att = await createAttestation(1n, 0n, now);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await expect(bridge.processAttestation(att, sigs)).to.be.revertedWith("ZERO_ASSETS");
    });
  });

  // ── 12. processAttestation: non-RELAYER caller ──────────────

  describe("processAttestation — any caller", function () {
    it("should allow any caller to process attestation (no RELAYER_ROLE required)", async function () {
      const now = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), now);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await expect(bridge.connect(user).processAttestation(att, sigs)).to.emit(bridge, "AttestationReceived");
    });
  });

  // ── 13 & 14. invalidateAttestationId branches ──────────────

  describe("invalidateAttestationId", function () {
    it("should revert ALREADY_USED when attestation ID was already marked", async function () {
      const id = ethers.keccak256(ethers.toUtf8Bytes("inv-dup"));
      await bridge.connect(emergency).invalidateAttestationId(id, "first");
      await expect(bridge.connect(emergency).invalidateAttestationId(id, "second"))
        .to.be.revertedWith("ALREADY_USED");
    });

    it("should revert REASON_REQUIRED when reason is empty", async function () {
      const id = ethers.keccak256(ethers.toUtf8Bytes("inv-empty"));
      await expect(bridge.connect(emergency).invalidateAttestationId(id, ""))
        .to.be.revertedWith("REASON_REQUIRED");
    });
  });

  // ── 15. _updateSupplyCap no-op (cap unchanged) ─────────────

  describe("_updateSupplyCap — no-op path", function () {
    it("should not emit SupplyCapUpdated when calculated cap == current cap", async function () {
      // 11M assets at 110% → cap = 10M (matches initial MUSD cap)
      const now = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), now);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      const tx = await bridge.processAttestation(att, sigs);
      await expect(tx).to.not.emit(bridge, "SupplyCapUpdated");
    });
  });

  // ── 16. Cap decrease from attestation ───────────────────────

  describe("_updateSupplyCap — cap decrease", function () {
    it("should decrease cap and track in dailyCapDecreased", async function () {
      // First: increase cap within daily limit (11.55M assets → 10.5M cap, +0.5M)
      await submitAttestation(ethers.parseEther("11550000"), 1n, "dec-1");
      const capAfterFirst = await bridge.getCurrentSupplyCap();
      expect(capAfterFirst).to.equal(ethers.parseEther("10500000"));

      // Second: lower assets (11M → 10M cap, decrease of 0.5M)
      await time.increase(61);
      await submitAttestation(ethers.parseEther("11000000"), 2n, "dec-2");
      const capAfterSecond = await bridge.getCurrentSupplyCap();
      expect(capAfterSecond).to.equal(ethers.parseEther("10000000"));
      expect(await bridge.dailyCapDecreased()).to.equal(ethers.parseEther("500000"));
    });
  });

  // ── 17. DAILY_CAP_LIMIT_EXHAUSTED ──────────────────────────

  describe("_handleRateLimitCapIncrease — exhausted", function () {
    it("should revert DAILY_CAP_LIMIT_EXHAUSTED after limit is fully used", async function () {
      // First attestation: 12.1M assets → 11M cap (increase of 1M = full daily limit)
      await submitAttestation(ethers.parseEther("12100000"), 1n, "exh-1");
      expect(await bridge.getRemainingDailyCapLimit()).to.equal(0n);

      // Second attestation: try to increase further → exhausted
      await time.increase(61);
      const now2 = BigInt(await time.latest());
      const att2 = await createAttestation(2n, ethers.parseEther("13200000"), now2);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));
      await expect(bridge.processAttestation(att2, sigs2))
        .to.be.revertedWith("DAILY_CAP_LIMIT_EXHAUSTED");
    });
  });

  // requestUpgrade tests removed — _authorizeUpgrade now uses onlyTimelock.

  // ── 21. getHealthRatio: supply > 0, attestedCantonAssets == 0 ─

  describe("getHealthRatio — supply > 0, no attestation", function () {
    it("should return 0 when totalSupply > 0 but attestedCantonAssets == 0", async function () {
      await musd.mint(deployer.address, ethers.parseEther("1000000"));
      const ratio = await bridge.getHealthRatio();
      expect(ratio).to.equal(0n);
    });
  });

  // ── 22 & 23. View functions — window expired branches ───────

  describe("View functions — window-expired branches", function () {
    it("getNetDailyCapIncrease returns 0 after 24h window expires", async function () {
      // Use some of the daily limit
      await submitAttestation(ethers.parseEther("12100000"), 1n, "win-net");
      expect(await bridge.getNetDailyCapIncrease()).to.be.gt(0n);

      // Advance past 24h window
      await time.increase(24 * 3600 + 1);
      expect(await bridge.getNetDailyCapIncrease()).to.equal(0n);
    });

    it("getRemainingDailyCapLimit returns full limit after 24h window expires", async function () {
      await submitAttestation(ethers.parseEther("12100000"), 1n, "win-rem");
      expect(await bridge.getRemainingDailyCapLimit()).to.equal(0n); // fully used

      await time.increase(24 * 3600 + 1);
      expect(await bridge.getRemainingDailyCapLimit()).to.equal(DAILY_CAP_LIMIT);
    });

    it("getRemainingDailyCapLimit returns 0 when limit is fully exhausted within window", async function () {
      // Exhaust the 1M daily limit
      await submitAttestation(ethers.parseEther("12100000"), 1n, "win-exh");
      expect(await bridge.getRemainingDailyCapLimit()).to.equal(0n);
    });
  });
});
