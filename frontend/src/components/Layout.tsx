import React from "react";
import { Navbar } from "./Navbar";
import type { ActiveChain } from "@/hooks/useChain";

interface LayoutProps {
  children: React.ReactNode;
  address: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  activePage: string;
  onNavigate: (page: string) => void;
  chain: ActiveChain;
  onToggleChain: () => void;
  cantonParty: string | null;
}

export function Layout({
  children,
  address,
  onConnect,
  onDisconnect,
  activePage,
  onNavigate,
  chain,
  onToggleChain,
  cantonParty,
}: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar
        address={address}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        activePage={activePage}
        onNavigate={onNavigate}
        chain={chain}
        onToggleChain={onToggleChain}
        cantonParty={cantonParty}
      />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
