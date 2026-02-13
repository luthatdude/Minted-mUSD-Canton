// Dashboard Mint Page — combines Ethereum and Canton minting views
// FIX H-06: Populated stub file (was 0-byte)

import React from "react";
import { PageHeader } from "@/components/PageHeader";
import { MintPage } from "./MintPage";

export function DashboardMintPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard Mint"
        description="Mint mUSD using USDC across Ethereum and Canton Network"
      />
      <MintPage />
    </div>
  );
}

export default DashboardMintPage;
