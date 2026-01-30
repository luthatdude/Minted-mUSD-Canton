import type { AppProps } from "next/app";
import "@/styles/globals.css";
import { WalletConnectProvider } from "@/hooks/useWalletConnect";
import { MetaMaskProvider } from "@/hooks/useMetaMask";
import { UnifiedWalletProvider } from "@/hooks/useUnifiedWallet";
import { LoopWalletProvider } from "@/hooks/useLoopWallet";

// App configuration
const LOOP_APP_NAME = "Minted Protocol";
const LOOP_NETWORK = (process.env.NEXT_PUBLIC_CANTON_NETWORK as 'devnet' | 'testnet' | 'mainnet' | 'local') || 'devnet';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <WalletConnectProvider autoConnect={true}>
      <MetaMaskProvider>
        <UnifiedWalletProvider>
          <LoopWalletProvider appName={LOOP_APP_NAME} network={LOOP_NETWORK}>
            <Component {...pageProps} />
          </LoopWalletProvider>
        </UnifiedWalletProvider>
      </MetaMaskProvider>
    </WalletConnectProvider>
  );
}
