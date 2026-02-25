#!/usr/bin/env npx ts-node --skip-project
export {}; // module boundary — prevents global scope conflicts with other scripts
/**
 * ops-doctor.ts — Deterministic devnet health diagnostic.
 *
 * Checks environment, API availability, operator health, and stale literal drift.
 * Non-destructive: read-only queries, no writes.
 *
 * Usage:
 *   npx ts-node --skip-project scripts/ops-doctor.ts [flags]
 *
 * Flags:
 *   --base-url <u>  Frontend API base URL (default: http://localhost:3001)
 *   --party <p>     Party for API queries (default: env CANTON_CANARY_PARTY)
 *   --src-dir <d>   Source directory for stale scan (default: ./src)
 *
 * Exit codes:
 *   0 = healthy
 *   1 = unhealthy (at least one check failed)
 */

import * as fs from "fs";
import * as path from "path";

// Load .env.local if present (lightweight dotenv — no external dependency)
function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// Resolve project root: prefer cwd, fall back to script dir parent
const PROJECT_ROOT = fs.existsSync(path.resolve(process.cwd(), "package.json"))
  ? process.cwd()
  : path.resolve(__dirname, "..");

loadEnvFile(path.join(PROJECT_ROOT, ".env.local"));
loadEnvFile(path.join(PROJECT_ROOT, ".env"));

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const BASE_URL = getArg("base-url", "http://localhost:3001");
const PARTY = getArg("party",
  process.env.CANTON_CANARY_PARTY || "minted-canary::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce"
);
const SRC_DIR = getArg("src-dir", path.resolve(PROJECT_ROOT, "src"));

const CANTON_PARTY_RE = /^[A-Za-z0-9._:-]+::1220[0-9a-f]{64}$/i;
const PKG_ID_RE = /^[0-9a-f]{64}$/i;
const STALE_PATTERNS = [
  "minted-validator-1::122038",
  "0489a86388cc81e3e0bee8dc8f6781229d0e01451c1f2d19deea594255e5993b",
];

interface Check {
  name: string;
  category: "env" | "api" | "health" | "drift";
  result: "PASS" | "FAIL" | "WARN";
  detail: string;
}

const checks: Check[] = [];

function check(name: string, category: Check["category"], pass: boolean, detail: string, warnOnly = false): void {
  const result = pass ? "PASS" : warnOnly ? "WARN" : "FAIL";
  checks.push({ name, category, result, detail });
}

// ── Env checks ──────────────────────────────────────────────

function runEnvChecks(): void {
  const cantonParty = process.env.CANTON_PARTY || "";
  check("CANTON_PARTY format", "env",
    CANTON_PARTY_RE.test(cantonParty),
    cantonParty ? `${cantonParty.slice(0, 25)}...` : "(empty)");

  const pkgId = process.env.NEXT_PUBLIC_DAML_PACKAGE_ID || "";
  check("NEXT_PUBLIC_DAML_PACKAGE_ID format", "env",
    PKG_ID_RE.test(pkgId),
    pkgId ? `${pkgId.slice(0, 16)}...` : "(empty)");

  const cip56Id = process.env.NEXT_PUBLIC_CIP56_PACKAGE_ID || "";
  check("NEXT_PUBLIC_CIP56_PACKAGE_ID format", "env",
    PKG_ID_RE.test(cip56Id),
    cip56Id ? `${cip56Id.slice(0, 16)}...` : "(empty)");
}

// ── API checks ──────────────────────────────────────────────

