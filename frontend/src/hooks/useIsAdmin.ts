/**
 * useIsAdmin Hook (H-08)
 *
 * Gates access to the AdminPage so that **only the wallet specified in
 * NEXT_PUBLIC_ADMIN_WALLET** can view and interact with admin functions.
 *
 * This is a hard client-side gate — the env var holds the single authorized
 * wallet address. On-chain role checks (DEFAULT_ADMIN_ROLE / TIMELOCK_ROLE)
 * still protect every transaction, but the UI itself is only visible to the
 * designated operator wallet.
 *
 * Returns { isAdmin, isLoading }.
 */

import { useState, useEffect } from "react";
import { useWalletConnect } from "./useWalletConnect";
import { ADMIN_WALLET } from "@/lib/config";

export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const { address, isConnected } = useWalletConnect();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isConnected || !address) {
      setIsAdmin(false);
      setIsLoading(false);
      return;
    }

    // Hard wallet-address gate: only the designated admin wallet may enter.
    const allowed =
      ADMIN_WALLET !== "" && address.toLowerCase() === ADMIN_WALLET;

    setIsAdmin(allowed);
    setIsLoading(false);
  }, [address, isConnected]);

  return { isAdmin, isLoading };
}
