"use strict";
/**
 * Canton v2 HTTP JSON API Client
 *
 * Thin wrapper around the Canton Ledger API v2 (Canton 3.x / Daml SDK 3.x).
 * Replaces @daml/ledger which targets the deprecated v1 JSON API.
 *
 * Endpoints used:
 *   GET  /v2/state/ledger-end          → current offset
 *   POST /v2/state/active-contracts    → query active contracts by template
 *   POST /v2/commands/submit-and-wait  → exercise choices
 *   GET  /v2/users                     → list users
 *   GET  /v2/packages                  → list uploaded packages
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
exports.CIP56_INTERFACES = exports.TEMPLATES = exports.parseTemplateId = exports.CantonApiError = exports.CantonClient = void 0;
const crypto = __importStar(require("crypto"));
// ============================================================
//                     CLIENT
// ============================================================
class CantonClient {
    baseUrl;
    token;
    userId;
    actAs;
    readAs;
    timeoutMs;
    defaultPackageId;
    constructor(config) {
        // Strip trailing slash
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.token = config.token;
        this.userId = config.userId;
        this.actAs = config.actAs;
        this.readAs = config.readAs || [];
        this.timeoutMs = config.timeoutMs || 30000;
        this.defaultPackageId = config.defaultPackageId || "";
    }
    // ----------------------------------------------------------
    //  Private helpers
    // ----------------------------------------------------------
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const resp = await fetch(url, {
                method,
                headers: {
                    "Authorization": `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                throw new CantonApiError(resp.status, path, text);
            }
            return await resp.json();
        }
        catch (err) {
            if (err.name === "AbortError") {
                throw new Error(`Canton API timeout (${this.timeoutMs}ms): ${method} ${path}`);
            }
            throw err;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Build the filter object for active-contracts queries.
     * If templateId is provided, filters by that template for the actAs party.
     * If null, returns all contracts visible to the party.
     */
    buildFilter(templateId) {
        if (!templateId) {
            // Wildcard — all templates visible to this party
            return {
                filtersByParty: {
                    [this.actAs]: {
                        identifierFilter: {
                            wildcardFilter: {},
                        },
                    },
                },
            };
        }
        const tid = {
            moduleName: templateId.moduleName,
            entityName: templateId.entityName,
        };
        if (templateId.packageId) {
            tid.packageId = templateId.packageId;
        }
        return {
            filtersByParty: {
                [this.actAs]: {
                    identifierFilter: {
                        templateFilter: {
                            value: { templateId: tid },
                        },
                    },
                },
            },
        };
    }
    // ----------------------------------------------------------
    //  Public API
    // ----------------------------------------------------------
    /**
     * Get the current ledger end offset.
     */
    async getLedgerEnd() {
        const resp = await this.request("GET", "/v2/state/ledger-end");
        return resp.offset;
    }
    /**
     * Query active contracts, optionally filtered by template.
     *
     * @param templateId  Template to filter by (e.g., {moduleName:"Minted.Protocol.V3", entityName:"AttestationRequest"})
     * @param payloadFilter  Optional: further filter on payload fields (client-side)
     */
    async queryContracts(templateId, payloadFilter) {
        const offset = await this.getLedgerEnd();
        const body = {
            filter: this.buildFilter(templateId),
            activeAtOffset: offset,
        };
        const entries = await this.request("POST", "/v2/state/active-contracts", body);
        const contracts = [];
        for (const entry of entries) {
            const ac = entry.contractEntry?.JsActiveContract;
            if (!ac)
                continue;
            const evt = ac.createdEvent;
            // Client-side template filtering — the v2 API may return all contracts
            // when the requested template doesn't exist in any uploaded package.
            // The templateId string format is "packageId:ModuleName:EntityName".
            if (templateId) {
                const tplStr = evt.templateId; // e.g. "abc123:Minted.Protocol.V3:AttestationRequest"
                const parts = tplStr.split(":");
                const mod = parts.length >= 3 ? parts[parts.length - 2] : "";
                const ent = parts.length >= 3 ? parts[parts.length - 1] : "";
                if (mod !== templateId.moduleName || ent !== templateId.entityName) {
                    continue;
                }
            }
            const contract = {
                contractId: evt.contractId,
                templateId: evt.templateId,
                payload: evt.createArgument,
                createdAt: evt.createdAt,
                offset: evt.offset,
                signatories: evt.signatories,
                observers: evt.observers,
            };
            // Apply client-side payload filter if provided
            if (payloadFilter && !payloadFilter(contract.payload)) {
                continue;
            }
            contracts.push(contract);
        }
        return contracts;
    }
    /**
     * Create a contract on the ledger.
     *
     * @param templateId   Template of the contract to create
     * @param payload      Contract payload (create arguments)
     * @returns The contract creation result (transaction events)
     */
    /**
     * Format a TemplateId as the string "packageId:moduleName:entityName"
     * required by the Canton v2 JSON API.
     */
    formatTemplateId(templateId) {
        const pkg = templateId.packageId || this.defaultPackageId;
        if (!pkg) {
            throw new Error(`No packageId for template ${templateId.moduleName}:${templateId.entityName}. ` +
                `Set CANTON_PACKAGE_ID env or provide packageId in TemplateId.`);
        }
        return `${pkg}:${templateId.moduleName}:${templateId.entityName}`;
    }
    async createContract(templateId, payload) {
        const commandId = `relay-create-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const body = {
            userId: this.userId,
            actAs: [this.actAs],
            readAs: this.readAs,
            commandId,
            commands: [
                {
                    CreateCommand: {
                        templateId: this.formatTemplateId(templateId),
                        createArguments: payload,
                    },
                },
            ],
        };
        return this.request("POST", "/v2/commands/submit-and-wait", body);
    }
    /**
     * Exercise a choice on a contract.
     *
     * @param templateId   Template of the contract
     * @param contractId   Contract ID to exercise on
     * @param choice       Choice name (e.g., "Attestation_Complete")
     * @param choiceArgument  Choice argument payload
     * @param extraActAs   Additional parties to include in actAs (e.g., governance party
     *                     for choices with multi-party controllers like ReceiveYield)
     * @returns The exercise result (transaction events)
     */
    async exerciseChoice(templateId, contractId, choice, choiceArgument = {}, extraActAs = []) {
        const commandId = `relay-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        // Build actAs array: always include primary party, plus any extra parties
        // (e.g., governance party for dual-controller choices like ReceiveYield)
        const actAs = [this.actAs, ...extraActAs.filter(p => p && p !== this.actAs)];
        const body = {
            userId: this.userId,
            actAs,
            readAs: this.readAs,
            commandId,
            commands: [
                {
                    ExerciseCommand: {
                        templateId: this.formatTemplateId(templateId),
                        contractId,
                        choice,
                        choiceArgument,
                    },
                },
            ],
        };
        return this.request("POST", "/v2/commands/submit-and-wait", body);
    }
    /**
     * List users on the participant.
     */
    async listUsers() {
        const resp = await this.request("GET", "/v2/users");
        return resp.users;
    }
    /**
     * List uploaded package IDs.
     */
    async listPackages() {
        const resp = await this.request("GET", "/v2/packages");
        return resp.packageIds;
    }
}
exports.CantonClient = CantonClient;
// ============================================================
//                     ERROR TYPE
// ============================================================
class CantonApiError extends Error {
    status;
    path;
    body;
    constructor(status, path, body) {
        super(`Canton API error ${status} on ${path}: ${body.slice(0, 200)}`);
        this.status = status;
        this.path = path;
        this.body = body;
        this.name = "CantonApiError";
    }
}
exports.CantonApiError = CantonApiError;
// ============================================================
//                     TEMPLATE ID HELPERS
// ============================================================
/**
 * Parse a "Module.Name:EntityName" string into a TemplateId.
 * Also accepts "PackageId:Module.Name:EntityName".
 */
