import React from "react";
import { Navbar } from "./Navbar";

interface LayoutProps {
  children: React.ReactNode;
  address: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  activePage: string;
  onNavigate: (page: string) => void;
}

export function Layout({
  children,
  address,
  onConnect,
  onDisconnect,
  activePage,
  onNavigate,
}: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-950">
      <Navbar
        address={address}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        activePage={activePage}
        onNavigate={onNavigate}
      />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
