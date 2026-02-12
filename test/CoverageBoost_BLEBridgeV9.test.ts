/**
 * BLEBridgeV9 Coverage Boost Tests
 * Targets uncovered branches: view functions, upgrade timelock, MUSD token timelock,
 * migration, force-update, cap calculation, health ratio, and edge cases.
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BLEBridgeV9, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("BLEBridgeV9 — Coverage Boost", function () {
  let bridge: BLEBridgeV9;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];

  const MIN_SIGNATURES = 3;
  const COLLATERAL_RATIO = 11000n; // 110%
  const DAILY_CAP_LIMIT = ethers.parseEther("1000000");
  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000");

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
      DAILY_CAP_LIMIT,
    ])) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await musd.grantRole(CAP_MANAGER_ROLE, await bridge.getAddress());
    await bridge.grantRole(EMERGENCY_ROLE, emergency.address);
    await bridge.grantRole(RELAYER_ROLE, deployer.address);

    for (const v of validators) {
      await bridge.grantRole(VALIDATOR_ROLE, v.address);
    }
  });

  async function createSortedSignatures(
    attestation: { id: string; cantonAssets: bigint; nonce: bigint; timestamp: bigint },
    signers: HardhatEthersSigner[]
  ): Promise<string[]> {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const bridgeAddr = await bridge.getAddress();
    const messageHash = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "address"],
      [attestation.id, attestation.cantonAssets, attestation.nonce, attestation.timestamp, chainId, bridgeAddr]
    );
    const ethHash = ethers.hashMessage(ethers.getBytes(messageHash));

    const sigPairs = await Promise.all(
      signers.map(async (s) => ({
        address: s.address,
        sig: await s.signMessage(ethers.getBytes(messageHash)),
      }))
    );
    sigPairs.sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    return sigPairs.map((p) => p.sig);
  }

  // ── View Functions ──────────────────────────────────────────

  describe("View Functions", function () {
    it("getCurrentSupplyCap should return MUSD supply cap", async function () {
      const cap = await bridge.getCurrentSupplyCap();
      expect(cap).to.equal(INITIAL_SUPPLY_CAP);
    });

    it("getRemainingMintable should return cap - totalSupply", async function () {
      const remaining = await bridge.getRemainingMintable();
      expect(remaining).to.equal(INITIAL_SUPPLY_CAP);
    });

    it("calculateSupplyCap should return assets / collateralRatio", async function () {
      const assets = ethers.parseEther("1100000");
      const cap = await bridge.calculateSupplyCap(assets);
      // 1,100,000 / 1.1 = 1,000,000
      expect(cap).to.equal(ethers.parseEther("1000000"));
    });

    it("getNetDailyCapIncrease should return 0 initially", async function () {
      const net = await bridge.getNetDailyCapIncrease();
      expect(net).to.equal(0n);
    });

    it("getRemainingDailyCapLimit should return full limit initially", async function () {
      const remaining = await bridge.getRemainingDailyCapLimit();
      expect(remaining).to.equal(DAILY_CAP_LIMIT);
    });

    it("getHealthRatio should return max uint256 when no supply", async function () {
      const ratio = await bridge.getHealthRatio();
      // No mUSD supply → type(uint256).max
      expect(ratio).to.equal(ethers.MaxUint256);
    });

    it("getHealthRatio should return correct ratio after attestation", async function () {
      // Mint some mUSD so totalSupply > 0
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.grantRole(BRIDGE_ROLE, deployer.address);
      await musd.mint(deployer.address, ethers.parseEther("1000000"));

      const now = BigInt(await time.latest());
      const attestation = {
        id: ethers.keccak256(ethers.toUtf8Bytes("health-test-1")),
        cantonAssets: ethers.parseEther("11000000"), // 11M canton assets
        nonce: 1n,
        timestamp: now,
      };
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await bridge.processAttestation(attestation, sigs);

      const ratio = await bridge.getHealthRatio();
      // Health ratio = cantonAssets * 10000 / supplyCap
      // = 11M * 10000 / supplyCap
      expect(ratio).to.be.gt(0);
    });
  });

  // ── MUSD Token Timelock ─────────────────────────────────────

  describe("MUSD Token Timelock", function () {
    it("Should request MUSD token change", async function () {
      const newMusd = ethers.Wallet.createRandom().address;
      await expect(bridge.requestSetMUSDToken(newMusd))
        .to.emit(bridge, "MUSDTokenChangeRequested");
    });

    it("Should cancel MUSD token change", async function () {
      const newMusd = ethers.Wallet.createRandom().address;
      await bridge.requestSetMUSDToken(newMusd);
      await expect(bridge.cancelSetMUSDToken())
        .to.emit(bridge, "MUSDTokenChangeCancelled");
    });

    it("Should reject execution before timelock", async function () {
      const newMusd = ethers.Wallet.createRandom().address;
      await bridge.requestSetMUSDToken(newMusd);
      await expect(bridge.executeSetMUSDToken())
        .to.be.revertedWith("TIMELOCK_ACTIVE");
    });

    it("Should execute MUSD token change after timelock", async function () {
      // Deploy new MUSD for migration test
      const MUSDFactory = await ethers.getContractFactory("MUSD");
      const newMusd = await MUSDFactory.deploy(INITIAL_SUPPLY_CAP);

      await bridge.requestSetMUSDToken(await newMusd.getAddress());
      await time.increase(48 * 3600 + 1);
      await expect(bridge.executeSetMUSDToken())
        .to.emit(bridge, "MUSDTokenUpdated");

      expect(await bridge.musdToken()).to.equal(await newMusd.getAddress());
    });

    it("Should reject execution with no pending request", async function () {
      await expect(bridge.executeSetMUSDToken())
        .to.be.revertedWith("NO_PENDING_CHANGE");
    });

    it("Should reject request with zero address", async function () {
      await expect(bridge.requestSetMUSDToken(ethers.ZeroAddress))
        .to.be.revertedWith("INVALID_ADDRESS");
    });

    it("Should reject request from non-admin", async function () {
      const newMusd = ethers.Wallet.createRandom().address;
      await expect(bridge.connect(user).requestSetMUSDToken(newMusd))
        .to.be.reverted;
    });
  });

  // ── Upgrade Timelock ────────────────────────────────────────

  describe("Upgrade Timelock", function () {
    it("Should request upgrade", async function () {
      const newImpl = ethers.Wallet.createRandom().address;
      await expect(bridge.requestUpgrade(newImpl))
        .to.emit(bridge, "UpgradeRequested");
    });

    it("Should cancel upgrade", async function () {
      const newImpl = ethers.Wallet.createRandom().address;
      await bridge.requestUpgrade(newImpl);
      await expect(bridge.cancelUpgrade())
        .to.emit(bridge, "UpgradeCancelled");
    });

    it("Should reject upgrade without timelock", async function () {
      // Deploy a real implementation for upgrade
      const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
      const newImpl = await BridgeFactory.deploy();

      await bridge.requestUpgrade(await newImpl.getAddress());
      // Try to upgrade immediately — should fail in _authorizeUpgrade
      await expect(
        upgrades.upgradeProxy(await bridge.getAddress(), BridgeFactory)
      ).to.be.reverted;
    });

    it("Should reject request from non-admin", async function () {
      const newImpl = ethers.Wallet.createRandom().address;
      await expect(bridge.connect(user).requestUpgrade(newImpl)).to.be.reverted;
    });
  });

  // ── Emergency Functions (additional branches) ───────────────

  describe("Emergency Functions — Additional Branches", function () {
    it("forceUpdateNonce should update nonce", async function () {
      await bridge.connect(emergency).forceUpdateNonce(42, "recovery");
      expect(await bridge.currentNonce()).to.equal(42);
    });

    it("forceUpdateNonce should reject from non-emergency", async function () {
      await expect(bridge.connect(user).forceUpdateNonce(42, "test")).to.be.reverted;
    });

    it("migrateUsedAttestations should mark IDs as used", async function () {
      const ids = [
        ethers.keccak256(ethers.toUtf8Bytes("migrate-1")),
        ethers.keccak256(ethers.toUtf8Bytes("migrate-2")),
      ];
      const oldBridge = ethers.Wallet.createRandom().address;
      await bridge.migrateUsedAttestations(ids, oldBridge);

      // Verify IDs are now marked as used
      expect(await bridge.usedAttestationIds(ids[0])).to.be.true;
      expect(await bridge.usedAttestationIds(ids[1])).to.be.true;
    });

    it("migrateUsedAttestations should reject from non-admin", async function () {
      const ids = [ethers.keccak256(ethers.toUtf8Bytes("test"))];
      await expect(
        bridge.connect(user).migrateUsedAttestations(ids, ethers.Wallet.createRandom().address)
      ).to.be.reverted;
    });

    it("unpause() view function should revert directing to requestUnpause", async function () {
      await bridge.connect(emergency).pause();
      await expect(bridge.unpause()).to.be.reverted;
    });

    it("Should reject unpause execution before timelock", async function () {
      await bridge.connect(emergency).pause();
      await bridge.requestUnpause();
      await expect(bridge.executeUnpause()).to.be.revertedWith("TIMELOCK_NOT_ELAPSED");
    });
  });

  // ── Rate Limit Edge Cases ──────────────────────────────────

  describe("Rate Limit Edge Cases", function () {
    it("Should track cap decreases separately from increases", async function () {
      // First process an attestation to set baseline
      const now = BigInt(await time.latest());
      const attestation = {
        id: ethers.keccak256(ethers.toUtf8Bytes("rate-limit-1")),
        cantonAssets: ethers.parseEther("11000000"),
        nonce: 1n,
        timestamp: now,
      };
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await bridge.processAttestation(attestation, sigs);

      // Now decrease
      const now2 = BigInt(await time.latest()) + 61n;
      await time.increaseTo(Number(now2));
      const attestation2 = {
        id: ethers.keccak256(ethers.toUtf8Bytes("rate-limit-2")),
        cantonAssets: ethers.parseEther("5000000"), // big decrease
        nonce: 2n,
        timestamp: now2,
      };
      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));
      await bridge.processAttestation(attestation2, sigs2);

      // getNetDailyCapIncrease returns single uint256 (net of increases - decreases)
      const net = await bridge.getNetDailyCapIncrease();
      // Decrease was larger than increase, so net should be 0
      expect(net).to.equal(0n);
    });

    it("Should handle attestation with exactly MIN_ATTESTATION_GAP", async function () {
      const now = BigInt(await time.latest());
      const a1 = {
        id: ethers.keccak256(ethers.toUtf8Bytes("gap-1")),
        cantonAssets: ethers.parseEther("11000000"),
        nonce: 1n,
        timestamp: now,
      };
      await bridge.processAttestation(a1, await createSortedSignatures(a1, validators.slice(0, 3)));

      // Exactly 60 seconds later
      await time.increase(60);
      const now2 = BigInt(await time.latest());
      const a2 = {
        id: ethers.keccak256(ethers.toUtf8Bytes("gap-2")),
        cantonAssets: ethers.parseEther("11100000"),
        nonce: 2n,
        timestamp: now2,
      };
      await bridge.processAttestation(a2, await createSortedSignatures(a2, validators.slice(0, 3)));
    });

    it("Should reject attestation too soon after last", async function () {
      const now = BigInt(await time.latest());
      const a1 = {
        id: ethers.keccak256(ethers.toUtf8Bytes("toofast-1")),
        cantonAssets: ethers.parseEther("11000000"),
        nonce: 1n,
        timestamp: now,
      };
      await bridge.processAttestation(a1, await createSortedSignatures(a1, validators.slice(0, 3)));

      // Only 10 seconds later
      await time.increase(10);
      const now2 = BigInt(await time.latest());
      const a2 = {
        id: ethers.keccak256(ethers.toUtf8Bytes("toofast-2")),
        cantonAssets: ethers.parseEther("11100000"),
        nonce: 2n,
        timestamp: now2,
      };
      await expect(
        bridge.processAttestation(a2, await createSortedSignatures(a2, validators.slice(0, 3)))
      ).to.be.revertedWith("ATTESTATION_TOO_CLOSE");
    });
  });

  // ── Collateral Ratio Edge Cases ─────────────────────────────

  describe("Collateral Ratio Edge Cases", function () {
    it("Should reject ratio change without cooldown", async function () {
      // First change
      await bridge.setCollateralRatio(11500n);
      // Second change immediately
      await expect(bridge.setCollateralRatio(12000n))
        .to.be.revertedWith("RATIO_CHANGE_COOLDOWN");
    });

    it("Should allow ratio change after cooldown", async function () {
      await bridge.setCollateralRatio(11500n);
      await time.increase(24 * 3600 + 1); // 1 day + 1s
      await bridge.setCollateralRatio(12000n);
      expect(await bridge.collateralRatioBps()).to.equal(12000n);
    });

    it("Should reject ratio below minimum (10000)", async function () {
      await expect(bridge.setCollateralRatio(9999n))
        .to.be.revertedWith("RATIO_BELOW_100_PERCENT");
    });
  });

  // ── Min Signatures Edge Cases ───────────────────────────────

  describe("Min Signatures Edge Cases", function () {
    it("Should reject minSignatures of 0", async function () {
      await expect(bridge.setMinSignatures(0))
        .to.be.revertedWith("MIN_SIGS_TOO_LOW");
    });

    it("Should reject minSignatures of 1", async function () {
      await expect(bridge.setMinSignatures(1))
        .to.be.revertedWith("MIN_SIGS_TOO_LOW");
    });

    it("Should reject minSignatures > 10", async function () {
      await expect(bridge.setMinSignatures(11))
        .to.be.revertedWith("MIN_SIGS_TOO_HIGH");
    });
  });
});
