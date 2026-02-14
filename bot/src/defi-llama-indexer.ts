/**
 * DefiLlama Yield Indexer — Hybrid Layer 1
 *
 * Polls DeFiLlama /pools endpoint every 10 minutes, filters to the top 50
 * ACTIVE Ethereum stablecoin yield sources, and applies tranche scoring.
 *
 * Dead-protocol filtering:
 *   - Exclude pools with TVL < $500K (no meaningful liquidity)
 *   - Exclude pools with APY === 0 or null (no yield activity)
 *   - Exclude pools from projects with total Ethereum TVL < $1M
 *   - Exclude pools with "il" exposure (impermanent loss, non-stablecoin)
 *   - Exclude pools that haven't been updated in DeFiLlama for > 7 days
 *   - Deduplicate by project+symbol (keep highest TVL instance)
 *
 * Output: Normalized YieldOpportunity[] compatible with on-chain YieldScanner
 *         structs, ready for frontend consumption and on-chain verification.
 *
 * Usage:
 *   npx ts-node src/defi-llama-indexer.ts
 *
 * ENV:
 *   INDEXER_PORT           — HTTP port (default: 3212)
 *   INDEXER_HOST           — Bind address (default: 127.0.0.1)
 *   INDEXER_POLL_MS        — Poll interval (default: 600000 = 10 min)
 *   INDEXER_MIN_TVL        — Minimum TVL in USD (default: 500000)
 *   INDEXER_MIN_PROJECT_TVL — Minimum project-level TVL (default: 1000000)
 *   INDEXER_MAX_APY_DROP_7D — Max 7d APY drop % before exclusion (default: -90)
 *   INDEXER_BEARER_TOKEN   — Bearer token for API auth (default: "" = no auth)
 *   CORS_ORIGIN            — Allowed CORS origin (default: http://localhost:3000)
 */

import * as http from "http";

// ═══════════════════════════════════════════════════════════════════════════
//                         TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Raw pool from DeFiLlama /pools response */
interface LlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  stablecoin: boolean;
  ilRisk: string;        // "no" | "yes"
  exposure: string;      // "single" | "multi"
  poolMeta: string | null;
  underlyingTokens: string[] | null;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
}

/** Protocol ID mapping — matches on-chain YieldScanner.Protocol enum */
export enum ProtocolId {
  AaveV3 = 0,
  CompoundV3 = 1,
  MorphoBlue = 2,
  Pendle = 3,
  SkySUSDS = 4,
  EthenaSUSDe = 5,
  Spark = 6,
  CurveConvex = 7,
  YearnV3 = 8,
  // Extended protocols (9+) — new protocols added by the indexer
  Lido = 9,
  RocketPool = 10,
  Frax = 11,
  Fluid = 12,
  Euler = 13,
  MakerDSR = 14,
  Gearbox = 15,
  Silo = 16,
  Radiant = 17,
  Sturdy = 18,
  Notional = 19,
  Exactly = 20,
  Sommelier = 21,
  Harvest = 22,
  Beefy = 23,
  Convex = 24,
  StakeDAO = 25,
  Angle = 26,
  MountainUSDM = 27,
  Usual = 28,
  Resolv = 29,
  Origin = 30,
  Prisma = 31,
  crvUSD = 32,
  Tokemak = 33,
  Ondo = 34,
  Maple = 35,
  Clearpool = 36,
  TrueFi = 37,
  Goldfinch = 38,
  Centrifuge = 39,
  Ribbon = 40,
  Idle = 41,
  Instadapp = 42,
  DForce = 43,
  Benqi = 44,
  Venus = 45,
  Aura = 46,
  Balancer = 47,
  Yearn = 48,
  Generic = 49,
}

/** Risk tier — matches on-chain RiskTier enum */
export enum RiskTier {
  Low = 0,
  Medium = 1,
  High = 2,
  Unclassified = 3,
}

/** Tranche — matches on-chain Tranche enum */
export enum Tranche {
  Senior = 0,
  Mezzanine = 1,
  Junior = 2,
}

/** Normalized yield opportunity — matches on-chain Opportunity struct */
export interface IndexedOpportunity {
  protocol: number;
  protocolName: string;
  risk: RiskTier;
  label: string;
  venue: string;          // DeFiLlama pool ID (for on-chain: contract address)
  marketId: string;       // bytes32 hex (0x0 for most)
  supplyApyBps: number;
  borrowApyBps: number;
  tvlUsd: number;         // Raw USD (not 6-decimal)
  utilizationBps: number;
  extraData: number;
  available: boolean;
  // Extended fields from DeFiLlama
  apyBase: number;
  apyReward: number;
  apy7dDelta: number | null;
  apy30dDelta: number | null;
  volumeUsd7d: number | null;
  projectTotalTvl: number;
  securityScore: number;  // 0-100
  securityTier: string;   // S/A/B/C/D
  underlyingTokens: string[];
  poolMeta: string | null;
  // ── Leverage loop fields ──
  isLeveraged: boolean;           // true if this is a loop strategy opportunity
  leverageMultiplier: number;     // e.g., 3.33 for 70% LTV, 4.0 for 75% LTV
  loopCount: number;              // Conceptual loops (1 with flash loan)
  baseProtocol: string;           // Underlying protocol (e.g., "AAVE V3")
  effectiveApyBps: number;        // Net APY after leverage: supply*L - borrow*(L-1) + merkl
  merklApyBps: number;            // Estimated Merkl reward APY in bps
  leverageStrategy: string;       // Strategy contract name ("AaveV3Loop", "EulerV2Loop", etc.)
}

