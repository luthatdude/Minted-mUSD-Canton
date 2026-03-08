import React from "react";

interface LandingFallbackProps {
  onConnectEthereum: () => void;
  onConnectCanton: () => void;
  isEthConnecting: boolean;
  isCantonConnecting: boolean;
}

export function LandingFallback({
  onConnectEthereum,
  onConnectCanton,
  isEthConnecting,
  isCantonConnecting,
}: LandingFallbackProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-[#050510] via-[#0a0a2e] to-[#050510] px-4 text-center">
      {/* Animated gradient orbs (CSS only) */}
      <div className="absolute left-1/4 top-1/4 h-64 w-64 animate-pulse rounded-full bg-blue-600/10 blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 h-48 w-48 animate-pulse rounded-full bg-emerald-600/10 blur-3xl" />
      <div className="absolute left-1/2 top-1/3 h-32 w-32 animate-pulse rounded-full bg-purple-600/10 blur-2xl" />

      {/* Grid pattern overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Content */}
      <div className="relative z-10">
        <h1 className="text-5xl font-extrabold tracking-tight text-white sm:text-7xl">
          Minted{" "}
          <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
            mUSD
          </span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-300/80">
          Institutional-grade stablecoin bridging Canton Network tokenized assets
          to Ethereum DeFi
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-4">
          {[
            { label: "Cross-Chain", value: "Canton + ETH" },
            { label: "Settlement", value: "Atomic" },
            { label: "Compliance", value: "CIP-56" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm"
            >
              <span className="text-gray-400">{s.label}: </span>
              <span className="font-semibold text-white">{s.value}</span>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={onConnectEthereum}
            disabled={isEthConnecting}
            className="rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-blue-500/25 transition-all hover:shadow-blue-500/40 hover:brightness-110 disabled:opacity-60"
          >
            {isEthConnecting ? "Connecting..." : "Connect Ethereum"}
          </button>
          <button
            onClick={onConnectCanton}
            disabled={isCantonConnecting}
            className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-8 py-3.5 font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all hover:shadow-emerald-500/40 hover:brightness-110 disabled:opacity-60"
          >
            {isCantonConnecting ? "Connecting..." : "Connect Canton"}
          </button>
        </div>

        <div className="mt-16 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
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
              className="rounded-xl border border-white/10 bg-black/30 p-5 backdrop-blur-sm transition-colors hover:border-white/20"
            >
              <h3 className="mb-2 font-semibold text-white">{card.title}</h3>
              <p className="text-sm text-gray-400">{card.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
