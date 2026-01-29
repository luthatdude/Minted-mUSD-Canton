import { useState, useCallback, useRef, useEffect } from "react";
import { CANTON_CONFIG } from "@/lib/config";

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
  const tokenRef = useRef<string>(CANTON_CONFIG.token);
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

  /** Query active contracts by template */
  const query = useCallback(
    async (templateId: string, filter?: Record<string, any>): Promise<CantonContract[]> => {
      try {
        const resp = await fetch(`${baseUrl}/v1/query`, {
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
      }
    },
    [baseUrl, headers]
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
        const resp = await fetch(`${baseUrl}/v1/exercise`, {
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
    [baseUrl, headers]
  );

  /** Create a new contract */
  const create = useCallback(
    async (templateId: string, payload: Record<string, any>): Promise<string> => {
      try {
        const resp = await fetch(`${baseUrl}/v1/create`, {
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
    [baseUrl, headers]
  );

  return { ...state, setToken, disconnect, query, exercise, create };
}
