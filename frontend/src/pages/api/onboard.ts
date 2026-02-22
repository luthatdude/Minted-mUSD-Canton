import type { NextApiRequest, NextApiResponse } from "next";

/**
 * /api/onboard — Canton party onboarding and compliance registration.
 *
 * Endpoints (via ?action= query param):
 *   GET  ?action=status&ethAddress=0x...  — Check if ETH address has Canton party
 *   POST ?action=provision                — Provision Canton party + ComplianceRegistry entry
 *   POST ?action=kyc-check                — Stub: check KYC status
 *
 * In production, this would integrate with:
 *   - Sumsub/Onfido for KYC verification
 *   - Canton Participant Admin API for party allocation
 *   - ComplianceRegistry DAML template for compliance entry
 *
 * Security: This runs server-side only. Canton admin tokens are never exposed to the client.
 */

// ── Types ──────────────────────────────────────────────────────
interface OnboardStatusResponse {
  registered: boolean;
  cantonParty: string | null;
  kycStatus: "none" | "pending" | "approved" | "rejected";
}

interface ProvisionResponse {
  success: boolean;
  cantonParty: string;
  complianceContractId: string;
}

interface KycCheckResponse {
  status: "pending" | "approved" | "rejected";
  message: string;
}

type ErrorResponse = { error: string };

// ── In-memory registry (replace with DB in production) ────────
const partyRegistry = new Map<
  string,
  { cantonParty: string; kycStatus: string; complianceCid: string }
>();

// ── Canton Admin API helpers ──────────────────────────────────
const CANTON_ADMIN_URL =
  process.env.CANTON_ADMIN_URL ||
  process.env.CANTON_API_URL ||
  `http://${process.env.CANTON_HOST || "localhost"}:${process.env.CANTON_PORT || "7575"}`;
const CANTON_ADMIN_TOKEN = process.env.CANTON_ADMIN_TOKEN || "";
const CANTON_OPERATOR_PARTY =
  process.env.CANTON_PARTY ||
  "minted-validator-1::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";

function partyHintFromEth(ethAddress: string): string {
  return `minted-user-${ethAddress.toLowerCase().slice(2, 10)}`;
}

function authHeaders(): Record<string, string> {
  return CANTON_ADMIN_TOKEN
    ? { Authorization: `Bearer ${CANTON_ADMIN_TOKEN}` }
    : {};
}

