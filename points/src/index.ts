/**
 * Minted Points System — Entry Point
 *
 * Wires snapshot → calculator → API server together.
 */

import "dotenv/config";
import { startServer } from "./server";
import { processSnapshots } from "./calculator";
import { takeSnapshot } from "./snapshot";
import { SNAPSHOT_INTERVAL_MS, getCurrentSeason, SEASONS } from "./config";
import { getDb, setMetadata } from "./db";

// Override the snapshot loop to include calculation
async function snapshotAndCalculate(): Promise<void> {
  const rows = await takeSnapshot();
  if (rows.length > 0) {
    processSnapshots(rows);
  }
}

// Patch the interval to use the combined function
function startPointsEngine(): void {
  const season = getCurrentSeason();

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          MINTED POINTS SYSTEM v1.0.0            ║");
  console.log("╠══════════════════════════════════════════════════╣");
  if (season) {
    console.log(`║  Active Season: ${season.id} — ${season.name.padEnd(28)}║`);
    console.log(`║  Ends: ${season.endDate.toISOString().split("T")[0].padEnd(39)}║`);
  } else {
    console.log("║  No active season                                ║");
  }
  console.log(`║  Snapshot interval: ${(SNAPSHOT_INTERVAL_MS / 60000).toFixed(0)} min${" ".repeat(24)}║`);
  console.log("╚══════════════════════════════════════════════════╝");

  console.log("\nSeasons:");
  for (const s of SEASONS) {
    const now = new Date();
    const status = now < s.startDate ? "upcoming" : now < s.endDate ? "ACTIVE" : "ended";
    console.log(
      `  ${s.id}. ${s.name.padEnd(12)} ${s.startDate.toISOString().split("T")[0]} → ${s.endDate.toISOString().split("T")[0]}  [${status}]`
    );
  }
  console.log("");

  // Initialize DB
  getDb();

  // Initial snapshot + calculation
  snapshotAndCalculate().catch(console.error);

  // Schedule recurring
  setInterval(() => {
    snapshotAndCalculate().catch(console.error);
  }, SNAPSHOT_INTERVAL_MS);
}

// Main
startPointsEngine();
startServer();
