import React, { useState } from "react";
import { Layout } from "@/components/Layout";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { useWCContracts } from "@/hooks/useWCContracts";
import { useChainState } from "@/hooks/useChain";
import { useLoopWallet } from "@/hooks/useLoopWallet";

// Ethereum pages
import { DashboardPage } from "./DashboardPage";
import { MintPage } from "./MintPage";
import { StakePage } from "./StakePage";
import { BorrowPage } from "./BorrowPage";
import { BridgePage } from "./BridgePage";
import { AdminPage } from "./AdminPage";
import { PointsPage } from "./PointsPage";

// Canton pages
import { CantonDashboard } from "@/components/canton/CantonDashboard";
import { CantonMint } from "@/components/canton/CantonMint";
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

  function renderPage() {
    if (chainState.chain === "canton") {
      switch (page) {
        case "dashboard":
          return <CantonDashboard />;
        case "mint":
          return <CantonMint />;
        case "stake":
          return <CantonStake />;
        case "borrow":
          return <CantonBorrow />;
        case "bridge":
          return <CantonBridge />;
        case "admin":
          return <CantonAdmin />;
        default:
          return <CantonDashboard />;
      }
    }

    // Ethereum - pages will use hooks internally
    switch (page) {
      case "dashboard":
        return <DashboardPage onNavigate={setPage} />;
      case "mint":
        return <MintPage />;
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
        return <DashboardPage />;
    }
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
