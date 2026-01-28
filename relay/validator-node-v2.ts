/**
 * Minted Protocol - Canton Validator Node V2
 *
 * KEY CHANGE: Validators query Canton Network's actual tokenized asset ledger,
 * NOT manually-updated DAML contracts.
 *
 * Flow:
 *   1. Watch for AttestationRequest contracts on Canton
 *   2. Query Canton Network API for actual tokenized asset values
 *   3. Verify attestation payload matches Canton's state
 *   4. Sign with AWS KMS if valid
 *   5. Submit ValidatorSignature to Canton
 *
 * This allows Canton to choose which assets back mUSD.
 */

import Ledger from "@daml/ledger";
import { ContractId } from "@daml/types";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { ethers } from "ethers";
// FIX M-17: Removed unused crypto import

// ============================================================
//                     CONFIGURATION
// ============================================================

interface ValidatorConfig {
  // Canton DAML Ledger
  cantonLedgerHost: string;
  cantonLedgerPort: number;
  cantonLedgerToken: string;
  validatorParty: string;

  // Canton Network Asset API (separate from DAML ledger)
  cantonAssetApiUrl: string;
  cantonAssetApiKey: string;

  // AWS KMS
  awsRegion: string;
  kmsKeyId: string;

  // Ethereum
  ethereumAddress: string;
  bridgeContractAddress: string;

  // Operational
  pollIntervalMs: number;
  minCollateralRatioBps: number;
}

const DEFAULT_CONFIG: ValidatorConfig = {
  cantonLedgerHost: process.env.CANTON_LEDGER_HOST || "localhost",
  cantonLedgerPort: parseInt(process.env.CANTON_LEDGER_PORT || "6865"),
  cantonLedgerToken: process.env.CANTON_LEDGER_TOKEN || "",
  validatorParty: process.env.VALIDATOR_PARTY || "",

  cantonAssetApiUrl: process.env.CANTON_ASSET_API_URL || "https://api.canton.network",
  cantonAssetApiKey: process.env.CANTON_ASSET_API_KEY || "",

  awsRegion: process.env.AWS_REGION || "us-east-1",
  kmsKeyId: process.env.KMS_KEY_ID || "",

  ethereumAddress: process.env.VALIDATOR_ETH_ADDRESS || "",
  bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000"),
  minCollateralRatioBps: parseInt(process.env.MIN_COLLATERAL_RATIO_BPS || "11000"),
};

// ============================================================
//                     CANTON ASSET TYPES
// ============================================================

interface CantonAsset {
  assetId: string;
  category: "Equity" | "FixedIncome" | "RealEstate" | "Commodities" | "CashEquivalent";
  issuerName: string;
  currentValue: bigint;  // In wei (18 decimals)
  lastUpdated: string;   // ISO timestamp
}

interface CantonAssetSnapshot {
  snapshotId: string;
  timestamp: string;
  assets: CantonAsset[];
  totalValue: bigint;
  stateHash: string;  // Hash of the snapshot for verification
}

// ============================================================
//                     DAML TYPES
// ============================================================

interface CantonAssetAttestation {
  assetId: string;
  category: string;
  issuerName: string;
  assetValue: string;
  attestedAt: string;
}

interface AttestationPayload {
  attestationId: string;
  cantonAssets: CantonAssetAttestation[];
  totalCantonValue: string;
  targetChainId: string;
  targetBridgeAddress: string;
  requestedSupplyCap: string;
  collateralRatioBps: string;
  nonce: string;
  expiresAt: string;
}

interface AttestationRequest {
  aggregator: string;
  validatorGroup: string[];
  payload: AttestationPayload;
}

// ============================================================
//                     CANTON ASSET API CLIENT
// ============================================================

class CantonAssetClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  /**
   * Fetch current snapshot of all tokenized assets from Canton Network
   */
  async getAssetSnapshot(): Promise<CantonAssetSnapshot> {
    const response = await fetch(`${this.apiUrl}/v1/assets/snapshot`, {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return {
      snapshotId: data.snapshotId,
      timestamp: data.timestamp,
      assets: data.assets.map((a: any) => ({
        assetId: a.assetId,
        category: a.category,
        issuerName: a.issuerName,
        currentValue: BigInt(a.currentValue),
        lastUpdated: a.lastUpdated,
      })),
      totalValue: BigInt(data.totalValue),
      stateHash: data.stateHash,
    };
  }

  /**
   * Fetch specific assets by ID
   */
  async getAssetsByIds(assetIds: string[]): Promise<CantonAsset[]> {
    const response = await fetch(`${this.apiUrl}/v1/assets/batch`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ assetIds }),
    });

    if (!response.ok) {
      throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.assets.map((a: any) => ({
      assetId: a.assetId,
      category: a.category,
      issuerName: a.issuerName,
      currentValue: BigInt(a.currentValue),
      lastUpdated: a.lastUpdated,
    }));
  }

  /**
   * Verify a state hash matches Canton's current state
   */
  async verifyStateHash(stateHash: string): Promise<boolean> {
    const response = await fetch(`${this.apiUrl}/v1/state/verify`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stateHash }),
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.valid === true;
  }
}

