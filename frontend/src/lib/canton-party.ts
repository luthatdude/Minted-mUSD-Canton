const DEFAULT_LOCAL_PARTY_NAMESPACE =
  "12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";

const DEFAULT_FULL_PARTY_ALIASES: Record<string, string> = {
  "eb4e4b84e7db045557f78d9b5e8c2b98":
    "minted-user-33f97321::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
  "eb4e4b84e7db045557f78d9b5e8c2b98::12202dadec11aab8a9dc6ad790b6caab962e2c39ff419a2ae0d12e9ce6e87601ebad":
    "minted-user-33f97321::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
  "dde6467edc610708573d717a53c7c396":
    "minted-user-33f97321::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
  "dde6467edc610708573d717a53c7c396::12200d9a833bb01839aa0c236eb5fe18008bd21fa980873a0c463ba1866506b4af9e":
    "minted-user-33f97321::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
};

const DEFAULT_LEGACY_NAMESPACE_BY_HINT: Record<string, string> = {
  "minted-user-33f97321":
    "122033f97321214b5b8443f6212a05836c8ffe42dda5000000000000000000000000",
  "eb4e4b84e7db045557f78d9b5e8c2b98":
    "12202dadec11aab8a9dc6ad790b6caab962e2c39ff419a2ae0d12e9ce6e87601ebad",
};

/**
 * Canonicalize a Canton party for this local participant.
 *
 * In devnet we sometimes receive legacy user-party namespaces from old onboarding sessions.
 * This helper remaps those legacy namespaces to the local participant namespace so UI and
 * bridge submissions consistently use hosted local parties.
 */
export function normalizeCantonParty(partyId?: string | null): string | null {
  if (!partyId) return null;

  const trimmed = partyId.trim();
  if (!trimmed) return null;

  const parts = trimmed.split("::");
  if (parts.length !== 2) return trimmed;

  const hint = parts[0];
  const namespace = parts[1];

  const localNamespace =
    process.env.NEXT_PUBLIC_CANTON_LOCAL_PARTY_NAMESPACE || DEFAULT_LOCAL_PARTY_NAMESPACE;

  if (namespace === localNamespace) return trimmed;

  const configuredLegacyByHint = process.env.NEXT_PUBLIC_CANTON_LEGACY_NAMESPACE_BY_HINT;
  const configuredFullAliases = process.env.NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON;

  if (configuredFullAliases) {
    try {
      const parsed = JSON.parse(configuredFullAliases) as Record<string, string>;
      const mapped = parsed[trimmed] || parsed[hint];
      if (mapped && typeof mapped === "string" && mapped.trim()) {
        return mapped.trim();
      }
    } catch {
      // Ignore malformed optional config and fall back to built-in defaults.
    }
  }

  const defaultFullAlias = DEFAULT_FULL_PARTY_ALIASES[trimmed] || DEFAULT_FULL_PARTY_ALIASES[hint];
  if (defaultFullAlias) {
    return defaultFullAlias;
  }

  if (configuredLegacyByHint) {
    try {
      const parsed = JSON.parse(configuredLegacyByHint) as Record<string, string>;
      const configuredLegacy = parsed[hint];
      if (configuredLegacy && namespace === configuredLegacy) {
        return `${hint}::${localNamespace}`;
      }
    } catch {
      // Ignore malformed optional config and fall back to built-in map.
    }
  }

  const defaultLegacy = DEFAULT_LEGACY_NAMESPACE_BY_HINT[hint];
  if (defaultLegacy && namespace === defaultLegacy) {
    return `${hint}::${localNamespace}`;
  }

  return trimmed;
}
