# Minted mUSD Protocol — Operational Runbooks

> FIX: Addresses audit finding for missing operational runbooks (P0 operational gap)

## Table of Contents
1. [Relay Service Down](#relay-service-down)
2. [Validator Down / Quorum Loss](#validator-down--quorum-loss)
3. [Emergency Pause](#emergency-pause)
4. [Oracle Price Feed Stale](#oracle-price-feed-stale)
5. [Supply Cap Breach](#supply-cap-breach)
6. [Reserve Ratio Below Threshold](#reserve-ratio-below-threshold)
7. [Liquidation Surge](#liquidation-surge)
8. [smUSD Share Price Anomaly](#smusd-share-price-anomaly)
9. [Canton Participant Down](#canton-participant-down)
10. [Database Recovery](#database-recovery)
11. [Key Rotation](#key-rotation)
12. [Incident Response Checklist](#incident-response-checklist)

---

## Relay Service Down

**Alert:** `RelayServiceDown`
**Severity:** Critical
**Impact:** Bridge operations halted — no mints, redemptions, or attestations processed

### Diagnosis
```bash
# Check pod status
kubectl -n musd get pods -l app=musd-relay

# Check logs
kubectl -n musd logs -l app=musd-relay --tail=100

# Check Docker container (if docker-compose)
docker compose -f relay/docker-compose.yml ps relay
docker compose -f relay/docker-compose.yml logs --tail=100 relay
```

### Resolution
1. **If CrashLoopBackOff:** Check logs for startup errors (missing secrets, bad config)
2. **If OOMKilled:** Increase memory limit in deployment or docker-compose
3. **If connectivity issue:** Verify Canton host reachable, Ethereum RPC URL valid
4. **Restart:**
   ```bash
   kubectl -n musd rollout restart deployment/musd-relay
   # or
   docker compose -f relay/docker-compose.yml restart relay
   ```
5. **Verify recovery:** Check health endpoint returns 200
   ```bash
   curl http://localhost:8080/health
   ```

### Escalation
If service cannot be recovered within 15 minutes, trigger emergency pause (see below).

---

## Validator Down / Quorum Loss

**Alert:** `ValidatorServiceDown`
**Severity:** Critical
**Impact:** If 2+ of 3 validators are down, bridge attestations cannot achieve quorum

### Diagnosis
```bash
# Check all validator pods
kubectl -n musd get pods -l app=musd-validator

# Check AWS KMS connectivity (validators use KMS for signing)
aws kms describe-key --key-id $VALIDATOR_KMS_KEY_ID --region $AWS_REGION
```

### Resolution
1. Single validator down: Bridge continues with 2/3 quorum. Fix at normal priority.
2. Two validators down: **CRITICAL** — attestations blocked
   - Restart failed validators immediately
   - If KMS issue: check AWS service health, IAM permissions
   - If Canton connectivity: check network policies, participant health
3. All three down: Trigger emergency pause

### Verification
```bash
# Confirm heartbeat files are being updated
kubectl -n musd exec $VALIDATOR_POD -- cat /tmp/heartbeat
```

---

## Emergency Pause

**When to use:** Active exploit, critical bug discovered, oracle manipulation detected

### Procedure
1. **Ethereum side — pause all contracts:**
   ```bash
   # Using Foundry keystore (never pass raw private keys on CLI)
   # To set up: cast wallet import deployer --interactive
   # For hardware wallet: replace --account deployer with --ledger
   # Pause order: BorrowModule → SMUSD → DirectMintV2 → BLEBridgeV9
   cast send $BORROW_MODULE "pause()" --account deployer
   cast send $SMUSD "pause()" --account deployer
   cast send $DIRECT_MINT "pause()" --account deployer
   cast send $BLE_BRIDGE "pause()" --account deployer
   ```

2. **Canton side — pause via governance:**
   - Submit `EmergencyPause` governance proposal
   - Requires elevated threshold (e.g., 3-of-5)
   - Pauses: CantonDirectMintService, CantonLendingService, CantonStakingService, CantonBoostPoolService

3. **Notify:**
   - Team Slack/Discord: `@channel EMERGENCY PAUSE ACTIVATED — [reason]`
   - Public status page: Update to "Maintenance"
   - Twitter/X: "Protocol temporarily paused for security review"

4. **Post-pause:** Investigate root cause, deploy fix, coordinate unpause

### Unpause Procedure
1. Deploy and verify fix
2. Unpause Canton side (governance proposal with `EmergencyPause` action type)
3. Unpause Ethereum contracts in reverse order: BLEBridgeV9 → DirectMintV2 → SMUSD → BorrowModule
4. Monitor for 1 hour post-unpause

---

## Oracle Price Feed Stale

**Alert:** `OraclePriceStale`
**Severity:** Warning → Critical (if >1 hour)
**Impact:** Borrows and withdrawals blocked (liquidations still proceed with stale prices)

### Diagnosis
```bash
# Check Tradecraft DEX API (primary oracle source for Canton)
curl -s https://api.tradecraft.exchange/v1/ratio/CC/USDCx

# Check Temple DEX API (fallback)
curl -s -H "Authorization: Bearer $TEMPLE_JWT" https://api.temple.exchange/v1/price/Amulet/USDCx

# Check Ethereum oracle
cast call $PRICE_ORACLE "getLatestPrice(address)" $COLLATERAL_TOKEN
```

### Resolution
1. **If API is down:** Switch to fallback oracle source
2. **If relay not syncing:** Check relay service logs for price sync errors
3. **Manual price update (Canton):**
   - Submit governance proposal with `ParameterUpdate` action type
   - Exercise `PriceFeed_Update` with new price
4. **Emergency override (>50% price move):**
   - Use `PriceFeed_EmergencyUpdate` (requires `EmergencyPause` governance action)

---

## Supply Cap Breach

**Alert:** `SupplyCapBreached`
**Severity:** Critical
**Impact:** Protocol invariant violated — mUSD supply exceeds backing

### Diagnosis
```bash
# Check Ethereum supply
cast call $MUSD "totalSupply()"
cast call $DIRECT_MINT "supplyCap()"

# Check Canton supply (via relay API or Canton ledger query)
```

### Resolution
This should NEVER happen. If it does:
1. **Immediately trigger emergency pause**
2. Identify which minting path bypassed the cap (DirectMint vs Lending vs Bridge)
3. Do NOT unpause until root cause is identified and fixed
4. May require governance proposal to adjust supply cap or burn excess

---

## Reserve Ratio Below Threshold

**Alert:** `ReserveRatioBelowThreshold`
**Severity:** Critical
**Impact:** mUSD may be undercollateralized — redemptions at risk

### Diagnosis
```bash
# Check USDC reserves in Treasury
cast call $TREASURY "totalAssets()"

# Check total mUSD supply
cast call $MUSD "totalSupply()"

# Calculate ratio
echo "scale=4; $(cast call $TREASURY 'totalAssets()' | cast --to-dec) / $(cast call $MUSD 'totalSupply()' | cast --to-dec)" | bc
```

### Resolution
1. If ratio < 99% but > 95%: Monitor closely, check if strategy yields are pending
2. If ratio < 95%: Consider pausing new mints until reserves recover
3. If ratio < 90%: Emergency pause + investigate potential exploit or strategy loss

---

## Liquidation Surge

**Alert:** `LiquidationSurge`
**Severity:** Warning
**Impact:** Mass liquidations may indicate market crash or oracle manipulation

### Diagnosis
1. Check if price drop is real (compare with CoinGecko, Chainlink)
2. Check oracle manipulation (sudden price spike followed by revert)
3. Check if liquidation bot is functioning correctly

### Resolution
1. If prices are genuinely crashing: Let liquidations proceed (protocol working as intended)
2. If oracle manipulation suspected: Pause oracle updates, investigate
3. If bot malfunction: Restart liquidation bot, check gas price limits

---

## smUSD Share Price Anomaly

**Alert:** `SharePriceDecreaseAnomaly`
**Severity:** Critical
**Impact:** Strategy loss or share price manipulation — stakers may be losing funds

### Diagnosis
```bash
# Check Ethereum share price
cast call $SMUSD "convertToAssets(uint256)" 1000000000000000000

# Check strategy performance
cast call $TREASURY "getStrategyReport(address)" $STRATEGY_ADDRESS
```

### Resolution
1. If strategy reported a loss: Verify it's genuine, not a reentrancy exploit
2. If share price was manipulated: Emergency pause staking
3. The 10% max decrease cap (FIX D-M05) should prevent catastrophic loss

---

## Canton Participant Down

**Alert:** `CantonParticipantDown`
**Severity:** Critical
**Impact:** All Canton-side operations halted

### Resolution
```bash
kubectl -n musd rollout restart deployment/canton-participant
kubectl -n musd logs -l app=canton-participant --tail=200
```

If persistent: Check PostgreSQL health, disk space, network policies.

---

## Database Recovery

### PostgreSQL (Canton Ledger)
```bash
# Check PVC usage
kubectl -n musd exec $PG_POD -- df -h /var/lib/postgresql/data

# Backup
kubectl -n musd exec $PG_POD -- pg_dump -U canton canton_ledger > backup.sql

# Restore from backup
kubectl -n musd exec -i $PG_POD -- psql -U canton canton_ledger < backup.sql
```

---

## Key Rotation

### Relay Private Key
1. Generate new key (offline, air-gapped machine)
2. Update Kubernetes secret (never write keys to files on disk):
   ```bash
   kubectl -n musd create secret generic relay-private-key \
     --from-literal=relayer_private_key="$NEW_KEY" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Update on-chain: `cast send $BLE_BRIDGE "updateRelayer(address)" $NEW_ADDRESS --account deployer`
4. Restart relay: `kubectl -n musd rollout restart deployment/musd-relay`

### Validator KMS Keys
1. Create new KMS key in AWS
2. Update validator configuration with new `KMS_KEY_ID`
3. Update on-chain: `BLEBridgeV9.updateValidator(index, newAddress)`
4. Restart validator

### Canton Token
1. Generate new token via Canton admin API
2. Update Kubernetes secret:
   ```bash
   kubectl -n musd create secret generic canton-token \
     --from-literal=canton_token="$NEW_TOKEN" \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Restart all services: `kubectl -n musd rollout restart deployment --all`

---

## Incident Response Checklist

- [ ] Identify severity (Critical / High / Medium)
- [ ] If Critical: Trigger emergency pause
- [ ] Notify on-call engineer via PagerDuty
- [ ] Open incident channel in Slack
- [ ] Collect logs from all affected services
- [ ] Identify root cause
- [ ] Deploy fix to staging, verify
- [ ] Deploy fix to production
- [ ] Monitor for 1 hour post-fix
- [ ] Write post-mortem within 48 hours
- [ ] Update runbooks if needed

---

## On-Call Contacts

> **Setup required:** Configure on-call rotations in PagerDuty and update this table.
> PagerDuty service IDs are set via the `PAGERDUTY_SERVICE_ID` environment variable.

| Role | PagerDuty Escalation Policy | Slack Channel |
|------|----------------------------|---------------|
| Protocol Engineering | `musd-protocol-oncall` | #musd-protocol-eng |
| Infrastructure | `musd-infra-oncall` | #musd-infra |
| Security | `musd-security-oncall` | #musd-security |

## Alerting Channels

| Severity | Channel |
|----------|---------|
| Critical | PagerDuty (page immediately) |
| Warning | Slack #musd-alerts |
| Info | Grafana dashboard |
