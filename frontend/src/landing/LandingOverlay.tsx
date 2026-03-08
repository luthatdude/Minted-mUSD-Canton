import React from "react";

interface LandingOverlayProps {
  onConnectEthereum: () => void;
  onConnectCanton: () => void;
  isEthConnecting: boolean;
  isCantonConnecting: boolean;
}

export function LandingOverlay({
  onConnectEthereum,
  onConnectCanton,
  isEthConnecting,
  isCantonConnecting,
}: LandingOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-4">
      {/* Title block */}
      <div className="mb-2 text-center">
        <h1 className="text-6xl font-extrabold tracking-tight text-white drop-shadow-lg sm:text-7xl">
          Minted{" "}
          <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
            mUSD
          </span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-300/80">
          Institutional-grade stablecoin bridging Canton Network tokenized assets
          to Ethereum DeFi
        </p>
      </div>

      {/* Stat pills */}
      <div className="mt-8 flex flex-wrap justify-center gap-4">
        {[
          { label: "Cross-Chain", value: "Canton + ETH" },
          { label: "Settlement", value: "Atomic" },
          { label: "Compliance", value: "CIP-56" },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm backdrop-blur-sm"
          >
            <span className="text-gray-400">{s.label}: </span>
            <span className="font-semibold text-white">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Connect buttons */}
      <div className="pointer-events-auto mt-10 flex flex-col gap-3 sm:flex-row">
        <button
          onClick={onConnectEthereum}
          disabled={isEthConnecting}
          className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:shadow-blue-500/40 hover:brightness-110 disabled:opacity-60"
        >
          {isEthConnecting ? "Connecting..." : "Connect Ethereum"}
        </button>
        <button
          onClick={onConnectCanton}
          disabled={isCantonConnecting}
          className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all hover:shadow-emerald-500/40 hover:brightness-110 disabled:opacity-60"
        >
          {isCantonConnecting ? "Connecting..." : "Connect Canton"}
        </button>
      </div>

      {/* Feature cards */}
      <div className="pointer-events-auto mt-16 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            title: "Cross-Chain Bridge",
            desc: "Atomic settlement between Canton Network and Ethereum with multi-sig attestation",
          },
          {
            title: "Yield Strategies",
            desc: "Stake mUSD as smUSD for yield from diversified treasury allocations",
          },
          {
            title: "DeFi Native",
            desc: "Borrow against collateral, leverage positions, and participate in governance",
          },
        ].map((card) => (
          <div
            key={card.title}
            className="rounded-xl border border-white/10 bg-black/40 p-5 backdrop-blur-md transition-colors hover:border-white/20"
          >
            <h3 className="mb-2 font-semibold text-white">{card.title}</h3>
            <p className="text-sm text-gray-400">{card.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
