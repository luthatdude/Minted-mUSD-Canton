// Points API server — serves points data and leaderboard
// Populated stub file (was 0-byte)

import { loadConfig } from "./config";

const config = loadConfig();

// TODO: Implement Express/Fastify server with endpoints:
// GET /api/points/:address — user's total points and breakdown
// GET /api/leaderboard — top N users by points
// GET /api/snapshot/latest — latest snapshot metadata
// GET /api/merkle/:address — Merkle proof for airdrop claim
// POST /api/snapshot/trigger — admin: trigger manual snapshot (auth required)

console.log(`[Points] Server starting on port ${config.port}`);
console.log(`[Points] Epoch start: ${config.epochStart}`);
