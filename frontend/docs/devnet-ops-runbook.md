# Canton DevNet Operations Runbook

Operational procedures for maintaining the Minted mUSD Canton devnet bridge infrastructure.

## Prerequisites

- Frontend dev server running: `npm run dev -- -p 3001`
- Canton participant node accessible (default: `localhost:7575`)
- Environment configured: `.env.local` with `CANTON_PARTY`, `NEXT_PUBLIC_DAML_PACKAGE_ID`, `NEXT_PUBLIC_CIP56_PACKAGE_ID`

### Build & Dev Server Concurrency

Do not run `npm run build` and `next dev` concurrently. Running a production build while the dev server is active corrupts the `.next/` compilation cache, causing all API routes to return HTML 500 error pages.

After running `npm run build`, always restart the dev server:

```bash
# Kill the running dev server, then:
npm run dev -- -p 3001
```

Wait for the server to report "Ready" before running API or canary checks.

## Daily Verify (One Command)

Run the full verification suite in one command:

```bash
npm run ops:verify
```

This runs sequentially: `typecheck:scripts` -> `ops:doctor` -> `ops:topup` (dry-run) -> `ops:canary` (dry-run).
If any step fails, the chain stops with a non-zero exit code.

**If unhealthy:**
1. Check the failing step's output for the specific error.
2. Run `npm run ops:topup -- --target 2000 --chunk 250 --execute --mode protocol` to restore inventory.
3. Run `npm run ops:canary -- --amount 7571 --execute --require-conversion` to validate the bridge path.
4. Re-run `npm run ops:verify` to confirm health.

## Daily Checks

### 1. Ops Doctor

```bash
npm run ops:doctor
```

Runs all diagnostics: env format, API availability, operator health, and stale literal drift.
Outputs a human-readable table and machine-readable JSON summary.
Exit code 0 = healthy, 1 = unhealthy.

### 2. Operator Health Check

```bash
npm run ops:health
```

**What it checks:**
- Operator inventory level (mUSD available for CIP-56 → redeemable conversions)
- Floor target (default: 2000 mUSD, configured via `CANTON_OPERATOR_INVENTORY_FLOOR`)
- Status classification: `OK` (above floor), `LOW` (below floor), `EMPTY` (zero inventory)

**Healthy output example:**
```json
{
  "operatorInventory": "2083.000000",
  "floorTarget": 2000,
  "floorDeficit": "0.000000",
  "status": "OK"
}
```

**Action thresholds:**
| Status | Meaning | Action |
|--------|---------|--------|
| `OK` | Inventory >= floor | No action needed |
| `LOW` | 0 < inventory < floor | Run topup (see Recovery section) |
| `EMPTY` | inventory = 0 | Urgent: run topup immediately |

### 2. Bridge Canary

Run after health check to validate the full bridge path:

```bash
npm run ops:canary -- --amount 1 --execute --require-conversion
```

This exercises:
1. CIP-56 → redeemable conversion (requires operator inventory)
2. DirectMint_Redeem exercise (validates DAML service is operational)

### 3. Force-Conversion Canary (Deterministic)

When the canary party has surplus redeemable balance, `--require-conversion` fails because
no conversion is needed. Use `--force-conversion-probe` to always test the real conversion path:

```bash
npm run ops:canary:force-conversion
# equivalent to: npm run ops:canary -- --force-conversion-probe --execute
```

**How it works:**
1. Queries balances and takes a CID snapshot of all existing tokens
2. Forces a small (1.0 mUSD) CIP-56 → redeemable conversion regardless of existing redeemable balance
3. After conversion, identifies newly-created CIDs by diffing against the snapshot
4. Constrains redeem token selection to **only** CIDs from this conversion run
5. Asserts `conversion_path_executed`: PASS only if conversion succeeded AND redeem consumed a newly-converted CID

**Preconditions:**
- Canary party must hold ≥ 1.0 CIP-56 balance
- Operator inventory must be ≥ 1.0 mUSD

**When to use:** Daily monitoring, CI/CD gates, or any time `--require-conversion` fails due to pre-existing redeemable balance.

