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

import * as crypto from "crypto";

// ============================================================
//                     TYPES
// ============================================================

/** Canton template identifier (module + entity, optionally with package ID) */
export interface TemplateId {
  moduleName: string;
  entityName: string;
  packageId?: string;
}

/** A contract visible on the ledger */
export interface ActiveContract<T = Record<string, unknown>> {
  contractId: string;
  templateId: string;        // Full qualified: "pkgId:Module:Entity"
  payload: T;                // createArgument
  createdAt: string;         // ISO timestamp
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

// ============================================================
//                     CLIENT
// ============================================================

export class CantonClient {
  private baseUrl: string;
  private token: string;
  private userId: string;
  private actAs: string;
  private readAs: string[];
  private timeoutMs: number;
  private defaultPackageId: string;

  constructor(config: CantonClientConfig) {
    // Strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.userId = config.userId;
    this.actAs = config.actAs;
    this.readAs = config.readAs || [];
    this.timeoutMs = config.timeoutMs || 30_000;
    this.defaultPackageId = config.defaultPackageId || "";
  }

  // ----------------------------------------------------------
  //  Private helpers
  // ----------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
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

      return await resp.json() as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Canton API timeout (${this.timeoutMs}ms): ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Build the filter object for active-contracts queries.
   * If templateId is provided, filters by that template for the actAs party.
   * If null, returns all contracts visible to the party.
   */
  private buildFilter(templateId?: TemplateId | null): Record<string, unknown> {
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

    const tid: Record<string, string> = {
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
  async getLedgerEnd(): Promise<number> {
    const resp = await this.request<{ offset: number }>("GET", "/v2/state/ledger-end");
    return resp.offset;
  }

  /**
   * Query active contracts, optionally filtered by template.
   *
   * @param templateId  Template to filter by (e.g., {moduleName:"Minted.Protocol.V3", entityName:"AttestationRequest"})
   * @param payloadFilter  Optional: further filter on payload fields (client-side)
   */
  async queryContracts<T = Record<string, unknown>>(
    templateId?: TemplateId | null,
    payloadFilter?: (payload: T) => boolean
  ): Promise<ActiveContract<T>[]> {
    const offset = await this.getLedgerEnd();

    const body = {
      filter: this.buildFilter(templateId),
      activeAtOffset: offset,
    };

    type RawEntry = {
      contractEntry: {
        JsActiveContract?: {
          createdEvent: {
            contractId: string;
            templateId: string;
            createArgument: T;
            createdAt: string;
            offset: number;
            signatories: string[];
            observers: string[];
          };
        };
      };
    };

    const entries = await this.request<RawEntry[]>("POST", "/v2/state/active-contracts", body);

    const contracts: ActiveContract<T>[] = [];
    for (const entry of entries) {
      const ac = entry.contractEntry?.JsActiveContract;
      if (!ac) continue;

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

      const contract: ActiveContract<T> = {
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
  private formatTemplateId(templateId: TemplateId): string {
    const pkg = templateId.packageId || this.defaultPackageId;
    if (!pkg) {
      throw new Error(
        `No packageId for template ${templateId.moduleName}:${templateId.entityName}. ` +
        `Set CANTON_PACKAGE_ID env or provide packageId in TemplateId.`
      );
    }
    return `${pkg}:${templateId.moduleName}:${templateId.entityName}`;
  }

  async createContract<T = Record<string, unknown>>(
    templateId: TemplateId,
    payload: T
  ): Promise<unknown> {
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
  async exerciseChoice(
    templateId: TemplateId,
    contractId: string,
    choice: string,
    choiceArgument: Record<string, unknown> = {},
    extraActAs: string[] = []
  ): Promise<unknown> {
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
  async listUsers(): Promise<CantonUser[]> {
    const resp = await this.request<{ users: CantonUser[] }>("GET", "/v2/users");
    return resp.users;
  }

  /**
   * List uploaded package IDs.
   */
  async listPackages(): Promise<string[]> {
    const resp = await this.request<{ packageIds: string[] }>("GET", "/v2/packages");
    return resp.packageIds;
  }
}

// ============================================================
//                     ERROR TYPE
// ============================================================

export class CantonApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`Canton API error ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "CantonApiError";
  }
}

// ============================================================
//                     TEMPLATE ID HELPERS
// ============================================================

/**
 * Parse a "Module.Name:EntityName" string into a TemplateId.
 * Also accepts "PackageId:Module.Name:EntityName".
 */
export function parseTemplateId(qualified: string): TemplateId {
  const parts = qualified.split(":");
  if (parts.length === 2) {
    return { moduleName: parts[0], entityName: parts[1] };
  } else if (parts.length === 3) {
    return { packageId: parts[0], moduleName: parts[1], entityName: parts[2] };
  }
  throw new Error(`Invalid template ID format: "${qualified}" (expected "Module:Entity" or "Pkg:Module:Entity")`);
}

/** Well-known template IDs for Minted Protocol */
export const TEMPLATES = {
  AttestationRequest: { moduleName: "Minted.Protocol.V3", entityName: "AttestationRequest" } as TemplateId,
  SignedAttestation:  { moduleName: "Minted.Protocol.V3", entityName: "SignedAttestation" } as TemplateId,
  ValidatorSignature: { moduleName: "Minted.Protocol.V3", entityName: "ValidatorSignature" } as TemplateId,
  BridgeService:      { moduleName: "Minted.Protocol.V3", entityName: "BridgeService" } as TemplateId,
  BridgeOutRequest:   { moduleName: "Minted.Protocol.V3", entityName: "BridgeOutRequest" } as TemplateId,
  BridgeInRequest:    { moduleName: "Minted.Protocol.V3", entityName: "BridgeInRequest" } as TemplateId,
  MUSDSupplyService:  { moduleName: "Minted.Protocol.V3", entityName: "MUSDSupplyService" } as TemplateId,
  ComplianceRegistry: { moduleName: "Compliance", entityName: "ComplianceRegistry" } as TemplateId,
  // Standalone module bridge-out requests (from CantonDirectMint USDC/USDCx minting)
  StandaloneBridgeOutRequest: { moduleName: "CantonDirectMint", entityName: "BridgeOutRequest" } as TemplateId,
  CantonDirectMintService: { moduleName: "CantonDirectMint", entityName: "CantonDirectMintService" } as TemplateId,
  // Standalone module redemption requests (mUSD burned; Canton USDC owed)
  RedemptionRequest: { moduleName: "CantonDirectMint", entityName: "RedemptionRequest" } as TemplateId,
  // On-ledger marker for Ethereum-side redemption settlement idempotency
  RedemptionEthereumSettlement: { moduleName: "CantonDirectMint", entityName: "RedemptionEthereumSettlement" } as TemplateId,
  // Canton-side USDC token used for redemption fulfillment
  CantonUSDC: { moduleName: "CantonDirectMint", entityName: "CantonUSDC" } as TemplateId,
  // Canton mUSD token (CantonDirectMint module)
  CantonMUSD:             { moduleName: "CantonDirectMint", entityName: "CantonMUSD" } as TemplateId,
  CantonMUSDTransferProposal: { moduleName: "CantonDirectMint", entityName: "CantonMUSDTransferProposal" } as TemplateId,
  // smUSD staking service (yield → pooledMusd, share price ↑)
  CantonStakingService:   { moduleName: "CantonSMUSD", entityName: "CantonStakingService" } as TemplateId,
  // ETH Pool service (yield → pooledUsdc counter, share price ↑)
  CantonETHPoolService:   { moduleName: "CantonETHPool", entityName: "CantonETHPoolService" } as TemplateId,
  // CIP-56 factories and instructions (ble-protocol-cip56 package, SDK 3.4.10)
  // C3: packageId pinned from CIP56_PACKAGE_ID env var to avoid template ambiguity.
  // Queries work without packageId (match any package); creates/exercises require it.
  CIP56MintedMUSD:            { moduleName: "CIP56Interfaces", entityName: "CIP56MintedMUSD", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) } as TemplateId,
  MUSDTransferFactory:        { moduleName: "CIP56Interfaces", entityName: "MUSDTransferFactory", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) } as TemplateId,
  MUSDTransferInstruction:    { moduleName: "CIP56Interfaces", entityName: "MUSDTransferInstruction", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) } as TemplateId,
  MUSDAllocationFactory:      { moduleName: "CIP56Interfaces", entityName: "MUSDAllocationFactory", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) } as TemplateId,
  MUSDAllocation:             { moduleName: "CIP56Interfaces", entityName: "MUSDAllocation", ...(process.env.CIP56_PACKAGE_ID ? { packageId: process.env.CIP56_PACKAGE_ID } : {}) } as TemplateId,
} as const;

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

export const CIP56_INTERFACES = {
  /** TransferFactory interface — for TransferFactory_Transfer choice */
  TransferFactory: {
    packageId: SPLICE_TRANSFER_INSTRUCTION_PKG,
    moduleName: "Splice.Api.Token.TransferInstructionV1",
    entityName: "TransferFactory",
  } as TemplateId,
  /** TransferInstruction interface — for TransferInstruction_Accept/Reject/Withdraw */
  TransferInstruction: {
    packageId: SPLICE_TRANSFER_INSTRUCTION_PKG,
    moduleName: "Splice.Api.Token.TransferInstructionV1",
    entityName: "TransferInstruction",
  } as TemplateId,
} as const;
