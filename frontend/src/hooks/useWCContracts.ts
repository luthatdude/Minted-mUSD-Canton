import { useMemo } from "react";
import { Contract } from "ethers";
import { useUnifiedWallet } from "./useUnifiedWallet";
import { CONTRACTS } from "@/lib/config";
import { MUSD_ABI } from "@/abis/MUSD";
import { SMUSD_ABI } from "@/abis/SMUSD";
import { DIRECT_MINT_ABI } from "@/abis/DirectMint";
import { TREASURY_ABI } from "@/abis/Treasury";
import { COLLATERAL_VAULT_ABI } from "@/abis/CollateralVault";
import { BORROW_MODULE_ABI } from "@/abis/BorrowModule";
import { LIQUIDATION_ENGINE_ABI } from "@/abis/LiquidationEngine";
import { BLE_BRIDGE_V9_ABI } from "@/abis/BLEBridgeV9";
import { PRICE_ORACLE_ABI } from "@/abis/PriceOracle";
import { ERC20_ABI } from "@/abis/ERC20";

// ABI mapping for all contracts
const ABI_MAP: Record<string, readonly string[]> = {
  MUSD: MUSD_ABI,
  SMUSD: SMUSD_ABI,
  DirectMint: DIRECT_MINT_ABI,
  Treasury: TREASURY_ABI,
  CollateralVault: COLLATERAL_VAULT_ABI,
  BorrowModule: BORROW_MODULE_ABI,
  LiquidationEngine: LIQUIDATION_ENGINE_ABI,
  BLEBridgeV9: BLE_BRIDGE_V9_ABI,
  PriceOracle: PRICE_ORACLE_ABI,
  USDC: ERC20_ABI,
};

/**
 * Hook to get a single contract instance using WalletConnect
 */
export function useWCContract(name: keyof typeof CONTRACTS): Contract | null {
  const { signer, provider, isConnected } = useUnifiedWallet();

  return useMemo(() => {
    const address = CONTRACTS[name];
    const abi = ABI_MAP[name];
    if (!address || !abi) return null;
    
    const signerOrProvider = signer || provider;
    if (!signerOrProvider) return null;
    
    return new Contract(address, abi, signerOrProvider);
  }, [name, signer, provider, isConnected]);
}

/**
 * Hook to get all protocol contracts using WalletConnect
 */
export function useWCContracts() {
  const { signer, provider, isConnected } = useUnifiedWallet();

  return useMemo(() => {
    const signerOrProvider = signer || provider;
    if (!signerOrProvider) {
      return {
        musd: null,
        smusd: null,
        usdc: null,
        directMint: null,
        treasury: null,
        vault: null,
        borrow: null,
        liquidation: null,
        bridge: null,
        oracle: null,
      };
    }

    const createContract = (name: keyof typeof CONTRACTS): Contract | null => {
      const address = CONTRACTS[name];
      const abi = ABI_MAP[name];
      if (!address || !abi) return null;
      return new Contract(address, abi, signerOrProvider);
    };

    return {
      musd: createContract("MUSD"),
      smusd: createContract("SMUSD"),
      usdc: createContract("USDC"),
      directMint: createContract("DirectMint"),
      treasury: createContract("Treasury"),
      vault: createContract("CollateralVault"),
      borrow: createContract("BorrowModule"),
      liquidation: createContract("LiquidationEngine"),
      bridge: createContract("BLEBridgeV9"),
      oracle: createContract("PriceOracle"),
    };
  }, [signer, provider, isConnected]);
}

// Type exports
export type WCContracts = ReturnType<typeof useWCContracts>;