### 4. Expected Policy-Block Behavior (Fallback Disabled)

When hybrid fallback is disabled (`CANTON_HYBRID_FALLBACK_ENABLED=false` or `--no-fallback`), force-conversion probes are expected to be blocked by policy. The canary reports `EXPECTED_BLOCKED_BY_POLICY` instead of `FAIL`:

```bash
npm run ops:canary:force-conversion:no-fallback
# equivalent to: npm run ops:canary -- --force-conversion-probe --no-fallback --execute
```

**Canary behavior table:**

| Mode | Fallback Enabled | Expected Verdict |
|------|-----------------|-----------------|
| native | off | `PASS` — native path needs no conversion |
| native | on | `PASS` — normal operation |
| force-conversion | off | `EXPECTED_BLOCKED_BY_POLICY` — conversion blocked by policy |
| force-conversion | on | `PASS` — conversion and redeem succeed |

**Output fields:** Every canary run emits a structured `[canary:result]` JSON line containing:
- `mode`: `"native"` or `"force-conversion"`
- `fallbackEnabled`: `true` or `false`
- `verdict`: `"PASS"`, `"FAIL"`, or `"EXPECTED_BLOCKED_BY_POLICY"`
- `assertions`: full assertion array

**Important:** `EXPECTED_BLOCKED_BY_POLICY` is a clean exit (exit code 0). CI/CD gates should treat it as a pass when fallback is intentionally disabled.

## 24h Post-Release Stability Check

Run after any migration merge to confirm operational stability over 24 hours.

```bash
npm run ops:check24h
```

This runs `ops:doctor` followed by the native canary in sequence.

**Pass criteria:**
- `ops:doctor`: all checks PASS, HEALTHY=true
- `ops:canary:native`: verdict=PASS, redeem_success=PASS

**Schedule:** Run at T+1h, T+4h, T+24h after merge.

**On failure:**
1. Run `npm run ops:doctor` independently to isolate the failing check.
2. If API checks fail: verify dev server is running (`curl http://localhost:3001`). Restart if needed.
3. If health checks fail: run `npm run ops:topup -- --target 2000 --chunk 250 --execute --mode protocol`.
4. If canary fails: check `[canary:result]` JSON for the specific assertion failure.
5. If all else fails: revert the migration merge (`git revert <sha>`) and investigate.

## Recovery Flows

### Topup: Operator Inventory Below Floor

**Step 1: Dry-run assessment**
```bash
npm run ops:topup -- --target 2000 --chunk 250
```

Review output to confirm:
- Current inventory level
- Number of transactions planned
- Deficit amount

**Step 2: Execute topup**
```bash
npm run ops:topup -- --target 2000 --chunk 250 --execute --mode protocol
```

The script:
- Validates CantonDirectMintService exists (protocol mode)
- Mints inventory in 250 mUSD chunks
- Re-checks inventory after each transaction
- Stops early when target is reached
- Emits JSON summary at the end

**Step 3: Verify**
```bash
npm run ops:health
```

Confirm `status: "OK"` and `floorDeficit: "0.000000"`.

### Emergency: Direct-Create Mode

Only use when protocol mode fails (e.g., service not deployed):

```bash
npm run ops:topup -- --target 2000 --chunk 250 --execute \
  --mode direct-create --allow-unsafe-direct-create
```

This bypasses CantonDirectMintService validation. Follow up by deploying the service.

## Known Failure Signatures

### NO_OPERATOR_INVENTORY

**Symptom:** `ops:health` returns `status: "EMPTY"`, bridge conversions fail.

**Cause:** No CantonMUSD contracts owned by operator party available for conversion.

**Fix:**
```bash
npm run ops:topup -- --target 2000 --chunk 250 --execute --mode protocol
```

### LOW_OPERATOR_INVENTORY

**Symptom:** `ops:health` returns `status: "LOW"`. Conversions work but capacity is limited.

**Cause:** Inventory below floor target after bridge activity.

**Fix:** Same as above. The topup script computes the exact deficit.

### BELOW_MIN_AMOUNT

