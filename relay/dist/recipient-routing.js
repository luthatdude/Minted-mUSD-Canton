"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRecipientEthAddress = exports.resolveRecipientParty = exports.parseRecipientEthAddresses = exports.parseRecipientPartyAliases = void 0;
const utils_1 = require("./utils");
const ethers_1 = require("ethers");
const MAX_ALIAS_MAP_SIZE_BYTES = 10 * 1024; // 10KB
/**
 * Parse CANTON_RECIPIENT_PARTY_ALIASES env JSON.
 *
 * Supports keys as:
 * - Full party IDs (recommended): "name::fingerprint"
 * - Party hints (fallback): "name"
 */
function parseRecipientPartyAliases(raw, sourceName) {
    if (!raw || !raw.trim())
        return {};
    if (raw.length > MAX_ALIAS_MAP_SIZE_BYTES) {
        throw new Error(`${sourceName} exceeds ${MAX_ALIAS_MAP_SIZE_BYTES} byte limit`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`${sourceName} must be valid JSON object`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${sourceName} must be a JSON object`);
    }
    const aliases = {};
    const entries = Object.entries(parsed);
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
        (0, utils_1.validateCantonPartyId)(key, `${sourceName} key`);
        (0, utils_1.validateCantonPartyId)(value, `${sourceName} value`);
        aliases[key] = value;
    }
    return aliases;
}
exports.parseRecipientPartyAliases = parseRecipientPartyAliases;
/**
 * Parse CANTON_REDEMPTION_ETH_RECIPIENTS env JSON.
 *
 * Keys support full party IDs and party hints.
 * Values must be valid Ethereum addresses.
 */
function parseRecipientEthAddresses(raw, sourceName) {
    if (!raw || !raw.trim())
        return {};
    if (raw.length > MAX_ALIAS_MAP_SIZE_BYTES) {
        throw new Error(`${sourceName} exceeds ${MAX_ALIAS_MAP_SIZE_BYTES} byte limit`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`${sourceName} must be valid JSON object`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${sourceName} must be a JSON object`);
    }
    const addresses = {};
    const entries = Object.entries(parsed);
    for (const [from, to] of entries) {
        if (typeof to !== "string" || to.trim().length === 0) {
            throw new Error(`${sourceName} value for "${from}" must be a non-empty string`);
        }
        const key = from.trim();
        const value = to.trim();
        if (!key) {
            throw new Error(`${sourceName} contains an empty key`);
        }
        (0, utils_1.validateCantonPartyId)(key, `${sourceName} key`);
        if (!ethers_1.ethers.isAddress(value)) {
            throw new Error(`${sourceName} value for "${from}" must be a valid Ethereum address`);
        }
        addresses[key] = ethers_1.ethers.getAddress(value);
    }
    return addresses;
}
exports.parseRecipientEthAddresses = parseRecipientEthAddresses;
/**
 * Resolve an on-chain recipient to a local party when aliasing is configured.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) Original recipient unchanged
 */
function resolveRecipientParty(recipientParty, aliases) {
    const direct = aliases[recipientParty];
    if (direct)
        return direct;
    const hint = recipientParty.split("::")[0];
    const byHint = aliases[hint];
    if (byHint)
        return byHint;
    return recipientParty;
}
exports.resolveRecipientParty = resolveRecipientParty;
/**
 * Resolve an Ethereum recipient address for a Canton party.
 *
 * Resolution order:
 * 1) Exact full-party match
 * 2) Party-hint match (prefix before "::")
 * 3) null
 */
function resolveRecipientEthAddress(recipientParty, addresses) {
    const direct = addresses[recipientParty];
    if (direct)
        return direct;
    const hint = recipientParty.split("::")[0];
    const byHint = addresses[hint];
    if (byHint)
        return byHint;
    return null;
}
exports.resolveRecipientEthAddress = resolveRecipientEthAddress;
//# sourceMappingURL=recipient-routing.js.map