function parseTemplateId(qualified) {
    const parts = qualified.split(":");
    if (parts.length === 2) {
        return { moduleName: parts[0], entityName: parts[1] };
    }
    else if (parts.length === 3) {
        return { packageId: parts[0], moduleName: parts[1], entityName: parts[2] };
    }
    throw new Error(`Invalid template ID format: "${qualified}" (expected "Module:Entity" or "Pkg:Module:Entity")`);
}
exports.parseTemplateId = parseTemplateId;
/** Well-known template IDs for Minted Protocol */
exports.TEMPLATES = {
    AttestationRequest: { moduleName: "Minted.Protocol.V3", entityName: "AttestationRequest" },
    SignedAttestation: { moduleName: "Minted.Protocol.V3", entityName: "SignedAttestation" },
    ValidatorSignature: { moduleName: "Minted.Protocol.V3", entityName: "ValidatorSignature" },
    BridgeService: { moduleName: "Minted.Protocol.V3", entityName: "BridgeService" },
    BridgeOutRequest: { moduleName: "Minted.Protocol.V3", entityName: "BridgeOutRequest" },
    BridgeInRequest: { moduleName: "Minted.Protocol.V3", entityName: "BridgeInRequest" },
    MUSDSupplyService: { moduleName: "Minted.Protocol.V3", entityName: "MUSDSupplyService" },
    ComplianceRegistry: { moduleName: "Compliance", entityName: "ComplianceRegistry" },
    // Standalone module bridge-out requests (from CantonDirectMint USDC/USDCx minting)
    StandaloneBridgeOutRequest: { moduleName: "CantonDirectMint", entityName: "BridgeOutRequest" },
    CantonDirectMintService: { moduleName: "CantonDirectMint", entityName: "CantonDirectMintService" },
    // Standalone module redemption requests (mUSD burned; Canton USDC owed)
    RedemptionRequest: { moduleName: "CantonDirectMint", entityName: "RedemptionRequest" },
    // On-ledger marker for Ethereum-side redemption settlement idempotency
    RedemptionEthereumSettlement: { moduleName: "CantonDirectMint", entityName: "RedemptionEthereumSettlement" },
    // Canton-side USDC token used for redemption fulfillment
    CantonUSDC: { moduleName: "CantonDirectMint", entityName: "CantonUSDC" },
    // Canton mUSD token (CantonDirectMint module)
    CantonMUSD: { moduleName: "CantonDirectMint", entityName: "CantonMUSD" },
    CantonMUSDTransferProposal: { moduleName: "CantonDirectMint", entityName: "CantonMUSDTransferProposal" },
    // smUSD staking service (yield → pooledMusd, share price ↑)
    CantonStakingService: { moduleName: "CantonSMUSD", entityName: "CantonStakingService" },
    // ETH Pool service (yield → pooledUsdc counter, share price ↑)
    CantonETHPoolService: { moduleName: "CantonETHPool", entityName: "CantonETHPoolService" },
    // CIP-56 factories and instructions (ble-protocol-cip56 package, SDK 3.4.10)
    // C3: packageId pinned from CIP56_PACKAGE_ID env var to avoid template ambiguity.
    // Queries work without packageId (match any package); creates/exercises require it.
    CIP56MintedMUSD: { moduleName: "CIP56Interfaces", entityName: "CIP56MintedMUSD", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) },
    MUSDTransferFactory: { moduleName: "CIP56Interfaces", entityName: "MUSDTransferFactory", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) },
    MUSDTransferInstruction: { moduleName: "CIP56Interfaces", entityName: "MUSDTransferInstruction", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) },
    MUSDAllocationFactory: { moduleName: "CIP56Interfaces", entityName: "MUSDAllocationFactory", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) },
    MUSDAllocation: { moduleName: "CIP56Interfaces", entityName: "MUSDAllocation", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) },
};
/**
 * CIP-56 Splice interface IDs for exercising interface-defined choices.
 * Canton JSON API v2 requires the INTERFACE template ID (not the concrete
 * template) when exercising a choice defined on a Daml interface.
 * Pass these as the `templateId` argument to `exerciseChoice`.
 *
 * Package ID is from splice-api-token-transfer-instruction-v1 DAR
 * (bundled in ble-protocol-cip56-1.0.0.dar as a data-dependency).
 */
const SPLICE_TRANSFER_INSTRUCTION_PKG = "55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281";
exports.CIP56_INTERFACES = {
    /** TransferFactory interface — for TransferFactory_Transfer choice */
    TransferFactory: {
        packageId: SPLICE_TRANSFER_INSTRUCTION_PKG,
        moduleName: "Splice.Api.Token.TransferInstructionV1",
        entityName: "TransferFactory",
    },
    /** TransferInstruction interface — for TransferInstruction_Accept/Reject/Withdraw */
    TransferInstruction: {
        packageId: SPLICE_TRANSFER_INSTRUCTION_PKG,
        moduleName: "Splice.Api.Token.TransferInstructionV1",
        entityName: "TransferInstruction",
    },
};
//# sourceMappingURL=canton-client.js.map