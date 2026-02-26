# Canton DevNet Operations Runbook

Operational procedures for maintaining the Minted mUSD Canton devnet bridge infrastructure.

## Prerequisites

- Frontend dev server running: `npm run dev -- -p 3001`
- Canton participant node accessible (default: `localhost:7575`)
- Environment configured: `.env.local` with `CANTON_PARTY`, `NEXT_PUBLIC_DAML_PACKAGE_ID`, `NEXT_PUBLIC_CIP56_PACKAGE_ID`

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
| `BELOW_MIN_AMOUNT` | None (UI bug) | Enforce min amount >= 1.0 in bridge UI |
| `TEMPLATES_OR_INTERFACES_NOT_FOUND` | `ops:doctor` | Fix package ID in `.env.local` |
| `COMMAND_PREPROCESSING_FAILED` | None (auto-mitigated) | Check `privacyObservers` injection in `canton-command.ts` |
