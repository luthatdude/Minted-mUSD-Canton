/**
 * BLEBridgeV9 Comprehensive Tests
 * Tests attestation processing, supply cap management, rate limiting, and security
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BLEBridgeV9, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("BLEBridgeV9", function () {
  let bridge: BLEBridgeV9;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];

  const MIN_SIGNATURES = 3;
  const COLLATERAL_RATIO = 11000n; // 110%
  const DAILY_CAP_LIMIT = ethers.parseEther("1000000"); // 1M per day
  const INITIAL_SUPPLY_CAP = ethers.parseEther("10000000");

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    emergency = signers[1];
    user = signers[2];
    validators = signers.slice(3, 8); // 5 validators

    // Deploy MUSD
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = (await MUSDFactory.deploy(INITIAL_SUPPLY_CAP, ethers.ZeroAddress)) as MUSD;
    await musd.waitForDeployment();

    // Deploy BLEBridgeV9
    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
    bridge = (await upgrades.deployProxy(BridgeFactory, [
      MIN_SIGNATURES,
      await musd.getAddress(),
      COLLATERAL_RATIO,
      DAILY_CAP_LIMIT,
      deployer.address
    ])) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    // Setup roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();
    const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await musd.grantRole(CAP_MANAGER_ROLE, await bridge.getAddress());
    await bridge.grantRole(EMERGENCY_ROLE, emergency.address);

    for (const v of validators) {
      await bridge.grantRole(VALIDATOR_ROLE, v.address);
    }

    // Grant TIMELOCK_ROLE to deployer for admin function tests
    const TIMELOCK_ROLE = await bridge.TIMELOCK_ROLE();
    await bridge.grantRole(TIMELOCK_ROLE, deployer.address);

    // BRIDGE-M-04: Grant RELAYER_ROLE to deployer for attestation tests
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();
    await bridge.grantRole(RELAYER_ROLE, deployer.address);
  });

  // Helper to create sorted signatures
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

    const sigs: { sig: string; addr: string }[] = [];
    for (const signer of signers) {
      const sig = await signer.signMessage(ethers.getBytes(messageHash));
      sigs.push({ sig, addr: signer.address.toLowerCase() });
    }

    // Sort by address
    sigs.sort((a, b) => (a.addr < b.addr ? -1 : 1));
    return sigs.map((s) => s.sig);
  }

  // Helper to create attestation with entropy and computed ID
  async function createAttestation(nonce: bigint, cantonAssets: bigint, timestamp: bigint) {
    const entropy = ethers.hexlify(ethers.randomBytes(32));
    const cantonStateHash = ethers.hexlify(ethers.randomBytes(32));
    const id = await bridge.computeAttestationId(nonce, cantonAssets, timestamp, entropy, cantonStateHash);
    return { id, cantonAssets, nonce, timestamp, entropy, cantonStateHash };
  }

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await bridge.minSignatures()).to.equal(MIN_SIGNATURES);
      expect(await bridge.collateralRatioBps()).to.equal(COLLATERAL_RATIO);
      expect(await bridge.dailyCapIncreaseLimit()).to.equal(DAILY_CAP_LIMIT);
      expect(await bridge.currentNonce()).to.equal(0);
    });

    it("Should reject initialization with zero minSigs", async function () {
      const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
      await expect(
        upgrades.deployProxy(BridgeFactory, [0, await musd.getAddress(), COLLATERAL_RATIO, DAILY_CAP_LIMIT, deployer.address])
      ).to.be.revertedWithCustomError(BridgeFactory, "MinSigsTooLow");  // Now requires >= 2
    });

    it("Should reject initialization with one minSig", async function () {
      const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
      await expect(
        upgrades.deployProxy(BridgeFactory, [1, await musd.getAddress(), COLLATERAL_RATIO, DAILY_CAP_LIMIT, deployer.address])
      ).to.be.revertedWithCustomError(BridgeFactory, "MinSigsTooLow");  // At least 2 required
    });

    it("Should reject initialization with zero MUSD address", async function () {
      const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
      await expect(
        upgrades.deployProxy(BridgeFactory, [MIN_SIGNATURES, ethers.ZeroAddress, COLLATERAL_RATIO, DAILY_CAP_LIMIT, deployer.address])
      ).to.be.revertedWithCustomError(BridgeFactory, "InvalidMusdAddress");
    });

    it("Should reject initialization with ratio below 100%", async function () {
      const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
      await expect(
        upgrades.deployProxy(BridgeFactory, [MIN_SIGNATURES, await musd.getAddress(), 9999, DAILY_CAP_LIMIT, deployer.address])
      ).to.be.revertedWithCustomError(BridgeFactory, "RatioBelow100Percent");
    });
  });

  describe("Attestation Processing", function () {
    it("Should process valid attestation with sufficient signatures", async function () {
      const cantonAssets = ethers.parseEther("1100000"); // $1.1M assets
      const attestation = await createAttestation(1n, cantonAssets, BigInt(await time.latest()));

      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));

      await expect(bridge.processAttestation(attestation, sigs))
        .to.emit(bridge, "AttestationReceived");

      expect(await bridge.currentNonce()).to.equal(1);
      expect(await bridge.attestedCantonAssets()).to.equal(cantonAssets);

      // Check supply cap: 1.1M / 1.1 = 1M
      const expectedCap = (cantonAssets * 10000n) / COLLATERAL_RATIO;
      expect(await musd.supplyCap()).to.equal(expectedCap);
    });

    it("Should reject attestation with insufficient signatures", async function () {
      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));

      const sigs = await createSortedSignatures(attestation, validators.slice(0, 2)); // Only 2 sigs

      await expect(bridge.processAttestation(attestation, sigs))
        .to.be.revertedWithCustomError(bridge, "InsufficientSignatures");
    });

    it("Should reject attestation with wrong nonce", async function () {
      const attestation = await createAttestation(5n, ethers.parseEther("1000000"), BigInt(await time.latest()));

      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));

      await expect(bridge.processAttestation(attestation, sigs))
        .to.be.revertedWithCustomError(bridge, "InvalidNonce");
    });

    it("Should reject reused attestation ID", async function () {
      const cantonAssets = ethers.parseEther("1000000");
      const attestation1 = await createAttestation(1n, cantonAssets, BigInt(await time.latest()));

      const sigs1 = await createSortedSignatures(attestation1, validators.slice(0, 3));
      await bridge.processAttestation(attestation1, sigs1);

      // Try to reuse same ID
      const attestation2 = await createAttestation(2n, cantonAssets, BigInt(await time.latest()) + 61n);
      attestation2.id = attestation1.id; // Force same ID to trigger ATTESTATION_REUSED

      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));
      await expect(bridge.processAttestation(attestation2, sigs2))
        .to.be.revertedWithCustomError(bridge, "AttestationReused");
    });

    it("Should reject unsorted signatures", async function () {
      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));

      // Get signatures but reverse the order (unsorted)
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      const reversedSigs = [...sigs].reverse();

      await expect(bridge.processAttestation(attestation, reversedSigs))
        .to.be.revertedWithCustomError(bridge, "UnsortedSignatures");
    });

    it("Should reject future timestamp", async function () {
      const futureTime = BigInt(await time.latest()) + 1000n;
      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), futureTime);

      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await expect(bridge.processAttestation(attestation, sigs))
        .to.be.revertedWithCustomError(bridge, "FutureTimestamp");
    });

    it("Should reject stale attestation", async function () {
      // Process first attestation
      const attestation1 = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(attestation1, validators.slice(0, 3));
      await bridge.processAttestation(attestation1, sigs1);

      // Try older timestamp (now requires MIN_ATTESTATION_GAP = 60 seconds)
      const attestation2 = await createAttestation(2n, ethers.parseEther("1000000"), BigInt(await time.latest()) - 10n);

      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));
      // Error changed from STALE_ATTESTATION to ATTESTATION_TOO_CLOSE
      await expect(bridge.processAttestation(attestation2, sigs2))
        .to.be.revertedWithCustomError(bridge, "AttestationTooClose");
    });
  });

  describe("Rate Limiting", function () {
    it("Should enforce daily cap increase limit", async function () {
      // First attestation: $2.2M assets = $2M cap
      const attestation1 = await createAttestation(1n, ethers.parseEther("2200000"), BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(attestation1, validators.slice(0, 3));
      await bridge.processAttestation(attestation1, sigs1);

      const cap1 = await musd.supplyCap();

      // Second attestation: try to increase beyond daily limit
      await time.increase(60); // 1 minute later

      const attestation2 = await createAttestation(2n, ethers.parseEther("5500000"), BigInt(await time.latest()));
      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));

      // Should be rate limited
      await bridge.processAttestation(attestation2, sigs2);
      const cap2 = await musd.supplyCap();

      // Cap increase should be limited to 1M
      expect(cap2 - cap1).to.be.lte(DAILY_CAP_LIMIT);
    });

    it("Should reset rate limit after 24 hours", async function () {
      // First attestation
      const attestation1 = await createAttestation(1n, ethers.parseEther("2200000"), BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(attestation1, validators.slice(0, 3));
      await bridge.processAttestation(attestation1, sigs1);

      // Fast forward 25 hours
      await time.increase(25 * 60 * 60);

      // Should be able to increase again
      const attestation2 = await createAttestation(2n, ethers.parseEther("4400000"), BigInt(await time.latest()));
      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));
      await bridge.processAttestation(attestation2, sigs2);

      // Should have increased by up to daily limit
      expect(await musd.supplyCap()).to.be.gt(ethers.parseEther("2000000"));
    });
  });

  describe("Emergency Functions", function () {
    it("Should allow emergency role to pause", async function () {
      await expect(bridge.connect(emergency).pause())
        .to.emit(bridge, "Paused");

      expect(await bridge.paused()).to.be.true;
    });

    it("Should require admin role to unpause", async function () {
      await bridge.connect(emergency).pause();

      // Emergency role cannot unpause
      await expect(bridge.connect(emergency).requestUnpause())
        .to.be.reverted;

      // Admin can request unpause
      await expect(bridge.connect(deployer).requestUnpause())
        .to.emit(bridge, "UnpauseRequested");
      
      // Cannot execute immediately - need to wait 24 hours
      await expect(bridge.connect(deployer).executeUnpause())
        .to.be.revertedWithCustomError(bridge, "TimelockNotElapsed");
      
      // Fast forward 24 hours
      await time.increase(24 * 60 * 60);
      
      // Now admin can execute unpause
      await expect(bridge.connect(deployer).executeUnpause())
        .to.emit(bridge, "Unpaused");
    });

    it("Should allow emergency cap reduction", async function () {
      // First set a cap via attestation
      const attestation = await createAttestation(1n, ethers.parseEther("1100000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await bridge.processAttestation(attestation, sigs);

      const oldCap = await musd.supplyCap();
      const newCap = oldCap / 2n;

      await expect(bridge.connect(emergency).emergencyReduceCap(newCap, "Security incident"))
        .to.emit(bridge, "EmergencyCapReduction");

      expect(await musd.supplyCap()).to.equal(newCap);
    });

    it("Should reject cap increase via emergency function", async function () {
      const attestation = await createAttestation(1n, ethers.parseEther("1100000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await bridge.processAttestation(attestation, sigs);

      const oldCap = await musd.supplyCap();
      const higherCap = oldCap * 2n;

      await expect(bridge.connect(emergency).emergencyReduceCap(higherCap, "Bad intent"))
        .to.be.revertedWithCustomError(bridge, "NotAReduction");
    });

    it("Should invalidate attestation IDs", async function () {
      // Create attestation to compute its ID
      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));

      // Invalidate the computed ID
      await expect(bridge.connect(emergency).invalidateAttestationId(attestation.id, "Compromised"))
        .to.emit(bridge, "AttestationInvalidated")
        .withArgs(attestation.id, "Compromised");

      // Now this ID cannot be used
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));
      await expect(bridge.processAttestation(attestation, sigs))
        .to.be.revertedWithCustomError(bridge, "AttestationReused");
    });
  });

  describe("Admin Functions", function () {
    it("Should update min signatures", async function () {
      await expect(bridge.setMinSignatures(5))
        .to.emit(bridge, "MinSignaturesUpdated")
        .withArgs(MIN_SIGNATURES, 5);

      expect(await bridge.minSignatures()).to.equal(5);
    });

    it("Should update collateral ratio with cooldown", async function () {
      const oldRatio = await bridge.collateralRatioBps();
      const newRatio = oldRatio + 500n; // 5% increase

      await expect(bridge.setCollateralRatio(newRatio))
        .to.emit(bridge, "CollateralRatioUpdated");

      // Should fail immediately after
      await expect(bridge.setCollateralRatio(newRatio + 500n))
        .to.be.revertedWithCustomError(bridge, "RatioChangeCooldown");

      // After 1 day, should work
      await time.increase(86401);
      await expect(bridge.setCollateralRatio(newRatio + 500n))
        .to.emit(bridge, "CollateralRatioUpdated");
    });

    it("Should reject ratio change > 10%", async function () {
      const oldRatio = await bridge.collateralRatioBps();
      const newRatio = oldRatio + 1500n; // 15% increase

      await expect(bridge.setCollateralRatio(newRatio))
        .to.be.revertedWithCustomError(bridge, "RatioChangeTooLarge");
    });

    it("Should update daily cap increase limit", async function () {
      const newLimit = ethers.parseEther("2000000");

      await expect(bridge.setDailyCapIncreaseLimit(newLimit))
        .to.emit(bridge, "DailyCapIncreaseLimitUpdated");

      expect(await bridge.dailyCapIncreaseLimit()).to.equal(newLimit);
    });
  });

  describe("Paused State", function () {
    it("Should reject attestations when paused", async function () {
      await bridge.connect(emergency).pause();

      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));

      await expect(bridge.processAttestation(attestation, sigs))
        .to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });
  });

  describe("BRIDGE-M-04: Relayer Access Control", function () {
    it("Should reject processAttestation from non-relayer", async function () {
      const attestation = await createAttestation(1n, ethers.parseEther("1000000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));

      // user does not have RELAYER_ROLE
      await expect(bridge.connect(user).processAttestation(attestation, sigs))
        .to.be.reverted;
    });

    it("Should allow processAttestation from granted relayer", async function () {
      const RELAYER_ROLE = await bridge.RELAYER_ROLE();
      await bridge.grantRole(RELAYER_ROLE, user.address);

      const attestation = await createAttestation(1n, ethers.parseEther("1100000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(attestation, validators.slice(0, 3));

      await expect(bridge.connect(user).processAttestation(attestation, sigs))
        .to.emit(bridge, "AttestationReceived");
    });

    it("Should reject processAttestation after relayer role is revoked", async function () {
      const RELAYER_ROLE = await bridge.RELAYER_ROLE();
      await bridge.grantRole(RELAYER_ROLE, user.address);

      // Process one attestation successfully
      const attestation1 = await createAttestation(1n, ethers.parseEther("1100000"), BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(attestation1, validators.slice(0, 3));
      await bridge.connect(user).processAttestation(attestation1, sigs1);

      // Revoke role
      await bridge.revokeRole(RELAYER_ROLE, user.address);

      // Should fail now
      await time.increase(61);
      const attestation2 = await createAttestation(2n, ethers.parseEther("1100000"), BigInt(await time.latest()));
      const sigs2 = await createSortedSignatures(attestation2, validators.slice(0, 3));
      await expect(bridge.connect(user).processAttestation(attestation2, sigs2))
        .to.be.reverted;
    });
  });

  describe("Bridge to Canton (ETH → Canton)", function () {
    const CANTON_RECIPIENT = "minted-user-1::1220abc123";
    const BRIDGE_AMOUNT = ethers.parseEther("1000"); // 1000 mUSD

    beforeEach(async function () {
      // Mint some mUSD to user for bridging
      const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
      await musd.grantRole(BRIDGE_ROLE, deployer.address);
      await musd.mint(user.address, ethers.parseEther("10000"));

      // Set minimum bridge-out amount
      await bridge.setBridgeOutMinAmount(ethers.parseEther("10")); // 10 mUSD min

      // User approves bridge to spend mUSD
      await musd.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);
    });

    it("Should bridge mUSD to Canton successfully", async function () {
      const balanceBefore = await musd.balanceOf(user.address);

      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT))
        .to.emit(bridge, "BridgeToCantonRequested")
        .withArgs(
          // requestId is computed, just check the event is emitted
          (v: any) => typeof v === "string", // requestId
          user.address,
          BRIDGE_AMOUNT,
          1n, // first nonce
          CANTON_RECIPIENT,
          (v: any) => v > 0n // timestamp
        );

      // Verify mUSD was burned
      const balanceAfter = await musd.balanceOf(user.address);
      expect(balanceBefore - balanceAfter).to.equal(BRIDGE_AMOUNT);

      // Verify nonce incremented
      expect(await bridge.bridgeOutNonce()).to.equal(1);
    });

    it("Should increment nonce on each bridge-out", async function () {
      await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT);
      expect(await bridge.bridgeOutNonce()).to.equal(1);

      await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT);
      expect(await bridge.bridgeOutNonce()).to.equal(2);

      await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT);
      expect(await bridge.bridgeOutNonce()).to.equal(3);
    });

    it("Should emit unique requestIds for each bridge-out", async function () {
      const tx1 = await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT);
      const receipt1 = await tx1.wait();
      const event1 = receipt1!.logs.find(
        (l: any) => l.fragment?.name === "BridgeToCantonRequested"
      ) as any;

      const tx2 = await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT);
      const receipt2 = await tx2.wait();
      const event2 = receipt2!.logs.find(
        (l: any) => l.fragment?.name === "BridgeToCantonRequested"
      ) as any;

      expect(event1.args.requestId).to.not.equal(event2.args.requestId);
    });

    it("Should reject zero amount", async function () {
      await expect(bridge.connect(user).bridgeToCanton(0, CANTON_RECIPIENT))
        .to.be.revertedWithCustomError(bridge, "ZeroAmount");
    });

    it("Should reject amount below minimum", async function () {
      await expect(bridge.connect(user).bridgeToCanton(ethers.parseEther("5"), CANTON_RECIPIENT))
        .to.be.revertedWithCustomError(bridge, "BelowMin");
    });

    it("Should reject empty canton recipient", async function () {
      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, ""))
        .to.be.revertedWithCustomError(bridge, "InvalidRecipient");
    });

    it("Should reject canton recipient without :: delimiter", async function () {
      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, "invalidpartyformat"))
        .to.be.revertedWithCustomError(bridge, "InvalidRecipient");
    });

    it("Should accept canton recipient with valid :: delimiter", async function () {
      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, "party::1220fingerprint"))
        .to.emit(bridge, "BridgeToCantonRequested");
    });

    it("Should reject when paused", async function () {
      await bridge.connect(emergency).pause();

      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT))
        .to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("Should reject when user has insufficient balance", async function () {
      const hugeAmount = ethers.parseEther("999999");

      await expect(bridge.connect(user).bridgeToCanton(hugeAmount, CANTON_RECIPIENT))
        .to.be.reverted; // ERC20 insufficient balance
    });

    it("Should reject when user has not approved bridge", async function () {
      // Revoke approval
      await musd.connect(user).approve(await bridge.getAddress(), 0);

      await expect(bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_RECIPIENT))
        .to.be.reverted; // ERC20 insufficient allowance
    });

    it("Should allow admin to update bridge-out minimum", async function () {
      const newMin = ethers.parseEther("100");

      await expect(bridge.setBridgeOutMinAmount(newMin))
        .to.emit(bridge, "BridgeOutMinAmountUpdated")
        .withArgs(ethers.parseEther("10"), newMin);

      expect(await bridge.bridgeOutMinAmount()).to.equal(newMin);

      // Old amount now rejected
      await expect(bridge.connect(user).bridgeToCanton(ethers.parseEther("50"), CANTON_RECIPIENT))
        .to.be.revertedWithCustomError(bridge, "BelowMin");
    });

    it("Should allow zero minimum (no minimum enforcement)", async function () {
      await bridge.setBridgeOutMinAmount(0);

      // Small amount should work (still rejects zero though)
      await expect(bridge.connect(user).bridgeToCanton(1n, CANTON_RECIPIENT))
        .to.emit(bridge, "BridgeToCantonRequested");
    });

    it("Should restrict setBridgeOutMinAmount to admin", async function () {
      await expect(bridge.connect(user).setBridgeOutMinAmount(0))
        .to.be.reverted;
    });
  });
});