**Symptom:** Canary or bridge redeem fails with `BELOW_MIN_AMOUNT` DAML error.

**Cause:** Attempting to redeem a token with amount < 1.0 mUSD (DAML `minAmount` constraint).

**Fix:** The canary enforces `MIN_REDEEM = 1.0` and filters dust tokens. If this error appears in the UI, check that the bridge amount picker enforces the minimum. No operator action needed.

### COMMAND_PREPROCESSING_FAILED (missing fields)

**Symptom:** Canton returns `COMMAND_PREPROCESSING_FAILED: Missing non-optional field: privacyObservers`.

**Cause:** A create command for CantonMUSD/CantonUSDC/USDCx/CantonCoin did not include `privacyObservers`.

**Fix:** Already mitigated by auto-injection in `/api/canton-command.ts` (lines 204-212). If the error persists:
1. Check that `canton-command.ts` has the `needsPrivacyObservers` normalization.
2. If calling Canton directly (bypassing the API), include `"privacyObservers": []` in the payload.

### TEMPLATES_OR_INTERFACES_NOT_FOUND

**Symptom:** Canton returns 400 with `TEMPLATES_OR_INTERFACES_NOT_FOUND`.

**Cause:** The configured package ID does not match any DAR uploaded to the participant.

**Fix:**
1. Check current packages: `curl http://localhost:7575/v2/packages`
2. Compare against `.env.local`:
   - `NEXT_PUBLIC_DAML_PACKAGE_ID` — should match the ble-protocol DAR
   - `NEXT_PUBLIC_CIP56_PACKAGE_ID` — should match the ble-protocol-cip56 DAR
3. If mismatch, extract the correct ID from the DAR manifest:
   ```bash
   unzip -p path/to/ble-protocol-*.dar META-INF/MANIFEST.MF | grep Main-Dalf-Name
   ```
4. Update `.env.local` and restart the dev server.

## Environment Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `CANTON_PARTY` | Operator party (must be `local=True`) | `sv::1220...edce` |
| `NEXT_PUBLIC_DAML_PACKAGE_ID` | ble-protocol package (CantonDirectMint, etc.) | `eff3bf30...` |
| `NEXT_PUBLIC_CIP56_PACKAGE_ID` | ble-protocol-cip56 package (CIP-56 interfaces) | `11347710...` |
| `CANTON_OPERATOR_INVENTORY_FLOOR` | Health check floor target (mUSD) | `2000` |
| `CANTON_HYBRID_FALLBACK_ENABLED` | Enable/disable hybrid conversion fallback | `true` (default) |
| `CANTON_CANARY_PARTY` | Default party for ops scripts | `minted-canary::1220...` |

## Script Reference

| Script | Purpose | Default behavior |
|--------|---------|-----------------|
| `npm run ops:verify` | Full verification suite (all checks) | Dry-run chain, exits on first failure |
| `npm run ops:doctor` | Env + API + health + drift diagnostics | Read-only, exits 0/1 |
| `npm run ops:health` | Check operator inventory health | Read-only query |
| `npm run ops:topup -- [flags]` | Top up operator inventory | Dry-run (requires `--execute`) |
| `npm run ops:canary -- [flags]` | E2E bridge path validation | Dry-run (requires `--execute`) |
| `npm run ops:canary:force-conversion` | Deterministic conversion + redeem probe | Always executes (force mode) |
| `npm run ops:canary:native` | Native-mode bridge validation | Always executes |
| `npm run ops:canary:force-conversion:no-fallback` | Force-conversion with fallback disabled | Expects policy block (exit 0) |
| `npm run typecheck:scripts` | Type-check ops scripts | Read-only |

## Failure Signature Quick Map

