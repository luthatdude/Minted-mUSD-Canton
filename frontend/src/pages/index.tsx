import React, { useState } from "react";
import { Layout } from "@/components/Layout";
import { LandingPage } from "@/components/LandingPage";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useChainState } from "@/hooks/useChain";
import { useLoopWallet } from "@/hooks/useLoopWallet";

// Ethereum pages
import { DashboardMintPage } from "./DashboardMintPage";
import { StakePage } from "./StakePage";
import { BorrowPage } from "./BorrowPage";
import { BridgePage } from "./BridgePage";
import { AdminPage } from "./AdminPage";
import { PointsPage } from "./PointsPage";

// Canton pages
import { CantonDashboardMint } from "@/components/canton/CantonDashboardMint";
import { CantonStake } from "@/components/canton/CantonStake";
import { CantonBorrow } from "@/components/canton/CantonBorrow";
import { CantonBridge } from "@/components/canton/CantonBridge";
import { CantonAdmin } from "@/components/canton/CantonAdmin";

export default function Home() {
  const wallet = useWalletConnect();
  const contracts = useWCContracts();
  const chainState = useChainState();
  const loopWallet = useLoopWallet();
  const [page, setPage] = useState("dashboard");
  const [appLaunched, setAppLaunched] = useState(false);

  function renderPage() {
    if (chainState.chain === "canton") {
      switch (page) {
        case "dashboard":
          return <CantonDashboardMint />;
        case "stake":
          return <CantonStake />;
        case "borrow":
          return <CantonBorrow />;
        case "bridge":
          return <CantonBridge />;
        case "admin":
          return <CantonAdmin />;
        case "points":
          return <PointsPage />;
        default:
          return <CantonDashboardMint />;
      }
    }

    // Ethereum - pages will use hooks internally
    switch (page) {
      case "dashboard":
        return <DashboardMintPage />;
      case "stake":
        return <StakePage />;
      case "borrow":
        return <BorrowPage />;
      case "bridge":
        return <BridgePage />;
      case "points":
        return <PointsPage />;
      case "admin":
        return <AdminPage />;
      default:
        return <DashboardMintPage />;
    }
  }

  // Show landing page until user clicks "Launch App"
  if (!appLaunched) {
    return <LandingPage onLaunchApp={() => setAppLaunched(true)} />;
  }

  return (
    <Layout
      address={wallet.address}
      onConnect={wallet.connect}
      onDisconnect={wallet.disconnect}
      activePage={page}
      onNavigate={setPage}
      chain={chainState.chain}
      onToggleChain={chainState.toggle}
      cantonParty={loopWallet.partyId}
    >
      {wallet.error && chainState.chain === "ethereum" && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          {wallet.error}
        </div>
      )}
      {loopWallet.error && chainState.chain === "canton" && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          Canton: {loopWallet.error}
        </div>
      )}
      {renderPage()}
    </Layout>
  );
}
