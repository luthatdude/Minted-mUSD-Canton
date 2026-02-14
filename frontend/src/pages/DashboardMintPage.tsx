// Dashboard Mint Page — combines Ethereum and Canton minting views
// Populated stub file (was 0-byte)

import React from "react";
import { PageHeader } from "@/components/PageHeader";
import { MintPage } from "./MintPage";
import { ReferralWidget } from "@/components/ReferralWidget";

export function DashboardMintPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard Mint"
        subtitle="Mint mUSD using USDC across Ethereum and Canton Network"
      />
      <MintPage />

      {/* Referral Program Widget */}
      <div className="mx-auto max-w-3xl">
        <ReferralWidget />
      </div>
    </div>
  );
}

export default DashboardMintPage;
