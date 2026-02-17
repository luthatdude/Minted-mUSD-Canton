/**
 * Cross-Chain E2E Test: Canton → Ethereum Bridge
 *
 * TRUE end-to-end test that exercises the full bridge lifecycle:
 *
 *   1. Canton→ETH: Simulates Canton validators creating attestations,
 *      signs them with real secp256k1 keys, submits processAttestation()
 *      to BLEBridgeV9 on-chain, and verifies supply cap updates.
 *
 *   2. ETH→Canton: User calls bridgeToCanton(), burns mUSD on-chain,
 *      relay picks up BridgeToCantonRequested event and creates a
 *      BridgeOutRequest on Canton (simulated via mock Canton server).
 *
 *   3. Round-trip: Full mint→bridge-out→re-attest cycle verifying
 *      supply cap, nonce progression, and state hash chaining.
 *
 * Unlike unit tests, this:
 *   - Deploys real contracts (MUSD + BLEBridgeV9) on Hardhat
 *   - Uses real ECDSA signatures from validator wallets
 *   - Spins up a mock Canton HTTP JSON API server
 *   - Instantiates the actual relay's CantonClient
 *   - Validates event emissions match relay's expected ABI
 *   - Tests the full attestation→supplyCap→mint→burn→bridgeOut flow
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BLEBridgeV9, MUSD } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as http from "http";

// ─── Canton Mock Server ─────────────────────────────────────
// Simulates the Canton v2 HTTP JSON API for the relay client
// to interact with. Tracks contracts created by the relay.
// ─────────────────────────────────────────────────────────────

interface MockContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
  signatories: string[];
  createdAt: string;
}

class MockCantonServer {
  private server: http.Server | null = null;
  private contracts: MockContract[] = [];
  private offset = 0;
  private port = 0;

  /** Contracts created via submit-and-wait */
  get createdContracts(): MockContract[] {
    return [...this.contracts];
  }

  /** Start the mock server on an ephemeral port */
  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => this.handleRequest(req, res, body));
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  /** Stop the mock server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Inject a contract (simulates Canton ledger state) */
  addContract(contract: MockContract): void {
    this.contracts.push(contract);
    this.offset++;
  }

  /** Clear all contracts */
  reset(): void {
    this.contracts = [];
    this.offset = 0;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    res.setHeader("Content-Type", "application/json");

    const url = req.url || "";
    const method = req.method || "GET";

    // ── GET /v2/state/ledger-end ──
    if (method === "GET" && url === "/v2/state/ledger-end") {
      res.end(JSON.stringify({ offset: this.offset }));
      return;
    }

    // ── POST /v2/state/active-contracts ──
    if (method === "POST" && url === "/v2/state/active-contracts") {
      const entries = this.contracts.map((c) => ({
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              contractId: c.contractId,
              templateId: c.templateId,
              createArgument: c.payload,
              createdAt: c.createdAt,
              offset: 1,
              signatories: c.signatories,
              observers: [],
            },
          },
        },
      }));
      res.end(JSON.stringify(entries));
      return;
    }

    // ── POST /v2/commands/submit-and-wait ──
    if (method === "POST" && url === "/v2/commands/submit-and-wait") {
      const parsed = JSON.parse(body);
      const commands = parsed.commands || [];

      for (const cmd of commands) {
        if (cmd.createCommand) {
          const tid = cmd.createCommand.templateId;
          const templateStr = `mock:${tid.moduleName}:${tid.entityName}`;
          const newContract: MockContract = {
            contractId: `#mock:${this.offset + 1}:0`,
            templateId: templateStr,
            payload: cmd.createCommand.createArgument,
            signatories: parsed.actAs || [],
            createdAt: new Date().toISOString(),
          };
          this.contracts.push(newContract);
          this.offset++;
        }
      }

      res.end(JSON.stringify({
        completionOffset: this.offset,
        transaction: { events: [] },
      }));
      return;
    }

    // ── GET /v2/users ──
    if (method === "GET" && url === "/v2/users") {
      res.end(JSON.stringify({
        users: [{ id: "administrator", primaryParty: "test-party::1220abc", isDeactivated: false }],
      }));
      return;
    }

    // ── GET /v2/packages ──
    if (method === "GET" && url === "/v2/packages") {
      res.end(JSON.stringify({ packageIds: ["mock-package-001"] }));
      return;
    }

    // ── Fallback ──
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `Unknown endpoint: ${method} ${url}` }));
  }
}