async function checkApi(name: string, endpoint: string): Promise<boolean> {
  try {
    const url = `${BASE_URL}${endpoint}?party=${encodeURIComponent(PARTY)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    check(`${name} reachable`, "api", resp.ok, `HTTP ${resp.status}`);
    return resp.ok;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    check(`${name} reachable`, "api", false, msg.slice(0, 80));
    return false;
  }
}

interface OpsHealthResponse {
  operatorInventory: string;
  floorTarget: number;
  floorDeficit: string;
  status: string;
  maxBridgeable: string;
  blockers: string[];
}

async function runApiAndHealthChecks(): Promise<OpsHealthResponse | null> {
  await checkApi("canton-balances", "/api/canton-balances");
  await checkApi("canton-bridge-preflight", "/api/canton-bridge-preflight");
  const healthOk = await checkApi("canton-ops-health", "/api/canton-ops-health");

  if (!healthOk) return null;

  try {
    const url = `${BASE_URL}/api/canton-ops-health?party=${encodeURIComponent(PARTY)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = (await resp.json()) as OpsHealthResponse;

    check("status not EMPTY", "health",
      data.status !== "EMPTY",
      `status=${data.status}`);

    const inv = parseFloat(data.operatorInventory);
    const floor = data.floorTarget;
    check("inventory >= floor", "health",
      inv >= floor,
      `inventory=${inv.toFixed(2)} floor=${floor}`);

    const maxBridge = parseFloat(data.maxBridgeable);
    check("maxBridgeable > 0", "health",
      maxBridge > 0,
      `maxBridgeable=${maxBridge.toFixed(2)}`);

    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    check("ops-health parse", "health", false, msg.slice(0, 80));
    return null;
  }
}

// ── Drift checks ────────────────────────────────────────────

function scanDirectory(dir: string, patterns: string[]): string[] {
  const matches: string[] = [];
  if (!fs.existsSync(dir)) return matches;

  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|json)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(full, "utf8");
          for (const pat of patterns) {
            if (content.includes(pat)) {
              matches.push(`${path.relative(SRC_DIR, full)}: contains "${pat.slice(0, 30)}..."`);
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return matches;
}

function runDriftChecks(): void {
  const staleMatches = scanDirectory(SRC_DIR, STALE_PATTERNS);
  check("no stale party/package literals", "drift",
    staleMatches.length === 0,
    staleMatches.length === 0 ? "0 matches" : `${staleMatches.length} match(es): ${staleMatches[0]}`);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("[doctor] Canton DevNet Ops Doctor");
  console.log(`[doctor] base=${BASE_URL} party=${PARTY.slice(0, 25)}...`);
  console.log(`[doctor] src=${SRC_DIR}\n`);

  // Phase 1: Env
  console.log("── Environment ──");
  runEnvChecks();
  for (const c of checks.filter(c => c.category === "env")) {
    console.log(`  ${c.result.padEnd(4)} ${c.name}: ${c.detail}`);
  }

  // Phase 2: API + Health
  console.log("\n── API & Health ──");
  const health = await runApiAndHealthChecks();
  for (const c of checks.filter(c => c.category === "api" || c.category === "health")) {
    console.log(`  ${c.result.padEnd(4)} ${c.name}: ${c.detail}`);
  }

  // Phase 3: Drift
  console.log("\n── Drift Detection ──");
  runDriftChecks();
  for (const c of checks.filter(c => c.category === "drift")) {
    console.log(`  ${c.result.padEnd(4)} ${c.name}: ${c.detail}`);
  }

  // Summary
  const failCount = checks.filter(c => c.result === "FAIL").length;
  const warnCount = checks.filter(c => c.result === "WARN").length;
  const passCount = checks.filter(c => c.result === "PASS").length;

  const summary = {
    timestamp: new Date().toISOString(),
    total: checks.length,
    pass: passCount,
    fail: failCount,
    warn: warnCount,
    healthy: failCount === 0,
    checks,
    health: health ? {
      operatorInventory: health.operatorInventory,
      floorTarget: health.floorTarget,
      floorDeficit: health.floorDeficit,
      status: health.status,
      maxBridgeable: health.maxBridgeable,
      blockers: health.blockers,
    } : null,
  };

  console.log(`\n── Summary ──`);
  console.log(`  PASS=${passCount} FAIL=${failCount} WARN=${warnCount} HEALTHY=${failCount === 0}`);
  console.log(`\n[doctor:summary] ${JSON.stringify(summary)}`);

  if (failCount > 0) {
    console.error(`\n[doctor] UNHEALTHY — ${failCount} check(s) failed.`);
    process.exit(1);
  }

  console.log("\n[doctor] HEALTHY — all checks passed.");
}

main().catch((err) => {
  console.error(`[doctor] Fatal: ${err.message}`);
  process.exit(1);
});
