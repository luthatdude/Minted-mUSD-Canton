import { useState } from "react";
import Head from "next/head";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";

const revenueData = [
  {
    tvl: "$100M",
    yieldSpread: 6,
    appRewards: 8.1,
    fees: 0.8,
    total: 14.9,
  },
  {
    tvl: "$250M",
    yieldSpread: 15,
    appRewards: 20.25,
    fees: 2,
    total: 37.25,
  },
  {
    tvl: "$500M",
    yieldSpread: 30,
    appRewards: 40.5,
    fees: 4,
    total: 74.5,
  },
  {
    tvl: "$1B",
    yieldSpread: 60,
    appRewards: 81,
    fees: 8,
    total: 149,
  },
];

const feeStructure = [
  {
    stream: "Yield Spread",
    mechanism: "Treasury yield minus holder payout",
    rate: "6% of TVL",
  },
  {
    stream: "Canton App Rewards",
    mechanism: "Top app incentives (90% to Minted)",
    rate: "Variable",
  },
  {
    stream: "Attestation Fees",
    mechanism: "Canton Coin burns per attestation",
    rate: "0.05% of turnover",
  },
  {
    stream: "Mint/Redeem Fees",
    mechanism: "DirectMint entry/exit",
    rate: "0.1% each way",
  },
  {
    stream: "DEX LP Fees",
    mechanism: "Protocol-owned liquidity on Temple",
    rate: "LP fee share",
  },
];

const COLORS = {
  bg: "#0A0A0F",
  card: "#12121A",
  cardBorder: "#1E1E2E",
  accent: "#C8FF00",
  accentDim: "rgba(200, 255, 0, 0.15)",
  accentGlow: "rgba(200, 255, 0, 0.08)",
  blue: "#4A9EFF",
  purple: "#A855F7",
  textPrimary: "#F0F0F5",
  textSecondary: "#8888A0",
  textMuted: "#55556A",
  gridLine: "#1A1A28",
};

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div
        style={{
          background: COLORS.card,
          border: `1px solid ${COLORS.cardBorder}`,
          borderRadius: "12px",
          padding: "16px 20px",
          boxShadow: `0 20px 40px rgba(0,0,0,0.5), 0 0 30px ${COLORS.accentGlow}`,
        }}
      >
        <p
          style={{
            color: COLORS.accent,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "13px",
            fontWeight: 700,
            margin: "0 0 12px 0",
          }}
        >
          TVL: {label}
        </p>
        {payload.map((entry, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "24px",
              marginBottom: "6px",
            }}
          >
            <span style={{ color: COLORS.textSecondary, fontSize: "12px" }}>
              {entry.name}
            </span>
            <span style={{ color: entry.color, fontSize: "12px", fontWeight: 600 }}>
              ${entry.value}M
            </span>
          </div>
        ))}
        <div
          style={{
            borderTop: `1px solid ${COLORS.cardBorder}`,
            marginTop: "10px",
            paddingTop: "10px",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: COLORS.textPrimary, fontSize: "12px", fontWeight: 700 }}>
            TOTAL
          </span>
          <span style={{ color: COLORS.accent, fontSize: "13px", fontWeight: 700 }}>
            ${payload.reduce((sum, entry) => sum + entry.value, 0).toFixed(1)}M
          </span>
        </div>
      </div>
    );
  }
  return null;
};

