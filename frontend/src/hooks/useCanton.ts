import { useState, useCallback, useRef } from "react";
import { CANTON_CONFIG } from "@/lib/config";

// FIX FE-03: Request timeout for Canton API calls (30s default)
const CANTON_REQUEST_TIMEOUT_MS = 30_000;

// FIX FE-04: Simple in-flight request deduplication
const pendingRequests = new Map<string, Promise<any>>();

interface CantonContract {
  contractId: string;
  templateId: string;
  payload: Record<string, any>;
}

interface CantonState {
  connected: boolean;
  party: string | null;
  error: string | null;
}

/**
 * Hook for interacting with Canton Network Daml ledger.
 * Supports querying contracts, exercising choices, and creating contracts.
 */
export function useCanton() {
  const [state, setState] = useState<CantonState>({
    connected: false,
    party: null,
    error: null,
  });
  // FIX FE-01: Token must be set via setToken() after authentication,
  // not loaded from client-side config (was NEXT_PUBLIC_CANTON_TOKEN).
  const tokenRef = useRef<string>("");
  const baseUrl = `http://${CANTON_CONFIG.ledgerHost}:${CANTON_CONFIG.ledgerPort}`;

  const setToken = useCallback((token: string, party: string) => {
    tokenRef.current = token;
    setState({ connected: true, party, error: null });
  }, []);

  const disconnect = useCallback(() => {
    tokenRef.current = "";
    setState({ connected: false, party: null, error: null });
  }, []);

  const headers = useCallback(() => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${tokenRef.current}`,
  }), []);

  // FIX FE-03: Helper with timeout support via AbortController
  const fetchWithTimeout = useCallback(
    async (url: string, init: RequestInit): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CANTON_REQUEST_TIMEOUT_MS);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
    []
  );

  /** Query active contracts by template */
  const query = useCallback(
    async (templateId: string, filter?: Record<string, any>): Promise<CantonContract[]> => {
      // FIX FE-04: Deduplicate identical in-flight queries
      const dedupeKey = `query:${templateId}:${JSON.stringify(filter || {})}`;
      const existing = pendingRequests.get(dedupeKey);
      if (existing) return existing;

      const request = (async () => {
        try {
          const resp = await fetchWithTimeout(`${baseUrl}/v1/query`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              templateIds: [templateId],
              query: filter || {},
            }),
          });
          if (!resp.ok) throw new Error(`Query failed: ${resp.status}`);
          const data = await resp.json();
          return (data.result || []).map((c: any) => ({
            contractId: c.contractId,
            templateId: c.templateId,
            payload: c.payload,
          }));
        } catch (err: any) {
          setState((s) => ({ ...s, error: err.message }));
          return [];
        } finally {
          pendingRequests.delete(dedupeKey);
        }
      })();
      pendingRequests.set(dedupeKey, request);
      return request;
    },
    [baseUrl, headers, fetchWithTimeout]
  );

  /** Exercise a choice on a contract */
  const exercise = useCallback(
    async (
      templateId: string,
      contractId: string,
      choice: string,
      argument: Record<string, any>
    ): Promise<any> => {
      try {
        const resp = await fetchWithTimeout(`${baseUrl}/v1/exercise`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ templateId, contractId, choice, argument }),
        });
        if (!resp.ok) throw new Error(`Exercise failed: ${resp.status}`);
        const data = await resp.json();
        return data.result;
      } catch (err: any) {
        setState((s) => ({ ...s, error: err.message }));
        throw err;
      }
    },
    [baseUrl, headers, fetchWithTimeout]
  );

  /** Create a new contract */
  const create = useCallback(
    async (templateId: string, payload: Record<string, any>): Promise<string> => {
      try {
        const resp = await fetchWithTimeout(`${baseUrl}/v1/create`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ templateId, payload }),
        });
        if (!resp.ok) throw new Error(`Create failed: ${resp.status}`);
        const data = await resp.json();
        return data.result.contractId;
      } catch (err: any) {
        setState((s) => ({ ...s, error: err.message }));
        throw err;
      }
    },
    [baseUrl, headers, fetchWithTimeout]
  );

  return { ...state, setToken, disconnect, query, exercise, create };
}
