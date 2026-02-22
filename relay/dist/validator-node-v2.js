"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CantonAssetClient = exports.ValidatorNode = void 0;
const canton_client_1 = require("./canton-client");
const client_kms_1 = require("@aws-sdk/client-kms");
const ethers_1 = require("ethers");
const signer_1 = require("./signer");
const utils_1 = require("./utils");
const fs = __importStar(require("fs"));
// INFRA-H-02 / INFRA-H-06: Enforce TLS certificate validation at process level
(0, utils_1.enforceTLSSecurity)();
const DEFAULT_CONFIG = {
    cantonLedgerHost: process.env.CANTON_LEDGER_HOST || "localhost",
    cantonLedgerPort: parseInt(process.env.CANTON_LEDGER_PORT || "6865", 10),
    cantonLedgerToken: (0, utils_1.readSecret)("canton_token", "CANTON_LEDGER_TOKEN"),
    validatorParty: process.env.VALIDATOR_PARTY || "",
    cantonAssetApiUrl: process.env.CANTON_ASSET_API_URL || "https://api.canton.network",
    cantonAssetApiKey: (0, utils_1.readSecret)("canton_asset_api_key", "CANTON_ASSET_API_KEY"),
    awsRegion: process.env.AWS_REGION || "us-east-1",
    kmsKeyId: process.env.KMS_KEY_ID || "",
    kmsRotationKeyId: process.env.KMS_ROTATION_KEY_ID || "",
    kmsKeyRotationEnabled: process.env.KMS_KEY_ROTATION_ENABLED === "true",
    ethereumAddress: process.env.VALIDATOR_ETH_ADDRESS || "",
    rotationEthereumAddress: process.env.ROTATION_ETH_ADDRESS || "",
    bridgeContractAddress: process.env.BRIDGE_CONTRACT_ADDRESS || "",
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
    minCollateralRatioBps: parseInt(process.env.MIN_COLLATERAL_RATIO_BPS || "11000", 10),
    // Only sign attestation requests from allowed DAML templates
    allowedTemplates: (process.env.ALLOWED_TEMPLATES || "MintedProtocolV3:AttestationRequest")
        .split(",")
        .map(t => t.trim())
        .filter(Boolean),
};
// ============================================================
//                     CANTON ASSET API CLIENT
// ============================================================
class CantonAssetClient {
    apiUrl;
    apiKey;
    constructor(apiUrl, apiKey) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
    }
    /**
     * Fetch current snapshot of all tokenized assets from Canton Network
     * INFRA-H-06: All external API calls use HTTPS with certificate validation
     * enforced by enforceTLSSecurity() at process level
     */
    async getAssetSnapshot() {
        // INFRA-H-06: Validate URL scheme before making request
        if (!this.apiUrl.startsWith("https://") && process.env.NODE_ENV !== "development") {
            throw new Error(`SECURITY: Canton Asset API must use HTTPS. Got: ${this.apiUrl.substring(0, 40)}`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
        try {
            response = await fetch(`${this.apiUrl}/v1/assets/snapshot`, {
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return {
            snapshotId: data.snapshotId,
            timestamp: data.timestamp,
            assets: data.assets.map((a) => ({
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
    async getAssetsByIds(assetIds) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
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
        }
        finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            throw new Error(`Canton API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.assets.map((a) => ({
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
    async verifyStateHash(stateHash) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response;
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
        }
        finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            return false;
        }
        const data = await response.json();
        return data.valid === true;
    }
}
exports.CantonAssetClient = CantonAssetClient;
// ============================================================
//                     VALIDATOR NODE
// ============================================================
class ValidatorNode {
    config;
    canton;
    cantonAssetClient;
    kmsClient;
    signedAttestations = new Set();
    MAX_SIGNED_CACHE = 10000;
    isRunning = false;
    signingTimestamps = [];
    // BRIDGE-M-06: Rate limit coordination between validator and DAML layers.
    // The DAML BridgeService controls attestation creation rate (via Bridge_AssignNonce and
    // CantonDirectMint.dailyMintLimit). This validator-side rate limit is a secondary safety
    // net to prevent KMS key abuse if the DAML layer is compromised.
    //
    // IMPORTANT: This limit MUST be >= the maximum attestation creation rate on the DAML side
    // to prevent valid signatures from being rejected. The DAML dailyMintLimit caps mints
    // per 24h; if that produces N attestations/hour, MAX_SIGNS_PER_WINDOW must be >= N.
    // Default: 50/hour is conservative. Increase if DAML throughput is higher.
    // If this limit is hit, attestations will be delayed (not lost) until the window resets.
    MAX_SIGNS_PER_WINDOW = parseInt(process.env.MAX_SIGNS_PER_WINDOW || "50", 10);
    SIGNING_WINDOW_MS = parseInt(process.env.SIGNING_WINDOW_MS || "3600000", 10); // 1 hour
    lastSignedTotalValue = 0n;
    MAX_VALUE_JUMP_BPS = parseInt(process.env.MAX_VALUE_JUMP_BPS || "2000", 10); // 20%
    // KMS key rotation state
    activeKmsKeyId;
    activeEthAddress;
    rotationInProgress = false;
    constructor(config) {
        this.config = config;
        // Initialize with primary key, support rotation
        this.activeKmsKeyId = config.kmsKeyId;
        this.activeEthAddress = config.ethereumAddress;
        if (config.kmsKeyRotationEnabled && config.kmsRotationKeyId) {
            console.log(`[Validator] Key rotation ENABLED`);
            console.log(`[Validator]   Primary key: ${config.kmsKeyId ? "***..." + config.kmsKeyId.slice(-8) : "none"}`);
            console.log(`[Validator]   Rotation key: ${config.kmsRotationKeyId ? "***..." + config.kmsRotationKeyId.slice(-8) : "none"}`);
            console.log(`[Validator]   Primary ETH: ${config.ethereumAddress}`);
            console.log(`[Validator]   Rotation ETH: ${config.rotationEthereumAddress}`);
        }
        const protocol = process.env.CANTON_USE_TLS === "false" ? "http" : "https";
        // TS-H-03-NEW: Block plaintext Canton connections in production
        if (process.env.CANTON_USE_TLS === "false" && process.env.NODE_ENV === "production") {
            throw new Error("[ValidatorV2] CANTON_USE_TLS=false is not allowed in production");
        }
        this.canton = new canton_client_1.CantonClient({
            baseUrl: `${protocol}://${config.cantonLedgerHost}:${config.cantonLedgerPort}`,
            token: config.cantonLedgerToken,
            userId: "administrator",
            actAs: config.validatorParty,
            timeoutMs: 30000,
        });
        // Initialize Canton Asset API client
        this.cantonAssetClient = new CantonAssetClient(config.cantonAssetApiUrl, config.cantonAssetApiKey);
        // Initialize AWS KMS
        this.kmsClient = new client_kms_1.KMSClient({ region: config.awsRegion });
        console.log(`[Validator] Initialized`);
        console.log(`[Validator] Party: ${config.validatorParty}`);
        console.log(`[Validator] Canton API: ${config.cantonAssetApiUrl}`);
        console.log(`[Validator] ETH Address: ${config.ethereumAddress}`);
    }
    /**
     * Switch to rotation key for zero-downtime key rotation
     *
     * Key rotation flow:
     *   1. Generate new KMS key, get its ETH address
     *   2. Grant VALIDATOR_ROLE to new address on BLEBridgeV9 (via timelock)
     *   3. Set KMS_ROTATION_KEY_ID + ROTATION_ETH_ADDRESS + KMS_KEY_ROTATION_ENABLED=true
     *   4. Call activateRotationKey() — starts signing with new key
     *   5. Verify signatures working, then revoke old key's VALIDATOR_ROLE
     *   6. Promote: move rotation key to primary config, clear rotation fields
     */
    async activateRotationKey() {
        if (!this.config.kmsRotationKeyId || !this.config.rotationEthereumAddress) {
            throw new Error("Rotation key not configured");
        }
        console.log(`[Validator] ⚠️ ACTIVATING ROTATION KEY`);
        console.log(`[Validator]   Old: ${"***..." + this.activeKmsKeyId.slice(-8)} → ${this.activeEthAddress}`);
        console.log(`[Validator]   New: ${"***..." + this.config.kmsRotationKeyId.slice(-8)} → ${this.config.rotationEthereumAddress}`);
        // Test signing with rotation key before switching
        try {
            const testHash = ethers_1.ethers.id("rotation-key-test");
            await this.signWithKMSKey(testHash, this.config.kmsRotationKeyId, this.config.rotationEthereumAddress);
            console.log(`[Validator] ✓ Rotation key signing test passed`);
        }
        catch (error) {
            throw new Error(`Rotation key signing test FAILED: ${error.message}`);
        }
        this.rotationInProgress = true;
        this.activeKmsKeyId = this.config.kmsRotationKeyId;
        this.activeEthAddress = this.config.rotationEthereumAddress;
        this.rotationInProgress = false;
        console.log(`[Validator] ✅ Now signing with rotation key: ${"***..." + this.activeKmsKeyId.slice(-8)}`);
    }
    /**
     * Get current active key status
     */
    getKeyStatus() {
        return {
            activeKeyId: this.activeKmsKeyId,
            activeEthAddress: this.activeEthAddress,
            rotationAvailable: !!(this.config.kmsRotationKeyId && this.config.rotationEthereumAddress),
        };
    }
    async start() {
        console.log("[Validator] Starting...");
        this.isRunning = true;
        while (this.isRunning) {
            try {
                await this.pollForAttestations();
                try {
                    fs.writeFileSync("/tmp/heartbeat", new Date().toISOString());
                }
                catch (heartbeatError) {
                    if (process.env.NODE_ENV === "development") {
                        console.warn("[Validator] heartbeat write failed", heartbeatError);
                    }
                }
            }
            catch (error) {
                console.error("[Validator] Poll error:", error);
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }
    stop() {
        console.log("[Validator] Stopping...");
        this.isRunning = false;
    }
    async pollForAttestations() {
        // Only query allowed DAML templates (prevents signing arbitrary contracts)
        const templateId = this.config.allowedTemplates[0] || "MintedProtocolV3:AttestationRequest";
        const attestations = await this.canton.queryContracts((0, canton_client_1.parseTemplateId)(templateId));
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
                // BRIDGE-M-06: If this fires frequently, it may indicate a conflict with
                // DAML-side throughput. Increase MAX_SIGNS_PER_WINDOW to match DAML attestation
                // creation rate, or reduce DAML dailyMintLimit. Attestations are NOT lost —
                // they will be signed on the next poll cycle once the window clears.
                console.error(`[Validator] RATE LIMIT: ${this.signingTimestamps.length} signatures in ${this.SIGNING_WINDOW_MS}ms window. ` +
                    `Max=${this.MAX_SIGNS_PER_WINDOW}. Deferring to prevent KMS key abuse. ` +
                    `If this persists, increase MAX_SIGNS_PER_WINDOW to match DAML throughput.`);
                continue;
            }
            const attestedTotalValue = ethers_1.ethers.parseUnits(payload.totalCantonValue, 18);
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
    async verifyAgainstCanton(payload) {
        try {
            // 1. Fetch current asset snapshot from Canton
            const snapshot = await this.cantonAssetClient.getAssetSnapshot();
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
                const attestedValue = ethers_1.ethers.parseUnits(attestedAsset.assetValue, 18);
                // 0.1% of $500M = $500K which is too high; cap at $100K absolute
                const MAX_ABSOLUTE_TOLERANCE = ethers_1.ethers.parseUnits("100000", 18); // $100K
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
            const attestedTotal = ethers_1.ethers.parseUnits(payload.totalCantonValue, 18);
            const MAX_TOTAL_TOLERANCE = ethers_1.ethers.parseUnits("100000", 18); // $100K
            const percentTolerance = snapshot.totalValue / 1000n;
            const tolerance = percentTolerance < MAX_TOTAL_TOLERANCE ? percentTolerance : MAX_TOTAL_TOLERANCE;
            const totalDiff = attestedTotal > snapshot.totalValue
                ? attestedTotal - snapshot.totalValue
                : snapshot.totalValue - attestedTotal;
            if (totalDiff > tolerance) {
                return {
                    valid: false,
                    reason: `Total value mismatch: attested=${attestedTotal}, canton=${snapshot.totalValue}, diff=${totalDiff}`,
                    stateHash: snapshot.stateHash,
                };
            }
            // Enforce total-value tolerance — previously computed but never checked.
            // Without this, per-asset tolerances ($100K each) can accumulate across many assets
            // to produce a multi-million-dollar overvaluation that passes validation.
            if (totalDiff > tolerance) {
                return {
                    valid: false,
                    reason: `Total value mismatch: attested=${attestedTotal}, canton=${snapshot.totalValue}, diff=${totalDiff}, tolerance=${tolerance}`,
                    stateHash: snapshot.stateHash,
                };
            }
            // Only verify against assets included in attestation
            const includedAssetsValue = payload.cantonAssets.reduce((sum, a) => {
                return sum + ethers_1.ethers.parseUnits(a.assetValue, 18);
            }, 0n);
            const attestedTotalFromAssets = ethers_1.ethers.parseUnits(payload.totalCantonValue, 18);
            if (includedAssetsValue !== attestedTotalFromAssets) {
                return {
                    valid: false,
                    reason: `Asset sum mismatch: sum=${includedAssetsValue}, total=${attestedTotalFromAssets}`,
                    stateHash: snapshot.stateHash,
                };
            }
            // 5. Verify collateral ratio
            const requestedCap = ethers_1.ethers.parseUnits(payload.requestedSupplyCap, 18);
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
            const stateValid = await this.cantonAssetClient.verifyStateHash(snapshot.stateHash);
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
        }
        catch (error) {
            return {
                valid: false,
                reason: `Canton API error: ${error.message}`,
                stateHash: "",
            };
        }
    }
    async signAttestation(contractId, payload, cantonStateHash) {
        const attestationId = payload.attestationId;
        this.signedAttestations.add(attestationId);
        try {
            // Build message hash (includes cantonStateHash for on-ledger verification)
            const messageHash = this.buildMessageHash(payload, cantonStateHash);
            // Sign with KMS
            const signature = await this.signWithKMS(messageHash);
            // Submit to Canton
            await this.canton.exerciseChoice(canton_client_1.TEMPLATES.AttestationRequest, contractId, "Attestation_Sign", {
                validator: this.config.validatorParty,
                ecdsaSignature: signature,
                cantonStateHash: cantonStateHash, // Include hash of verified state
            });
            this.signedAttestations.add(attestationId);
            console.log(`[Validator] ✓ Signed attestation ${attestationId}`);
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
            // (except if the contract says we already signed)
            if (error.message?.includes("VALIDATOR_ALREADY_SIGNED") ||
                error.message?.includes("already signed")) {
                // Already signed on ledger - keep in set
            }
            else {
                this.signedAttestations.delete(attestationId);
            }
        }
    }
    buildMessageHash(payload, cantonStateHash) {
        const cantonAssets = ethers_1.ethers.parseUnits(payload.totalCantonValue, 18);
        const nonce = BigInt(payload.nonce);
        const timestamp = BigInt(Math.max(1, Math.floor(new Date(payload.expiresAt).getTime() / 1000) - 3600));
        // Include entropy in hash (matches BLEBridgeV9 signature verification)
        const entropy = payload.entropy
            ? (payload.entropy.startsWith("0x") ? payload.entropy : "0x" + payload.entropy)
            : ethers_1.ethers.ZeroHash;
        // Include Canton state hash for on-ledger verification
        const stateHash = cantonStateHash
            ? (cantonStateHash.startsWith("0x") ? cantonStateHash : "0x" + cantonStateHash)
            : ethers_1.ethers.ZeroHash;
        // Derive attestation ID matching BLEBridgeV9.computeAttestationId()
        // Previously used ethers.id(payload.attestationId) which is keccak256(utf8) — wrong.
        // On-chain: keccak256(abi.encodePacked(nonce, cantonAssets, timestamp, entropy, cantonStateHash, chainid, address))
        const idBytes32 = ethers_1.ethers.solidityPackedKeccak256(["uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"], [nonce, cantonAssets, timestamp, entropy, stateHash, BigInt(payload.targetChainId), payload.targetBridgeAddress]);
        // Message hash matches BLEBridgeV9.processAttestation() signature verification:
        // keccak256(abi.encodePacked(id, cantonAssets, nonce, timestamp, entropy, cantonStateHash, chainid, address))
        return ethers_1.ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint256", "address"], [
            idBytes32,
            cantonAssets,
            nonce,
            timestamp,
            entropy,
            stateHash,
            BigInt(payload.targetChainId),
            payload.targetBridgeAddress,
        ]);
    }
    // Sign with currently active KMS key (supports key rotation)
    async signWithKMS(messageHash) {
        return this.signWithKMSKey(messageHash, this.activeKmsKeyId, this.activeEthAddress);
    }
    /**
     * Sign with a specific KMS key
     * Used for both normal signing and rotation key testing
     */
    async signWithKMSKey(messageHash, keyId, ethAddress) {
        const ethSignedHash = ethers_1.ethers.hashMessage(ethers_1.ethers.getBytes(messageHash));
        const hashBytes = Buffer.from(ethSignedHash.slice(2), "hex");
        const command = new client_kms_1.SignCommand({
            KeyId: keyId,
            Message: hashBytes,
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
        });
        const response = await this.kmsClient.send(command);
        if (!response.Signature) {
            throw new Error(`KMS key ${keyId} returned empty signature`);
        }
        return (0, signer_1.formatKMSSignature)(Buffer.from(response.Signature), ethSignedHash, ethAddress);
    }
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
    if (!ethers_1.ethers.isAddress(DEFAULT_CONFIG.ethereumAddress)) {
        throw new Error("VALIDATOR_ETH_ADDRESS is not a valid Ethereum address");
    }
    if (!DEFAULT_CONFIG.bridgeContractAddress) {
        throw new Error("BRIDGE_CONTRACT_ADDRESS not set");
    }
    if (!ethers_1.ethers.isAddress(DEFAULT_CONFIG.bridgeContractAddress)) {
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
    // Validate template allowlist is not empty
    if (DEFAULT_CONFIG.allowedTemplates.length === 0) {
        throw new Error("ALLOWED_TEMPLATES must not be empty — validator needs at least one template to query");
    }
    console.log(`[Main] Allowed templates: ${DEFAULT_CONFIG.allowedTemplates.join(", ")}`);
    // INFRA-H-01 / INFRA-H-02: Validate HTTPS for all external endpoints
    (0, utils_1.requireHTTPS)(DEFAULT_CONFIG.cantonAssetApiUrl, "CANTON_ASSET_API_URL");
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
//# sourceMappingURL=validator-node-v2.js.map