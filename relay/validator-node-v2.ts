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

import Ledger, { CreateEvent } from "@daml/ledger";
import { ContractId } from "@daml/types";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { ethers } from "ethers";
import { formatKMSSignature } from "./signer";
import { readSecret, enforceTLSSecurity, requireHTTPS } from "./utils";
import * as fs from "fs";

// INFRA-H-02 / INFRA-H-06: Enforce TLS certificate validation at process level
enforceTLSSecurity();

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

  // AWS KMS — primary and rotation keys
  awsRegion: string;
  kmsKeyId: string;               // Primary signing key
  kmsRotationKeyId: string;       // FIX INFRA-03: Secondary key for zero-downtime rotation
  kmsKeyRotationEnabled: boolean; // Whether rotation is active

  // Ethereum — addresses for both keys
  ethereumAddress: string;              // Primary key ETH address
  rotationEthereumAddress: string;      // Rotation key ETH address
  bridgeContractAddress: string;

  // Operational
  pollIntervalMs: number;
  minCollateralRatioBps: number;

  // FIX P2-CODEX: Template allowlist to prevent signing arbitrary contract types
  allowedTemplates: string[];
}

const DEFAULT_CONFIG: ValidatorConfig = {
  cantonLedgerHost: process.env.CANTON_LEDGER_HOST || "localhost",
  cantonLedgerPort: parseInt(process.env.CANTON_LEDGER_PORT || "6865", 10),
  cantonLedgerToken: readSecret("canton_token", "CANTON_LEDGER_TOKEN"),
  validatorParty: process.env.VALIDATOR_PARTY || "",

  cantonAssetApiUrl: process.env.CANTON_ASSET_API_URL || "https://api.canton.network",
  cantonAssetApiKey: readSecret("canton_asset_api_key", "CANTON_ASSET_API_KEY"),

  awsRegion: process.env.AWS_REGION || "us-east-1",
  kmsKeyId: process.env.KMS_KEY_ID || "",
  kmsRotationKeyId: process.env.KMS_ROTATION_KEY_ID || "",
  kmsKeyRotationEnabled: process.env.KMS_KEY_ROTATION_ENABLED === "true",

  ethereumAddress: process.env.VALIDATOR_ETH_ADDRESS || "",
  rotationEthereumAddress: process.env.ROTATION_ETH_ADDRESS || "",
  bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
  minCollateralRatioBps: parseInt(process.env.MIN_COLLATERAL_RATIO_BPS || "11000", 10),

  // FIX P2-CODEX: Only sign attestation requests from allowed DAML templates
  allowedTemplates: (process.env.ALLOWED_TEMPLATES || "MintedProtocolV3:AttestationRequest")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean),
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
   * INFRA-H-06: All external API calls use HTTPS with certificate validation
   * enforced by enforceTLSSecurity() at process level
   */
  async getAssetSnapshot(): Promise<CantonAssetSnapshot> {
    // INFRA-H-06: Validate URL scheme before making request
    if (!this.apiUrl.startsWith("https://") && process.env.NODE_ENV !== "development") {
      throw new Error(`SECURITY: Canton Asset API must use HTTPS. Got: ${this.apiUrl.substring(0, 40)}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/assets/snapshot`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/assets/batch`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assetIds }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/state/verify`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stateHash }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return false;
    }

    const data: any = await response.json();
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
  private readonly MAX_SIGNED_CACHE = 10000;
  private isRunning: boolean = false;

  private signingTimestamps: number[] = [];
  private readonly MAX_SIGNS_PER_WINDOW = parseInt(process.env.MAX_SIGNS_PER_WINDOW || "50", 10);
  private readonly SIGNING_WINDOW_MS = parseInt(process.env.SIGNING_WINDOW_MS || "3600000", 10); // 1 hour
  private lastSignedTotalValue: bigint = 0n;
  private readonly MAX_VALUE_JUMP_BPS = parseInt(process.env.MAX_VALUE_JUMP_BPS || "2000", 10); // 20%

  // FIX INFRA-03: KMS key rotation state
  private activeKmsKeyId: string;
  private activeEthAddress: string;
  private rotationInProgress: boolean = false;

  constructor(config: ValidatorConfig) {
    this.config = config;

    // FIX INFRA-03: Initialize with primary key, support rotation
    this.activeKmsKeyId = config.kmsKeyId;
    this.activeEthAddress = config.ethereumAddress;

    if (config.kmsKeyRotationEnabled && config.kmsRotationKeyId) {
      console.log(`[Validator] Key rotation ENABLED`);
      console.log(`[Validator]   Primary key: ${config.kmsKeyId}`);
      console.log(`[Validator]   Rotation key: ${config.kmsRotationKeyId}`);
      console.log(`[Validator]   Primary ETH: ${config.ethereumAddress}`);
      console.log(`[Validator]   Rotation ETH: ${config.rotationEthereumAddress}`);
    }

    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
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

  /**
   * FIX INFRA-03: Switch to rotation key for zero-downtime key rotation
   *
   * Key rotation flow:
   *   1. Generate new KMS key, get its ETH address
   *   2. Grant VALIDATOR_ROLE to new address on BLEBridgeV9 (via timelock)
   *   3. Set KMS_ROTATION_KEY_ID + ROTATION_ETH_ADDRESS + KMS_KEY_ROTATION_ENABLED=true
   *   4. Call activateRotationKey() — starts signing with new key
   *   5. Verify signatures working, then revoke old key's VALIDATOR_ROLE
   *   6. Promote: move rotation key to primary config, clear rotation fields
   */
  async activateRotationKey(): Promise<void> {
    if (!this.config.kmsRotationKeyId || !this.config.rotationEthereumAddress) {
      throw new Error("Rotation key not configured");
    }

    console.log(`[Validator] ⚠️ ACTIVATING ROTATION KEY`);
    console.log(`[Validator]   Old: ${this.activeKmsKeyId} → ${this.activeEthAddress}`);
    console.log(`[Validator]   New: ${this.config.kmsRotationKeyId} → ${this.config.rotationEthereumAddress}`);

    // Test signing with rotation key before switching
    try {
      const testHash = ethers.id("rotation-key-test");
      await this.signWithKMSKey(testHash, this.config.kmsRotationKeyId, this.config.rotationEthereumAddress);
      console.log(`[Validator] ✓ Rotation key signing test passed`);
    } catch (error: any) {
      throw new Error(`Rotation key signing test FAILED: ${error.message}`);
    }

    this.rotationInProgress = true;
    this.activeKmsKeyId = this.config.kmsRotationKeyId;
    this.activeEthAddress = this.config.rotationEthereumAddress;
    this.rotationInProgress = false;

    console.log(`[Validator] ✅ Now signing with rotation key: ${this.activeKmsKeyId}`);
  }

  /**
   * FIX INFRA-03: Get current active key status
   */
  getKeyStatus(): { activeKeyId: string; activeEthAddress: string; rotationAvailable: boolean } {
    return {
      activeKeyId: this.activeKmsKeyId,
      activeEthAddress: this.activeEthAddress,
      rotationAvailable: !!(this.config.kmsRotationKeyId && this.config.rotationEthereumAddress),
    };
  }

  async start(): Promise<void> {
    console.log("[Validator] Starting...");
    this.isRunning = true;

    while (this.isRunning) {
      try {
        await this.pollForAttestations();
        try { fs.writeFileSync("/tmp/heartbeat", new Date().toISOString()); } catch {}
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
    // FIX P2-CODEX: Only query allowed DAML templates (prevents signing arbitrary contracts)
    const templateId = this.config.allowedTemplates[0] || "MintedProtocolV3:AttestationRequest";
    const attestations = await (this.ledger.query as any)(
      templateId,
      {}
    ) as CreateEvent<AttestationRequest>[];

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

      const now = Date.now();
      this.signingTimestamps = this.signingTimestamps.filter(t => now - t < this.SIGNING_WINDOW_MS);
      if (this.signingTimestamps.length >= this.MAX_SIGNS_PER_WINDOW) {
        console.error(`[Validator] ⚠️ RATE LIMIT: ${this.signingTimestamps.length} signatures in window. ` +
          `Max=${this.MAX_SIGNS_PER_WINDOW}. Pausing to prevent key abuse.`);
        continue;
      }

      const attestedTotalValue = ethers.parseUnits(payload.totalCantonValue, 18);
      if (this.lastSignedTotalValue > 0n) {
        const diff = attestedTotalValue > this.lastSignedTotalValue
          ? attestedTotalValue - this.lastSignedTotalValue
          : this.lastSignedTotalValue - attestedTotalValue;
        const jumpBps = (diff * 10000n) / this.lastSignedTotalValue;
        if (jumpBps > BigInt(this.MAX_VALUE_JUMP_BPS)) {
          console.error(`[Validator] ⚠️ ANOMALY: Total value jumped ${jumpBps} bps ` +
            `(${this.lastSignedTotalValue} → ${attestedTotalValue}). Max=${this.MAX_VALUE_JUMP_BPS} bps. Skipping.`);
          continue;
        }
      }

      // Sign it
      console.log(`[Validator] Signing attestation ${attestationId}...`);
      this.signingTimestamps.push(now);
      this.lastSignedTotalValue = attestedTotalValue;
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

        const attestedValue = ethers.parseUnits(attestedAsset.assetValue, 18);

        // 0.1% of $500M = $500K which is too high; cap at $100K absolute
        const MAX_ABSOLUTE_TOLERANCE = ethers.parseUnits("100000", 18); // $100K
        const percentTolerance = cantonAsset.currentValue / 1000n; // 0.1%
        const tolerance = percentTolerance < MAX_ABSOLUTE_TOLERANCE ? percentTolerance : MAX_ABSOLUTE_TOLERANCE;
        
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
      const MAX_TOTAL_TOLERANCE = ethers.parseUnits("100000", 18); // $100K
      const percentTolerance = snapshot.totalValue / 1000n;
      const tolerance = percentTolerance < MAX_TOTAL_TOLERANCE ? percentTolerance : MAX_TOTAL_TOLERANCE;
      
      const totalDiff = attestedTotal > snapshot.totalValue
        ? attestedTotal - snapshot.totalValue
        : snapshot.totalValue - attestedTotal;

      // Only verify against assets included in attestation
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

      // INFRA-CRIT-02: Verify target bridge address matches our configured bridge contract
      // Prevents signing attestations that route funds to unauthorized contracts
      if (payload.targetBridgeAddress &&
          payload.targetBridgeAddress.toLowerCase() !== this.config.bridgeContractAddress.toLowerCase()) {
        return {
          valid: false,
          reason: `Bridge address mismatch: payload=${payload.targetBridgeAddress}, expected=${this.config.bridgeContractAddress}`,
          stateHash: snapshot.stateHash,
        };
      }

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

    this.signedAttestations.add(attestationId);

    try {
      // Build message hash (includes cantonStateHash for on-ledger verification)
      const messageHash = this.buildMessageHash(payload, cantonStateHash);

      // Sign with KMS
      const signature = await this.signWithKMS(messageHash);

      // Submit to Canton
      await (this.ledger.exercise as any)(
        "MintedProtocolV3:AttestationRequest",
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

      if (this.signedAttestations.size > this.MAX_SIGNED_CACHE) {
        const toEvict = Math.floor(this.MAX_SIGNED_CACHE * 0.1);
        let evicted = 0;
        for (const key of this.signedAttestations) {
          if (evicted >= toEvict) break;
          this.signedAttestations.delete(key);
          evicted++;
        }
      }

    } catch (error: any) {
      console.error(`[Validator] Failed to sign attestation ${attestationId}:`, error.message);

      // (except if the contract says we already signed)
      if (error.message?.includes("VALIDATOR_ALREADY_SIGNED") ||
          error.message?.includes("already signed")) {
        // Already signed on ledger - keep in set
      } else {
        this.signedAttestations.delete(attestationId);
      }
    }
  }

  private buildMessageHash(payload: AttestationPayload, cantonStateHash?: string): string {
    const cantonAssets = ethers.parseUnits(payload.totalCantonValue, 18);
    const nonce = BigInt(payload.nonce);
    const timestamp = BigInt(Math.max(1, Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600));

    // FIX C-05: Include entropy in hash (matches BLEBridgeV9 signature verification)
    const entropy = (payload as any).entropy
      ? ((payload as any).entropy.startsWith("0x") ? (payload as any).entropy : "0x" + (payload as any).entropy)
      : ethers.ZeroHash;

    // FIX CROSS-CHAIN-01: Include Canton state hash for on-ledger verification
    const stateHash = cantonStateHash
      ? (cantonStateHash.startsWith("0x") ? cantonStateHash : "0x" + cantonStateHash)
      : ethers.ZeroHash;

    // FIX P2-CODEX: Derive attestation ID matching BLEBridgeV9.computeAttestationId()
    // Previously used ethers.id(payload.attestationId) which is keccak256(utf8) — wrong.
    // On-chain: keccak256(abi.encodePacked(nonce, cantonAssets, timestamp, entropy, cantonStateHash, chainid, address))
    const idBytes32 = ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
      [nonce, cantonAssets, timestamp, entropy, stateHash, BigInt(payload.targetChainId), payload.targetBridgeAddress]
    );

    // Message hash matches BLEBridgeV9.processAttestation() signature verification:
    // keccak256(abi.encodePacked(id, cantonAssets, nonce, timestamp, entropy, cantonStateHash, chainid, address))
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"],
      [
        idBytes32,
        cantonAssets,
        nonce,
        timestamp,
        entropy,
        stateHash,
        BigInt(payload.targetChainId),
        payload.targetBridgeAddress,
      ]
    );
  }

  // FIX INFRA-03: Sign with currently active KMS key (supports key rotation)
  private async signWithKMS(messageHash: string): Promise<string> {
    return this.signWithKMSKey(messageHash, this.activeKmsKeyId, this.activeEthAddress);
  }

  /**
   * FIX INFRA-03: Sign with a specific KMS key
   * Used for both normal signing and rotation key testing
   */
  private async signWithKMSKey(messageHash: string, keyId: string, ethAddress: string): Promise<string> {
    const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHash));
    const hashBytes = Buffer.from(ethSignedHash.slice(2), "hex");

    const command = new SignCommand({
      KeyId: keyId,
      Message: hashBytes,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    });

    const response = await this.kmsClient.send(command);

    if (!response.Signature) {
      throw new Error(`KMS key ${keyId} returned empty signature`);
    }

    return formatKMSSignature(
      Buffer.from(response.Signature),
      ethSignedHash,
      ethAddress
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
  // Validate required addresses at startup
  if (!DEFAULT_CONFIG.ethereumAddress) {
    throw new Error("VALIDATOR_ETH_ADDRESS not set");
  }
  if (!ethers.isAddress(DEFAULT_CONFIG.ethereumAddress)) {
    throw new Error("VALIDATOR_ETH_ADDRESS is not a valid Ethereum address");
  }
  if (!DEFAULT_CONFIG.bridgeContractAddress) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS not set");
  }
  if (!ethers.isAddress(DEFAULT_CONFIG.bridgeContractAddress)) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS is not a valid Ethereum address");
  }
  if (!DEFAULT_CONFIG.cantonLedgerToken) {
    throw new Error("CANTON_LEDGER_TOKEN not set");
  }
  if (!DEFAULT_CONFIG.cantonAssetApiKey) {
    throw new Error("CANTON_ASSET_API_KEY not set");
  }
  if (!DEFAULT_CONFIG.cantonAssetApiUrl.startsWith("https://") && process.env.NODE_ENV !== "development") {
    throw new Error("CANTON_ASSET_API_URL must use HTTPS in production");
  }
  // FIX P2-CODEX: Validate template allowlist is not empty
  if (DEFAULT_CONFIG.allowedTemplates.length === 0) {
    throw new Error("ALLOWED_TEMPLATES must not be empty — validator needs at least one template to query");
  }
  console.log(`[Main] Allowed templates: ${DEFAULT_CONFIG.allowedTemplates.join(", ")}`);
  // INFRA-H-01 / INFRA-H-02: Validate HTTPS for all external endpoints
  requireHTTPS(DEFAULT_CONFIG.cantonAssetApiUrl, "CANTON_ASSET_API_URL");

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

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

main().catch((error) => {
  console.error("[Main] Fatal error:", error);
  process.exit(1);
});

export { ValidatorNode, ValidatorConfig, CantonAssetClient };
