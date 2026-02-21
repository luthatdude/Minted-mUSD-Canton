/**
 * Diagnostic script: check Canton state for bridge processing
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, ".env.development") });

import { CantonClient, TEMPLATES } from "./canton-client";

async function main() {
  const canton = new CantonClient({
    baseUrl: `http://${process.env.CANTON_HOST}:${process.env.CANTON_PORT}`,
    token: process.env.CANTON_TOKEN || "dummy-no-auth",
    userId: process.env.CANTON_USER || "administrator",
    actAs: process.env.CANTON_PARTY!,
    defaultPackageId: process.env.CANTON_PACKAGE_ID,
  });

  console.log("=== Querying ALL BridgeInRequests ===");
  const allRequests = await canton.queryContracts<{
    nonce: number;
    status: string;
    amount: string;
    user: string;
  }>(TEMPLATES.BridgeInRequest);
  console.log(`Total BridgeInRequests: ${allRequests.length}`);
  for (const req of allRequests) {
    console.log(`  nonce=${req.payload.nonce}, status=${req.payload.status}, amount=${req.payload.amount}`);
  }

  console.log("\n=== Querying PENDING BridgeInRequests (with filter) ===");
  const pendingRequests = await canton.queryContracts<{
    nonce: number;
    status: string;
    amount: string;
    user: string;
  }>(TEMPLATES.BridgeInRequest, (p) => p.status === "pending");
  console.log(`Pending BridgeInRequests: ${pendingRequests.length}`);
  for (const req of pendingRequests) {
    console.log(`  nonce=${req.payload.nonce}, status=${req.payload.status}, amount=${req.payload.amount}`);
  }

  console.log("\n=== Querying ALL CantonMUSD tokens ===");
  const musdTokens = await canton.queryContracts<{
    amount: string;
    owner: string;
    agreementHash?: string;
    bridgeNonce?: number;
  }>(TEMPLATES.CantonMUSD);
  console.log(`Total CantonMUSD tokens: ${musdTokens.length}`);
  for (const tok of musdTokens) {
    console.log(`  amount=${tok.payload.amount}, agreementHash=${tok.payload.agreementHash || "NONE"}, owner=${String(tok.payload.owner).slice(0, 40)}`);
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  const pendingNonces = pendingRequests.filter(r => Number(r.payload.nonce) < 900).map(r => Number(r.payload.nonce));
  const totalPendingAmount = pendingRequests
    .filter(r => Number(r.payload.nonce) < 900)
    .reduce((sum, r) => sum + parseFloat(r.payload.amount), 0);
  console.log(`Pending nonces (< 900): [${pendingNonces.join(", ")}]`);
  console.log(`Total pending amount: ${totalPendingAmount} mUSD`);
  console.log(`Existing CantonMUSD tokens: ${musdTokens.length}`);
  console.log(`Missing CantonMUSD: ${pendingNonces.length - musdTokens.length} (need to mint)`);
}

main().catch(console.error);
