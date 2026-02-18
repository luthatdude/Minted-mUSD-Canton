/**
 * Bridge Nonce Sync Tests — Gap 3
 *
 * Verifies that DAML BridgeService nonce semantics stay in sync with Solidity
 * BLEBridgeV9's nonce counters across both bridge directions.
 *
 * Architecture:
 *   Solidity has TWO independent nonce counters:
 *     - currentNonce    (inbound: Canton→ETH attestation nonce, strict +1)
 *     - bridgeOutNonce  (outbound: ETH→Canton bridge-out nonce, independent)
 *
 *   DAML BridgeService has ONE nonce counter:
 *     - lastNonce (used by both Bridge_AssignNonce and Bridge_ReceiveFromEthereum)
 *
 *   Desync risk: If DAML's single counter interleaves assign (bridge-out) and
 *   receive (bridge-in) operations, the next attestation nonce won't match
 *   Solidity's currentNonce + 1, bricking the bridge.
 *
 * These tests simulate the full cross-chain nonce lifecycle on the Solidity side
 * and model the DAML nonce progression to verify correctness.
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BLEBridgeV9, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Bridge Nonce Sync (Canton ↔ Solidity)", function () {
  let bridge: BLEBridgeV9;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];

  const MIN_SIGNATURES = 3;
  const COLLATERAL_RATIO = 11000n; // 110%
  const DAILY_CAP_LIMIT = ethers.parseEther("10000000"); // 10M per day
  const INITIAL_SUPPLY_CAP = ethers.parseEther("100000000");

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
      deployer.address,
    ])) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    // Setup roles
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();
    const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
    const TIMELOCK_ROLE = await bridge.TIMELOCK_ROLE();
    const RELAYER_ROLE = await bridge.RELAYER_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await musd.grantRole(CAP_MANAGER_ROLE, await bridge.getAddress());
    await musd.grantRole(BRIDGE_ROLE, deployer.address);
    await bridge.grantRole(EMERGENCY_ROLE, emergency.address);
    await bridge.grantRole(TIMELOCK_ROLE, deployer.address);
    await bridge.grantRole(RELAYER_ROLE, deployer.address);

    for (const v of validators) {
      await bridge.grantRole(VALIDATOR_ROLE, v.address);
    }

    // Mint mUSD to user for bridge-out tests
    await musd.mint(user.address, ethers.parseEther("10000000"));
    await musd.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);
    await bridge.setBridgeOutMinAmount(ethers.parseEther("1")); // 1 mUSD min
  });

  // ── Helpers ────────────────────────────────────────────────────────

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
    sigs.sort((a, b) => (a.addr < b.addr ? -1 : 1));
    return sigs.map((s) => s.sig);
  }

  async function createAttestation(nonce: bigint, cantonAssets: bigint, timestamp: bigint) {
    const entropy = ethers.hexlify(ethers.randomBytes(32));
    const cantonStateHash = ethers.hexlify(ethers.randomBytes(32));
    const id = await bridge.computeAttestationId(nonce, cantonAssets, timestamp, entropy, cantonStateHash);
    return { id, cantonAssets, nonce, timestamp, entropy, cantonStateHash };
  }

  /** Process N sequential inbound attestations (Canton→ETH) */
  async function processNAttestations(count: number, startNonce: number, assetsPerAttestation: bigint) {
    for (let i = 0; i < count; i++) {
      await time.increase(61); // MIN_ATTESTATION_GAP
      const nonce = BigInt(startNonce + i);
      const ts = BigInt(await time.latest());
      const att = await createAttestation(nonce, assetsPerAttestation, ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);
    }
  }

  /**
   * Model DAML BridgeService nonce progression.
   *
   * DAML uses a SINGLE lastNonce for both Bridge_AssignNonce (bridge-out)
   * and Bridge_ReceiveFromEthereum (bridge-in). This class simulates the
   * DAML side to verify sync with Solidity's two independent counters.
   */
  class DAMLBridgeServiceModel {
    lastNonce: number;

    constructor(initialNonce: number = 0) {
      this.lastNonce = initialNonce;
    }

    /** Simulates Bridge_AssignNonce choice (outbound: Canton→ETH bridge-out request) */
    assignNonce(): number {
      const newNonce = this.lastNonce + 1;
      this.lastNonce = newNonce;
      return newNonce;
    }

    /** Simulates Bridge_ReceiveFromEthereum nonce check (inbound: ETH→Canton) */
    receiveFromEthereum(attestationNonce: number): void {
      if (attestationNonce !== this.lastNonce + 1) {
        throw new Error(
          `DAML NONCE_NOT_SEQUENTIAL: expected ${this.lastNonce + 1}, got ${attestationNonce}`
        );
      }
      this.lastNonce = attestationNonce;
    }
  }

  // ── Tests ──────────────────────────────────────────────────────────

  describe("Initialization", function () {
    it("Both Solidity nonce counters start at 0", async function () {
      expect(await bridge.currentNonce()).to.equal(0);
      expect(await bridge.bridgeOutNonce()).to.equal(0);
    });

    it("DAML model starts at 0 matching Solidity", function () {
      const daml = new DAMLBridgeServiceModel(0);
      expect(daml.lastNonce).to.equal(0);
    });
  });

  describe("Inbound attestation nonce (Canton→ETH)", function () {
    it("Sequential attestations increment currentNonce 1-by-1", async function () {
      const assets = ethers.parseEther("1100000");
      const daml = new DAMLBridgeServiceModel(0);

      for (let i = 1; i <= 5; i++) {
        await time.increase(61);
        const ts = BigInt(await time.latest());
        const att = await createAttestation(BigInt(i), assets, ts);
        const sigs = await createSortedSignatures(att, validators.slice(0, 3));
        await bridge.processAttestation(att, sigs);

        // Solidity side
        expect(await bridge.currentNonce()).to.equal(i);

        // DAML model: Bridge_ReceiveFromEthereum also does lastNonce + 1
        daml.receiveFromEthereum(i);
        expect(daml.lastNonce).to.equal(i);
      }
    });

    it("Rejects nonce gap (skipping nonce 2)", async function () {
      const assets = ethers.parseEther("1100000");

      // Process nonce 1
      await time.increase(61);
      const att1 = await createAttestation(1n, assets, BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(att1, validators.slice(0, 3));
      await bridge.processAttestation(att1, sigs1);

      // Try nonce 3 (skipping 2)
      await time.increase(61);
      const att3 = await createAttestation(3n, assets, BigInt(await time.latest()));
      const sigs3 = await createSortedSignatures(att3, validators.slice(0, 3));

      await expect(bridge.processAttestation(att3, sigs3))
        .to.be.revertedWithCustomError(bridge, "InvalidNonce");
    });

    it("Rejects nonce replay (re-submitting nonce 1)", async function () {
      const assets = ethers.parseEther("1100000");

      await time.increase(61);
      const att1 = await createAttestation(1n, assets, BigInt(await time.latest()));
      const sigs1 = await createSortedSignatures(att1, validators.slice(0, 3));
      await bridge.processAttestation(att1, sigs1);

      // Re-submit nonce 1 with different data
      await time.increase(61);
      const att1b = await createAttestation(1n, assets * 2n, BigInt(await time.latest()));
      const sigs1b = await createSortedSignatures(att1b, validators.slice(0, 3));

      await expect(bridge.processAttestation(att1b, sigs1b))
        .to.be.revertedWithCustomError(bridge, "InvalidNonce");
    });

    it("Rejects nonce 0 (must start at 1)", async function () {
      const assets = ethers.parseEther("1100000");
      const att = await createAttestation(0n, assets, BigInt(await time.latest()));
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));

      await expect(bridge.processAttestation(att, sigs))
        .to.be.revertedWithCustomError(bridge, "InvalidNonce");
    });
  });

  describe("Outbound bridge-out nonce (ETH→Canton)", function () {
    it("bridgeOutNonce increments independently of currentNonce", async function () {
      const cantonRecipient = "minted-user-1::1220abc123";
      const amount = ethers.parseEther("100");

      // Process an inbound attestation first (currentNonce → 1)
      await time.increase(61);
      const att = await createAttestation(1n, ethers.parseEther("11000000"), BigInt(await time.latest()));
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);

      expect(await bridge.currentNonce()).to.equal(1);
      expect(await bridge.bridgeOutNonce()).to.equal(0);

      // Bridge out (bridgeOutNonce → 1, 2, 3)
      await bridge.connect(user).bridgeToCanton(amount, cantonRecipient);
      expect(await bridge.bridgeOutNonce()).to.equal(1);
      expect(await bridge.currentNonce()).to.equal(1); // unchanged

      await bridge.connect(user).bridgeToCanton(amount, cantonRecipient);
      expect(await bridge.bridgeOutNonce()).to.equal(2);
      expect(await bridge.currentNonce()).to.equal(1); // still unchanged

      await bridge.connect(user).bridgeToCanton(amount, cantonRecipient);
      expect(await bridge.bridgeOutNonce()).to.equal(3);
      expect(await bridge.currentNonce()).to.equal(1); // still unchanged
    });
  });

  describe("Cross-direction nonce independence", function () {
    it("Interleaved bridge-in/out maintains both counters correctly", async function () {
      const cantonRecipient = "minted-validator-1::1220abc123";
      const bridgeAmount = ethers.parseEther("100");
      const attestAssets = ethers.parseEther("11000000");

      // Attestation 1 (inbound): currentNonce 0→1
      await time.increase(61);
      const att1 = await createAttestation(1n, attestAssets, BigInt(await time.latest()));
      await bridge.processAttestation(att1, await createSortedSignatures(att1, validators.slice(0, 3)));

      expect(await bridge.currentNonce()).to.equal(1);
      expect(await bridge.bridgeOutNonce()).to.equal(0);

      // Bridge-out 1: bridgeOutNonce 0→1
      await bridge.connect(user).bridgeToCanton(bridgeAmount, cantonRecipient);
      expect(await bridge.currentNonce()).to.equal(1);
      expect(await bridge.bridgeOutNonce()).to.equal(1);

      // Bridge-out 2: bridgeOutNonce 1→2
      await bridge.connect(user).bridgeToCanton(bridgeAmount, cantonRecipient);
      expect(await bridge.currentNonce()).to.equal(1);
      expect(await bridge.bridgeOutNonce()).to.equal(2);

      // Attestation 2 (inbound): currentNonce 1→2
      await time.increase(61);
      const att2 = await createAttestation(2n, attestAssets, BigInt(await time.latest()));
      await bridge.processAttestation(att2, await createSortedSignatures(att2, validators.slice(0, 3)));

      expect(await bridge.currentNonce()).to.equal(2);
      expect(await bridge.bridgeOutNonce()).to.equal(2); // unchanged

      // Bridge-out 3: bridgeOutNonce 2→3
      await bridge.connect(user).bridgeToCanton(bridgeAmount, cantonRecipient);
      expect(await bridge.currentNonce()).to.equal(2); // unchanged
      expect(await bridge.bridgeOutNonce()).to.equal(3);

      // Attestation 3 (inbound): currentNonce 2→3
      await time.increase(61);
      const att3 = await createAttestation(3n, attestAssets, BigInt(await time.latest()));
      await bridge.processAttestation(att3, await createSortedSignatures(att3, validators.slice(0, 3)));

      expect(await bridge.currentNonce()).to.equal(3);
      expect(await bridge.bridgeOutNonce()).to.equal(3);
    });
  });

  describe("DAML BridgeService single-counter desync risk", function () {
    /**
     * CRITICAL TEST: This models the exact desync scenario.
     *
     * DAML BridgeService has ONE lastNonce counter. Both Bridge_AssignNonce
     * (for outbound) and Bridge_ReceiveFromEthereum (for inbound) use it.
     *
     * Scenario:
     *   1. BridgeService.lastNonce = 0
     *   2. User bridges OUT (Canton→ETH): Bridge_AssignNonce → lastNonce = 1
     *   3. Relay tries to process inbound attestation with nonce=1 on DAML:
     *      Bridge_ReceiveFromEthereum checks nonce == lastNonce+1 == 2 → FAILS!
     *      The attestation has nonce=1, but DAML expects nonce=2.
     *
     * This means the Solidity side (currentNonce=0, expects nonce=1) and the
     * DAML side (lastNonce=1, expects nonce=2) are desynced after a single
     * bridge-out operation.
     *
     * MITIGATION: The relay must sequence operations or DAML must use separate
     * nonce counters for each direction (matching Solidity's architecture).
     */
    it("Models DAML single-counter desync: bridge-out then bridge-in", function () {
      const daml = new DAMLBridgeServiceModel(0);

      // Step 1: User does bridge-out from Canton→ETH
      // DAML Bridge_AssignNonce: lastNonce = 0 → 1
      const outboundNonce = daml.assignNonce();
      expect(outboundNonce).to.equal(1);
      expect(daml.lastNonce).to.equal(1);

      // Step 2: Relay processes inbound attestation (ETH→Canton) with nonce=1
      // Solidity currentNonce was 0, so nonce=1 is correct for Solidity.
      // But DAML now expects nonce=2 (lastNonce+1).
      //
      // This WILL throw, demonstrating the desync.
      expect(() => daml.receiveFromEthereum(1)).to.throw("NONCE_NOT_SEQUENTIAL");
    });

    it("Models DAML single-counter desync: multiple bridge-outs before bridge-in", function () {
      const daml = new DAMLBridgeServiceModel(0);

      // Three bridge-outs from Canton→ETH
      daml.assignNonce(); // lastNonce = 1
      daml.assignNonce(); // lastNonce = 2
      daml.assignNonce(); // lastNonce = 3

      // Now relay processes first inbound attestation (nonce=1 per Solidity)
      // DAML expects nonce=4 → DESYNC
      expect(() => daml.receiveFromEthereum(1)).to.throw("NONCE_NOT_SEQUENTIAL");
    });

    it("Models correct behavior: pure bridge-in sequence (no desync)", function () {
      const daml = new DAMLBridgeServiceModel(0);

      // No bridge-outs, just sequential bridge-ins
      daml.receiveFromEthereum(1); // lastNonce: 0 → 1
      expect(daml.lastNonce).to.equal(1);

      daml.receiveFromEthereum(2); // lastNonce: 1 → 2
      expect(daml.lastNonce).to.equal(2);

      daml.receiveFromEthereum(3); // lastNonce: 2 → 3
      expect(daml.lastNonce).to.equal(3);
    });

    it("Models correct behavior: pure bridge-out sequence (no desync)", function () {
      const daml = new DAMLBridgeServiceModel(0);

      expect(daml.assignNonce()).to.equal(1);
      expect(daml.assignNonce()).to.equal(2);
      expect(daml.assignNonce()).to.equal(3);
      expect(daml.lastNonce).to.equal(3);
    });

    /**
     * This models what the DAML architecture SHOULD look like:
     * separate nonce counters per direction, matching Solidity.
     */
    it("Models fixed architecture: separate directional nonce counters", function () {
      // Proposed fix: DAML should track lastInboundNonce and lastOutboundNonce separately
      let lastInboundNonce = 0;  // Maps to Solidity currentNonce
      let lastOutboundNonce = 0; // Maps to Solidity bridgeOutNonce

      // Bridge-out from Canton: increments outbound counter only
      lastOutboundNonce++;
      expect(lastOutboundNonce).to.equal(1);

      // Bridge-out again
      lastOutboundNonce++;
      expect(lastOutboundNonce).to.equal(2);

      // Inbound attestation (nonce=1): increments inbound counter only
      expect(1).to.equal(lastInboundNonce + 1); // Sequential check passes
      lastInboundNonce = 1;

      // Another bridge-out
      lastOutboundNonce++;
      expect(lastOutboundNonce).to.equal(3);

      // Inbound attestation (nonce=2): still works
      expect(2).to.equal(lastInboundNonce + 1); // Sequential check passes
      lastInboundNonce = 2;

      // Counters are independent — matches Solidity
      expect(lastInboundNonce).to.equal(2);
      expect(lastOutboundNonce).to.equal(3);
    });
  });

  describe("forceUpdateNonce emergency recovery", function () {
    it("Can recover from stuck nonce via emergency function", async function () {
      const assets = ethers.parseEther("1100000");

      // Process nonce 1
      await time.increase(61);
      const att1 = await createAttestation(1n, assets, BigInt(await time.latest()));
      await bridge.processAttestation(att1, await createSortedSignatures(att1, validators.slice(0, 3)));

      expect(await bridge.currentNonce()).to.equal(1);

      // Nonce 2 is "lost" (stuck attestation on Canton side)
      // Force jump to nonce 3
      await bridge.connect(emergency).forceUpdateNonce(3, "Nonce 2 stuck on Canton");
      expect(await bridge.currentNonce()).to.equal(3);

      // Now can process nonce 4
      await time.increase(61);
      const att4 = await createAttestation(4n, assets, BigInt(await time.latest()));
      await bridge.processAttestation(att4, await createSortedSignatures(att4, validators.slice(0, 3)));

      expect(await bridge.currentNonce()).to.equal(4);
    });

    it("forceUpdateNonce must be strictly increasing", async function () {
      expect(await bridge.currentNonce()).to.equal(0);

      await bridge.connect(emergency).forceUpdateNonce(5, "Jump ahead");
      expect(await bridge.currentNonce()).to.equal(5);

      // Cannot go backwards
      await expect(
        bridge.connect(emergency).forceUpdateNonce(3, "Go back")
      ).to.be.revertedWithCustomError(bridge, "NonceMustIncrease");

      // Cannot stay same
      await expect(
        bridge.connect(emergency).forceUpdateNonce(5, "Same nonce")
      ).to.be.revertedWithCustomError(bridge, "NonceMustIncrease");
    });

    it("forceUpdateNonce doesn't affect bridgeOutNonce", async function () {
      const cantonRecipient = "minted-user-1::1220abc123";

      // Do some bridge-outs first
      await bridge.connect(user).bridgeToCanton(ethers.parseEther("100"), cantonRecipient);
      await bridge.connect(user).bridgeToCanton(ethers.parseEther("100"), cantonRecipient);
      expect(await bridge.bridgeOutNonce()).to.equal(2);

      // Force update currentNonce
      await bridge.connect(emergency).forceUpdateNonce(10, "Resync");
      expect(await bridge.currentNonce()).to.equal(10);

      // bridgeOutNonce is unaffected
      expect(await bridge.bridgeOutNonce()).to.equal(2);

      // Bridge-out still increments from 2
      await bridge.connect(user).bridgeToCanton(ethers.parseEther("100"), cantonRecipient);
      expect(await bridge.bridgeOutNonce()).to.equal(3);
    });

    it("forceUpdateNonce requires EMERGENCY_ROLE", async function () {
      await expect(
        bridge.connect(user).forceUpdateNonce(1, "Unauthorized")
      ).to.be.reverted;
    });

    it("forceUpdateNonce requires reason", async function () {
      await expect(
        bridge.connect(emergency).forceUpdateNonce(1, "")
      ).to.be.revertedWithCustomError(bridge, "ReasonRequired");
    });
  });

  describe("High-volume nonce stress", function () {
    it("20 sequential attestations maintain strict monotonicity", async function () {
      const assets = ethers.parseEther("11000000");
      await processNAttestations(20, 1, assets);
      expect(await bridge.currentNonce()).to.equal(20);
    });

    it("Interleaved bridge-in/out over 30 operations", async function () {
      const cantonRecipient = "minted-validator-1::1220abc123";
      const assets = ethers.parseEther("11000000");

      let expectedCurrentNonce = 0;
      let expectedBridgeOutNonce = 0;

      for (let round = 0; round < 10; round++) {
        // Attestation (bridge-in)
        expectedCurrentNonce++;
        await time.increase(61);
        const att = await createAttestation(
          BigInt(expectedCurrentNonce),
          assets,
          BigInt(await time.latest())
        );
        await bridge.processAttestation(att, await createSortedSignatures(att, validators.slice(0, 3)));

        // Two bridge-outs per round
        await bridge.connect(user).bridgeToCanton(ethers.parseEther("100"), cantonRecipient);
        expectedBridgeOutNonce++;
        await bridge.connect(user).bridgeToCanton(ethers.parseEther("100"), cantonRecipient);
        expectedBridgeOutNonce++;

        // Verify both counters
        expect(await bridge.currentNonce()).to.equal(expectedCurrentNonce);
        expect(await bridge.bridgeOutNonce()).to.equal(expectedBridgeOutNonce);
      }

      // Final state: 10 attestations, 20 bridge-outs
      expect(await bridge.currentNonce()).to.equal(10);
      expect(await bridge.bridgeOutNonce()).to.equal(20);
    });
  });

  describe("Nonce after forceUpdate + resumed attestations", function () {
    it("Attestation after forceUpdate must use new nonce + 1", async function () {
      const assets = ethers.parseEther("1100000");

      // Process nonces 1 and 2
      await processNAttestations(2, 1, assets);
      expect(await bridge.currentNonce()).to.equal(2);

      // Force jump to nonce 100
      await bridge.connect(emergency).forceUpdateNonce(100, "Resync after incident");

      // Must use nonce 101 (not 3)
      await time.increase(61);
      const att = await createAttestation(101n, assets, BigInt(await time.latest()));
      await bridge.processAttestation(att, await createSortedSignatures(att, validators.slice(0, 3)));
      expect(await bridge.currentNonce()).to.equal(101);

      // nonce 3 should fail
      await time.increase(61);
      const attOld = await createAttestation(3n, assets, BigInt(await time.latest()));
      await expect(
        bridge.processAttestation(attOld, await createSortedSignatures(attOld, validators.slice(0, 3)))
      ).to.be.revertedWithCustomError(bridge, "InvalidNonce");
    });
  });
});
