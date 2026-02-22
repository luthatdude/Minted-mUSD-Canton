import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "ethers";

const TEST_PARTY =
  "minted-user-33f97321::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";

type RelayModule = {
  RelayService: new (config: any) => any;
};

function makeRelayConfig(stateFilePath: string) {
  return {
    cantonHost: "localhost",
    cantonPort: 7575,
    cantonToken: "test-token",
    cantonParty: TEST_PARTY,

    ethereumRpcUrl: "https://example.invalid",
    bridgeContractAddress: "0x1111111111111111111111111111111111111111",
    treasuryAddress: "0x2222222222222222222222222222222222222222",
    metaVault3Address: "0x3333333333333333333333333333333333333333",
    musdTokenAddress: "0x4444444444444444444444444444444444444444",
    relayerPrivateKey: "",
    relayerKmsKeyId: "",
    awsRegion: "us-east-1",

    validatorAddresses: {},
    recipientPartyAliases: {},
    redemptionRecipientAddresses: {},

    pollIntervalMs: 5000,
    maxRetries: 3,
    confirmations: 2,
    triggerAutoDeploy: false,
    autoAcceptMusdTransferProposals: false,
    fallbackRpcUrls: [],
    yieldDistributorAddress: "",
    ethPoolYieldDistributorAddress: "",
    cantonGovernanceParty: TEST_PARTY,
    stateFilePath,
    replayLookbackBlocks: 200000,
    maxRedemptionEthPayoutWei: ethers.parseUnits("50000", 18),
    autoGrantBridgeRoleForRedemptions: false,
  };
}

async function loadRelayModule(): Promise<RelayModule> {
  // relay-service.ts eagerly evaluates DEFAULT_CONFIG at import-time.
  // Set minimal required env values before importing the module in tests.
  process.env.ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "https://example.invalid";
  process.env.MUSD_TOKEN_ADDRESS =
    process.env.MUSD_TOKEN_ADDRESS || "0x4444444444444444444444444444444444444444";
  process.env.CANTON_USE_TLS = process.env.CANTON_USE_TLS || "false";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";

  return (await import("../relay-service")) as RelayModule;
}

describe("Relay bridge-out durability", () => {
  let RelayService: RelayModule["RelayService"];
  let tempRoot: string;

  beforeAll(async () => {
    ({ RelayService } = await loadRelayModule());
  });

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridgeout-durability-"));
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists and restores processedBridgeOuts across restarts", () => {
    const stateFilePath = path.join(tempRoot, "relay-state.json");
    const cfg = makeRelayConfig(stateFilePath);

    const relayA = new RelayService(cfg);
    (relayA as any).processedBridgeOuts.add("req-1");
    (relayA as any).processedBridgeOuts.add("req-2");
    (relayA as any).lastScannedBlock = 777;

    (relayA as any).persistState();

    const relayB = new RelayService(cfg);
    (relayB as any).loadPersistedState();

    const restored = Array.from((relayB as any).processedBridgeOuts).sort();
    expect(restored).toEqual(["req-1", "req-2"]);
    expect((relayB as any).lastScannedBlock).toBe(777);
  });

  it("advances cursor only to last safe block when processing fails mid-loop", async () => {
    const stateFilePath = path.join(tempRoot, "relay-state.json");
    const cfg = makeRelayConfig(stateFilePath);
    const relay = new RelayService(cfg);

    (relay as any).lastScannedBlock = 100;

    const event1 = {
      blockNumber: 101,
      args: {
        requestId: "request-1",
        sender: "0x9999999999999999999999999999999999999999",
        amount: ethers.parseEther("10"),
        nonce: 1n,
        cantonRecipient: TEST_PARTY,
        timestamp: 1700000000n,
      },
    };

    const event2 = {
      blockNumber: 102,
      args: {
        requestId: "request-2",
        sender: "0x8888888888888888888888888888888888888888",
        amount: ethers.parseEther("20"),
        nonce: 2n,
        cantonRecipient: TEST_PARTY,
        timestamp: 1700000010n,
      },
    };

    (relay as any).provider = {
      getBlockNumber: jest.fn().mockResolvedValue(110),
      getNetwork: jest.fn().mockResolvedValue({ chainId: 11155111n }),
    };

    (relay as any).bridgeContract = {
      filters: {
        BridgeToCantonRequested: jest.fn().mockReturnValue({}),
      },
      queryFilter: jest.fn().mockResolvedValue([event1, event2]),
    };

    (relay as any).canton = {
      createContract: jest.fn().mockResolvedValue({}),
    };

    const completeSpy = jest
      .spyOn(relay as any, "completeBridgeInAndMintMusd")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("simulated Canton failure"));

    const persistSpy = jest
      .spyOn(relay as any, "persistState")
      .mockImplementation(() => {});

    await (relay as any).watchEthereumBridgeOut();

    expect(completeSpy).toHaveBeenCalledTimes(2);
    expect((relay as any).processedBridgeOuts.has("request-1")).toBe(true);
    expect((relay as any).processedBridgeOuts.has("request-2")).toBe(false);
    expect((relay as any).lastScannedBlock).toBe(101);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
