/**
 * Shared utilities for Minted Protocol services
 * FIX T-M01: Extracted common code to reduce duplication
 */

import * as fs from "fs";

/**
 * FIX I-C01/T-C01: Read Docker secrets from /run/secrets/ with env var fallback.
 * Uses synchronous reads since this is called during module initialization.
 * For production, consider moving to async initialization if /run/secrets/
 * is on a network mount.
 */
export function readSecret(name: string, envVar: string): string {
  const secretPath = `/run/secrets/${name}`;
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    // Fall through to env var
  }
  return process.env[envVar] || "";
}
