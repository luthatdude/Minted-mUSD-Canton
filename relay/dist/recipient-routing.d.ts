export type RecipientPartyAliasMap = Record<string, string>;
export type RecipientEthAddressMap = Record<string, string>;
/**
 * Parse CANTON_RECIPIENT_PARTY_ALIASES env JSON.
 *
 * Supports keys as:
 * - Full party IDs (recommended): "name::fingerprint"
 * - Party hints (fallback): "name"
 */
export declare function parseRecipientPartyAliases(raw: string, sourceName: string): RecipientPartyAliasMap;
/**
 * Parse CANTON_REDEMPTION_ETH_RECIPIENTS env JSON.
 *
 * Keys support full party IDs and party hints.
 * Values must be valid Ethereum addresses.
 */
export declare function parseRecipientEthAddresses(raw: string, sourceName: string): RecipientEthAddressMap;
/**
 * Resolve an on-chain recipient to a local party when aliasing is configured.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) Original recipient unchanged
 */
export declare function resolveRecipientParty(recipientParty: string, aliases: RecipientPartyAliasMap): string;
/**
 * Resolve an Ethereum recipient address for a Canton party.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) null
 */
export declare function resolveRecipientEthAddress(recipientParty: string, addresses: RecipientEthAddressMap): string | null;
//# sourceMappingURL=recipient-routing.d.ts.map