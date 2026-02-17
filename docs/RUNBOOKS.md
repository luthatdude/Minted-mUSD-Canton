# Operational Runbooks — Minted mUSD Protocol

> **Owner:** SRE / DevOps  
> **Last updated:** 2026-02-14  
> **Severity classification:** P1 = immediate, P2 = within 1 hour, P3 = within 4 hours

---

## Table of Contents

1. [Incident Response — General](#1-incident-response--general)
2. [Global Protocol Pause (Circuit Breaker)](#2-global-protocol-pause-circuit-breaker)
3. [Bridge Pause / Unpause (BLEBridgeV9)](#3-bridge-pause--unpause-blebridgev9)
4. [Oracle Failure / Stale Price](#4-oracle-failure--stale-price)
5. [Liquidation Cascade](#5-liquidation-cascade)
6. [Key Rotation](#6-key-rotation)
7. [Database Failover (PostgreSQL)](#7-database-failover-postgresql)
8. [Canton Participant Recovery](#8-canton-participant-recovery)
9. [Relay Service Recovery](#9-relay-service-recovery)

---

## 1. Incident Response — General

### Classification

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| P1 — Critical | Active exploit, fund loss, bridge compromise | Immediate (<15 min) | Unauthorized minting, bridge attestation forgery |
| P2 — High | Service degraded, potential fund risk | <1 hour | Oracle stale, relay down, DB unresponsive |
| P3 — Medium | Degraded UX, no fund risk | <4 hours | Frontend errors, monitoring gaps, slow queries |
| P4 — Low | Cosmetic, informational | Next business day | Log noise, non-critical config drift |

### Incident Workflow

```
1. DETECT   → Alert fires (Prometheus / PagerDuty) OR user report
2. TRIAGE   → On-call engineer classifies severity (P1–P4)
3. CONTAIN  → For P1: activate global pause immediately (see §2)
4. NOTIFY   → Slack #incident channel + PagerDuty escalation
5. DIAGNOSE → Gather logs, chain state, contract reads
6. REMEDIATE → Apply fix (contract call, config change, restart)
7. VERIFY   → Confirm fix via monitoring + manual checks
8. RESOLVE  → Close incident, write post-mortem within 48h
```

### Communication Template

```
🚨 INCIDENT: [Title]
Severity: P[1-4]
Status: Investigating / Mitigating / Resolved
Impact: [What users experience]
Timeline:
  - HH:MM UTC — Detected via [source]
  - HH:MM UTC — [Action taken]
Next update: HH:MM UTC
```

### On-Call Contacts

| Role | Primary | Backup |
|------|---------|--------|
| Smart Contract Admin | `DEFAULT_ADMIN_ROLE` multisig | Protocol governance |
| Guardian (Emergency) | `GUARDIAN_ROLE` / `EMERGENCY_ROLE` keyholder | On-call engineer |
| Infrastructure | SRE on-call | DevOps lead |
| Canton Operator | Canton admin | Canton support |

---

## 2. Global Protocol Pause (Circuit Breaker)

**Contract:** `GlobalPauseRegistry.sol`  
**When:** Active exploit, unknown vulnerability, coordinated attack  
**Severity:** P1

### Pause (Emergency)

**Who:** Any `GUARDIAN_ROLE` holder

```bash
# Using cast (Foundry)
cast send $GLOBAL_PAUSE_REGISTRY "pauseGlobal()" \
  --rpc-url $RPC_URL \
  --private-key $GUARDIAN_KEY

# Verify
cast call $GLOBAL_PAUSE_REGISTRY "isGloballyPaused()(bool)" --rpc-url $RPC_URL
# Expected: true
```

**Effect:** All contracts with `whenNotGloballyPaused` modifier will revert. This includes:
- MUSD transfers, mints, burns
- SMUSD deposits/withdrawals
- DirectMintV2 mint/redeem
- TreasuryV2 deposits/withdrawals
- LeverageVault operations
- MetaVault operations

### Unpause (Recovery)

**Who:** `DEFAULT_ADMIN_ROLE` holder (multisig)

```bash
# Unpause requires admin — separation of duties from pause
cast send $GLOBAL_PAUSE_REGISTRY "unpauseGlobal()" \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_KEY

# Verify
cast call $GLOBAL_PAUSE_REGISTRY "isGloballyPaused()(bool)" --rpc-url $RPC_URL
# Expected: false
```

### Pre-unpause Checklist

- [ ] Root cause identified and remediated
- [ ] Contract state audited (no unauthorized state changes)
- [ ] Supply cap matches expected value
- [ ] Oracle prices are fresh
- [ ] Bridge attestation nonces are sequential
- [ ] Post-mortem drafted
- [ ] Team consensus on resumption

---

## 3. Bridge Pause / Unpause (BLEBridgeV9)

**Contract:** `BLEBridgeV9.sol`  
**When:** Bridge exploit, relay compromise, attestation anomaly  
**Severity:** P1

### Pause the Bridge

**Who:** `EMERGENCY_ROLE` holder

```bash
cast send $BLE_BRIDGE_V9 "pause()" \
  --rpc-url $RPC_URL \
  --private-key $EMERGENCY_KEY
```

**Effect:** All `whenNotPaused` functions revert:
- `submitAttestation()` — no new supply cap updates
- `emergencyReduceCap()` — still callable (intentional)
- Any pending unpause request is automatically cancelled

### Unpause the Bridge (24h Timelock)

**Who:** `DEFAULT_ADMIN_ROLE` → starts timelock; anyone → executes after delay

```bash
# Step 1: Request unpause (starts 24h clock)
cast send $BLE_BRIDGE_V9 "requestUnpause()" \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_KEY

# Step 2: Wait 24 hours (UNPAUSE_DELAY = 24 hours)

# Step 3: Execute unpause
cast send $BLE_BRIDGE_V9 "executeUnpause()" \
  --rpc-url $RPC_URL \
  --private-key $ADMIN_KEY
```

### Emergency Cap Reduction

If supply cap is inflated due to forged attestation:

```bash
cast send $BLE_BRIDGE_V9 "emergencyReduceCap(uint256,string)" \
  <new_lower_cap> "Reason: suspected forged attestation" \
  --rpc-url $RPC_URL \
  --private-key $EMERGENCY_KEY
```

### Pre-unpause Checklist

- [ ] Relay service restarted and healthy
- [ ] Validator nodes all online and signing
- [ ] Attestation nonces are sequential (no gaps)
- [ ] Canton-side bridge state matches Ethereum-side
- [ ] 24h timelock has elapsed
- [ ] Rate limit counters reviewed (`getNetDailyCapIncrease()`)

---

## 4. Oracle Failure / Stale Price

**Contract:** `PriceOracle.sol`  
**When:** Chainlink feed goes stale, price deviation circuit breaker trips  
**Severity:** P2

### Detection

The oracle reverts with `StalePrice()` when:
```
block.timestamp - updatedAt > stalePeriod
```

Typical `stalePeriod` values: 3600s (1h) for major pairs, 86400s (24h) for stable pairs.

### Immediate Actions

1. **Check Chainlink feed health:**
   ```bash
   # Get latest round data
   cast call $CHAINLINK_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
     --rpc-url $RPC_URL
   # Check: is updatedAt within stalePeriod?
   ```

2. **If feed is stale but price is correct — admin can reset:**
   ```bash
   cast send $PRICE_ORACLE "updatePrice(address)" $TOKEN_ADDRESS \
     --rpc-url $RPC_URL \
     --private-key $ORACLE_ADMIN_KEY
   ```

3. **If circuit breaker tripped (large price move):**
   ```bash
   # Keeper can reset after validating the price is legitimate
   cast send $PRICE_ORACLE "keeperResetPrice(address)" $TOKEN_ADDRESS \
     --rpc-url $RPC_URL \
     --private-key $KEEPER_KEY
   ```

4. **If feed is permanently broken — switch feed:**
   ```bash
   cast send $PRICE_ORACLE \
     "setFeed(address,address,uint256,uint8)" \
     $TOKEN $NEW_FEED $STALE_PERIOD $TOKEN_DECIMALS \
     --rpc-url $RPC_URL \
     --private-key $ORACLE_ADMIN_KEY
   ```

### Impact of Stale Oracle

- **BorrowModule:** `getHealthFactor()` reverts → no new borrows, no liquidations
- **LiquidationEngine:** Cannot calculate collateral value → liquidations blocked
- **CollateralVault:** Collateral factor calculations fail
- If prolonged, consider pausing borrow/liquidation contracts independently

---

## 5. Liquidation Cascade

**Contracts:** `LiquidationEngine.sol`, `BorrowModule.sol`, `CollateralVault.sol`  
**When:** Sharp price drop causes mass under-collateralization  
**Severity:** P2

### Detection Signals

- Prometheus alert: `liquidation_count_1h > threshold`
- Multiple vaults below liquidation threshold simultaneously
- Gas prices spiking (MEV bots competing for liquidations)

### Response Protocol

1. **Assess scale:**
   ```bash
   # Check how many vaults are underwater
   # (requires off-chain indexing or subgraph query)
   ```

2. **If cascade is orderly** (liquidators active, gas reasonable):
   - Monitor but do not intervene
   - Ensure liquidation bots have sufficient mUSD balance
   - Watch for oracle staleness (§4)

3. **If cascade threatens protocol solvency:**
   - Activate global pause (§2) to halt new borrows
   - Pause `DirectMintV2` to prevent redemption run
   - Assess total bad debt vs. treasury reserves
   - Consider emergency `closeFactorBps` increase:
     ```bash
     cast send $LIQUIDATION_ENGINE "setCloseFactor(uint256)" 10000 \
       --rpc-url $RPC_URL \
       --private-key $ADMIN_KEY
     # 10000 = 100% close factor (allow full liquidation)
     ```

4. **Post-cascade:**
   - Review bad debt accumulation
   - Assess if collateral factors need adjustment
   - Consider socializing bad debt via treasury

### Canton-Side Liquidations

Canton vaults use `LiquidationEngine` template in `MintedProtocolV2Fixed.daml`:
- Liquidations are DAML choices exercised by the operator
- Oracle price is fetched via `PriceOracle` template (ledger time staleness)
- Close factor and penalty are template parameters

---

## 6. Key Rotation

**Severity:** P3 (scheduled) or P1 (if key compromised)

### Ethereum Contract Roles

| Role | Contract(s) | Rotation Method |
|------|------------|-----------------|
| `DEFAULT_ADMIN_ROLE` | All contracts | `grantRole()` → `revokeRole()` on old |
| `GUARDIAN_ROLE` | GlobalPauseRegistry | Same — admin grants new, revokes old |
| `EMERGENCY_ROLE` | BLEBridgeV9 | Same |
| `MINTER_ROLE` | MUSD | Same |
| `TIMELOCK_ROLE` | DirectMintV2, TreasuryV2 | Same |
| `VALIDATOR_ROLE` | BLEBridgeV9 | Same — update all validator addresses |

```bash
# Example: rotate GUARDIAN_ROLE
NEW_GUARDIAN=0x...
OLD_GUARDIAN=0x...
GUARDIAN_ROLE=$(cast keccak "GUARDIAN_ROLE")

# Grant to new
cast send $CONTRACT "grantRole(bytes32,address)" $GUARDIAN_ROLE $NEW_GUARDIAN \
  --rpc-url $RPC_URL --private-key $ADMIN_KEY

# Revoke from old
cast send $CONTRACT "revokeRole(bytes32,address)" $GUARDIAN_ROLE $OLD_GUARDIAN \
  --rpc-url $RPC_URL --private-key $ADMIN_KEY
```

### Relay Validator Keys

1. Generate new key pair (AWS KMS or local)
2. Update `relay/secrets/` with new key material
3. Grant `VALIDATOR_ROLE` to new address on `BLEBridgeV9`
4. Restart validator node with new config
5. Verify attestation signing works
6. Revoke `VALIDATOR_ROLE` from old address
7. Destroy old key material

### Canton Participant Keys

1. Generate new TLS cert + key
2. Update K8s secret: `kubectl create secret tls canton-tls --cert=new.crt --key=new.key -n musd-canton`
3. Rolling restart of Canton participant: `kubectl rollout restart deployment/canton-participant -n musd-canton`
4. Verify JSON API connectivity

### PostgreSQL Credentials

1. Generate new password
2. Update K8s secret: `kubectl create secret generic postgres-credentials --from-literal=password=NEW_PASS -n musd-canton`
3. Update password in PostgreSQL: `ALTER USER canton_user PASSWORD 'NEW_PASS';`
4. Rolling restart Canton participant (picks up new secret)

---

## 7. Database Failover (PostgreSQL)

**Component:** `k8s/base/postgres-statefulset.yaml`  
**When:** PostgreSQL pod crash, PVC corruption, storage failure  
**Severity:** P1

### Detection

- Prometheus alert: `pg_up == 0`
- Canton participant logs: connection refused / timeout
- Health probe failures on Canton deployment

### Immediate Actions

1. **Check pod status:**
   ```bash
   kubectl get pods -n musd-canton -l app=postgres
   kubectl describe pod postgres-0 -n musd-canton
   kubectl logs postgres-0 -n musd-canton --tail=100
   ```

2. **If pod crash-looping:**
   ```bash
   # Check events
   kubectl get events -n musd-canton --sort-by='.lastTimestamp' | grep postgres

   # If PVC is healthy, delete pod to force reschedule
   kubectl delete pod postgres-0 -n musd-canton
   ```

3. **If PVC corruption — restore from backup:**
   ```bash
   # List available backups
   kubectl exec -n musd-canton postgres-backup-<latest> -- ls -la /backups/

   # Copy backup locally
   kubectl cp musd-canton/postgres-backup-pod:/backups/canton_YYYYMMDD_020000.sql.gz ./restore.sql.gz

   # Decompress
   gunzip restore.sql.gz

   # Scale down Canton participant
   kubectl scale deployment canton-participant -n musd-canton --replicas=0

   # Delete corrupted PVC and recreate
   kubectl delete pvc postgres-data -n musd-canton
   kubectl apply -f k8s/base/postgres-statefulset.yaml

   # Wait for new pod
   kubectl wait --for=condition=Ready pod/postgres-0 -n musd-canton --timeout=120s

   # Restore
   kubectl cp restore.sql musd-canton/postgres-0:/tmp/restore.sql
   kubectl exec -n musd-canton postgres-0 -- psql -U canton_user -d canton < /tmp/restore.sql

   # Scale Canton back up
   kubectl scale deployment canton-participant -n musd-canton --replicas=1
   ```

### Backup Schedule

- **Automated:** Daily at 02:00 UTC via `postgres-backup-cronjob.yaml`
- **Retention:** 7 local backups on PVC
- **Offsite:** Uploads to S3/GCS bucket (configured in `backup-config` ConfigMap)
- **Manual backup:** `kubectl create job --from=cronjob/postgres-backup manual-backup-$(date +%s) -n musd-canton`

---

## 8. Canton Participant Recovery

**Component:** `k8s/canton/participant-deployment.yaml`  
**When:** Participant crash, JSON API unresponsive, ledger sync issues  
**Severity:** P2

### Health Checks

```bash
# Check deployment status
kubectl get deployment canton-participant -n musd-canton
kubectl get pods -n musd-canton -l app=canton-participant

# Check gRPC health (if port-forwarded)
grpcurl -plaintext localhost:10011 grpc.health.v1.Health/Check

# Check JSON API via NGINX
curl -s https://canton-api.example.com/v1/parties | head -20
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| CrashLoopBackOff | Bad config, OOM | Check logs, increase memory limit |
| JSON API 503 | Participant not ready | Wait for ledger sync, check DB connection |
| Slow queries | Large ledger, missing indexes | Check PostgreSQL `pg_stat_activity`, add indexes |
| TLS errors | Expired cert | Rotate TLS secret (§6) |

### Restart Procedure

```bash
# Graceful rolling restart
kubectl rollout restart deployment/canton-participant -n musd-canton

# Monitor
kubectl rollout status deployment/canton-participant -n musd-canton

# Verify
kubectl logs -n musd-canton -l app=canton-participant --tail=50 -f
```

---

## 9. Relay Service Recovery

**Component:** `relay/docker-compose.yml`  
**When:** Relay stops forwarding attestations, validator nodes disconnected  
**Severity:** P2

### Health Checks

```bash
# Check container status
docker compose -f relay/docker-compose.yml ps

# Check relay logs
docker compose -f relay/docker-compose.yml logs relay --tail=50

# Check validator logs
docker compose -f relay/docker-compose.yml logs validator-1 --tail=50
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Relay not submitting | Canton API unreachable | Check Canton participant health (§8) |
| Validator not signing | AWS KMS timeout | Check IAM credentials, KMS key policy |
| Attestation rejected on-chain | Stale nonce, bad signature | Check `currentNonce` on BLEBridgeV9, verify signer addresses |
| Rate limit hit | Burst of attestations | Wait for 24h window reset, or increase `dailyCapIncreaseLimit` |

### Restart Procedure

```bash
# Restart all services
docker compose -f relay/docker-compose.yml restart

# Or restart just the relay
docker compose -f relay/docker-compose.yml restart relay

# Nuclear option — rebuild and restart
docker compose -f relay/docker-compose.yml down
docker compose -f relay/docker-compose.yml up -d --build
```

### Verifying Relay Health Post-Restart

```bash
# Check that nonces are advancing
cast call $BLE_BRIDGE_V9 "currentNonce()(uint256)" --rpc-url $RPC_URL
# Wait 5 minutes, check again — should increment if attestations flowing

# Check rate limit headroom
cast call $BLE_BRIDGE_V9 "getRemainingDailyCapLimit()(uint256)" --rpc-url $RPC_URL
```

---

## Appendix: Environment Variables Reference

```bash
# Contract addresses (set in .env or secrets manager)
GLOBAL_PAUSE_REGISTRY=0x...
BLE_BRIDGE_V9=0x...
PRICE_ORACLE=0x...
LIQUIDATION_ENGINE=0x...
DIRECT_MINT_V2=0x...
TREASURY_V2=0x...

# RPC
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY

# Keys (NEVER store plaintext — use hardware wallet or KMS)
GUARDIAN_KEY=<hardware-wallet-or-kms>
ADMIN_KEY=<multisig>
EMERGENCY_KEY=<hardware-wallet-or-kms>
ORACLE_ADMIN_KEY=<hardware-wallet-or-kms>
```

## Appendix: Monitoring Alert Rules

See `k8s/monitoring/prometheus-rules.yaml` for alert definitions. Critical alerts:

| Alert | Condition | Runbook Section |
|-------|-----------|-----------------|
| `ProtocolGloballyPaused` | `GlobalPauseRegistry.isGloballyPaused() == true` | §2 |
| `BridgePaused` | `BLEBridgeV9.paused() == true` | §3 |
| `OracleStale` | `block.timestamp - updatedAt > stalePeriod` | §4 |
| `HighLiquidationRate` | `liquidation_count_1h > 50` | §5 |
| `PostgresDown` | `pg_up == 0` | §7 |
| `CantonParticipantDown` | `canton_health != SERVING` | §8 |
| `RelayLagging` | `relay_last_attestation_age > 600s` | §9 |