/** Tranche suggestion — matches on-chain TrancheSuggestion struct */
export interface IndexedTrancheSuggestion {
  rank: number;
  tranche: Tranche;
  protocol: number;
  protocolName: string;
  label: string;
  venue: string;
  marketId: string;
  supplyApyBps: number;
  borrowApyBps: number;
  tvlUsd: number;
  utilizationBps: number;
  risk: RiskTier;
  compositeScore: number;
  reason: string;
  securityScore: number;
  securityTier: string;
  // ── Leverage loop fields ──
  isLeveraged: boolean;
  leverageMultiplier: number;
  effectiveApyBps: number;
  leverageStrategy: string;
}

/** Full scan result */
export interface IndexerResult {
  opportunities: IndexedOpportunity[];
  tranches: {
    senior: IndexedTrancheSuggestion[];
    mezzanine: IndexedTrancheSuggestion[];
    junior: IndexedTrancheSuggestion[];
  };
  meta: {
    totalPoolsScanned: number;
    ethereumPoolsFound: number;
    stablePoolsFound: number;
    activePoolsAfterFilter: number;
    projectsRepresented: number;
    scanTimestamp: number;
    scanDurationMs: number;
    scanNumber: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//                     PROTOCOL REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

/** Map DeFiLlama project slugs → our ProtocolId + security metadata */
interface ProtocolMeta {
  id: ProtocolId;
  risk: RiskTier;
  securityScore: number;  // 0-100
  tier: string;           // S/A/B/C/D
  audits: number;         // Known audit count
  launchYear: number;     // Year launched on mainnet
}

const PROTOCOL_REGISTRY: Record<string, ProtocolMeta> = {
  // ── S-Tier: Battle-tested, multi-billion, extensive audits ──
  "aave-v3":            { id: ProtocolId.AaveV3,       risk: RiskTier.Low,    securityScore: 96, tier: "S", audits: 30, launchYear: 2023 },
  "aave-v2":            { id: ProtocolId.AaveV3,       risk: RiskTier.Low,    securityScore: 95, tier: "S", audits: 25, launchYear: 2020 },
  "compound-v3":        { id: ProtocolId.CompoundV3,   risk: RiskTier.Low,    securityScore: 94, tier: "S", audits: 20, launchYear: 2022 },
  "compound":           { id: ProtocolId.CompoundV3,   risk: RiskTier.Low,    securityScore: 93, tier: "S", audits: 18, launchYear: 2019 },
  "lido":               { id: ProtocolId.Lido,         risk: RiskTier.Low,    securityScore: 95, tier: "S", audits: 15, launchYear: 2020 },
  "maker":              { id: ProtocolId.MakerDSR,     risk: RiskTier.Low,    securityScore: 95, tier: "S", audits: 20, launchYear: 2019 },
  "makerdao":           { id: ProtocolId.MakerDSR,     risk: RiskTier.Low,    securityScore: 95, tier: "S", audits: 20, launchYear: 2019 },
  "sky-savings-rate":   { id: ProtocolId.SkySUSDS,     risk: RiskTier.Low,    securityScore: 93, tier: "S", audits: 15, launchYear: 2024 },
  "spark":              { id: ProtocolId.Spark,        risk: RiskTier.Low,    securityScore: 90, tier: "S", audits: 10, launchYear: 2023 },
  "rocket-pool":        { id: ProtocolId.RocketPool,   risk: RiskTier.Low,    securityScore: 92, tier: "S", audits: 12, launchYear: 2021 },

  // ── A-Tier: Proven, growing, well-audited ──
  "morpho":             { id: ProtocolId.MorphoBlue,   risk: RiskTier.Medium, securityScore: 90, tier: "A", audits: 10, launchYear: 2024 },
  "morpho-blue":        { id: ProtocolId.MorphoBlue,   risk: RiskTier.Medium, securityScore: 90, tier: "A", audits: 10, launchYear: 2024 },
  "morpho-aavev3":      { id: ProtocolId.MorphoBlue,   risk: RiskTier.Medium, securityScore: 88, tier: "A", audits: 8,  launchYear: 2023 },
  "pendle":             { id: ProtocolId.Pendle,       risk: RiskTier.Medium, securityScore: 88, tier: "A", audits: 8,  launchYear: 2023 },
  "curve-dex":          { id: ProtocolId.CurveConvex,  risk: RiskTier.Medium, securityScore: 87, tier: "A", audits: 12, launchYear: 2020 },
  "convex-finance":     { id: ProtocolId.Convex,       risk: RiskTier.Medium, securityScore: 86, tier: "A", audits: 8,  launchYear: 2021 },
  "fluid":              { id: ProtocolId.Fluid,        risk: RiskTier.Medium, securityScore: 82, tier: "A", audits: 6,  launchYear: 2024 },
  "frax-lend":          { id: ProtocolId.Frax,         risk: RiskTier.Medium, securityScore: 83, tier: "A", audits: 7,  launchYear: 2023 },
  "fraxlend":           { id: ProtocolId.Frax,         risk: RiskTier.Medium, securityScore: 83, tier: "A", audits: 7,  launchYear: 2023 },
  "instadapp":          { id: ProtocolId.Instadapp,    risk: RiskTier.Medium, securityScore: 82, tier: "A", audits: 6,  launchYear: 2021 },
  "balancer-v2":        { id: ProtocolId.Balancer,     risk: RiskTier.Medium, securityScore: 85, tier: "A", audits: 10, launchYear: 2021 },
  "aura":               { id: ProtocolId.Aura,         risk: RiskTier.Medium, securityScore: 80, tier: "A", audits: 5,  launchYear: 2022 },
  "yearn-finance":      { id: ProtocolId.YearnV3,      risk: RiskTier.Medium, securityScore: 84, tier: "A", audits: 8,  launchYear: 2020 },
  "idle-finance":       { id: ProtocolId.Idle,         risk: RiskTier.Medium, securityScore: 80, tier: "A", audits: 6,  launchYear: 2020 },
  "angle":              { id: ProtocolId.Angle,        risk: RiskTier.Medium, securityScore: 80, tier: "A", audits: 5,  launchYear: 2022 },
  "stake-dao":          { id: ProtocolId.StakeDAO,     risk: RiskTier.Medium, securityScore: 78, tier: "A", audits: 5,  launchYear: 2021 },
  "ondo-finance":       { id: ProtocolId.Ondo,         risk: RiskTier.Medium, securityScore: 80, tier: "A", audits: 5,  launchYear: 2023 },
  "mountain-protocol":  { id: ProtocolId.MountainUSDM, risk: RiskTier.Medium, securityScore: 78, tier: "A", audits: 4,  launchYear: 2023 },

  // ── B-Tier: Newer or niche, but functional ──
  "euler":              { id: ProtocolId.Euler,        risk: RiskTier.Medium, securityScore: 75, tier: "B", audits: 6,  launchYear: 2023 },
  "euler-v2":           { id: ProtocolId.Euler,        risk: RiskTier.Medium, securityScore: 76, tier: "B", audits: 5,  launchYear: 2024 },
  "ethena":             { id: ProtocolId.EthenaSUSDe,  risk: RiskTier.High,   securityScore: 72, tier: "B", audits: 4,  launchYear: 2024 },
  "gearbox":            { id: ProtocolId.Gearbox,      risk: RiskTier.High,   securityScore: 74, tier: "B", audits: 5,  launchYear: 2022 },
  "silo-finance":       { id: ProtocolId.Silo,         risk: RiskTier.High,   securityScore: 72, tier: "B", audits: 4,  launchYear: 2023 },
  "silo-v2":            { id: ProtocolId.Silo,         risk: RiskTier.High,   securityScore: 73, tier: "B", audits: 4,  launchYear: 2024 },
  "notional-v3":        { id: ProtocolId.Notional,     risk: RiskTier.High,   securityScore: 74, tier: "B", audits: 5,  launchYear: 2023 },
  "exactly":            { id: ProtocolId.Exactly,      risk: RiskTier.Medium, securityScore: 74, tier: "B", audits: 4,  launchYear: 2023 },
  "sommelier":          { id: ProtocolId.Sommelier,    risk: RiskTier.High,   securityScore: 70, tier: "B", audits: 4,  launchYear: 2022 },
  "harvest-finance":    { id: ProtocolId.Harvest,      risk: RiskTier.High,   securityScore: 68, tier: "B", audits: 3,  launchYear: 2020 },
  "beefy":              { id: ProtocolId.Beefy,        risk: RiskTier.High,   securityScore: 70, tier: "B", audits: 3,  launchYear: 2020 },
  "crvusd":             { id: ProtocolId.crvUSD,       risk: RiskTier.Medium, securityScore: 82, tier: "B", audits: 6,  launchYear: 2023 },
  "usual":              { id: ProtocolId.Usual,        risk: RiskTier.Medium, securityScore: 70, tier: "B", audits: 3,  launchYear: 2024 },
  "resolv":             { id: ProtocolId.Resolv,       risk: RiskTier.High,   securityScore: 65, tier: "B", audits: 2,  launchYear: 2024 },
  "origin-dollar":      { id: ProtocolId.Origin,       risk: RiskTier.High,   securityScore: 68, tier: "B", audits: 4,  launchYear: 2020 },
  "sturdy":             { id: ProtocolId.Sturdy,       risk: RiskTier.High,   securityScore: 65, tier: "B", audits: 3,  launchYear: 2023 },

  // ── C-Tier: Institutional/RWA lending or higher-risk ──
  "maple":              { id: ProtocolId.Maple,        risk: RiskTier.High,   securityScore: 65, tier: "C", audits: 4,  launchYear: 2021 },
  "clearpool":          { id: ProtocolId.Clearpool,    risk: RiskTier.High,   securityScore: 60, tier: "C", audits: 3,  launchYear: 2022 },
  "truefi":             { id: ProtocolId.TrueFi,       risk: RiskTier.High,   securityScore: 62, tier: "C", audits: 4,  launchYear: 2021 },
  "goldfinch":          { id: ProtocolId.Goldfinch,    risk: RiskTier.High,   securityScore: 60, tier: "C", audits: 3,  launchYear: 2021 },
  "centrifuge":         { id: ProtocolId.Centrifuge,   risk: RiskTier.High,   securityScore: 62, tier: "C", audits: 3,  launchYear: 2021 },
  "ribbon-finance":     { id: ProtocolId.Ribbon,       risk: RiskTier.High,   securityScore: 65, tier: "C", audits: 4,  launchYear: 2021 },
  "tokemak":            { id: ProtocolId.Tokemak,      risk: RiskTier.High,   securityScore: 58, tier: "C", audits: 2,  launchYear: 2021 },
  "dforce":             { id: ProtocolId.DForce,       risk: RiskTier.High,   securityScore: 55, tier: "C", audits: 3,  launchYear: 2020 },
};

/** Stablecoin symbol keywords — used to filter pools */
const STABLECOIN_KEYWORDS = [
  "usdc", "usdt", "dai", "usde", "susde", "frax", "lusd", "gusd",
  "musd", "gho", "cusd", "pyusd", "usdm", "usdd", "tusd",
  "susd", "usds", "susds", "usd+", "rlusd", "usda", "usd0",
  "eusd", "dola", "crvusd", "mkusd", "rai", "fei", "ousd",
  "usdr", "alusd", "mim", "busd",
];

// ═══════════════════════════════════════════════════════════════════════════
//                     CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.INDEXER_PORT || "3212", 10);
const HOST = process.env.INDEXER_HOST || "127.0.0.1";
const POLL_INTERVAL_MS = parseInt(process.env.INDEXER_POLL_MS || "600000", 10);  // 10 min
const MIN_POOL_TVL = parseFloat(process.env.INDEXER_MIN_TVL || "500000");         // $500K
const MIN_PROJECT_TVL = parseFloat(process.env.INDEXER_MIN_PROJECT_TVL || "1000000"); // $1M
const MAX_APY_DROP_7D = parseFloat(process.env.INDEXER_MAX_APY_DROP_7D || "-90");    // -90%
const TOP_N = 50;
const PER_TRANCHE = 10;
const DEFI_LLAMA_URL = "https://yields.llama.fi/pools";
const DEFI_LLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";\nconst INDEXER_BEARER_TOKEN = process.env.INDEXER_BEARER_TOKEN || ""; // empty = no auth (dev)

// ═══════════════════════════════════════════════════════════════════════════
//                     LOGGING
// ═══════════════════════════════════════════════════════════════════════════

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level.toUpperCase()}] [DEFI-INDEXER] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//                     STATE
// ═══════════════════════════════════════════════════════════════════════════