// ============================================================
//                     VALIDATOR NODE
// ============================================================

class ValidatorNode {
  private config: ValidatorConfig;
  private ledger: Ledger;
  private cantonClient: CantonAssetClient;
  private kmsClient: KMSClient;
  private signedAttestations: Set<string> = new Set();
  private isRunning: boolean = false;

  constructor(config: ValidatorConfig) {
    this.config = config;

    // FIX H-12: Use TLS for Canton ledger connections
    const protocol = process.env.CANTON_USE_TLS === "true" ? "https" : "http";
    const wsProtocol = process.env.CANTON_USE_TLS === "true" ? "wss" : "ws";
    this.ledger = new Ledger({
      token: config.cantonLedgerToken,
      httpBaseUrl: `${protocol}://${config.cantonLedgerHost}:${config.cantonLedgerPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonLedgerHost}:${config.cantonLedgerPort}`,
    });

    // Initialize Canton Asset API client
    this.cantonClient = new CantonAssetClient(
      config.cantonAssetApiUrl,
      config.cantonAssetApiKey
    );

    // Initialize AWS KMS
    this.kmsClient = new KMSClient({ region: config.awsRegion });

    console.log(`[Validator] Initialized`);
    console.log(`[Validator] Party: ${config.validatorParty}`);
    console.log(`[Validator] Canton API: ${config.cantonAssetApiUrl}`);
    console.log(`[Validator] ETH Address: ${config.ethereumAddress}`);
  }

