/**
 * Centralized environment variable accessors with strict validation.
 *
 * Eliminates per-endpoint duplication of process.env reads, regex
 * patterns, and fallback logic. All Canton API endpoints should use
 * these getters instead of reading process.env directly.
 */

// ── Validation patterns ──────────────────────────────────────

/** Canton party ID: `alias::1220<64-hex>` */
export const CANTON_PARTY_PATTERN = /^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i;

/** DAML package ID: 64-char lowercase hex */
export const PKG_ID_PATTERN = /^[0-9a-f]{64}$/i;

// ── Typed getters ────────────────────────────────────────────

export function getCantonBaseUrl(): string {
  return (
    process.env.CANTON_API_URL ||
    `http://${process.env.CANTON_HOST || "localhost"}:${process.env.CANTON_PORT || "7575"}`
  );
}

export function getCantonToken(): string {
  return process.env.CANTON_TOKEN || "";
}

export function getCantonParty(): string {
  return process.env.CANTON_PARTY || "";
}

export function getCantonUser(): string {
  return process.env.CANTON_USER || "administrator";
}

export function getPackageId(): string {
  return (
    process.env.NEXT_PUBLIC_DAML_PACKAGE_ID ||
    process.env.CANTON_PACKAGE_ID ||
    ""
  );
}

export function getLendingPackageId(): string {
  return (
    process.env.CANTON_LENDING_PACKAGE_ID ||
    getPackageId()
  );
}

export function getCip56PackageId(): string {
  return (
    process.env.NEXT_PUBLIC_CIP56_PACKAGE_ID ||
    process.env.CIP56_PACKAGE_ID ||
    ""
  );
}

/**
 * Deduped list of V3 package IDs (NEXT_PUBLIC_DAML_PACKAGE_ID + CANTON_PACKAGE_ID).
 * Filters out empty/invalid entries.
 */
export function getV3PackageIds(): string[] {
  return Array.from(
    new Set(
      [getPackageId(), process.env.CANTON_PACKAGE_ID].filter(
        (id): id is string => typeof id === "string" && id.length === 64
      )
    )
  );
}

// ── Validators ───────────────────────────────────────────────

export interface ConfigError {
  error: string;
  errorType: "CONFIG_ERROR";
}

/**
 * Validate that required Canton config is present and well-formed.
 * Returns null if valid, or a ConfigError object if not.
 *
 * @param requireCip56 — also validate CIP56_PACKAGE_ID (for CIP-56 mutation endpoints)
 */
export function validateConfig(opts?: { requireCip56?: boolean }): ConfigError | null {
  const party = getCantonParty();
  if (!party || !CANTON_PARTY_PATTERN.test(party)) {
    return { error: "CANTON_PARTY not configured or invalid", errorType: "CONFIG_ERROR" };
  }

  const pkgId = getPackageId();
  if (!pkgId || !PKG_ID_PATTERN.test(pkgId)) {
    return {
      error: "CANTON_PACKAGE_ID/NEXT_PUBLIC_DAML_PACKAGE_ID not configured or invalid",
      errorType: "CONFIG_ERROR",
    };
  }

  if (opts?.requireCip56) {
    const cip56 = getCip56PackageId();
    if (!cip56 || !PKG_ID_PATTERN.test(cip56)) {
      return {
        error: "CIP56_PACKAGE_ID/NEXT_PUBLIC_CIP56_PACKAGE_ID not configured or invalid",
        errorType: "CONFIG_ERROR",
      };
    }
  }

  return null;
}

/**
 * Validate a party string from user input (query param or body field).
 * Returns the trimmed party or throws.
 */
export function validatePartyInput(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Missing Canton party");
  }
  const party = raw.trim();
  if (party.length > 200 || !CANTON_PARTY_PATTERN.test(party)) {
    throw new Error("Invalid Canton party format");
  }
  return party;
}
