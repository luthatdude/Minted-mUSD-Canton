import React from "react";
import { shortenAddress } from "@/lib/format";

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "mint", label: "Mint / Redeem" },
  { key: "stake", label: "Stake" },
  { key: "borrow", label: "Borrow" },
  { key: "liquidate", label: "Liquidations" },
  { key: "bridge", label: "Bridge" },
  { key: "canton", label: "Canton" },
  { key: "admin", label: "Admin" },
];

interface NavbarProps {
  address: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  activePage: string;
  onNavigate: (page: string) => void;
}

export function Navbar({ address, onConnect, onDisconnect, activePage, onNavigate }: NavbarProps) {
  return (
    <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <button onClick={() => onNavigate("dashboard")} className="text-xl font-bold text-white">
            Minted<span className="text-brand-400">Protocol</span>
          </button>
          <div className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => onNavigate(item.key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  activePage === item.key
                    ? "bg-brand-600/20 text-brand-400"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          {address ? (
            <button onClick={onDisconnect} className="btn-secondary text-sm">
              {shortenAddress(address)}
            </button>
          ) : (
            <button onClick={onConnect} className="btn-primary text-sm">
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