const StatCard = ({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) => (
  <div
    style={{
      background: COLORS.card,
      border: `1px solid ${COLORS.cardBorder}`,
      borderRadius: "14px",
      padding: "20px 24px",
      flex: 1,
      minWidth: "140px",
      position: "relative",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: "2px",
        background: color,
      }}
    />
    <p
      style={{
        color: COLORS.textMuted,
        fontSize: "11px",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        margin: "0 0 8px 0",
      }}
    >
      {label}
    </p>
    <p
      style={{
        color: color,
        fontSize: "28px",
        fontWeight: 800,
        margin: "0 0 4px 0",
      }}
    >
      {value}
    </p>
    <p style={{ color: COLORS.textSecondary, fontSize: "11px", margin: 0 }}>
      {sub}
    </p>
  </div>
);

export default function RevenueModel() {
  const [activeView, setActiveView] = useState<"stacked" | "area">("stacked");

  return (
    <>
      <Head>
        <title>mUSD Revenue Model | Minted Protocol</title>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </Head>
      <div
        style={{
          background: COLORS.bg,
          minHeight: "100vh",
          padding: "40px 32px",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {/* Header */}
        <div style={{ maxWidth: "1000px", margin: "0 auto 40px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
            <div
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: COLORS.accent,
                boxShadow: `0 0 12px ${COLORS.accent}`,
              }}
            />
            <span
              style={{
                color: COLORS.textMuted,
                fontSize: "11px",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
              }}
            >
              mUSD Canton Pilot
            </span>
          </div>
          <h1
            style={{
              color: COLORS.textPrimary,
              fontSize: "36px",
              fontWeight: 800,
              margin: "0 0 8px 0",
            }}
          >
            Revenue Model
          </h1>
          <p style={{ color: COLORS.textSecondary, fontSize: "14px", margin: 0 }}>
            Projected annual revenue across TVL milestones
          </p>
        </div>

        {/* Stat Cards */}
        <div
          style={{
            maxWidth: "1000px",
            margin: "0 auto 40px",
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <StatCard label="@ $500M TVL" value="$74.5M" sub="Annual Revenue" color={COLORS.accent} />
          <StatCard label="Yield Spread" value="6%" sub="of TVL (10-12% yield)" color={COLORS.blue} />
          <StatCard label="App Rewards" value="90%" sub="To Minted" color={COLORS.purple} />
          <StatCard label="@ $1B TVL" value="$149M" sub="Annual Revenue" color={COLORS.accent} />
        </div>

        {/* Chart Toggle */}
        <div style={{ maxWidth: "1000px", margin: "0 auto 20px" }}>
          <div style={{ display: "flex", gap: "4px" }}>
            {(["stacked", "area"] as const).map((view) => (
              <button
                key={view}
                onClick={() => setActiveView(view)}
                style={{
                  background: activeView === view ? COLORS.accentDim : "transparent",
                  border: `1px solid ${activeView === view ? COLORS.accent : COLORS.cardBorder}`,
                  color: activeView === view ? COLORS.accent : COLORS.textSecondary,
                  padding: "8px 16px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {view === "stacked" ? "Bar Chart" : "Area Chart"}
              </button>
            ))}
          </div>
        </div>

        {/* Chart */}
        <div
          style={{
            maxWidth: "1000px",
            margin: "0 auto 48px",
            background: COLORS.card,
            border: `1px solid ${COLORS.cardBorder}`,
            borderRadius: "16px",
            padding: "32px 24px 24px",
          }}
        >
          <ResponsiveContainer width="100%" height={400}>
            {activeView === "stacked" ? (
              <BarChart data={revenueData} margin={{ top: 20, right: 20, left: 20, bottom: 5 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.gridLine} vertical={false} />
                <XAxis
                  dataKey="tvl"
                  tick={{ fill: COLORS.textSecondary, fontSize: 12 }}
                  axisLine={{ stroke: COLORS.cardBorder }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: COLORS.textMuted, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}M`}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: COLORS.accentGlow }} />
                <Bar dataKey="yieldSpread" name="Yield Spread" stackId="a" fill={COLORS.blue} />
                <Bar dataKey="appRewards" name="App Rewards" stackId="a" fill={COLORS.purple} />
                <Bar dataKey="fees" name="Fees" stackId="a" fill={COLORS.accent} radius={[4, 4, 0, 0]} />
              </BarChart>
            ) : (
              <AreaChart data={revenueData} margin={{ top: 20, right: 20, left: 20, bottom: 5 }}>
                <defs>
                  <linearGradient id="gradBlue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.blue} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COLORS.blue} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradPurple" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.purple} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COLORS.purple} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.accent} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={COLORS.accent} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.gridLine} vertical={false} />
                <XAxis
                  dataKey="tvl"
                  tick={{ fill: COLORS.textSecondary, fontSize: 12 }}
                  axisLine={{ stroke: COLORS.cardBorder }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: COLORS.textMuted, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}M`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="yieldSpread" name="Yield Spread" stroke={COLORS.blue} strokeWidth={2} fill="url(#gradBlue)" />
                <Area type="monotone" dataKey="appRewards" name="App Rewards" stroke={COLORS.purple} strokeWidth={2} fill="url(#gradPurple)" />
                <Area type="monotone" dataKey="fees" name="Fees" stroke={COLORS.accent} strokeWidth={2} fill="url(#gradGreen)" />
              </AreaChart>
            )}
          </ResponsiveContainer>

          {/* Legend */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "32px",
              marginTop: "20px",
              paddingTop: "16px",
              borderTop: `1px solid ${COLORS.cardBorder}`,
            }}
          >
            {[
              { label: "Yield Spread (6%)", color: COLORS.blue },
              { label: "App Rewards (90%)", color: COLORS.purple },
              { label: "Fees", color: COLORS.accent },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "3px", background: item.color }} />
                <span style={{ color: COLORS.textSecondary, fontSize: "11px" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Fee Structure Table */}
        <div style={{ maxWidth: "1000px", margin: "0 auto 48px" }}>
          <h2 style={{ color: COLORS.textPrimary, fontSize: "20px", fontWeight: 700, margin: "0 0 20px 0" }}>
            Fee Structure
          </h2>
          <div
            style={{
              background: COLORS.card,
              border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: "16px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 2fr 1fr",
                padding: "14px 24px",
                background: COLORS.accentGlow,
                borderBottom: `1px solid ${COLORS.cardBorder}`,
              }}
            >
              {["Stream", "Mechanism", "Rate"].map((h) => (
                <span
                  key={h}
                  style={{
                    color: COLORS.textMuted,
                    fontSize: "10px",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  {h}
                </span>
              ))}
            </div>
            {feeStructure.map((row, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.2fr 2fr 1fr",
                  padding: "16px 24px",
                  borderBottom: i < feeStructure.length - 1 ? `1px solid ${COLORS.cardBorder}` : "none",
                }}
              >
                <span style={{ color: COLORS.textPrimary, fontSize: "13px", fontWeight: 600 }}>{row.stream}</span>
                <span style={{ color: COLORS.textSecondary, fontSize: "12px" }}>{row.mechanism}</span>
                <span style={{ color: COLORS.accent, fontSize: "12px", fontWeight: 600 }}>{row.rate}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Revenue by TVL Table */}
        <div style={{ maxWidth: "1000px", margin: "0 auto 48px" }}>
          <h2 style={{ color: COLORS.textPrimary, fontSize: "20px", fontWeight: 700, margin: "0 0 20px 0" }}>
            Revenue by TVL
          </h2>
          <div
            style={{
              background: COLORS.card,
              border: `1px solid ${COLORS.cardBorder}`,
              borderRadius: "16px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                padding: "14px 24px",
                background: COLORS.accentGlow,
                borderBottom: `1px solid ${COLORS.cardBorder}`,
              }}
            >
              {["TVL", "Yield Spread", "App Rewards", "Fees", "Total"].map((h) => (
                <span
                  key={h}
                  style={{
                    color: COLORS.textMuted,
                    fontSize: "10px",
                    fontWeight: 600,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    textAlign: h === "Total" ? "right" : "left",
                  }}
                >
                  {h}
                </span>
              ))}
            </div>
            {revenueData.map((row, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                  padding: "16px 24px",
                  borderBottom: i < revenueData.length - 1 ? `1px solid ${COLORS.cardBorder}` : "none",
                  background: row.tvl === "$500M" ? COLORS.accentGlow : "transparent",
                }}
              >
                <span style={{ color: COLORS.textPrimary, fontSize: "13px", fontWeight: 700 }}>{row.tvl}</span>
                <span style={{ color: COLORS.blue, fontSize: "13px", fontWeight: 500 }}>${row.yieldSpread}M</span>
                <span style={{ color: COLORS.purple, fontSize: "13px", fontWeight: 500 }}>${row.appRewards}M</span>
                <span style={{ color: COLORS.textSecondary, fontSize: "13px", fontWeight: 500 }}>${row.fees}M</span>
                <span style={{ color: COLORS.accent, fontSize: "14px", fontWeight: 800, textAlign: "right" }}>
                  ${row.total}M
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ maxWidth: "1000px", margin: "0 auto" }}>
          <p
            style={{
              color: COLORS.textMuted,
              fontSize: "10px",
              letterSpacing: "0.05em",
              textAlign: "center",
            }}
          >
            MINTED · mUSD CANTON PILOT · REVENUE PROJECTIONS
          </p>
        </div>
      </div>
    </>
  );
}