| Error | Script to run | Expected fix |
|-------|--------------|-------------|
| `NO_OPERATOR_INVENTORY` | `ops:topup -- --execute --mode protocol` | Mint operator inventory to floor |
| `LOW_OPERATOR_INVENTORY` | `ops:topup -- --execute --mode protocol` | Top up to floor target |
| `INSUFFICIENT_OPERATOR_INVENTORY` | `ops:topup -- --execute --mode protocol` | mUSD faucet: operator inventory too low |
| `BELOW_MIN_AMOUNT` | None (UI bug) | Enforce min amount >= 1.0 in bridge UI |
| `TEMPLATES_OR_INTERFACES_NOT_FOUND` | `ops:doctor` | Fix package ID in `.env.local` |
| `COMMAND_PREPROCESSING_FAILED` | None (auto-mitigated) | Check `privacyObservers` injection in `canton-command.ts` |

## Devnet Faucet

### Purpose

Provision test Canton assets (mUSD, CTN, USDC, USDCx) on devnet for testing staking, bridge, and pool flows. The faucet creates operator-issued, user-owned token contracts on the Canton ledger.

### Safety Model

The faucet has 7 independent safety gates — all must pass for a mint to succeed:

| # | Gate | Enforced by | Default |
|---|------|------------|---------|
| 1 | Feature flag disabled | `ENABLE_DEVNET_FAUCET` env var | `false` |
| 2 | Non-production env | `NODE_ENV` check + `DEVNET_ENV` override | blocked in production |
| 3 | Party allowlist | `DEVNET_FAUCET_ALLOWLIST` | empty (blocks all) |
| 4a | Max per tx | `DEVNET_FAUCET_MAX_PER_TX` | 100 |
| 4b | Daily cap per party | `DEVNET_FAUCET_DAILY_CAP_PER_PARTY` | 1000 |
| 4c | Cooldown between requests | `DEVNET_FAUCET_COOLDOWN_SECONDS` | 30s |
| 5 | Structured audit log | Server-side `console.log` | always on |
| 6 | DEVNET ONLY UI label | Client-side warning banner | always shown |
| 7 | Connected wallet required | `activeParty` check | blocks when disconnected |

**NEVER enable `ENABLE_DEVNET_FAUCET` in production.** The faucet creates real Canton contracts with operator signing authority.

### Required Environment Variables

Add to `.env.local` (never commit actual values):

```bash
# Client-side — shows/hides the faucet panel
NEXT_PUBLIC_ENABLE_DEVNET_FAUCET=true

# Server-side master switch
ENABLE_DEVNET_FAUCET=true

# Comma-separated allowlisted party IDs
DEVNET_FAUCET_ALLOWLIST=alice::1220abc...,bob::1220def...

# Rate limits
DEVNET_FAUCET_MAX_PER_TX=100
DEVNET_FAUCET_DAILY_CAP_PER_PARTY=1000
DEVNET_FAUCET_COOLDOWN_SECONDS=30
```

### Expected Errors

| Error Type | HTTP | Meaning |
|-----------|------|---------|
| `DISABLED` | 403 | `ENABLE_DEVNET_FAUCET` is not `true` |
| `NOT_ALLOWLISTED` | 403 | Party not in `DEVNET_FAUCET_ALLOWLIST` |
| `RATE_LIMITED` | 429 | Cooldown active or daily cap exceeded |
| `INVALID_INPUT` | 400 | Bad asset, amount, or party format |
| `CONFIG_ERROR` | 500 | Canton config missing (PARTY, PACKAGE_ID) |
| `UPSTREAM_ERROR` | 502 | Canton API command failed |
| `INSUFFICIENT_OPERATOR_INVENTORY` | 409 | mUSD funding: operator inventory too low |
| `UNSUPPORTED_MODE` | 400 | mUSD funding: invalid mode parameter |

### How to Use for Staking/Bridge Tests

1. **Enable faucet** — set env vars above, restart dev server
2. **Open Faucet page** — navigate to `/FaucetPage` in the UI
3. **Connect Loop wallet** — the Canton faucet section appears below Ethereum faucets
4. **Mint test tokens** — select asset, enter amount, click Mint
5. **Verify balances** — balances refresh automatically; also check via:
   ```bash
   curl "http://localhost:3001/api/canton-balances?party=YOUR_PARTY"
   ```
6. **Test staking** — navigate to `/StakePage`, your minted mUSD should appear
7. **Test bridge** — minted mUSD can be used in bridge-out flows

### API Direct Usage