  async start(): Promise<void> {
    console.log("[Validator] Starting...");
    this.isRunning = true;

    while (this.isRunning) {
      try {
        await this.pollForAttestations();
      } catch (error) {
        console.error("[Validator] Poll error:", error);
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    console.log("[Validator] Stopping...");
    this.isRunning = false;
  }

  private async pollForAttestations(): Promise<void> {
    // Query AttestationRequest contracts
    const attestations = await this.ledger.query<AttestationRequest>(
      "MintedProtocolV3:AttestationRequest" as any,
      {}
    );

    for (const attestation of attestations) {
      const request = attestation.payload;
      const payload = request.payload;
      const attestationId = payload.attestationId;

      // Check if we're in the validator group
      if (!request.validatorGroup.includes(this.config.validatorParty)) {
        continue;
      }

      // Check if we've already signed
      if (this.signedAttestations.has(attestationId)) {
        continue;
      }

      // Check expiration
      const expiresAt = new Date(payload.expiresAt);
      if (expiresAt <= new Date()) {
        console.log(`[Validator] Attestation ${attestationId} expired, skipping`);
        continue;
      }

      // CRITICAL: Verify against Canton Network's actual state
      const verification = await this.verifyAgainstCanton(payload);
      if (!verification.valid) {
        console.warn(`[Validator] Attestation ${attestationId} failed verification: ${verification.reason}`);
        continue;
      }

      // Sign it
      console.log(`[Validator] Signing attestation ${attestationId}...`);
      await this.signAttestation(attestation.contractId, payload, verification.stateHash);
    }
  }

  /**
   * CRITICAL: Verify attestation payload against Canton Network's actual asset state
   */
  private async verifyAgainstCanton(payload: AttestationPayload): Promise<{
    valid: boolean;
    reason?: string;
    stateHash: string;
  }> {
    try {
      // 1. Fetch current asset snapshot from Canton
      const snapshot = await this.cantonClient.getAssetSnapshot();

      // 2. Get the asset IDs referenced in the attestation
      const requestedAssetIds = payload.cantonAssets.map(a => a.assetId);

      // 3. Verify each asset exists and value matches
      for (const attestedAsset of payload.cantonAssets) {
        const cantonAsset = snapshot.assets.find(a => a.assetId === attestedAsset.assetId);

        if (!cantonAsset) {
          return {
            valid: false,
            reason: `Asset ${attestedAsset.assetId} not found in Canton`,
            stateHash: snapshot.stateHash,
          };
        }

        // FIX H-13: Use ethers.parseUnits for financial precision
        const attestedValue = ethers.parseUnits(attestedAsset.assetValue, 18);

        // Allow 0.1% tolerance for timing differences
        const tolerance = cantonAsset.currentValue / 1000n;
        const diff = attestedValue > cantonAsset.currentValue
          ? attestedValue - cantonAsset.currentValue
          : cantonAsset.currentValue - attestedValue;

        if (diff > tolerance) {
          return {
            valid: false,
            reason: `Asset ${attestedAsset.assetId} value mismatch: attested=${attestedAsset.assetValue}, canton=${cantonAsset.currentValue}`,
            stateHash: snapshot.stateHash,
          };
        }
      }

      // 4. Verify total matches
      const attestedTotal = ethers.parseUnits(payload.totalCantonValue, 18);
      const tolerance = snapshot.totalValue / 1000n;
      const totalDiff = attestedTotal > snapshot.totalValue
        ? attestedTotal - snapshot.totalValue
        : snapshot.totalValue - attestedTotal;

      // Only verify against assets included in attestation
      // FIX H-13: Use ethers.parseUnits
      const includedAssetsValue = payload.cantonAssets.reduce((sum, a) => {
        return sum + ethers.parseUnits(a.assetValue, 18);
      }, 0n);

      const attestedTotalFromAssets = ethers.parseUnits(payload.totalCantonValue, 18);
      if (includedAssetsValue !== attestedTotalFromAssets) {
        return {
          valid: false,
          reason: `Asset sum mismatch: sum=${includedAssetsValue}, total=${attestedTotalFromAssets}`,
          stateHash: snapshot.stateHash,
        };
      }

      // 5. Verify collateral ratio
      const requestedCap = ethers.parseUnits(payload.requestedSupplyCap, 18);
      const requiredCollateral = requestedCap * BigInt(payload.collateralRatioBps) / 10000n;

      if (includedAssetsValue < requiredCollateral) {
        return {
          valid: false,
          reason: `Insufficient collateral: ${includedAssetsValue} < ${requiredCollateral} required`,
          stateHash: snapshot.stateHash,
        };
      }

      // FIX M-16: Verify the snapshot state hash is valid with Canton
      const stateValid = await this.cantonClient.verifyStateHash(snapshot.stateHash);
      if (!stateValid) {
        return {
          valid: false,
          reason: `Canton state hash verification failed: ${snapshot.stateHash}`,
          stateHash: snapshot.stateHash,
        };
      }

      console.log(`[Validator] ✓ Verified against Canton: ${payload.cantonAssets.length} assets, total=${payload.totalCantonValue}`);

      return {
        valid: true,
        stateHash: snapshot.stateHash,
      };

    } catch (error: any) {
      return {
        valid: false,
        reason: `Canton API error: ${error.message}`,
        stateHash: "",
      };
    }
  }

  private async signAttestation(
    contractId: ContractId<AttestationRequest>,
    payload: AttestationPayload,
    cantonStateHash: string
  ): Promise<void> {
    const attestationId = payload.attestationId;

    try {
      // Build message hash
      const messageHash = this.buildMessageHash(payload);

      // Sign with KMS
      const signature = await this.signWithKMS(messageHash);

      // Submit to Canton
      await this.ledger.exercise(
        "MintedProtocolV3:AttestationRequest" as any,
        contractId,
        "ProvideSignature",
        {
          validator: this.config.validatorParty,
          ecdsaSignature: signature,
          cantonStateHash: cantonStateHash,  // Include hash of verified state
        }
      );

      this.signedAttestations.add(attestationId);
      console.log(`[Validator] ✓ Signed attestation ${attestationId}`);

    } catch (error: any) {
      console.error(`[Validator] Failed to sign attestation ${attestationId}:`, error.message);

      if (error.message?.includes("VALIDATOR_ALREADY_SIGNED") ||
          error.message?.includes("already signed")) {
        this.signedAttestations.add(attestationId);
      }
    }
  }

  private buildMessageHash(payload: AttestationPayload): string {
    const idBytes32 = ethers.id(payload.attestationId);
    const timestamp = Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600;

    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "address"],
      [
        idBytes32,
        ethers.parseUnits(payload.totalCantonValue, 18),
        BigInt(payload.nonce),
        BigInt(timestamp),
        BigInt(payload.targetChainId),
        payload.targetBridgeAddress,
      ]
    );
  }

  private async signWithKMS(messageHash: string): Promise<string> {
    const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHash));
    const hashBytes = Buffer.from(ethSignedHash.slice(2), "hex");

    const command = new SignCommand({
      KeyId: this.config.kmsKeyId,
      Message: hashBytes,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    });

    const response = await this.kmsClient.send(command);

    if (!response.Signature) {
      throw new Error("KMS returned empty signature");
    }

    const { formatKMSSignature } = require("./signer");
    return formatKMSSignature(
      Buffer.from(response.Signature),
      ethSignedHash,
      this.config.ethereumAddress
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main(): Promise<void> {
  console.log("===========================================");
  console.log("  Minted Protocol - Validator Node V2      ");
  console.log("  (Canton Network Asset Verification)      ");
  console.log("===========================================");
  console.log("");

  if (!DEFAULT_CONFIG.validatorParty) {
    throw new Error("VALIDATOR_PARTY not set");
  }
  if (!DEFAULT_CONFIG.kmsKeyId) {
    throw new Error("KMS_KEY_ID not set");
  }
  if (!DEFAULT_CONFIG.cantonAssetApiUrl) {
    throw new Error("CANTON_ASSET_API_URL not set");
  }

  const validator = new ValidatorNode(DEFAULT_CONFIG);

  const shutdown = () => {
    console.log("\n[Main] Shutting down...");
    validator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await validator.start();
}

main().catch((error) => {
  console.error("[Main] Fatal error:", error);
  process.exit(1);
});

export { ValidatorNode, ValidatorConfig, CantonAssetClient };
