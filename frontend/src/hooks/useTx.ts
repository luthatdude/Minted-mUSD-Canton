import { useState, useCallback } from "react";
import { ethers } from "ethers";

interface TxState {
  loading: boolean;
  hash: string | null;
  error: string | null;
  success: boolean;
}

/**
 * Hook for sending Ethereum transactions with loading/error/success tracking.
 */
export function useTx() {
  const [state, setState] = useState<TxState>({
    loading: false,
    hash: null,
    error: null,
    success: false,
  });

  const reset = useCallback(() => {
    setState({ loading: false, hash: null, error: null, success: false });
  }, []);

  const send = useCallback(
    async (txFn: () => Promise<ethers.TransactionResponse>): Promise<ethers.TransactionReceipt | null> => {
      setState({ loading: true, hash: null, error: null, success: false });
      try {
        const tx = await txFn();
        setState((s) => ({ ...s, hash: tx.hash }));
        const receipt = await tx.wait();
        setState({ loading: false, hash: tx.hash, error: null, success: true });
        return receipt;
      } catch (err: any) {
        const message =
          err.reason || err.shortMessage || err.message || "Transaction failed";
        setState({ loading: false, hash: null, error: message, success: false });
        return null;
      }
    },
    []
  );

  return { ...state, send, reset };
}
