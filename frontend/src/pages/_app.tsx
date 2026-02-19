import type { AppProps } from "next/app";
import { WalletConnectProvider } from "@/hooks/useWalletConnect";
import { MetaMaskProvider } from "@/hooks/useMetaMask";
import { UnifiedWalletProvider } from "@/hooks/useUnifiedWallet";
import { LoopWalletProvider } from "@/hooks/useLoopWallet";
import { MultiChainDepositProvider } from "@/hooks/useMultiChainDeposit";
import "@/styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <WalletConnectProvider>
      <MetaMaskProvider>
        <UnifiedWalletProvider>
          <LoopWalletProvider appName="Minted mUSD">
            <MultiChainDepositProvider>
              <Component {...pageProps} />
            </MultiChainDepositProvider>
          </LoopWalletProvider>
        </UnifiedWalletProvider>
      </MetaMaskProvider>
    </WalletConnectProvider>
  );
}
