import type { AppProps } from "next/app";
import "@/styles/globals.css";
import { EthWalletProvider } from "@/hooks/useEthWallet";
import { LoopWalletProvider } from "@/hooks/useLoopWallet";

// App configuration
const LOOP_APP_NAME = "Minted Protocol";
const LOOP_NETWORK = (process.env.NEXT_PUBLIC_CANTON_NETWORK as 'devnet' | 'testnet' | 'mainnet' | 'local') || 'devnet';
const DEFAULT_ETH_CHAIN = parseInt(process.env.NEXT_PUBLIC_ETH_CHAIN_ID || '11155111'); // Sepolia

export default function App({ Component, pageProps }: AppProps) {
  return (
    <EthWalletProvider defaultChainId={DEFAULT_ETH_CHAIN}>
      <LoopWalletProvider appName={LOOP_APP_NAME} network={LOOP_NETWORK}>
        <Component {...pageProps} />
      </LoopWalletProvider>
    </EthWalletProvider>
  );
}
