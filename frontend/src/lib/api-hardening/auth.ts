/**
 * Lightweight API request guards for Canton endpoints.
 *
 * Provides method enforcement and request shape validation without
 * requiring a full session/auth middleware framework.
 *
 * NOTE: This stack does not currently have session middleware.
 * The guards here validate request shape and method only.
 * Full session-based auth binding (verifying that the caller is
 * authorized to act as the requested party) is a TODO that requires
 * infrastructure changes (session cookies, JWT validation, etc.).
 */

import type { NextApiRequest, NextApiResponse } from "next";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Enforce that the request uses the expected HTTP method.
 * Returns true if the method matches; sends 405 and returns false otherwise.
 *
 * Usage:
 *   if (!guardMethod(req, res, "POST")) return;
 */
export function guardMethod(
  req: NextApiRequest,
  res: NextApiResponse,
  expected: HttpMethod
): boolean {
  if (req.method === expected) return true;
  res.status(405).json({ error: "Method not allowed" });
  return false;
}

/**
 * Extract and validate a Canton party from the request body.
 * Returns the trimmed party string or null (after sending 400 response).
 *
 * For POST endpoints that receive party in req.body.
 *
 * Usage:
 *   const party = guardBodyParty(req, res);
 *   if (!party) return;
 */
export function guardBodyParty(
  req: NextApiRequest,
  res: NextApiResponse,
  opts?: { fieldName?: string; extraFields?: Record<string, unknown> }
): string | null {
  const fieldName = opts?.fieldName ?? "party";
  const body = req.body || {};
  const raw = body[fieldName];

  if (!raw || typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({
      error: `Missing ${fieldName}`,
      ...(opts?.extraFields || {}),
    });
    return null;
  }

  const party = raw.trim();
  // Pattern: alias::1220<64-hex>
  if (party.length > 200 || !/^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i.test(party)) {
    res.status(400).json({
      error: `Invalid Canton ${fieldName} format`,
      ...(opts?.extraFields || {}),
    });
    return null;
  }

  return party;
}

/**
 * Extract and validate a Canton party from query parameters.
 * Returns the trimmed party string or null (after sending 400 response).
 *
 * For GET endpoints that receive party in req.query.
 *
 * Usage:
 *   const party = guardQueryParty(req, res);
 *   if (!party) return;
 */
export function guardQueryParty(
  req: NextApiRequest,
  res: NextApiResponse
): string | null {
  const raw = req.query.party;
  const candidate = Array.isArray(raw) ? raw[0] : raw;

  if (!candidate || typeof candidate !== "string" || !candidate.trim()) {
    res.status(400).json({ error: "Invalid or missing Canton party" });
    return null;
  }

  const party = candidate.trim();
  if (party.length > 200 || !/^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i.test(party)) {
    res.status(400).json({ error: "Invalid Canton party format" });
    return null;
  }

  return party;
}

// TODO: Add session-based auth binding when middleware is available.
// This would verify that the authenticated user's session maps to the
// requested Canton party, preventing party impersonation attacks.
// Current risk: any caller can submit commands as any party.
// Mitigation: Canton's own auth token limits accessible parties.