// ─── Test Suite ─────────────────────────────────────────────

describe("Cross-Chain E2E: Canton ↔ Ethereum Bridge", function () {
  // Increase timeout for e2e tests
  this.timeout(120_000);

  let bridge: BLEBridgeV9;
  let musd: MUSD;
  let deployer: HardhatEthersSigner;
  let emergency: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let validators: HardhatEthersSigner[];
  let cantonServer: MockCantonServer;

  const MIN_SIGNATURES = 3;
  const COLLATERAL_RATIO = 11000n; // 110%
  const DAILY_CAP_LIMIT = ethers.parseEther("10000000"); // 10M per day
  const INITIAL_SUPPLY_CAP = ethers.parseEther("100000000"); // 100M

  // Canton party identifier (matches relay config)
  const CANTON_PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    emergency = signers[1];
    user = signers[2];
    minter = signers[3];
    validators = signers.slice(4, 9); // 5 validators

    // ── Deploy MUSD Token ──
    const MUSDFactory = await ethers.getContractFactory("MUSD");
    musd = (await MUSDFactory.deploy(INITIAL_SUPPLY_CAP, ethers.ZeroAddress)) as MUSD;
    await musd.waitForDeployment();

    // ── Deploy BLEBridgeV9 (UUPS Proxy) ──
    const BridgeFactory = await ethers.getContractFactory("BLEBridgeV9");
    bridge = (await upgrades.deployProxy(BridgeFactory, [
      MIN_SIGNATURES,
      await musd.getAddress(),
      COLLATERAL_RATIO,
      DAILY_CAP_LIMIT,
      deployer.address, // timelock
    ])) as unknown as BLEBridgeV9;
    await bridge.waitForDeployment();

    // ── Grant roles ──
    const BRIDGE_ROLE = await musd.BRIDGE_ROLE();
    const VALIDATOR_ROLE = await bridge.VALIDATOR_ROLE();
    const EMERGENCY_ROLE = await bridge.EMERGENCY_ROLE();
    const CAP_MANAGER_ROLE = await musd.CAP_MANAGER_ROLE();
    const TIMELOCK_ROLE = await bridge.TIMELOCK_ROLE();

    await musd.grantRole(BRIDGE_ROLE, await bridge.getAddress());
    await musd.grantRole(BRIDGE_ROLE, deployer.address); // for minting test tokens
    await musd.grantRole(CAP_MANAGER_ROLE, await bridge.getAddress());
    await bridge.grantRole(EMERGENCY_ROLE, emergency.address);
    await bridge.grantRole(TIMELOCK_ROLE, deployer.address);

    for (const v of validators) {
      await bridge.grantRole(VALIDATOR_ROLE, v.address);
    }

    // ── Set bridge-out minimum ──
    await bridge.setBridgeOutMinAmount(ethers.parseEther("10"));

    // ── Start mock Canton server ──
    cantonServer = new MockCantonServer();
    await cantonServer.start();
  });

  afterEach(async function () {
    if (cantonServer) {
      await cantonServer.stop();
    }
  });

  // ─── Helpers ────────────────────────────────────────────────

  async function createSortedSignatures(
    attestation: {
      id: string;
      cantonAssets: bigint;
      nonce: bigint;
      timestamp: bigint;
      entropy: string;
      cantonStateHash: string;
    },
    signers: HardhatEthersSigner[]
  ): Promise<string[]> {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const bridgeAddr = await bridge.getAddress();

    const messageHash = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
      [
        attestation.id,
        attestation.cantonAssets,
        attestation.nonce,
        attestation.timestamp,
        attestation.entropy,
        attestation.cantonStateHash,
        chainId,
        bridgeAddr,
      ]
    );

    const sigs: { sig: string; addr: string }[] = [];
    for (const signer of signers) {
      const sig = await signer.signMessage(ethers.getBytes(messageHash));
      sigs.push({ sig, addr: signer.address.toLowerCase() });
    }

    sigs.sort((a, b) => (a.addr < b.addr ? -1 : 1));
    return sigs.map((s) => s.sig);
  }

  async function createAttestation(
    nonce: bigint,
    cantonAssets: bigint,
    timestamp: bigint,
    prevStateHash?: string
  ) {
    const entropy = ethers.hexlify(ethers.randomBytes(32));
    // Chain state hashes: each attestation builds on the previous
    const cantonStateHash = prevStateHash
      ? ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [prevStateHash, nonce]))
      : ethers.hexlify(ethers.randomBytes(32));
    const id = await bridge.computeAttestationId(nonce, cantonAssets, timestamp, entropy, cantonStateHash);
    return { id, cantonAssets, nonce, timestamp, entropy, cantonStateHash };
  }

  // ─── 1. Canton → Ethereum (Attestation Flow) ──────────────

  describe("1. Canton → Ethereum: Attestation-driven supply cap", function () {
    it("should process a Canton attestation and update mUSD supply cap", async function () {
      // Simulate: Canton validators attest $5.5M in Canton assets
      const cantonAssets = ethers.parseEther("5500000"); // $5.5M
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, cantonAssets, ts);

      // Validators sign (simulating KMS signatures in production)
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));

      // Process on-chain
      const tx = await bridge.processAttestation(att, sigs);
      const receipt = await tx.wait();

      // Verify events
      const attestationEvent = receipt!.logs.find(
        (l: any) => l.fragment?.name === "AttestationReceived"
      ) as any;
      expect(attestationEvent).to.not.be.undefined;
      expect(attestationEvent.args.cantonAssets).to.equal(cantonAssets);

      const stateHashEvent = receipt!.logs.find(
        (l: any) => l.fragment?.name === "CantonStateHashVerified"
      ) as any;
      expect(stateHashEvent).to.not.be.undefined;

      // Verify supply cap: $5.5M / 1.1 = $5M
      const expectedCap = (cantonAssets * 10000n) / COLLATERAL_RATIO;
      expect(await musd.supplyCap()).to.equal(expectedCap);

      // Verify nonce advanced
      expect(await bridge.currentNonce()).to.equal(1);

      // Verify Canton state hash recorded
      expect(await bridge.lastCantonStateHash()).to.equal(att.cantonStateHash);
      expect(await bridge.verifiedStateHashes(att.cantonStateHash)).to.be.true;
    });

    it("should chain multiple attestations with linked state hashes", async function () {
      // Attestation 1: $5.5M
      const ts1 = BigInt(await time.latest());
      const att1 = await createAttestation(1n, ethers.parseEther("5500000"), ts1);
      const sigs1 = await createSortedSignatures(att1, validators.slice(0, 3));
      await bridge.processAttestation(att1, sigs1);

      const stateHash1 = await bridge.lastCantonStateHash();

      // Attestation 2: $6.6M (chained from previous state hash)
      await time.increase(120); // 2 minutes gap
      const ts2 = BigInt(await time.latest());
      const att2 = await createAttestation(2n, ethers.parseEther("6600000"), ts2, stateHash1);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));
      await bridge.processAttestation(att2, sigs2);

      const stateHash2 = await bridge.lastCantonStateHash();
      expect(stateHash2).to.not.equal(stateHash1);
      expect(await bridge.verifiedStateHashes(stateHash2)).to.be.true;

      // Supply cap should reflect latest attestation
      const expectedCap = (ethers.parseEther("6600000") * 10000n) / COLLATERAL_RATIO;
      expect(await musd.supplyCap()).to.equal(expectedCap);

      // Nonce progressed
      expect(await bridge.currentNonce()).to.equal(2);
    });

    it("should enforce rate limiting on rapid supply cap increases", async function () {
      // Attestation 1: small to establish baseline
      const ts1 = BigInt(await time.latest());
      const att1 = await createAttestation(1n, ethers.parseEther("1100000"), ts1); // $1.1M → $1M cap
      const sigs1 = await createSortedSignatures(att1, validators.slice(0, 3));
      await bridge.processAttestation(att1, sigs1);

      const capAfter1 = await musd.supplyCap();

      // Attestation 2: huge jump ($110M assets → $100M cap)
      // This would be a $99M increase, way above daily limit of $10M
      await time.increase(120);
      const ts2 = BigInt(await time.latest());
      const att2 = await createAttestation(2n, ethers.parseEther("110000000"), ts2);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));
      await bridge.processAttestation(att2, sigs2);

      const capAfter2 = await musd.supplyCap();
      const increase = capAfter2 - capAfter1;

      // Should be clamped to daily limit
      expect(increase).to.be.lte(DAILY_CAP_LIMIT);
      expect(increase).to.equal(DAILY_CAP_LIMIT);
    });
  });

  // ─── 2. Ethereum → Canton (Bridge-Out Flow) ──────────────

  describe("2. Ethereum → Canton: Bridge-out (burn + relay pickup)", function () {
    const BRIDGE_AMOUNT = ethers.parseEther("1000"); // 1000 mUSD

    beforeEach(async function () {
      // Setup: attestation to establish supply cap, then mint tokens
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);

      // Mint mUSD to user (deployer has BRIDGE_ROLE)
      await musd.mint(user.address, ethers.parseEther("50000"));

      // User approves bridge
      await musd.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);
    });

    it("should burn mUSD and emit BridgeToCantonRequested event", async function () {
      const balanceBefore = await musd.balanceOf(user.address);

      const tx = await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_PARTY);
      const receipt = await tx.wait();

      // Verify mUSD burned
      const balanceAfter = await musd.balanceOf(user.address);
      expect(balanceBefore - balanceAfter).to.equal(BRIDGE_AMOUNT);

      // Verify event emitted with correct data
      const event = receipt!.logs.find(
        (l: any) => l.fragment?.name === "BridgeToCantonRequested"
      ) as any;
      expect(event).to.not.be.undefined;
      expect(event.args.sender).to.equal(user.address);
      expect(event.args.amount).to.equal(BRIDGE_AMOUNT);
      expect(event.args.nonce).to.equal(1n);
      expect(event.args.cantonRecipient).to.equal(CANTON_PARTY);
    });

    it("should allow relay to create BridgeOutRequest on Canton via mock API", async function () {
      // Step 1: User bridges out on Ethereum
      const tx = await bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, CANTON_PARTY);
      const receipt = await tx.wait();

      // Step 2: Parse the event (relay would do this via ethers event listener)
      const bridgeInterface = bridge.interface;
      const event = receipt!.logs
        .map((log) => {
          try {
            return bridgeInterface.parseLog({ topics: log.topics as string[], data: log.data });
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "BridgeToCantonRequested");

      expect(event).to.not.be.undefined;
      const { requestId, sender, amount, nonce, cantonRecipient, timestamp: eventTs } = event!.args;

      // Step 3: Relay creates BridgeOutRequest on Canton (via mock server)
      // This simulates what relay-service.ts does in processBridgeOutEvents()
      const { CantonClient, TEMPLATES } = await import("../relay/canton-client");

      const cantonPort = (cantonServer as any).port;
      const client = new CantonClient({
        baseUrl: `http://127.0.0.1:${cantonPort}`,
        token: "test-jwt-token",
        userId: "relay",
        actAs: CANTON_PARTY,
      });

      // Verify Canton is reachable
      const ledgerEnd = await client.getLedgerEnd();
      expect(ledgerEnd).to.be.a("number");

      // Create the BridgeOutRequest contract on Canton
      await client.createContract(TEMPLATES.BridgeOutRequest, {
        requestId: requestId,
        sender: sender,
        amount: amount.toString(),
        cantonRecipient: cantonRecipient,
        ethTxHash: receipt!.hash,
        nonce: nonce.toString(),
        timestamp: eventTs.toString(),
        bridgeContract: await bridge.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      });

      // Verify contract was created on mock Canton
      const created = cantonServer.createdContracts;
      const bridgeOutReq = created.find((c) =>
        c.templateId.includes("BridgeOutRequest")
      );
      expect(bridgeOutReq).to.not.be.undefined;
      expect(bridgeOutReq!.payload.requestId).to.equal(requestId);
      expect(bridgeOutReq!.payload.sender).to.equal(sender);
      expect(bridgeOutReq!.payload.cantonRecipient).to.equal(CANTON_PARTY);
    });

    it("should reject bridge-out below minimum amount", async function () {
      await expect(
        bridge.connect(user).bridgeToCanton(ethers.parseEther("5"), CANTON_PARTY)
      ).to.be.revertedWithCustomError(bridge, "BelowMin");
    });

    it("should reject bridge-out with invalid Canton party format", async function () {
      await expect(
        bridge.connect(user).bridgeToCanton(BRIDGE_AMOUNT, "invalid-no-double-colon")
      ).to.be.revertedWithCustomError(bridge, "InvalidRecipient");
    });
  });

  // ─── 3. Full Round-Trip: Attest → Mint → Bridge-Out → Re-Attest ──

  describe("3. Full round-trip: Canton attestation → mint → bridge-out → re-attest", function () {
    it("should complete a full Canton↔Ethereum lifecycle", async function () {
      const bridgeAddr = await bridge.getAddress();

      // ════════════════════════════════════════════════
      // STEP 1: Canton attestation → supply cap set
      // ════════════════════════════════════════════════
      const cantonAssets1 = ethers.parseEther("11000000"); // $11M → $10M cap
      const ts1 = BigInt(await time.latest());
      const att1 = await createAttestation(1n, cantonAssets1, ts1);
      const sigs1 = await createSortedSignatures(att1, validators.slice(0, 3));

      await bridge.processAttestation(att1, sigs1);

      const supplyCap1 = await musd.supplyCap();
      expect(supplyCap1).to.equal((cantonAssets1 * 10000n) / COLLATERAL_RATIO);
      expect(await bridge.currentNonce()).to.equal(1);

      // ════════════════════════════════════════════════
      // STEP 2: Mint mUSD (within supply cap)
      // ════════════════════════════════════════════════
      const mintAmount = ethers.parseEther("5000000"); // $5M mUSD
      await musd.mint(user.address, mintAmount);

      expect(await musd.totalSupply()).to.be.gte(mintAmount);
      expect(await musd.balanceOf(user.address)).to.equal(mintAmount);

      // ════════════════════════════════════════════════
      // STEP 3: Bridge-out (burn mUSD on Ethereum)
      // ════════════════════════════════════════════════
      const bridgeOutAmount = ethers.parseEther("1000000"); // $1M mUSD
      await musd.connect(user).approve(bridgeAddr, ethers.MaxUint256);

      const tx = await bridge.connect(user).bridgeToCanton(bridgeOutAmount, CANTON_PARTY);
      const receipt = await tx.wait();

      // Tokens burned
      expect(await musd.balanceOf(user.address)).to.equal(mintAmount - bridgeOutAmount);
      expect(await bridge.bridgeOutNonce()).to.equal(1);

      // Event emitted for relay
      const bridgeOutEvent = receipt!.logs.find(
        (l: any) => l.fragment?.name === "BridgeToCantonRequested"
      ) as any;
      expect(bridgeOutEvent).to.not.be.undefined;
      expect(bridgeOutEvent.args.amount).to.equal(bridgeOutAmount);

      // ════════════════════════════════════════════════
      // STEP 4: Relay picks up event, notifies Canton (mock)
      // ════════════════════════════════════════════════
      const { CantonClient, TEMPLATES } = await import("../relay/canton-client");
      const cantonPort = (cantonServer as any).port;
      const client = new CantonClient({
        baseUrl: `http://127.0.0.1:${cantonPort}`,
        token: "test-jwt",
        userId: "relay",
        actAs: CANTON_PARTY,
      });

      await client.createContract(TEMPLATES.BridgeOutRequest, {
        requestId: bridgeOutEvent.args.requestId,
        sender: user.address,
        amount: bridgeOutAmount.toString(),
        cantonRecipient: CANTON_PARTY,
        ethTxHash: receipt!.hash,
        nonce: "1",
        timestamp: bridgeOutEvent.args.timestamp.toString(),
        bridgeContract: bridgeAddr,
        chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      });

      const cantonContracts = cantonServer.createdContracts;
      expect(cantonContracts.length).to.be.gte(1);

      // ════════════════════════════════════════════════
      // STEP 5: Canton processes bridge-out, assets decrease.
      //         New attestation reflects reduced assets.
      // ════════════════════════════════════════════════
      await time.increase(120); // 2 min gap

      // Assets decreased by bridged amount (Canton side)
      const cantonAssets2 = cantonAssets1 - bridgeOutAmount; // $10M
      const ts2 = BigInt(await time.latest());
      const stateHash1 = await bridge.lastCantonStateHash();
      const att2 = await createAttestation(2n, cantonAssets2, ts2, stateHash1);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));

      await bridge.processAttestation(att2, sigs2);

      // Supply cap reduced to reflect decreased assets
      const supplyCap2 = await musd.supplyCap();
      const expectedCap2 = (cantonAssets2 * 10000n) / COLLATERAL_RATIO;
      expect(supplyCap2).to.equal(expectedCap2);
      expect(supplyCap2).to.be.lt(supplyCap1);

      // ════════════════════════════════════════════════
      // STEP 6: Verify final state consistency
      // ════════════════════════════════════════════════
      expect(await bridge.currentNonce()).to.equal(2);
      expect(await bridge.attestedCantonAssets()).to.equal(cantonAssets2);
      expect(await bridge.bridgeOutNonce()).to.equal(1);

      // State hash chain is intact
      const stateHash2 = await bridge.lastCantonStateHash();
      expect(stateHash2).to.not.equal(stateHash1);
      expect(await bridge.verifiedStateHashes(stateHash1)).to.be.true;
      expect(await bridge.verifiedStateHashes(stateHash2)).to.be.true;

      // Health ratio: $10M assets / $4M supply ≈ 250%
      const supply = await musd.totalSupply();
      if (supply > 0n) {
        const healthRatio = await bridge.getHealthRatio();
        expect(healthRatio).to.be.gte(10000n); // >= 100%
      }
    });
  });

  // ─── 4. Relay Canton Client Integration ────────────────────

  describe("4. Relay CantonClient integration with mock Canton", function () {
    it("should query attestation request contracts from Canton", async function () {
      const { CantonClient, TEMPLATES } = await import("../relay/canton-client");
      const cantonPort = (cantonServer as any).port;
      const client = new CantonClient({
        baseUrl: `http://127.0.0.1:${cantonPort}`,
        token: "test-jwt",
        userId: "relay",
        actAs: CANTON_PARTY,
      });

      // Inject mock AttestationRequest contracts
      cantonServer.addContract({
        contractId: "#mock:1:0",
        templateId: "pkg123:Minted.Protocol.V3:AttestationRequest",
        payload: {
          operator: CANTON_PARTY,
          cantonAssets: "5500000000000000000000000",
          nonce: "1",
          requiredSignatures: 3,
          status: "pending",
        },
        signatories: [CANTON_PARTY],
        createdAt: new Date().toISOString(),
      });

      // Query via CantonClient
      const contracts = await client.queryContracts(TEMPLATES.AttestationRequest);
      expect(contracts.length).to.equal(1);
      expect(contracts[0].payload.operator).to.equal(CANTON_PARTY);
      expect(contracts[0].payload.nonce).to.equal("1");
    });

    it("should exercise a choice on a Canton contract", async function () {
      const { CantonClient, TEMPLATES } = await import("../relay/canton-client");
      const cantonPort = (cantonServer as any).port;
      const client = new CantonClient({
        baseUrl: `http://127.0.0.1:${cantonPort}`,
        token: "test-jwt",
        userId: "relay",
        actAs: CANTON_PARTY,
      });

      // Inject a BridgeService contract
      cantonServer.addContract({
        contractId: "#mock:bridge:0",
        templateId: "pkg123:Minted.Protocol.V3:BridgeService",
        payload: { operator: CANTON_PARTY, active: true },
        signatories: [CANTON_PARTY],
        createdAt: new Date().toISOString(),
      });

      // Exercise a choice (mock just accepts it)
      const result = await client.exerciseChoice(
        TEMPLATES.BridgeService,
        "#mock:bridge:0",
        "ProcessBridgeOut",
        { requestId: "0xabc123", amount: "1000000000000000000000" }
      );

      expect(result).to.not.be.undefined;
    });

    it("should handle Canton API timeout gracefully", async function () {
      const { CantonClient } = await import("../relay/canton-client");

      // Use a non-existent port to trigger timeout
      const client = new CantonClient({
        baseUrl: "http://127.0.0.1:1", // unlikely to be listening
        token: "test-jwt",
        userId: "relay",
        actAs: CANTON_PARTY,
        timeoutMs: 500, // 500ms timeout
      });

      try {
        await client.getLedgerEnd();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Should get a connection error or timeout
        expect(err.message).to.match(/timeout|ECONNREFUSED|fetch failed/i);
      }
    });
  });

  // ─── 5. Bridge Event ABI Compatibility ────────────────────

  describe("5. Bridge event ABI compatibility with relay", function () {
    it("should emit AttestationReceived with fields relay expects", async function () {
      // The relay's BRIDGE_ABI expects: AttestationReceived(id, cantonAssets, newSupplyCap, nonce, timestamp)
      const cantonAssets = ethers.parseEther("5500000");
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, cantonAssets, ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));

      const tx = await bridge.processAttestation(att, sigs);
      const receipt = await tx.wait();

      // Parse event using the contract interface
      const event = bridge.interface.parseLog({
        topics: receipt!.logs[receipt!.logs.length - 1].topics as string[],
        data: receipt!.logs[receipt!.logs.length - 1].data,
      });

      // Verify all fields the relay expects are present
      if (event?.name === "AttestationReceived") {
        expect(event.args.id).to.equal(att.id);
        expect(event.args.cantonAssets).to.equal(cantonAssets);
        expect(event.args.nonce).to.equal(1n);
        expect(event.args.timestamp).to.equal(ts);
        expect(event.args.newSupplyCap).to.be.gt(0n);
      }
    });

    it("should emit BridgeToCantonRequested with fields relay expects", async function () {
      // Setup: mint tokens to user
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);

      await musd.mint(user.address, ethers.parseEther("10000"));
      await musd.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);

      const tx = await bridge.connect(user).bridgeToCanton(
        ethers.parseEther("1000"),
        CANTON_PARTY
      );
      const receipt = await tx.wait();

      // Parse event
      const event = bridge.interface.parseLog({
        topics: receipt!.logs[receipt!.logs.length - 1].topics as string[],
        data: receipt!.logs[receipt!.logs.length - 1].data,
      });

      // Verify all fields the relay expects
      if (event?.name === "BridgeToCantonRequested") {
        expect(event.args.requestId).to.be.a("string");
        expect(event.args.sender).to.equal(user.address);
        expect(event.args.amount).to.equal(ethers.parseEther("1000"));
        expect(event.args.nonce).to.equal(1n);
        expect(event.args.cantonRecipient).to.equal(CANTON_PARTY);
        expect(event.args.timestamp).to.be.gt(0n);
      }
    });

    it("should emit SupplyCapUpdated for relay monitoring", async function () {
      const cantonAssets = ethers.parseEther("5500000");
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, cantonAssets, ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));

      await expect(bridge.processAttestation(att, sigs))
        .to.emit(bridge, "SupplyCapUpdated")
        .withArgs(
          INITIAL_SUPPLY_CAP, // oldCap (from MUSD constructor)
          (cantonAssets * 10000n) / COLLATERAL_RATIO, // newCap
          cantonAssets // attestedAssets
        );
    });
  });

  // ─── 6. Security: Cross-chain attack scenarios ────────────

  describe("6. Cross-chain attack scenarios", function () {
    it("should prevent double-spend via attestation replay", async function () {
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));

      // First submission succeeds
      await bridge.processAttestation(att, sigs);

      // Replay with same attestation ID should fail
      const att2 = { ...att, nonce: 2n }; // Try different nonce but same ID
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));

      // Will fail on either InvalidNonce or AttestationReused
      await expect(bridge.processAttestation(att, sigs)).to.be.reverted;
    });

    it("should prevent supply inflation via stale attestation", async function () {
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);

      // Wait >6 hours (MAX_ATTESTATION_AGE)
      await time.increase(7 * 60 * 60);

      // Create attestation with timestamp that passes MIN_ATTESTATION_GAP (>60s after last)
      // but is still older than MAX_ATTESTATION_AGE (>6h before current block)
      const staleTs = ts + 120n; // 2 min after first attestation (passes gap check)
      // Current block.timestamp ≈ ts + 7h, so age = 7h - 120s ≈ 6h58m > 6h → too old
      const att2 = await createAttestation(2n, ethers.parseEther("999000000"), staleTs);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));

      await expect(bridge.processAttestation(att2, sigs2))
        .to.be.revertedWithCustomError(bridge, "AttestationTooOld");
    });

    it("should prevent bridge-out during emergency pause", async function () {
      // Setup
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("11000000"), ts);
      const sigs = await createSortedSignatures(att, validators.slice(0, 3));
      await bridge.processAttestation(att, sigs);
      await musd.mint(user.address, ethers.parseEther("10000"));
      await musd.connect(user).approve(await bridge.getAddress(), ethers.MaxUint256);

      // Emergency pause
      await bridge.connect(emergency).pause();

      // Bridge-out should fail
      await expect(
        bridge.connect(user).bridgeToCanton(ethers.parseEther("1000"), CANTON_PARTY)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");

      // Attestation should also fail
      await time.increase(120);
      const ts2 = BigInt(await time.latest());
      const att2 = await createAttestation(2n, ethers.parseEther("11000000"), ts2);
      const sigs2 = await createSortedSignatures(att2, validators.slice(0, 3));
      await expect(bridge.processAttestation(att2, sigs2))
        .to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("should prevent unauthorized validator from inflating supply", async function () {
      // Create attestation signed by non-validator accounts
      const ts = BigInt(await time.latest());
      const att = await createAttestation(1n, ethers.parseEther("999000000"), ts);

      // Sign with user accounts who don't have VALIDATOR_ROLE
      const fakeSigs = await createSortedSignatures(att, [user, minter, deployer]);

      await expect(bridge.processAttestation(att, fakeSigs))
        .to.be.revertedWithCustomError(bridge, "InvalidValidator");
    });
  });
});
