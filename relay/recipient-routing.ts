import { validateCantonPartyId } from "./utils";
import { ethers } from "ethers";

export type RecipientPartyAliasMap = Record<string, string>;
export type RecipientEthAddressMap = Record<string, string>;

const MAX_ALIAS_MAP_SIZE_BYTES = 10 * 1024; // 10KB

/**
 * Parse CANTON_RECIPIENT_PARTY_ALIASES env JSON.
 *
 * Supports keys as:
 * - Full party IDs (recommended): "name::fingerprint"
 * - Party hints (fallback): "name"
 */
export function parseRecipientPartyAliases(
  raw: string,
  sourceName: string
): RecipientPartyAliasMap {
  if (!raw || !raw.trim()) return {};

  if (raw.length > MAX_ALIAS_MAP_SIZE_BYTES) {
    throw new Error(
      `${sourceName} exceeds ${MAX_ALIAS_MAP_SIZE_BYTES} byte limit`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceName} must be valid JSON object`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must be a JSON object`);
  }

  const aliases: RecipientPartyAliasMap = {};
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [from, to] of entries) {
    if (typeof to !== "string" || to.trim().length === 0) {
      throw new Error(`${sourceName} value for "${from}" must be a non-empty string`);
    }

    const key = from.trim();
    const value = to.trim();
    if (!key) {
      throw new Error(`${sourceName} contains an empty alias key`);
    }

    // Validate both key and value as Canton party IDs.
    // Keys without namespace (party hints) are allowed by validator.
    validateCantonPartyId(key, `${sourceName} key`);
    validateCantonPartyId(value, `${sourceName} value`);
    aliases[key] = value;
  }

  return aliases;
}

/**
 * Parse CANTON_REDEMPTION_ETH_RECIPIENTS env JSON.
 *
 * Keys support full party IDs and party hints.
 * Values must be valid Ethereum addresses.
 */
export function parseRecipientEthAddresses(
  raw: string,
  sourceName: string
): RecipientEthAddressMap {
  if (!raw || !raw.trim()) return {};

  if (raw.length > MAX_ALIAS_MAP_SIZE_BYTES) {
    throw new Error(
      `${sourceName} exceeds ${MAX_ALIAS_MAP_SIZE_BYTES} byte limit`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceName} must be valid JSON object`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must be a JSON object`);
  }

  const addresses: RecipientEthAddressMap = {};
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [from, to] of entries) {
    if (typeof to !== "string" || to.trim().length === 0) {
      throw new Error(`${sourceName} value for "${from}" must be a non-empty string`);
    }

    const key = from.trim();
    const value = to.trim();
    if (!key) {
      throw new Error(`${sourceName} contains an empty key`);
    }

    validateCantonPartyId(key, `${sourceName} key`);
    if (!ethers.isAddress(value)) {
      throw new Error(`${sourceName} value for "${from}" must be a valid Ethereum address`);
    }

    addresses[key] = ethers.getAddress(value);
  }

  return addresses;
}

/**
 * Resolve an on-chain recipient to a local party when aliasing is configured.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) Original recipient unchanged
 */
export function resolveRecipientParty(
  recipientParty: string,
  aliases: RecipientPartyAliasMap
): string {
  const direct = aliases[recipientParty];
  if (direct) return direct;

  const hint = recipientParty.split("::")[0];
  const byHint = aliases[hint];
  if (byHint) return byHint;

  return recipientParty;
}

/**
 * Resolve an Ethereum recipient address for a Canton party.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) null
 */
export function resolveRecipientEthAddress(
  recipientParty: string,
  addresses: RecipientEthAddressMap
): string | null {
  const direct = addresses[recipientParty];
  if (direct) return direct;

  const hint = recipientParty.split("::")[0];
  const byHint = addresses[hint];
  if (byHint) return byHint;

  return null;
}
