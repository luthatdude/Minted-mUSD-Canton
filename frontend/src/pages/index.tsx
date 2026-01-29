import React, { useState } from "react";
import { Layout } from "@/components/Layout";
import { useWallet } from "@/hooks/useWallet";
import { useContracts } from "@/hooks/useContract";
import { DashboardPage } from "./DashboardPage";
import { MintPage } from "./MintPage";
import { StakePage } from "./StakePage";
import { BorrowPage } from "./BorrowPage";
import { LiquidationsPage } from "./LiquidationsPage";
import { BridgePage } from "./BridgePage";
import { CantonPage } from "./CantonPage";
import { AdminPage } from "./AdminPage";

export default function Home() {
  const wallet = useWallet();
  const contracts = useContracts(wallet.signer);
  const [page, setPage] = useState("dashboard");

  function renderPage() {
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
      case "canton":
        return <CantonPage />;
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
    >
      {wallet.error && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-400">
          {wallet.error}
        </div>
      )}
      {renderPage()}
    </Layout>
  );
}