```bash
# Mint 50 mUSD for a party
curl -X POST http://localhost:3001/api/canton-devnet-faucet \
  -H "Content-Type: application/json" \
  -d '{"party":"alice::1220abc...","asset":"mUSD","amount":"50"}'
```

### mUSD Funding on Single-Party Devnet

On a single-party devnet, direct `CantonMUSD` creates fail because DAML enforces `issuer != owner`. The faucet UI automatically routes mUSD requests to a dedicated operator-mediated funding endpoint (`/api/canton-devnet-fund-musd`) that transfers mUSD from operator inventory instead of creating new tokens.

**How it works:**
1. Queries operator-owned `CantonMUSD` inventory (excluding pool-reserved CIDs)
2. Selects inventory contracts (greedy, largest-first) to cover the requested amount
3. Archives selected operator contracts
4. Creates a new `CantonMUSD` owned by the target party (requested amount)
5. Creates change `CantonMUSD` for operator (if inventory > requested)
6. All steps execute in a single atomic Canton batch

**Prerequisites:**
- Operator must have sufficient mUSD inventory (use `ops:topup` to restore)
- Same safety gates as the faucet (feature flag, allowlist, rate limits)

**Additional error type:**

| Error Type | HTTP | Meaning |
|-----------|------|---------|
| `INSUFFICIENT_OPERATOR_INVENTORY` | 409 | Operator mUSD balance too low — run `ops:topup` |
| `UNSUPPORTED_MODE` | 400 | Invalid `mode` parameter (only `inventory_transfer` supported) |

**API direct usage:**
```bash
# Fund 50 mUSD to a party via operator inventory transfer
curl -X POST http://localhost:3001/api/canton-devnet-fund-musd \
  -H "Content-Type: application/json" \
  -d '{"party":"alice::1220abc...","amount":"50","mode":"inventory_transfer"}'
```

**Response includes:**
- `inventoryConsumed`: number of operator contracts consumed
- `inventoryRemaining`: operator mUSD balance after transfer

### Disabling the Faucet

Set `ENABLE_DEVNET_FAUCET=false` in `.env.local` (or remove it). The server-side gate rejects all requests immediately. The client-side panel hides automatically when `NEXT_PUBLIC_ENABLE_DEVNET_FAUCET` is not `true`.

## Legacy Decommission Plan

Remaining hybrid/fallback code to remove after confirming native-only stability.

### Emergency Fallback Flags

| Flag | Location | Purpose | Status |
|------|----------|---------|--------|
| `ENABLE_HYBRID_FALLBACK` | `.env.local`, `canton-convert.ts` | Re-enable CIP-56→redeemable conversion | OFF (disabled) |
| `CANTON_HYBRID_FALLBACK_ENABLED` | `.env.local`, canary scripts | Canary fallback detection | OFF (disabled) |
| `--fallback-enabled` | canary CLI flag | Override fallback for testing | Available |

### Cleanup Criteria

Remove dead hybrid code when ALL conditions are met:
1. Native-only mode has run stable for >= 7 days (no conversion-related incidents)
2. `ops:check24h` passes at T+24h, T+72h, T+7d post-merge
3. No operator reports of failed native CIP-56 operations
4. Team sign-off on permanent removal

### What to Remove

- `frontend/src/lib/api-hardening/fallback.ts` — hybrid fallback classification logic
- `frontend/src/pages/api/canton-convert.ts` — conversion endpoint (or gate permanently)
- `ENABLE_HYBRID_FALLBACK` env references in all API routes
- Canary `--no-fallback` / `--fallback-enabled` flags (simplify to native-only)
- `ops:canary:force-conversion` and `ops:canary:force-conversion:no-fallback` scripts

### Rollback Strategy (While Flags Remain)

To re-enable hybrid conversion in an emergency:

```bash
# In .env.local:
ENABLE_HYBRID_FALLBACK=true
CANTON_HYBRID_FALLBACK_ENABLED=true

# Restart dev server, then verify:
npm run ops:canary:force-conversion
```

The conversion path remains functional — only the policy gate is disabled. Re-enabling is a config change, not a code change.
