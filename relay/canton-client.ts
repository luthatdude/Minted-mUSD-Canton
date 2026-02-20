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
import {
  cantonApiErrorsTotal,
  cantonApiRetriesTotal,
  cantonApiDuration,
} from "./metrics";

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
  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_RETRY_DELAY_MS = 1000;
  private static readonly MAX_RETRY_DELAY_MS = 15000;
  private static readonly ACTIVE_CONTRACTS_LIMIT = 200;

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

  private async requestOnce<T>(
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const pathLabel = path.split("?")[0];
    const timer = cantonApiDuration.labels(method, pathLabel).startTimer();
    let lastError: unknown;

    try {
      const maxRetries = this.getMaxRetriesForPath(path);
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await this.requestOnce<T>(method, path, body);
        } catch (err: any) {
          lastError = err;

          if (err instanceof CantonApiError) {
            cantonApiErrorsTotal.labels(String(err.status), pathLabel).inc();
            if (!err.isRetryable() || attempt >= maxRetries) {
              throw err;
            }
            cantonApiRetriesTotal.labels(String(err.status), pathLabel).inc();
            const delay = Math.min(
              CantonClient.BASE_RETRY_DELAY_MS * Math.pow(2, attempt) * err.backoffMultiplier(),
              CantonClient.MAX_RETRY_DELAY_MS
            );
            // Add bounded jitter to avoid synchronized retry storms.
            const jitteredDelay = Math.round(delay * (0.8 + Math.random() * 0.4));
            await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
            continue;
          }

          if (this.isNetworkError(err)) {
            cantonApiErrorsTotal.labels("network", pathLabel).inc();
            if (attempt >= maxRetries) {
              throw err;
            }
            cantonApiRetriesTotal.labels("network", pathLabel).inc();
            const delay = Math.min(
              CantonClient.BASE_RETRY_DELAY_MS * Math.pow(2, attempt),
              CantonClient.MAX_RETRY_DELAY_MS
            );
            const jitteredDelay = Math.round(delay * (0.8 + Math.random() * 0.4));
            await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
            continue;
          }

          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Unknown Canton API failure");
    } finally {
      timer();
    }
  }

  private isNetworkError(err: any): boolean {
    if (!err) return false;
    const code = String(err.code || "");
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
      return true;
    }
    const message = String(err.message || "");
    return message.includes("timeout") || message.includes("ENOTFOUND");
  }

  private getMaxRetriesForPath(path: string): number {
    // Avoid nested retry windows for write commands (create/exercise). The relay
    // poll loop already retries naturally on the next cycle, and command IDs are
    // per-operation, so extending this call can silently delay settlement paths.
    if (path === "/v2/commands/submit-and-wait") {
      return 0;
    }
    return CantonClient.MAX_RETRIES;
  }

  /**
   * Build the eventFormat object for active-contracts queries.
   *
   * NOTE: On Canton 3.4, the legacy `filter` field may silently broaden queries
   * and return the full ACS. We therefore use `eventFormat` with oneof-encoded
   * identifier filters and fully qualified template IDs.
   */
  private buildEventFormat(templateId?: TemplateId | null): Record<string, unknown> {
    const wildcard = {
      filtersByParty: {
        [this.actAs]: {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: {
                  value: { includeCreatedEventBlob: false },
                },
              },
            },
          ],
        },
      },
      verbose: true,
    };

    if (!templateId) {
      return wildcard;
    }

    const templateIdString = this.formatTemplateId(templateId);
    return {
      filtersByParty: {
        [this.actAs]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: templateIdString,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
      verbose: true,
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
      eventFormat: this.buildEventFormat(templateId),
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

    const activeContractsPath =
      `/v2/state/active-contracts?limit=${CantonClient.ACTIVE_CONTRACTS_LIMIT}`;

    let entries: RawEntry[];
    try {
      entries = await this.request<RawEntry[]>("POST", activeContractsPath, body);
    } catch (error: any) {
      if (error instanceof CantonApiError && error.status === 404 && templateId) {
        const templateIdString = this.formatTemplateId(templateId);
        console.warn(
          `[CantonClient] Active-contracts template lookup returned 404: ${templateIdString}`
        );
      }
      throw error;
    }

    // The active-contracts endpoint lacks cursor pagination. If we hit the hard
    // cap, results may be truncated (typically oldest-first), which is unsafe for
    // bridge correctness. Fail loudly instead of silently dropping newer contracts.
    if (entries.length >= CantonClient.ACTIVE_CONTRACTS_LIMIT) {
      const templateLabel = templateId ? this.formatTemplateId(templateId) : "wildcard";
      throw new CantonQueryLimitError(CantonClient.ACTIVE_CONTRACTS_LIMIT, templateLabel);
    }

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

  isRetryable(): boolean {
    // 413 is intentionally excluded: payload size will not shrink on retry.
    return [429, 500, 502, 503, 504].includes(this.status);
  }

  backoffMultiplier(): number {
    // Give rate-limit responses extra breathing room.
    return this.status === 429 ? 3 : 1;
  }
}

export class CantonQueryLimitError extends CantonApiError {
  constructor(limit: number, templateLabel: string) {
    super(
      413,
      "/v2/state/active-contracts",
      `Potentially truncated response at limit=${limit} for ${templateLabel}. ` +
        `Use archival hygiene or migrate this flow to /v2/updates-based consumption.`
    );
    this.name = "CantonQueryLimitError";
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
  ValidatorSignature: { moduleName: "Minted.Protocol.V3", entityName: "ValidatorSignature" } as TemplateId,
  BridgeService:      { moduleName: "Minted.Protocol.V3", entityName: "BridgeService" } as TemplateId,
  BridgeOutRequest:   { moduleName: "Minted.Protocol.V3", entityName: "BridgeOutRequest" } as TemplateId,
  BridgeInRequest:    { moduleName: "Minted.Protocol.V3", entityName: "BridgeInRequest" } as TemplateId,
  MUSDSupplyService:  { moduleName: "Minted.Protocol.V3", entityName: "MUSDSupplyService" } as TemplateId,
  ComplianceRegistry: { moduleName: "Compliance", entityName: "ComplianceRegistry" } as TemplateId,
  // Standalone module bridge-out requests (from CantonDirectMint USDC/USDCx minting)
  StandaloneBridgeOutRequest: { moduleName: "CantonDirectMint", entityName: "BridgeOutRequest" } as TemplateId,
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
} as const;
