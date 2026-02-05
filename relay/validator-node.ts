/**
 * Minted Protocol - Canton Validator Node
 *
 * Watches for AttestationRequest contracts and signs them using AWS KMS.
 *
 * Flow:
 *   1. Subscribe to Canton ledger
 *   2. Watch for new AttestationRequest contracts
 *   3. Verify collateral requirements
 *   4. Sign with AWS KMS
 *   5. Submit ValidatorSignature to Canton
 */

import Ledger, { CreateEvent } from "@daml/ledger";
import { ContractId } from "@daml/types";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { ethers } from "ethers";
// FIX M-20: Use static import instead of dynamic require
import { formatKMSSignature } from "./signer";
// FIX T-M01: Use shared readSecret utility
import { readSecret } from "./utils";
import * as fs from "fs";

// ============================================================
//                     CONFIGURATION
// ============================================================

interface ValidatorConfig {
  // Canton
  cantonHost: string;
  cantonPort: number;
  cantonToken: string;
  validatorParty: string;  // This validator's party ID

  // AWS KMS
  awsRegion: string;
  kmsKeyId: string;  // KMS key ARN or alias

  // Ethereum (for address derivation)
  ethereumAddress: string;  // Validator's Ethereum address

  // Operational
  pollIntervalMs: number;
  minCollateralRatioBps: number;  // 11000 = 110%
}

const DEFAULT_CONFIG: ValidatorConfig = {
  cantonHost: process.env.CANTON_HOST || "localhost",
  // FIX H-7: Added explicit radix 10 to all parseInt calls
  cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
  // FIX I-C01: Read sensitive values from Docker secrets, fallback to env vars
  cantonToken: readSecret("canton_token", "CANTON_TOKEN"),
  validatorParty: process.env.VALIDATOR_PARTY || "",

  awsRegion: process.env.AWS_REGION || "us-east-1",
  kmsKeyId: process.env.KMS_KEY_ID || "",

  ethereumAddress: process.env.VALIDATOR_ETH_ADDRESS || "",

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
  minCollateralRatioBps: parseInt(process.env.MIN_COLLATERAL_RATIO_BPS || "11000", 10),
};

// ============================================================
//                     DAML TYPES
// ============================================================

interface AttestationPayload {
  attestationId: string;
  globalCantonAssets: string;
  targetAddress: string;
  amount: string;
  isMint: boolean;
  nonce: string;
  chainId: string;
  expiresAt: string;
}

interface AttestationRequest {
  aggregator: string;
  validatorGroup: string[];
  payload: AttestationPayload;
  positionCids: ContractId<unknown>[];
  collectedSignatures: string[];
}

interface InstitutionalEquityPosition {
  bank: string;
  validatorGroup: string[];
  aggregator: string;
  totalValue: string;
  referenceId: string;
  lastUpdated: string;
}

// ============================================================
//                     VALIDATOR NODE
// ============================================================

class ValidatorNode {
  private config: ValidatorConfig;
  private ledger: Ledger;
  private kmsClient: KMSClient;
  // FIX M-18: Use a bounded cache with eviction instead of unbounded Set
  private signedAttestations: Set<string> = new Set();
  private readonly MAX_SIGNED_CACHE = 10000;
  private isRunning: boolean = false;
  // FIX B-C06: Ethereum provider for contract verification
  private ethereumProvider: ethers.JsonRpcProvider | null = null;
  private verifiedBridgeCodeHash: string | null = null;

  constructor(config: ValidatorConfig) {
    this.config = config;

    // FIX H-12: Default to TLS for Canton ledger connections (opt-out instead of opt-in)
    const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
    const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
    this.ledger = new Ledger({
      token: config.cantonToken,
      httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
      wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
    });

    // Initialize AWS KMS
    this.kmsClient = new KMSClient({ region: config.awsRegion });

    // FIX B-C06: Initialize Ethereum provider for bridge verification
    if (process.env.ETHEREUM_RPC_URL) {
      this.ethereumProvider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
    }

    console.log(`[Validator] Initialized`);
    console.log(`[Validator] Party: ${config.validatorParty}`);
    console.log(`[Validator] ETH Address: ${config.ethereumAddress}`);
    console.log(`[Validator] KMS Key: ${config.kmsKeyId}`);
  }

