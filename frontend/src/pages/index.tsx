import React, { useState } from "react";
import { Layout } from "@/components/Layout";
import { useWallet } from "@/hooks/useWallet";
import { useContracts } from "@/hooks/useContract";
import { useChainState } from "@/hooks/useChain";
import { useCanton } from "@/hooks/useCanton";

// Ethereum pages
import { DashboardPage } from "./DashboardPage";
import { MintPage } from "./MintPage";
import { StakePage } from "./StakePage";
import { BorrowPage } from "./BorrowPage";
import { LiquidationsPage } from "./LiquidationsPage";
import { BridgePage } from "./BridgePage";
import { AdminPage } from "./AdminPage";

// Canton pages
import { CantonDashboard } from "@/components/canton/CantonDashboard";
import { CantonMint } from "@/components/canton/CantonMint";
import { CantonStake } from "@/components/canton/CantonStake";
import { CantonBorrow } from "@/components/canton/CantonBorrow";
import { CantonLiquidations } from "@/components/canton/CantonLiquidations";
import { CantonBridge } from "@/components/canton/CantonBridge";
import { CantonAdmin } from "@/components/canton/CantonAdmin";

export default function Home() {
  const wallet = useWallet();
  const contracts = useContracts(wallet.signer);
  const chainState = useChainState();
  const canton = useCanton();
  const [page, setPage] = useState("dashboard");

  function renderPage() {
    if (chainState.chain === "canton") {
      switch (page) {
        case "dashboard":
          return <CantonDashboard canton={canton} />;
        case "mint":
          return <CantonMint canton={canton} />;
        case "stake":
          return <CantonStake canton={canton} />;
        case "borrow":
          return <CantonBorrow canton={canton} />;
        case "liquidate":
          return <CantonLiquidations canton={canton} />;
        case "bridge":
          return <CantonBridge canton={canton} />;
        case "admin":
          return <CantonAdmin canton={canton} />;
        default:
          return <CantonDashboard canton={canton} />;
      }
    }

    // Ethereum
    switch (page) {
      case "dashboard":
        return <DashboardPage contracts={contracts} />;
      case "mint":
        return <MintPage contracts={contracts} address={wallet.address} />;
      case "stake":
        return <StakePage contracts={contracts} address={wallet.address} />;
      case "borrow":
        return <BorrowPage contracts={contracts} address={wallet.address} signer={wallet.signer} />;
      case "liquidate":
        return <LiquidationsPage contracts={contracts} address={wallet.address} />;
      case "bridge":
        return <BridgePage contracts={contracts} address={wallet.address} />;
      case "admin":
        return <AdminPage contracts={contracts} address={wallet.address} />;
      default:
        return <DashboardPage contracts={contracts} />;
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
      cantonParty={canton.party}
    >
      {wallet.error && chainState.chain === "ethereum" && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          {wallet.error}
        </div>
      )}
      {canton.error && chainState.chain === "canton" && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          Canton: {canton.error}
        </div>
      )}
      {renderPage()}
    </Layout>
  );
}
