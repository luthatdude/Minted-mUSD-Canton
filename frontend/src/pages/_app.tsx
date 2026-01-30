import type { AppProps } from "next/app";
import "@/styles/globals.css";
import { WalletConnectProvider } from "@/hooks/useWalletConnect";
import { MetaMaskProvider } from "@/hooks/useMetaMask";
import { UnifiedWalletProvider } from "@/hooks/useUnifiedWallet";
import { LoopWalletProvider } from "@/hooks/useLoopWallet";
import { MultiChainDepositProvider } from "@/hooks/useMultiChainDeposit";

// App configuration
const LOOP_APP_NAME = "Minted Protocol";
const LOOP_NETWORK = (process.env.NEXT_PUBLIC_CANTON_NETWORK as 'devnet' | 'testnet' | 'mainnet' | 'local') || 'devnet';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <WalletConnectProvider autoConnect={true}>
      <MetaMaskProvider>
        <UnifiedWalletProvider>
          <MultiChainDepositProvider>
            <LoopWalletProvider appName={LOOP_APP_NAME} network={LOOP_NETWORK}>
              <Component {...pageProps} />
            </LoopWalletProvider>
          </MultiChainDepositProvider>
        </UnifiedWalletProvider>
      </MetaMaskProvider>
    </WalletConnectProvider>
  );
}