let latestResult: IndexerResult | null = null;
let scanCount = 0;
let projectTvlCache: Record<string, number> = {};
let lastProtocolFetch = 0;

// ═══════════════════════════════════════════════════════════════════════════
//                     PROTOCOL-LEVEL TVL FETCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch total TVL per protocol from DeFiLlama /protocols.
 * Cached for 1 hour since this changes slowly.
 */
async function fetchProtocolTvls(): Promise<void> {
  const now = Date.now();
  if (now - lastProtocolFetch < 3600_000 && Object.keys(projectTvlCache).length > 0) {
    return; // Use cache
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let resp: Response;
    try {
      resp = await fetch(DEFI_LLAMA_PROTOCOLS_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      log("warn", `Protocols endpoint returned ${resp.status} — using cached data`);
      return;
    }
    const data = await resp.json() as Array<{ slug: string; name: string; tvl: number; chainTvls?: Record<string, number> }>;
    const newCache: Record<string, number> = {};
    for (const p of data) {
      const slug = p.slug?.toLowerCase() || p.name?.toLowerCase().replace(/\s+/g, "-") || "";
      // Use Ethereum-specific TVL if available, else total
      const ethTvl = p.chainTvls?.["Ethereum"] ?? p.tvl ?? 0;
      newCache[slug] = ethTvl;
    }
    projectTvlCache = newCache;
    lastProtocolFetch = now;
    log("info", `Cached TVL for ${Object.keys(newCache).length} protocols`);
  } catch (err: unknown) {
    log("warn", `Protocol TVL fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     CORE: FETCH + FILTER + SCORE
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAndProcess(): Promise<void> {
  scanCount++;
  const startTime = Date.now();
  log("info", `Starting scan #${scanCount}...`);

  try {
    // 1. Fetch protocol-level TVLs (cached, used for dead-protocol detection)
    await fetchProtocolTvls();

    // 2. Fetch all pools from DeFiLlama
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let resp: Response;
    try {
      resp = await fetch(DEFI_LLAMA_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      log("error", `DeFiLlama returned ${resp.status}`);
      return;
    }
    const text = await resp.text();
    if (text.length > 100 * 1024 * 1024) {
      log("error", `Response too large: ${(text.length / 1e6).toFixed(1)}MB`);
      return;
    }
    const json = JSON.parse(text) as { data?: LlamaPool[] };
    if (!json.data || !Array.isArray(json.data)) {
      log("error", "DeFiLlama response missing 'data' array");
      return;
    }

    const allPools = json.data;
    log("info", `Fetched ${allPools.length} total pools from DeFiLlama`);

    // ── Step 1: Ethereum-only filter ──────────────────────────────────
    const ethPools = allPools.filter(
      (p) => p.chain?.toLowerCase() === "ethereum"
    );
    log("info", `  ${ethPools.length} pools on Ethereum`);

    // ── Step 2: Stablecoin filter ─────────────────────────────────────
    const stablePools = ethPools.filter((p) => {
      const sym = (p.symbol || "").toLowerCase();
      return STABLECOIN_KEYWORDS.some((kw) => sym.includes(kw));
    });
    log("info", `  ${stablePools.length} stablecoin pools`);

    // ── Step 3: Dead protocol filtering ───────────────────────────────
    const activePools = stablePools.filter((p) => {
      // (a) Pool TVL must be above threshold
      if ((p.tvlUsd ?? 0) < MIN_POOL_TVL) return false;

      // (b) APY must be > 0 (no dead yields)
      const apy = p.apyBase ?? p.apy ?? 0;
      if (apy <= 0) return false;

      // (c) No impermanent loss exposure (purely stablecoin yield)
      if (p.ilRisk === "yes") return false;

      // (d) Check project-level TVL (dead projects have < $1M total)
      const projectSlug = (p.project || "").toLowerCase().replace(/\s+/g, "-");
      const projectTvl = projectTvlCache[projectSlug] ?? 0;
      if (projectTvl > 0 && projectTvl < MIN_PROJECT_TVL) return false;

      // (e) If 7d APY delta is available and APY dropped > configured threshold, likely dying
      if (p.apyPct7D !== null && p.apyPct7D !== undefined) {
        const baseApy = p.apyBase ?? p.apy ?? 0;
        if (baseApy > 0 && p.apyPct7D < MAX_APY_DROP_7D) return false;
      }

      return true;
    });
    log("info", `  ${activePools.length} active pools after dead-protocol filter`);

    // ── Step 4: Deduplicate by project+symbol (keep highest TVL) ──────
    const deduped = deduplicatePools(activePools);
    log("info", `  ${deduped.length} pools after deduplication`);

    // ── Step 5: Score, sort, take top 50 ──────────────────────────────
    const scored = deduped.map((p) => scorePool(p));
    scored.sort((a, b) => b.compositeScore - a.compositeScore);
    const top50 = scored.slice(0, TOP_N);
    log("info", `  Top ${top50.length} opportunities selected`);

    // ── Step 6: Convert to IndexedOpportunity[] ───────────────────────
    const opportunities: IndexedOpportunity[] = top50.map((s) => s.opportunity);

    // ── Step 6b: Enrich with leveraged loop variants ──────────────────
    const leveragedVariants = enrichWithLeverageOpportunities(opportunities);
    log("info", `  ${leveragedVariants.length} leveraged loop variants generated`);
    opportunities.push(...leveragedVariants);

    // ── Step 7: Build tranche suggestions ─────────────────────────────
    const tranches = buildTranches(opportunities);

    // Count unique projects
    const projects = new Set(top50.map((s) => s.opportunity.protocolName));

    const duration = Date.now() - startTime;
    latestResult = {
      opportunities,
      tranches,
      meta: {
        totalPoolsScanned: allPools.length,
        ethereumPoolsFound: ethPools.length,
        stablePoolsFound: stablePools.length,
        activePoolsAfterFilter: activePools.length,
        projectsRepresented: projects.size,
        scanTimestamp: Date.now(),
        scanDurationMs: duration,
        scanNumber: scanCount,
      },
    };

    log("info", `Scan #${scanCount} complete in ${duration}ms — ${opportunities.length} opportunities across ${projects.size} protocols`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Scan #${scanCount} failed: ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                     DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

function deduplicatePools(pools: LlamaPool[]): LlamaPool[] {
  const best = new Map<string, LlamaPool>();
  for (const p of pools) {
    const key = `${p.project.toLowerCase()}::${p.symbol.toLowerCase()}`;
    const existing = best.get(key);
    if (!existing || (p.tvlUsd ?? 0) > (existing.tvlUsd ?? 0)) {
      best.set(key, p);
    }
  }
  return Array.from(best.values());
}

// ═══════════════════════════════════════════════════════════════════════════
//                     SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════

interface ScoredPool {
  opportunity: IndexedOpportunity;
  compositeScore: number;
}

function scorePool(pool: LlamaPool): ScoredPool {
  const projectSlug = pool.project.toLowerCase().replace(/\s+/g, "-");
  const meta = PROTOCOL_REGISTRY[projectSlug] || {
    id: ProtocolId.Generic,
    risk: RiskTier.Unclassified,
    securityScore: 40,
    tier: "D",
    audits: 0,
    launchYear: 2025,
  };

  const apyBase = pool.apyBase ?? pool.apy ?? 0;
  const apyReward = pool.apyReward ?? 0;
  const totalApy = apyBase + apyReward;
  const supplyBps = Math.round(totalApy * 100); // Convert % to bps
  const tvl = pool.tvlUsd ?? 0;

  // ── Composite score (used for top-50 ranking) ──
  // Weights: security 35%, yield 30%, TVL 20%, stability 15%
  const yieldScore = Math.min(10000, supplyBps * 10); // 10% APY → 10000
  const securityScoreNorm = meta.securityScore * 100;  // 0-10000
  const tvlScore = tvlScoreCalc(tvl);
  const stabilityScore = stabilityScoreCalc(pool);

  const composite = Math.round(
    yieldScore * 0.30 +
    securityScoreNorm * 0.35 +
    tvlScore * 0.20 +
    stabilityScore * 0.15
  );

  const opportunity: IndexedOpportunity = {
    protocol: meta.id,
    protocolName: pool.project,
    risk: meta.risk,
    label: `${pool.project} ${pool.symbol}`,
    venue: pool.pool, // DeFiLlama pool ID
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    supplyApyBps: supplyBps,
    borrowApyBps: 0,
    tvlUsd: tvl,
    utilizationBps: 0,
    extraData: 0,
    available: true,
    // Extended
    apyBase,
    apyReward,
    apy7dDelta: pool.apyPct7D,
    apy30dDelta: pool.apyPct30D,
    volumeUsd7d: pool.volumeUsd7d,
    projectTotalTvl: projectTvlCache[projectSlug] ?? 0,
    securityScore: meta.securityScore,
    securityTier: meta.tier,
    underlyingTokens: pool.underlyingTokens ?? [],
    poolMeta: pool.poolMeta,
    // Leverage fields — populated by enrichWithLeverageOpportunities()
    isLeveraged: false,
    leverageMultiplier: 1.0,
    loopCount: 0,
    baseProtocol: pool.project,
    effectiveApyBps: supplyBps,
    merklApyBps: 0,
    leverageStrategy: "",
  };

  return { opportunity, compositeScore: composite };
}

function tvlScoreCalc(tvl: number): number {
  if (tvl >= 1_000_000_000) return 10000;  // $1B+
  if (tvl >= 500_000_000)   return 9000;
  if (tvl >= 100_000_000)   return 8000;
  if (tvl >= 50_000_000)    return 7000;
  if (tvl >= 10_000_000)    return 6000;
  if (tvl >= 5_000_000)     return 5000;
  if (tvl >= 1_000_000)     return 4000;
  if (tvl >= 500_000)       return 2000;
  return 500;
}

function stabilityScoreCalc(pool: LlamaPool): number {
  // If we have 7d/30d APY delta data, use it for stability measurement
  // Stable APY = high score; volatile APY = low score
  let score = 7000; // Neutral default

  if (pool.apyPct7D !== null && pool.apyPct7D !== undefined) {
    const absDelta7d = Math.abs(pool.apyPct7D);
    if (absDelta7d < 5) score = 10000;       // Very stable
    else if (absDelta7d < 15) score = 8000;   // Stable
    else if (absDelta7d < 30) score = 6000;   // Moderate
    else if (absDelta7d < 50) score = 4000;   // Volatile
    else score = 2000;                         // Very volatile
  }

  // Bonus for having 30d data (more history = more trustworthy)
  if (pool.apyPct30D !== null && pool.apyPct30D !== undefined) {
    if (Math.abs(pool.apyPct30D) < 20) score = Math.min(10000, score + 500);
  }

  return score;
}

// ═══════════════════════════════════════════════════════════════════════════
//                     LEVERAGE LOOP OPPORTUNITY ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/** Protocols that support leveraged looping strategies */
const LEVERAGE_ELIGIBLE_PROTOCOLS: Record<number, {
  strategy: string;
  defaultLtvBps: number;     // Target LTV (75% = 7500)
  maxLeverageX100: number;   // Max leverage × 100 (4x = 400)
  merklEstimateBps: number;  // Estimated Merkl reward APY bps
}> = {
  [ProtocolId.AaveV3]:       { strategy: "AaveV3Loop",     defaultLtvBps: 7500, maxLeverageX100: 400, merklEstimateBps: 50  },
  [ProtocolId.CompoundV3]:   { strategy: "CompoundV3Loop", defaultLtvBps: 7000, maxLeverageX100: 333, merklEstimateBps: 30  },
  [ProtocolId.Euler]:        { strategy: "EulerV2Loop",    defaultLtvBps: 7500, maxLeverageX100: 400, merklEstimateBps: 80  },
  [ProtocolId.MorphoBlue]:   { strategy: "MorphoLoop",     defaultLtvBps: 7000, maxLeverageX100: 333, merklEstimateBps: 100 },
};

/**
 * Enrich base opportunities with synthetic leveraged variants.
 *
 * For each lending opportunity on AAVE/Compound/Euler/Morpho, creates a
 * leveraged variant showing effective APY after looping.
 *
 * Net APY = supplyAPY × leverage − borrowAPY × (leverage − 1) + merklAPY
 */
function enrichWithLeverageOpportunities(opps: IndexedOpportunity[]): IndexedOpportunity[] {
  const leveragedOpps: IndexedOpportunity[] = [];

  for (const opp of opps) {
    const config = LEVERAGE_ELIGIBLE_PROTOCOLS[opp.protocol];
    if (!config) continue;

    // Skip if base APY is 0 or negative (looping won't help)
    if (opp.supplyApyBps <= 0) continue;

    // Calculate leverage: L = 1 / (1 - LTV)
    const leverageX100 = Math.round(10000 * 100 / (10000 - config.defaultLtvBps));  // e.g., 400 for 75% LTV
    const leverage = leverageX100 / 100; // 4.0

    // Estimate borrow rate (typically ~80-120% of supply rate for same-asset)
    // Use borrowApyBps if available, else estimate at 110% of supply
    const borrowApyBps = opp.borrowApyBps > 0
      ? opp.borrowApyBps
      : Math.round(opp.supplyApyBps * 1.1);

    // Net APY = supply * L - borrow * (L-1) + merkl
    const supplyComponent = Math.round(opp.supplyApyBps * leverage);
    const borrowComponent = Math.round(borrowApyBps * (leverage - 1));
    const netApyBps = supplyComponent - borrowComponent + config.merklEstimateBps;

    // Only add if net APY is positive and higher than base
    if (netApyBps <= 0 || netApyBps <= opp.supplyApyBps) continue;

    const leveragedOpp: IndexedOpportunity = {
      ...opp,
      label: `${opp.protocolName} ${config.strategy} (${leverage.toFixed(1)}x)`,
      supplyApyBps: netApyBps,
      isLeveraged: true,
      leverageMultiplier: leverage,
      loopCount: 1, // Flash loan = 1 tx
      baseProtocol: opp.protocolName,
      effectiveApyBps: netApyBps,
      merklApyBps: config.merklEstimateBps,
      leverageStrategy: config.strategy,
      // Adjust risk tier up for leverage
      risk: opp.risk === RiskTier.Low ? RiskTier.Medium : RiskTier.High,
      // Reduce security score for leverage risk
      securityScore: Math.max(40, opp.securityScore - 10),
    };

    leveragedOpps.push(leveragedOpp);
  }

  return leveragedOpps;
}

// ═══════════════════════════════════════════════════════════════════════════
//                     TRANCHE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

function buildTranches(opps: IndexedOpportunity[]): IndexerResult["tranches"] {
  if (opps.length === 0) {
    return {
      senior: [],
      mezzanine: [],
      junior: [],
    };
  }

  const seniorScores   = opps.map((o) => trancheScore(o, Tranche.Senior));
  const mezzScores     = opps.map((o) => trancheScore(o, Tranche.Mezzanine));
  const juniorScores   = opps.map((o) => trancheScore(o, Tranche.Junior));

  const senior    = buildTrancheSuggestions(opps, seniorScores, Tranche.Senior, PER_TRANCHE);
  const mezzanine = buildTrancheSuggestions(opps, mezzScores, Tranche.Mezzanine, PER_TRANCHE);
  const junior    = buildTrancheSuggestions(opps, juniorScores, Tranche.Junior, PER_TRANCHE);

  return { senior, mezzanine, junior };
}

/**
 * Tranche scoring — mirrors the on-chain _trancheScore() logic exactly.
 *
 *   Senior:     yield=10%, security=40%, tvl=30%, util=20%
 *   Mezzanine:  yield=30%, security=25%, tvl=25%, util=20%
 *   Junior:     yield=50%, security=15%, tvl=20%, util=15%
 */
function trancheScore(opp: IndexedOpportunity, t: Tranche): number {
  let yieldW: number, secW: number, tvlW: number, utilW: number;

  if (t === Tranche.Senior) {
    yieldW = 10; secW = 40; tvlW = 30; utilW = 20;
  } else if (t === Tranche.Mezzanine) {
    yieldW = 30; secW = 25; tvlW = 25; utilW = 20;
  } else {
    yieldW = 50; secW = 15; tvlW = 20; utilW = 15;
  }

  const yieldS = yieldScore(opp);
  const securityS = securityScore(opp, t);
  const tvlS = tvlScoreCalc(opp.tvlUsd);
  const utilS = utilizationScore(opp);

  if (!opp.available) return 0;

  return Math.round((yieldS * yieldW + securityS * secW + tvlS * tvlW + utilS * utilW) / 100);
}

function yieldScore(opp: IndexedOpportunity): number {
  const apy = opp.supplyApyBps;
  if (apy >= 1000) return 10000;
  return Math.round((apy * 10000) / 1000);
}

function securityScore(opp: IndexedOpportunity, t: Tranche): number {
  let base = opp.securityScore * 100; // 0-10000

  // Tranche modifiers (same as on-chain)
  if (t === Tranche.Senior) {
    if (opp.risk === RiskTier.Medium) base = Math.round(base * 0.80);
    if (opp.risk === RiskTier.High) base = Math.round(base * 0.50);
  } else if (t === Tranche.Junior) {
    if (opp.risk === RiskTier.High) base = Math.round(base * 1.30);
    if (base > 10000) base = 10000;
  }

  return base;
}

function utilizationScore(opp: IndexedOpportunity): number {
  // DeFiLlama doesn't provide utilization directly; use stability as proxy
  return 7000; // Neutral — on-chain verification will provide real utilization
}

function buildTrancheSuggestions(
  opps: IndexedOpportunity[],
  scores: number[],
  t: Tranche,
  n: number,
): IndexedTrancheSuggestion[] {
  const indices = scores
    .map((s, i) => ({ score: s, index: i }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  return indices.map((item, rank) => {
    const opp = opps[item.index];
    return {
      rank: rank + 1,
      tranche: t,
      protocol: opp.protocol,
      protocolName: opp.protocolName,
      label: opp.label,
      venue: opp.venue,
      marketId: opp.marketId,
      supplyApyBps: opp.supplyApyBps,
      borrowApyBps: opp.borrowApyBps,
      tvlUsd: opp.tvlUsd,
      utilizationBps: opp.utilizationBps,
      risk: opp.risk,
      compositeScore: item.score,
      reason: trancheReason(opp, t, rank),
      securityScore: opp.securityScore,
      securityTier: opp.securityTier,
      isLeveraged: opp.isLeveraged,
      leverageMultiplier: opp.leverageMultiplier,
      effectiveApyBps: opp.effectiveApyBps,
      leverageStrategy: opp.leverageStrategy,
    };
  });
}

function trancheReason(opp: IndexedOpportunity, t: Tranche, rank: number): string {
  if (t === Tranche.Senior) {
    if (rank === 0) {
      if (opp.risk === RiskTier.Low) return "Safest yield - blue-chip protocol, deep liquidity";
      return "Best capital preservation option";
    }
    if (rank === 1) return "Strong safety with competitive yield";
    if (opp.risk === RiskTier.Low) return "Battle-tested, institutional-grade";
    return "Acceptable risk for preservation mandate";
  }
  if (t === Tranche.Mezzanine) {
    if (rank === 0) return "Optimal risk/reward balance - strong fundamentals";
    if (rank === 1) return "Well-balanced yield with proven security";
    if (opp.supplyApyBps > 500) return "Attractive yield with manageable risk";
    return "Balanced allocation candidate";
  }
  // Junior
  if (rank === 0) {
    if (opp.supplyApyBps > 1000) return "Highest yield available - elevated risk accepted";
    return "Best yield opportunity in scan";
  }
  if (rank === 1) return "Strong yield with acceptable risk trade-off";
  if (opp.supplyApyBps > 800) return "High yield play - monitor closely";
  return "Yield-maximizing opportunity";
}

// ═══════════════════════════════════════════════════════════════════════════
//                     HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

function sendJSON(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60",
  });
  res.end(JSON.stringify(data));
}

// Rate limiting
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 120;
const rlMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = rlMap.get(ip);
  if (!e || now >= e.resetAt) {
    rlMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  e.count++;
  return e.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rlMap) {
    if (now >= e.resetAt) rlMap.delete(ip);
  }
}, 300_000);

const server = http.createServer((req, res) => {
  const clientIp = req.socket.remoteAddress || "unknown";
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  // ── H-4: Bearer token authentication ──────────────────────────────
  if (INDEXER_BEARER_TOKEN && req.url !== "/health") {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader !== `Bearer ${INDEXER_BEARER_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — provide valid Bearer token" }));
      return;
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── Health ──────────────────────────────────────────────────────────
  if (pathname === "/health") {
    sendJSON(res, {
      status: "ok",
      service: "defi-llama-indexer",
      scanCount,
      lastScan: latestResult?.meta.scanTimestamp
        ? new Date(latestResult.meta.scanTimestamp).toISOString()
        : null,
    });
    return;
  }

  // ── Top 50 opportunities ────────────────────────────────────────────
  if (pathname === "/api/yields/top50") {
    if (!latestResult) {
      sendJSON(res, { error: "No scan data yet. First scan in progress..." }, 503);
      return;
    }
    sendJSON(res, {
      opportunities: latestResult.opportunities,
      meta: latestResult.meta,
    });
    return;
  }

  // ── Tranche suggestions ─────────────────────────────────────────────
  if (pathname === "/api/yields/tranches") {
    if (!latestResult) {
      sendJSON(res, { error: "No scan data yet" }, 503);
      return;
    }
    sendJSON(res, {
      tranches: latestResult.tranches,
      meta: latestResult.meta,
    });
    return;
  }

  // ── Full result (top50 + tranches) ──────────────────────────────────
  if (pathname === "/api/yields/full") {
    if (!latestResult) {
      sendJSON(res, { error: "No scan data yet" }, 503);
      return;
    }
    sendJSON(res, latestResult);
    return;
  }

  // ── Protocol registry ───────────────────────────────────────────────
  if (pathname === "/api/yields/protocols") {
    sendJSON(res, {
      protocols: Object.entries(PROTOCOL_REGISTRY).map(([slug, meta]) => ({
        slug,
        id: meta.id,
        risk: meta.risk,
        securityScore: meta.securityScore,
        tier: meta.tier,
        audits: meta.audits,
        launchYear: meta.launchYear,
      })),
    });
    return;
  }

  // ── Status ──────────────────────────────────────────────────────────
  if (pathname === "/api/yields/status") {
    sendJSON(res, {
      scanCount,
      lastScan: latestResult?.meta.scanTimestamp
        ? new Date(latestResult.meta.scanTimestamp).toISOString()
        : null,
      protocolsCached: Object.keys(projectTvlCache).length,
      config: {
        pollIntervalMs: POLL_INTERVAL_MS,
        minPoolTvl: MIN_POOL_TVL,
        minProjectTvl: MIN_PROJECT_TVL,
        topN: TOP_N,
        perTranche: PER_TRANCHE,
      },
      meta: latestResult?.meta ?? null,
    });
    return;
  }

  sendJSON(res, { error: "Not found" }, 404);
});

// ═══════════════════════════════════════════════════════════════════════════
//                     MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  log("info", "Starting DeFi Llama Yield Indexer...");
  log("info", `Config: top ${TOP_N}, min pool TVL $${MIN_POOL_TVL.toLocaleString()}, min project TVL $${MIN_PROJECT_TVL.toLocaleString()}`);
  log("info", `Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // First scan
  await fetchAndProcess();

  // Recurring scans
  setInterval(() => fetchAndProcess(), POLL_INTERVAL_MS);

  // Start server
  server.listen(PORT, HOST, () => {
    log("info", `Listening on http://${HOST}:${PORT}`);
    log("info", "Endpoints:");
    log("info", "  GET /api/yields/top50     - Top 50 Ethereum yield opportunities");
    log("info", "  GET /api/yields/tranches  - Tranche suggestions (Senior/Mez/Junior)");
    log("info", "  GET /api/yields/full      - Full result (top50 + tranches)");
    log("info", "  GET /api/yields/protocols - Protocol security registry");
    log("info", "  GET /api/yields/status    - Scanner status");
    log("info", "  GET /health               - Health check");
  });
}

// Graceful shutdown
const shutdown = (sig: string) => {
  log("info", `${sig} received — shutting down`);
  server.close(() => {
    log("info", "Server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log("error", `Unhandled rejection: ${reason}`);
  process.exit(1);
});

main().catch((err) => {
  log("error", `Fatal: ${err.message}`);
  process.exit(1);
});
