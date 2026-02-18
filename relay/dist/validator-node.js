"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidatorNode = void 0;
const ledger_1 = __importDefault(require("@daml/ledger"));
const client_kms_1 = require("@aws-sdk/client-kms");
const ethers_1 = require("ethers");
// FIX M-20: Use static import instead of dynamic require
const signer_1 = require("./signer");
// FIX T-M01: Use shared readSecret utility
const utils_1 = require("./utils");
const fs = __importStar(require("fs"));
const DEFAULT_CONFIG = {
    cantonHost: process.env.CANTON_HOST || "localhost",
    // FIX H-7: Added explicit radix 10 to all parseInt calls
    cantonPort: parseInt(process.env.CANTON_PORT || "6865", 10),
    // FIX I-C01: Read sensitive values from Docker secrets, fallback to env vars
    cantonToken: (0, utils_1.readSecret)("canton_token", "CANTON_TOKEN"),
    validatorParty: process.env.VALIDATOR_PARTY || "",
    awsRegion: process.env.AWS_REGION || "us-east-1",
    kmsKeyId: process.env.KMS_KEY_ID || "",
    ethereumAddress: process.env.VALIDATOR_ETH_ADDRESS || "",
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
    minCollateralRatioBps: parseInt(process.env.MIN_COLLATERAL_RATIO_BPS || "11000", 10),
};
// ============================================================
//                     VALIDATOR NODE
// ============================================================
class ValidatorNode {
    config;
    ledger;
    kmsClient;
    // FIX M-18: Use a bounded cache with eviction instead of unbounded Set
    signedAttestations = new Set();
    MAX_SIGNED_CACHE = 10000;
    isRunning = false;
    // FIX B-C06: Ethereum provider for contract verification
    ethereumProvider = null;
    verifiedBridgeCodeHash = null;
    constructor(config) {
        this.config = config;
        // FIX H-12: Default to TLS for Canton ledger connections (opt-out instead of opt-in)
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        const wsProtocol = process.env.CANTON_USE_TLS === "false" ? "ws" : "wss";
        this.ledger = new ledger_1.default({
            token: config.cantonToken,
            httpBaseUrl: `${protocol}://${config.cantonHost}:${config.cantonPort}`,
            wsBaseUrl: `${wsProtocol}://${config.cantonHost}:${config.cantonPort}`,
        });
        // Initialize AWS KMS
        this.kmsClient = new client_kms_1.KMSClient({ region: config.awsRegion });
        // FIX B-C06: Initialize Ethereum provider for bridge verification
        if (process.env.ETHEREUM_RPC_URL) {
            this.ethereumProvider = new ethers_1.ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
        }
        console.log(`[Validator] Initialized`);
        console.log(`[Validator] Party: ${config.validatorParty}`);
        console.log(`[Validator] ETH Address: ${config.ethereumAddress}`);
        console.log(`[Validator] KMS Key: ${config.kmsKeyId}`);
    }
    /**
     * Start the validator node
     */
    async start() {
        console.log("[Validator] Starting...");
        // FIX B-C06: Verify bridge contract before starting
        await this.verifyBridgeContract();
        this.isRunning = true;
        // Main loop
        while (this.isRunning) {
            try {
                await this.pollForAttestations();
                // FIX 5C-L02: Write heartbeat file for Docker healthcheck
                try {
                    fs.writeFileSync("/tmp/heartbeat", new Date().toISOString());
                }
                catch { }
            }
            catch (error) {
                console.error("[Validator] Poll error:", error);
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }
    /**
     * Stop the validator node
     */
    stop() {
        console.log("[Validator] Stopping...");
        this.isRunning = false;
    }
    /**
     * FIX B-C06: Verify bridge contract exists and has expected code
     * This prevents signing attestations for malicious/wrong contracts
     */
    async verifyBridgeContract() {
        const bridgeAddress = process.env.BRIDGE_CONTRACT_ADDRESS;
        if (!bridgeAddress) {
            throw new Error("BRIDGE_CONTRACT_ADDRESS not set - cannot verify bridge");
        }
        if (!ethers_1.ethers.isAddress(bridgeAddress)) {
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
            this.verifiedBridgeCodeHash = ethers_1.ethers.keccak256(code);
            console.log(`[Validator] Bridge code hash: ${this.verifiedBridgeCodeHash}`);
            // If expected hash is set, verify it matches
            const expectedHash = process.env.EXPECTED_BRIDGE_CODE_HASH;
            if (expectedHash && expectedHash !== this.verifiedBridgeCodeHash) {
                throw new Error(`SECURITY: Bridge code hash mismatch! Expected ${expectedHash}, got ${this.verifiedBridgeCodeHash}`);
            }
            console.log(`[Validator] ✓ Bridge contract verified at ${bridgeAddress}`);
        }
        catch (error) {
            if (error.message?.includes("SECURITY:")) {
                throw error;
            }
            throw new Error(`Failed to verify bridge contract: ${error.message}`);
        }
    }
    /**
     * Poll for attestation requests that need signing
     * FIX B-H05: Added query timeout to prevent indefinite hangs
     */
    async pollForAttestations() {
        // FIX B-H05: Timeout for Canton ledger queries (30 seconds)
        const QUERY_TIMEOUT_MS = 30000;
        const queryWithTimeout = async (queryFn) => {
            return Promise.race([
                queryFn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Canton query timeout")), QUERY_TIMEOUT_MS))
            ]);
        };
        // Query AttestationRequest contracts where we're in the validator group
        // FIX M-08: Use MintedProtocolV3 to match relay-service.ts
        const attestations = await queryWithTimeout(() => this.ledger.query("MintedProtocolV3:AttestationRequest", {} // Query all, filter locally
        ));
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
    async verifyCollateral(request) {
        const payload = request.payload;
        // FIX C-09: Fetch all positions ONCE, not per positionCid
        let totalValue = 0n;
        try {
            // FIX M-08: Use MintedProtocolV3 to match relay-service.ts
            const positions = await this.ledger.query("MintedProtocolV3:InstitutionalEquityPosition", {});
            // Deduplicate by referenceId to prevent double-counting
            const seen = new Set();
            for (const pos of positions) {
                const refId = pos.payload.referenceId;
                if (seen.has(refId))
                    continue;
                seen.add(refId);
                // FIX H-13: Use ethers.parseUnits for precision
                totalValue += ethers_1.ethers.parseUnits(pos.payload.totalValue, 18);
            }
        }
        catch (error) {
            console.warn(`[Validator] Failed to fetch positions:`, error);
            return false;
        }
        // FIX H-13: Use ethers.parseUnits instead of parseFloat
        const requestedAmount = ethers_1.ethers.parseUnits(payload.amount, 18);
        const reportedAssets = ethers_1.ethers.parseUnits(payload.globalCantonAssets, 18);
        // Check reported assets match fetched total
        // Allow small rounding difference
        const assetsDiff = totalValue > reportedAssets
            ? totalValue - reportedAssets
            : reportedAssets - totalValue;
        if (assetsDiff > 1000000n) { // 0.000001 tolerance
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
    async signAttestation(contractId, payload) {
        const attestationId = payload.attestationId;
        // FIX H-14: Mark as signing BEFORE async KMS call to prevent TOCTOU race
        this.signedAttestations.add(attestationId);
        try {
            // Build message hash (same as Solidity contract expects)
            const messageHash = this.buildMessageHash(payload);
            // Sign with KMS
            const signature = await this.signWithKMS(messageHash);
            // Submit to Canton
            // FIX M-08: Use MintedProtocolV3 to match relay-service.ts
            await this.ledger.exercise("MintedProtocolV3:AttestationRequest", contractId, "ProvideSignature", {
                validator: this.config.validatorParty,
                ecdsaSignature: signature,
            });
            console.log(`[Validator] Signed attestation ${attestationId}`);
            // FIX M-18: Evict oldest 10% of entries if cache exceeds limit
            if (this.signedAttestations.size > this.MAX_SIGNED_CACHE) {
                const toEvict = Math.floor(this.MAX_SIGNED_CACHE * 0.1);
                let evicted = 0;
                for (const key of this.signedAttestations) {
                    if (evicted >= toEvict)
                        break;
                    this.signedAttestations.delete(key);
                    evicted++;
                }
            }
        }
        catch (error) {
            console.error(`[Validator] Failed to sign attestation ${attestationId}:`, error.message);
            // FIX H-14: Remove from set on failure so it can be retried
            // (except if the contract says we already signed)
            if (error.message?.includes("VALIDATOR_ALREADY_SIGNED")) {
                // Already signed on ledger - keep in set
            }
            else {
                this.signedAttestations.delete(attestationId);
            }
        }
    }
    /**
     * Build the message hash for signing
     */
    buildMessageHash(payload) {
        const idBytes32 = ethers_1.ethers.id(payload.attestationId);
        // FIX T-C01: Use BigInt for chainId to avoid IEEE 754 precision loss on large chain IDs
        const chainId = BigInt(payload.chainId);
        // FIX B-M01: Validate timestamp to prevent negative values
        const rawTimestamp = Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600;
        const timestamp = Math.max(1, rawTimestamp);
        // This must match what BLEBridgeV9 expects
        return ethers_1.ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256", "uint256", "uint256", "address"], [
            idBytes32,
            ethers_1.ethers.parseUnits(payload.globalCantonAssets, 18),
            BigInt(payload.nonce),
            BigInt(timestamp),
            chainId,
            // FIX C-7: Require BRIDGE_CONTRACT_ADDRESS instead of falling back to ZeroAddress
            process.env.BRIDGE_CONTRACT_ADDRESS || (() => { throw new Error("BRIDGE_CONTRACT_ADDRESS not set"); })(),
        ]);
    }
    /**
     * Sign a message hash using AWS KMS
     */
    async signWithKMS(messageHash) {
        // Convert to eth signed message hash
        const ethSignedHash = ethers_1.ethers.hashMessage(ethers_1.ethers.getBytes(messageHash));
        const hashBytes = Buffer.from(ethSignedHash.slice(2), "hex");
        // Sign with KMS
        const command = new client_kms_1.SignCommand({
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
    derToRsv(derSig, messageHash) {
        return (0, signer_1.formatKMSSignature)(derSig, messageHash, this.config.ethereumAddress);
    }
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.ValidatorNode = ValidatorNode;
// ============================================================
//                     MAIN
// ============================================================
async function main() {
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
    if (!ethers_1.ethers.isAddress(DEFAULT_CONFIG.ethereumAddress)) {
        throw new Error("VALIDATOR_ETH_ADDRESS is not a valid Ethereum address");
    }
    // FIX C-7: Validate bridge contract address at startup
    if (!process.env.BRIDGE_CONTRACT_ADDRESS) {
        throw new Error("BRIDGE_CONTRACT_ADDRESS not set");
    }
    if (!ethers_1.ethers.isAddress(process.env.BRIDGE_CONTRACT_ADDRESS)) {
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
//# sourceMappingURL=validator-node.js.map