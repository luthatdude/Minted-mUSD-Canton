const DEFAULT_LOCAL_PARTY_NAMESPACE =
  "122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";

const DEFAULT_LEGACY_NAMESPACE_BY_HINT: Record<string, string> = {
  "minted-user-33f97321":
    "122033f97321214b5b8443f6212a05836c8ffe42dda5000000000000000000000000",
  "eb4e4b84e7db045557f78d9b5e8c2b98":
    "12202dadec11aab8a9dc6ad790b6caab962e2c39ff419a2ae0d12e9ce6e87601ebad",
};

/**
 * Canonicalize a Canton party for this local participant.
 *
 * Normalization priority:
 *   1. If namespace already matches local participant → pass-through
 *   2. If explicit env alias exists (NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON) → apply
 *   3. If legacy namespace matches by hint (env or built-in) → remap to local namespace
 *   4. Otherwise → pass-through unchanged
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

  // Priority 2: Explicit env-configured aliases (full party or hint-only key)
  const configuredFullAliases = process.env.NEXT_PUBLIC_CANTON_PARTY_ALIASES_JSON;
  if (configuredFullAliases) {
    try {
      const parsed = JSON.parse(configuredFullAliases) as Record<string, string>;
      const mapped = parsed[trimmed] || parsed[hint];
      if (mapped && typeof mapped === "string" && mapped.trim()) {
        const result = mapped.trim();
        if (process.env.NODE_ENV === "development") {
          console.debug("[canton-party] env alias remap:", trimmed, "→", result);
        }
        return result;
      }
    } catch {
      // Ignore malformed optional config and fall through.
    }
  }

  // Priority 3a: Env-configured legacy namespace by hint
  const configuredLegacyByHint = process.env.NEXT_PUBLIC_CANTON_LEGACY_NAMESPACE_BY_HINT;
  if (configuredLegacyByHint) {
    try {
      const parsed = JSON.parse(configuredLegacyByHint) as Record<string, string>;
      const configuredLegacy = parsed[hint];
      if (configuredLegacy && namespace === configuredLegacy) {
        const result = `${hint}::${localNamespace}`;
        if (process.env.NODE_ENV === "development") {
          console.debug("[canton-party] legacy remap (env):", trimmed, "→", result);
        }
        return result;
      }
    } catch {
      // Ignore malformed optional config and fall back to built-in map.
    }
  }

  // Priority 3b: Built-in legacy namespace map (exact namespace match only)
  const defaultLegacy = DEFAULT_LEGACY_NAMESPACE_BY_HINT[hint];
  if (defaultLegacy && namespace === defaultLegacy) {
    const result = `${hint}::${localNamespace}`;
    if (process.env.NODE_ENV === "development") {
      console.debug("[canton-party] legacy remap (built-in):", trimmed, "→", result);
    }
    return result;
  }

  // Priority 4: Pass-through unchanged
  return trimmed;
}