  /**
   * Start the validator node
   */
  async start(): Promise<void> {
    console.log("[Validator] Starting...");
    
    // FIX B-C06: Verify bridge contract before starting
    await this.verifyBridgeContract();
    
    this.isRunning = true;

    // Main loop
    while (this.isRunning) {
      try {
        await this.pollForAttestations();
        // FIX 5C-L02: Write heartbeat file for Docker healthcheck
        try { fs.writeFileSync("/tmp/heartbeat", new Date().toISOString()); } catch {}
      } catch (error) {
        console.error("[Validator] Poll error:", error);
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * Stop the validator node
   */
  stop(): void {
    console.log("[Validator] Stopping...");
    this.isRunning = false;
  }

  /**
   * FIX B-C06: Verify bridge contract exists and has expected code
   * This prevents signing attestations for malicious/wrong contracts
   */
  private async verifyBridgeContract(): Promise<void> {
    const bridgeAddress = process.env.BRIDGE_CONTRACT_ADDRESS;
    
    if (!bridgeAddress) {
      throw new Error("BRIDGE_CONTRACT_ADDRESS not set - cannot verify bridge");
    }
    
    if (!ethers.isAddress(bridgeAddress)) {
      throw new Error(`BRIDGE_CONTRACT_ADDRESS is not a valid address: ${bridgeAddress}`);
    }
    
    if (!this.ethereumProvider) {
      console.warn("[Validator] ETHEREUM_RPC_URL not set - skipping bridge code verification");
      console.warn("[Validator] WARNING: In production, set ETHEREUM_RPC_URL to verify bridge contract");
      return;
    }
    
    console.log(`[Validator] Verifying bridge contract at ${bridgeAddress}...`);
    
    try {
      const code = await this.ethereumProvider.getCode(bridgeAddress);
      
      if (code === "0x" || code.length < 100) {
        throw new Error(`SECURITY: Bridge contract at ${bridgeAddress} has no code or is EOA`);
      }
      
      // Hash the code for comparison/logging
      this.verifiedBridgeCodeHash = ethers.keccak256(code);
      console.log(`[Validator] Bridge code hash: ${this.verifiedBridgeCodeHash}`);
      
      // If expected hash is set, verify it matches
      const expectedHash = process.env.EXPECTED_BRIDGE_CODE_HASH;
      if (expectedHash && expectedHash !== this.verifiedBridgeCodeHash) {
        throw new Error(`SECURITY: Bridge code hash mismatch! Expected ${expectedHash}, got ${this.verifiedBridgeCodeHash}`);
      }
      
      console.log(`[Validator] ✓ Bridge contract verified at ${bridgeAddress}`);
    } catch (error: any) {
      if (error.message?.includes("SECURITY:")) {
        throw error;
      }
      throw new Error(`Failed to verify bridge contract: ${error.message}`);
    }
  }

  /**
   * Poll for attestation requests that need signing
   */
  private async pollForAttestations(): Promise<void> {
    // Query AttestationRequest contracts where we're in the validator group
    const attestations = await (this.ledger.query as any)(
      "MintedProtocolV2:AttestationRequest",
      {}  // Query all, filter locally
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
      if (request.collectedSignatures.includes(this.config.validatorParty)) {
        continue;
      }

      // Check if we've signed in this session (prevent double-signing during latency)
      if (this.signedAttestations.has(attestationId)) {
        continue;
      }

      // Check expiration
      const expiresAt = new Date(payload.expiresAt);
      if (expiresAt <= new Date()) {
        console.log(`[Validator] Attestation ${attestationId} expired, skipping`);
        continue;
      }

      // Verify collateral
      const isValid = await this.verifyCollateral(request);
      if (!isValid) {
        console.log(`[Validator] Attestation ${attestationId} failed collateral check, skipping`);
        continue;
      }

      // Sign it
      console.log(`[Validator] Signing attestation ${attestationId}...`);
      await this.signAttestation(attestation.contractId, payload);
    }
  }

  /**
   * Verify the attestation has sufficient collateral backing
   */
  // FIX C-09: Fetch positions ONCE and deduplicate to prevent inflated collateral
  // FIX H-13: Use ethers.parseUnits instead of parseFloat for financial precision
  private async verifyCollateral(request: AttestationRequest): Promise<boolean> {
    const payload = request.payload;

    // FIX C-09: Fetch all positions ONCE, not per positionCid
    let totalValue = 0n;
    try {
      const positions = await (this.ledger.query as any)(
        "MintedProtocolV2:InstitutionalEquityPosition",
        {}
      ) as CreateEvent<InstitutionalEquityPosition>[];

      // Deduplicate by referenceId to prevent double-counting
      const seen = new Set<string>();
      for (const pos of positions) {
        const refId = pos.payload.referenceId;
        if (seen.has(refId)) continue;
        seen.add(refId);
        // FIX H-13: Use ethers.parseUnits for precision
        totalValue += ethers.parseUnits(pos.payload.totalValue, 18);
      }
    } catch (error) {
      console.warn(`[Validator] Failed to fetch positions:`, error);
      return false;
    }

    // FIX H-13: Use ethers.parseUnits instead of parseFloat
    const requestedAmount = ethers.parseUnits(payload.amount, 18);
    const reportedAssets = ethers.parseUnits(payload.globalCantonAssets, 18);

    // Check reported assets match fetched total
    // Allow small rounding difference
    const assetsDiff = totalValue > reportedAssets
      ? totalValue - reportedAssets
      : reportedAssets - totalValue;

    if (assetsDiff > 1000000n) {  // 0.000001 tolerance
      console.warn(`[Validator] Asset mismatch: reported=${payload.globalCantonAssets}, found=${totalValue}`);
      return false;
    }

    // Check collateral ratio (e.g., 110%)
    const requiredCollateral = requestedAmount * BigInt(this.config.minCollateralRatioBps) / 10000n;

    if (reportedAssets < requiredCollateral) {
      console.warn(`[Validator] Insufficient collateral: ${reportedAssets} < ${requiredCollateral}`);
      return false;
    }

    console.log(`[Validator] Collateral verified: ${payload.globalCantonAssets} >= ${requiredCollateral} (${this.config.minCollateralRatioBps / 100}%)`);
    return true;
  }

  /**
   * Sign attestation and submit to Canton
   */
  private async signAttestation(
    contractId: ContractId<AttestationRequest>,
    payload: AttestationPayload
  ): Promise<void> {
    const attestationId = payload.attestationId;

    // FIX H-14: Mark as signing BEFORE async KMS call to prevent TOCTOU race
    this.signedAttestations.add(attestationId);

    try {
      // Build message hash (same as Solidity contract expects)
      const messageHash = this.buildMessageHash(payload);

      // Sign with KMS
      const signature = await this.signWithKMS(messageHash);

      // Submit to Canton
      await (this.ledger.exercise as any)(
        "MintedProtocolV2:AttestationRequest",
        contractId,
        "ProvideSignature",
        {
          validator: this.config.validatorParty,
          ecdsaSignature: signature,
        }
      );

      console.log(`[Validator] Signed attestation ${attestationId}`);

      // FIX M-18: Evict oldest 10% of entries if cache exceeds limit
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

      // FIX H-14: Remove from set on failure so it can be retried
      // (except if the contract says we already signed)
      if (error.message?.includes("VALIDATOR_ALREADY_SIGNED")) {
        // Already signed on ledger - keep in set
      } else {
        this.signedAttestations.delete(attestationId);
      }
    }
  }

  /**
   * Build the message hash for signing
   */
  private buildMessageHash(payload: AttestationPayload): string {
    const idBytes32 = ethers.id(payload.attestationId);
    // FIX T-C01: Use BigInt for chainId to avoid IEEE 754 precision loss on large chain IDs
    const chainId = BigInt(payload.chainId);
    const timestamp = Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600;

    // This must match what BLEBridgeV9 expects
    return ethers.solidityPackedKeccak256(
      ["bytes32", "uint256", "uint256", "uint256", "uint256", "address"],
      [
        idBytes32,
        ethers.parseUnits(payload.globalCantonAssets, 18),
        BigInt(payload.nonce),
        BigInt(timestamp),
        chainId,
        // FIX C-7: Require BRIDGE_CONTRACT_ADDRESS instead of falling back to ZeroAddress
        process.env.BRIDGE_CONTRACT_ADDRESS || (() => { throw new Error("BRIDGE_CONTRACT_ADDRESS not set"); })(),
      ]
    );
  }

  /**
   * Sign a message hash using AWS KMS
   */
  private async signWithKMS(messageHash: string): Promise<string> {
    // Convert to eth signed message hash
    const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHash));
    const hashBytes = Buffer.from(ethSignedHash.slice(2), "hex");

    // Sign with KMS
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

    // Convert DER to RSV format
    const derSignature = Buffer.from(response.Signature);
    const rsvSignature = this.derToRsv(derSignature, ethSignedHash);

    return rsvSignature;
  }

  /**
   * Convert DER-encoded signature to RSV format
   * Uses the logic from signer.ts
   */
  // FIX M-20: Use static import (declared at top of file) instead of dynamic require
  private derToRsv(derSig: Buffer, messageHash: string): string {
    return formatKMSSignature(derSig, messageHash, this.config.ethereumAddress);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
//                     MAIN
// ============================================================

async function main(): Promise<void> {
  console.log("===========================================");
  console.log("  Minted Protocol - Validator Node         ");
  console.log("===========================================");
  console.log("");

  // Validate config
  if (!DEFAULT_CONFIG.validatorParty) {
    throw new Error("VALIDATOR_PARTY not set");
  }
  if (!DEFAULT_CONFIG.kmsKeyId) {
    throw new Error("KMS_KEY_ID not set");
  }
  if (!DEFAULT_CONFIG.ethereumAddress) {
    throw new Error("VALIDATOR_ETH_ADDRESS not set");
  }
  // FIX M-23: Validate Ethereum address format
  if (!ethers.isAddress(DEFAULT_CONFIG.ethereumAddress)) {
    throw new Error("VALIDATOR_ETH_ADDRESS is not a valid Ethereum address");
  }
  // FIX C-7: Validate bridge contract address at startup
  if (!process.env.BRIDGE_CONTRACT_ADDRESS) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS not set");
  }
  if (!ethers.isAddress(process.env.BRIDGE_CONTRACT_ADDRESS)) {
    throw new Error("BRIDGE_CONTRACT_ADDRESS is not a valid Ethereum address");
  }
  if (!DEFAULT_CONFIG.cantonToken) {
    throw new Error("CANTON_TOKEN not set");
  }

  // Create validator node
  const validator = new ValidatorNode(DEFAULT_CONFIG);

  // Handle shutdown
  const shutdown = () => {
    console.log("\n[Main] Shutting down...");
    validator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start validator
  await validator.start();
}

// FIX T-C03: Handle unhandled promise rejections to prevent silent failures
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Main] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

main().catch((error) => {
  console.error("[Main] Fatal error:", error);
  process.exit(1);
});

export { ValidatorNode, ValidatorConfig };
