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
 * FIX FE-H01: Added transaction simulation before signing to catch reverts early.
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

  /**
   * Simulate a transaction to check if it would succeed
   * FIX FE-H01: Catches reverts before user signs, saving gas on failed txs
   */
  const simulate = useCallback(
    async (simulateFn: () => Promise<void>): Promise<boolean> => {
      try {
        await simulateFn();
        return true;
      } catch (err: any) {
        const message =
          err.reason || err.shortMessage || err.message || "Simulation failed";
        setState({ loading: false, hash: null, error: `Simulation: ${message}`, success: false });
        return false;
      }
    },
    []
  );

  const send = useCallback(
    async (
      txFn: () => Promise<ethers.TransactionResponse>,
      simulateFn?: () => Promise<void>
    ): Promise<ethers.TransactionReceipt | null> => {
      setState({ loading: true, hash: null, error: null, success: false });
      
      // FIX FE-H01: Simulate first if simulation function provided
      if (simulateFn) {
        const simOk = await simulate(simulateFn);
        if (!simOk) {
          return null;
        }
      }
      
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
    [simulate]
  );

  return { ...state, send, reset, simulate };
}
