# Validator Security Policy — AC-02 Mitigation

> **Finding**: AC-02 — 3-of-5 validator collusion risk  
> **Severity**: HIGH  
> **Mitigation**: Geographic distribution + key rotation policy

---

## 1. Geographic Distribution Requirements

### Mandatory Spread

All validator nodes **MUST** be distributed across a minimum of **3 distinct geographic regions** and **3 distinct cloud providers** (or self-hosted facilities) to prevent:

- Single-jurisdiction legal seizure
- Regional network partitioning
- Cloud provider outages affecting quorum

| Validator | Region | Provider | Jurisdiction |
|-----------|--------|----------|-------------|
| Validator 1 | US-East (Virginia) | AWS | United States |
| Validator 2 | EU-West (Frankfurt) | GCP | Germany / EU |
| Validator 3 | APAC (Singapore) | Azure | Singapore |
| Validator 4 | EU-North (Finland) | Hetzner | Finland / EU |
| Validator 5 | US-West (Oregon) | Self-hosted | United States |

### Constraints

- No two validators in the same **data center** or **availability zone**.
- No more than **2 validators** under the **same legal jurisdiction**.
- At least **1 validator** operated by an entity independent of the core team.

---

## 2. Key Rotation Schedule

### Rotation Cadence

| Key Type | Rotation Period | Grace Period | Procedure |
|----------|----------------|-------------|-----------|
| Validator ECDSA signing key | **90 days** | 7 days overlap | See §2.1 |
| Canton participant key | **180 days** | 14 days overlap | See §2.2 |
| Relay hot-wallet key | **30 days** | 24 hours | See §2.3 |

### 2.1 Validator ECDSA Key Rotation

1. Generate new key pair on the validator's HSM (or secure enclave).
2. Submit `grantRole(VALIDATOR_ROLE, newAddress)` via timelock governance.
3. Wait for timelock delay (24h minimum).
4. Confirm new key signs a test attestation successfully.
5. Submit `revokeRole(VALIDATOR_ROLE, oldAddress)` via timelock governance.
6. Securely destroy old key material after grace period.

### 2.2 Canton Participant Key Rotation

1. Generate new Canton participant identity.
2. Update `VALIDATOR_ADDRESSES` mapping (DAML Party → new Ethereum address).
3. Re-register on Canton domain with new identity.
4. Verify new identity can observe and sign attestation contracts.
5. Decommission old identity after 14-day overlap.

### 2.3 Relay Hot-Wallet Rotation

1. Fund new relay wallet with gas ETH.
2. Update relay-service configuration with new private key (via Docker secrets).
3. Verify relay can submit test transaction.
4. Drain remaining ETH from old wallet.

---

## 3. Collusion Mitigation Controls

### 3.1 Minimum Signature Threshold

- **Current**: 3-of-5 (`minSignatures = 3`)
- **Recommendation**: Increase to **4-of-7** when operational maturity allows.
- `BLEBridgeV9.setMinSignatures()` enforces range `[2, 10]`.

### 3.2 Rate Limiting (Defense in Depth)

Even if 3 validators collude, the following on-chain guards limit damage:

| Guard | Limit | Effect |
|-------|-------|--------|
| `dailyCapIncreaseLimit` | 1M mUSD/day | Caps supply expansion per 24h window |
| `MAX_ATTESTATION_AGE` | 6 hours | Rejects stale attestations |
| `MIN_ATTESTATION_GAP` | 60 seconds | Prevents same-block replay |
| `collateralRatioBps` | ≥ 110% | Requires over-collateralization |
| `UNPAUSE_DELAY` | 24 hours | Prevents immediate recovery after exploit |

### 3.3 Anomaly Detection

The relay service (`validator-node-v2.ts`) enforces:

- **Signing rate limit**: `MAX_SIGNS_PER_WINDOW` prevents validators from bulk-signing.
- **Value jump detection**: Flags attestations with large asset value changes.
- **Cross-validator consistency**: Alerts if a single validator signs significantly more than peers.

### 3.4 External Monitoring

- Oracle keeper (`oracle-keeper.ts`) cross-validates on-chain prices against CoinGecko.
- Price oracle (`price-oracle.ts`) cross-validates Tradecraft vs Temple DEX prices.
- Telegram alerts on all circuit-breaker trips, price divergence, and attestation anomalies.

---

## 4. Incident Response

### If Collusion Is Suspected

1. **Immediate**: Any `EMERGENCY_ROLE` holder calls `BLEBridgeV9.pause()`.
2. **Investigate**: Review attestation logs, signing patterns, and price feeds.
3. **Remediate**: Revoke compromised validators via `revokeRole(VALIDATOR_ROLE, addr)`.
4. **Recover**: After 24h timelock, call `requestUnpause()` → `executeUnpause()`.
5. **Post-mortem**: Rotate all validator keys regardless of identified scope.

### Key Compromise Response

- **Single key**: Immediately revoke via `revokeRole`. Quorum unaffected (2 remaining ≥ 3 threshold).
- **Two keys**: Pause bridge, revoke both, emergency-deploy replacement validators.
- **Three+ keys (quorum)**: Pause bridge, emergency governance to redeploy V9 with new validator set.

---

## 5. Audit Trail

All validator actions emit events for off-chain monitoring:

- `AttestationReceived` — every processed attestation
- `AttestationInvalidated` — manual invalidation with reason
- `MinSignaturesUpdated` — threshold changes
- `AttestationsMigrated` — V8→V9 migration records

Logs **MUST** be retained for a minimum of **2 years** in immutable storage.

---

## 6. Review Schedule

This policy **MUST** be reviewed:

- Every **6 months** by the security team
- After any validator key rotation
- After any security incident
- Before any mainnet deployment

---

*Last updated: 2026-02-12*  
*Policy owner: Minted Protocol Security Team*