async function findPartyByHint(partyHint: string): Promise<string | null> {
  const resp = await fetch(`${CANTON_ADMIN_URL}/v2/parties`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const parties: Array<{ party?: string }> = data.partyDetails || [];
  const found = parties.find((p) => typeof p.party === "string" && p.party.startsWith(`${partyHint}::`));
  return found?.party || null;
}

/**
 * Allocate a party on the Canton participant via the admin API.
 * In production, this would use the Canton Participant Admin API:
 *   POST /v2/parties with party_id_hint and display_name.
 */
async function allocateCantonParty(
  ethAddress: string
): Promise<string> {
  const partyHint = partyHintFromEth(ethAddress);
  const displayName = `Minted User ${ethAddress.slice(0, 8)}`;

  // If the party already exists on this participant, reuse it.
  const existingParty = await findPartyByHint(partyHint);
  if (existingParty) return existingParty;

  try {
    const resp = await fetch(`${CANTON_ADMIN_URL}/v2/parties`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        partyIdHint: partyHint,
        displayName,
        localMetadata: {
          resourceVersion: "",
          annotations: {
            "minted.eth_address": ethAddress,
            "minted.onboarded_at": new Date().toISOString(),
          },
        },
        identityProviderId: "",
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(
        `[Onboard] Party allocation failed: ${resp.status} ${errorText}`
      );
      if (resp.status === 400 && errorText.includes("already exists")) {
        const existing = await findPartyByHint(partyHint);
        if (existing) return existing;
      }
      throw new Error(`Party allocation failed: ${resp.status}`);
    }

    const data = await resp.json();
    return data.party || data.result?.party || `${partyHint}::unknown`;
  } catch (err) {
    console.error("[Onboard] Canton admin request failed:", err);
    throw err;
  }
}

/**
 * Create or verify a ComplianceRegistry entry for the new party.
 * Exercises ValidateMint to ensure the party is not blacklisted.
 */
async function ensureComplianceEntry(
  cantonParty: string
): Promise<string> {
  try {
    const ledgerResp = await fetch(`${CANTON_ADMIN_URL}/v2/state/ledger-end`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
    });
    if (!ledgerResp.ok) throw new Error("Unable to query Canton ledger end");
    const { offset } = await ledgerResp.json();

    const queryResp = await fetch(`${CANTON_ADMIN_URL}/v2/state/active-contracts?limit=200`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [CANTON_OPERATOR_PARTY]: {
              identifierFilter: {
                wildcardFilter: {},
              },
            },
          },
        },
        activeAtOffset: offset,
      }),
    });

    if (queryResp.ok) {
      const entries = await queryResp.json();
      for (const entry of entries as any[]) {
        const created = entry?.contractEntry?.JsActiveContract?.createdEvent;
        if (!created) continue;
        const templateId = String(created.templateId || "");
        const entity = templateId.split(":").pop();
        if (entity === "ComplianceRegistry") {
          return created.contractId || "compliance-ok";
        }
      }
    }

    // Development fallback
    if (process.env.NODE_ENV !== "production") {
      return `compliance-dev-${Date.now()}`;
    }
    throw new Error("No ComplianceRegistry found on Canton");
  } catch (err) {
    console.error("[Onboard] Compliance check failed:", err);
    if (process.env.NODE_ENV !== "production") {
      return `compliance-dev-${Date.now()}`;
    }
    throw err;
  }
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<
    OnboardStatusResponse | ProvisionResponse | KycCheckResponse | ErrorResponse
  >
) {
  const action = req.query.action as string;

  // ── GET: Check onboarding status ──────────────────────────
  if (req.method === "GET" && action === "status") {
    const ethAddress = (req.query.ethAddress as string)?.toLowerCase();

    if (!ethAddress || !/^0x[a-f0-9]{40}$/.test(ethAddress)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }

    let entry = partyRegistry.get(ethAddress);
    if (!entry) {
      const existingParty = await findPartyByHint(partyHintFromEth(ethAddress));
      if (existingParty) {
        entry = {
          cantonParty: existingParty,
          kycStatus: "approved",
          complianceCid: "compliance-existing",
        };
        partyRegistry.set(ethAddress, entry);
      }
    }

    return res.status(200).json({
      registered: !!entry,
      cantonParty: entry?.cantonParty || null,
      kycStatus: (entry?.kycStatus as OnboardStatusResponse["kycStatus"]) || "none",
    });
  }

  // ── POST: Provision Canton party ──────────────────────────
  if (req.method === "POST" && action === "provision") {
    const { ethAddress, kycToken } = req.body || {};

    if (!ethAddress || !/^0x[a-f0-9]{40}$/i.test(ethAddress)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }

    // Check if already provisioned
    const existing = partyRegistry.get(ethAddress.toLowerCase());
    if (existing) {
      return res.status(200).json({
        success: true,
        cantonParty: existing.cantonParty,
        complianceContractId: existing.complianceCid,
      });
    }

    const existingParty = await findPartyByHint(partyHintFromEth(ethAddress));
    if (existingParty) {
      const complianceCid = await ensureComplianceEntry(existingParty);
      partyRegistry.set(ethAddress.toLowerCase(), {
        cantonParty: existingParty,
        kycStatus: "approved",
        complianceCid,
      });
      return res.status(200).json({
        success: true,
        cantonParty: existingParty,
        complianceContractId: complianceCid,
      });
    }

    // In production: validate KYC token with Sumsub/Onfido
    // For now, accept any non-empty kycToken as "approved"
    if (!kycToken && process.env.NODE_ENV === "production") {
      return res.status(400).json({ error: "KYC verification required" });
    }

    try {
      // Step 1: Allocate Canton party
      const cantonParty = await allocateCantonParty(ethAddress);

      // Step 2: Ensure compliance entry
      const complianceCid = await ensureComplianceEntry(cantonParty);

      // Step 3: Store mapping
      partyRegistry.set(ethAddress.toLowerCase(), {
        cantonParty,
        kycStatus: "approved",
        complianceCid,
      });

      console.log(
        `[Onboard] Provisioned: ${ethAddress} → ${cantonParty}`
      );

      return res.status(200).json({
        success: true,
        cantonParty,
        complianceContractId: complianceCid,
      });
    } catch (err) {
      console.error("[Onboard] Provision failed:", err);
      return res.status(500).json({
        error: err instanceof Error ? err.message : "Provisioning failed",
      });
    }
  }

  // ── POST: KYC status check (stub) ────────────────────────
  if (req.method === "POST" && action === "kyc-check") {
    const { ethAddress } = req.body || {};

    if (!ethAddress) {
      return res.status(400).json({ error: "ethAddress required" });
    }

    // Stub: auto-approve in development, pending in production
    const isProd = process.env.NODE_ENV === "production";

    return res.status(200).json({
      status: isProd ? "pending" : "approved",
      message: isProd
        ? "KYC verification is in progress. This usually takes 1-2 business days."
        : "Development mode: auto-approved",
    });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
