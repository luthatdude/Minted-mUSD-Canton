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
/** Canton template identifier (module + entity, optionally with package ID) */
export interface TemplateId {
    moduleName: string;
    entityName: string;
    packageId?: string;
}
/** A contract visible on the ledger */
export interface ActiveContract<T = Record<string, unknown>> {
    contractId: string;
    templateId: string;
    payload: T;
    createdAt: string;
    offset: number;
    signatories: string[];
    observers: string[];
}
/** Result of querying active contracts */
export interface QueryResult<T = Record<string, unknown>> {
    contracts: ActiveContract<T>[];
}
/** Canton user */
export interface CantonUser {
    id: string;
    primaryParty: string;
    isDeactivated: boolean;
}
/** Client configuration */
export interface CantonClientConfig {
    /** Base URL of the Canton JSON API (e.g., "http://localhost:7575") */
    baseUrl: string;
    /** JWT bearer token */
    token: string;
    /** User ID for command submission (e.g., "administrator") */
    userId: string;
    /** Party ID to act as (e.g., "minted-validator-1::1220...") */
    actAs: string;
    /** Additional parties to read as */
    readAs?: string[];
    /** Request timeout in milliseconds */
    timeoutMs?: number;
    /** Default DAML package ID for template resolution */
    defaultPackageId?: string;
}
export declare class CantonClient {
    private baseUrl;
    private token;
    private userId;
    private actAs;
    private readAs;
    private timeoutMs;
    private defaultPackageId;
    constructor(config: CantonClientConfig);
    private request;
    /**
     * Build the filter object for active-contracts queries.
     * If templateId is provided, filters by that template for the actAs party.
     * If null, returns all contracts visible to the party.
     */
    private buildFilter;
    /**
     * Get the current ledger end offset.
     */
    getLedgerEnd(): Promise<number>;
    /**
     * Query active contracts, optionally filtered by template.
     *
     * @param templateId  Template to filter by (e.g., {moduleName:"Minted.Protocol.V3", entityName:"AttestationRequest"})
     * @param payloadFilter  Optional: further filter on payload fields (client-side)
     */
    queryContracts<T = Record<string, unknown>>(templateId?: TemplateId | null, payloadFilter?: (payload: T) => boolean): Promise<ActiveContract<T>[]>;
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
    private formatTemplateId;
    createContract<T = Record<string, unknown>>(templateId: TemplateId, payload: T): Promise<unknown>;
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
    exerciseChoice(templateId: TemplateId, contractId: string, choice: string, choiceArgument?: Record<string, unknown>, extraActAs?: string[]): Promise<unknown>;
    /**
     * List users on the participant.
     */
    listUsers(): Promise<CantonUser[]>;
    /**
     * List uploaded package IDs.
     */
    listPackages(): Promise<string[]>;
}
export declare class CantonApiError extends Error {
    readonly status: number;
    readonly path: string;
    readonly body: string;
    constructor(status: number, path: string, body: string);
}
/**
 * Parse a "Module.Name:EntityName" string into a TemplateId.
 * Also accepts "PackageId:Module.Name:EntityName".
 */
export declare function parseTemplateId(qualified: string): TemplateId;
/** Well-known template IDs for Minted Protocol */
export declare const TEMPLATES: {
    readonly AttestationRequest: TemplateId;
    readonly ValidatorSignature: TemplateId;
    readonly BridgeService: TemplateId;
    readonly BridgeOutRequest: TemplateId;
    readonly BridgeInRequest: TemplateId;
    readonly MUSDSupplyService: TemplateId;
    readonly ComplianceRegistry: TemplateId;
    readonly StandaloneBridgeOutRequest: TemplateId;
    readonly RedemptionRequest: TemplateId;
    readonly RedemptionEthereumSettlement: TemplateId;
    readonly CantonUSDC: TemplateId;
    readonly CantonMUSD: TemplateId;
    readonly CantonMUSDTransferProposal: TemplateId;
    readonly CantonStakingService: TemplateId;
    readonly CantonETHPoolService: TemplateId;
};
//# sourceMappingURL=canton-client.d.ts.map