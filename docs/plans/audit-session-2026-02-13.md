# Audit Session: Minted-mUSD-Canton
- **Started**: 2026-02-13
- **Last Updated**: 2026-02-19
- **Auditor**: AI-Assisted
- **Scope**: Bridge + relay runtime path for Canton devnet/Sepolia (`contracts/BLEBridgeV9.sol`, `relay/**`, `scripts/canton-*.sh`, Docker wiring)
- **Mode(s)**: Mode 1 (Security), Mode 4 (Architecture), Mode 5 (Session)

## Progress

### Files Audited
| File Group | Status | Findings | Notes |
|------|--------|----------|-------|
| `contracts/BLEBridgeV9.sol` | ✅ Complete | 0 | Spot-reviewed attestation/nonce/signature path; no new bridge-contract blocker in this pass |
| `relay/relay-service.ts` | ✅ Complete | 1 HIGH, 1 MEDIUM | Devnet transport/profile mismatch and default port drift |
| `relay/validator-node-v2.ts` | ✅ Complete | 1 HIGH | Env namespace drift from compose (`CANTON_*` vs `CANTON_LEDGER_*`) |
| `relay/docker-compose.yml` | ✅ Complete | 2 HIGH | Defaults route to unresolved host and incompatible transport/port profile |
| `relay/.env.example` | ✅ Complete | 1 MEDIUM | Example values conflict with compose/runtime defaults |
| `relay/test-canton-connection.ts` | ✅ Complete | 0 | Confirmed expected devnet endpoint assumptions (`localhost:7575`, optional TLS) |
| `scripts/canton-init.sh` | ✅ Complete | 0 | Confirms devnet HTTP JSON API on `7575` |
| `scripts/canton-monitor.sh` | ✅ Complete | 1 LOW | Checks wrong gRPC forwarder container name |
| `contracts/*.sol` | 🔄 In Progress | - | Remaining bridge-adjacent contracts pending deeper pass |
| `daml/**/*.daml` | 🔄 In Progress | - | Authorization/privacy invariants pending deeper pass |
| `bot/src/*.ts` | ⬜ Pending | - | Out of this bridge/relay-focused slice |
| `frontend/src/**/*.{ts,tsx}` | ⬜ Pending | - | Out of this bridge/relay-focused slice |
| `k8s/**/*.yaml` | ⬜ Pending | - | Out of this bridge/relay-focused slice |

### Cumulative Findings Summary
- CRITICAL: 0
- HIGH: 3
- MEDIUM: 2
- LOW: 1
- INFO: 0

### Detailed Findings
## Finding BRIDGE-RELAY-H-01: Devnet startup profile is internally contradictory (TLS vs documented Canton endpoint)
- **Severity**: HIGH
- **Files**: `relay/docker-compose.yml`, `relay/relay-service.ts`, `relay/validator-node-v2.ts`
- **Lines**: `relay/docker-compose.yml:56`, `relay/docker-compose.yml:68`, `relay/relay-service.ts:497`, `relay/validator-node-v2.ts:314`
- **Description**: Compose defaults to `NODE_ENV=production` and `CANTON_USE_TLS=true`; both relay and validator reject `CANTON_USE_TLS=false` in production. Documented devnet path uses plaintext JSON API on `7575`.
- **Impact**: With `.env.example` values, startup aborts; with TLS left enabled, Canton calls fail handshake against `7575`.
- **Proof of Concept**: `test-canton-connection.ts` succeeds on `http://127.0.0.1:7575` and fails on `https://127.0.0.1:7575` with `ERR_SSL_PACKET_LENGTH_TOO_LONG`; relay startup with `NODE_ENV=production CANTON_USE_TLS=false` throws fatal security error.
- **Recommendation**: Split dev/prod compose profiles or set explicit dev override (`NODE_ENV=development`, `CANTON_USE_TLS=false`) for local devnet; keep strict TLS policy for production profile only.
- **References**: CWE-693 (Protection Mechanism Failure), CWE-16 (Configuration)

## Finding BRIDGE-RELAY-H-02: Validator service ignores compose Canton endpoint variables
- **Severity**: HIGH
- **Files**: `relay/validator-node-v2.ts`, `relay/docker-compose.yml`
- **Lines**: `relay/validator-node-v2.ts:62`, `relay/validator-node-v2.ts:63`, `relay/docker-compose.yml:167`, `relay/docker-compose.yml:168`
- **Description**: Validator code reads `CANTON_LEDGER_HOST`/`CANTON_LEDGER_PORT`, but compose sets `CANTON_HOST`/`CANTON_PORT`.
- **Impact**: Validators default to `localhost:6865` and ignore compose-provided endpoint settings; bridge signature flow can stall while relay appears configured.
- **Proof of Concept**: `docker-compose.yml` has no `CANTON_LEDGER_*` variables for validators; validator defaults remain hard-coded to `6865`.
- **Recommendation**: Unify env keys (prefer one namespace) and add startup validation to fail fast when required vars are missing/mismatched.
- **References**: CWE-16 (Configuration)

## Finding BRIDGE-RELAY-H-03: Compose default host `canton` is unresolved in current topology
- **Severity**: HIGH
- **Files**: `relay/docker-compose.yml`
- **Lines**: `relay/docker-compose.yml:54`, `relay/docker-compose.yml:116`, `relay/docker-compose.yml:167`, `relay/docker-compose.yml:217`, `relay/docker-compose.yml:266`
- **Description**: Compose defaults all bridge services to `CANTON_HOST=canton`, but no `canton` service is defined in this compose file.
- **Impact**: Default deployment cannot resolve Canton host and fails to connect unless operators override host manually.
- **Proof of Concept**: `rg '^  canton:' relay/docker-compose.yml` returns no service; container DNS lookup for `canton` returns NXDOMAIN.
- **Recommendation**: Default to `host.docker.internal` (for local port-forward workflows) or declare a concrete Canton service/network alias.
- **References**: CWE-16 (Configuration)

## Finding BRIDGE-RELAY-M-01: Port defaults are inconsistent across bridge/relay artifacts
- **Severity**: MEDIUM
- **Files**: `relay/.env.example`, `relay/relay-service.ts`, `relay/docker-compose.yml`, `relay/test-canton-connection.ts`, `scripts/canton-init.sh`
- **Lines**: `relay/.env.example:11`, `relay/relay-service.ts:107`, `relay/docker-compose.yml:55`, `relay/test-canton-connection.ts:17`, `scripts/canton-init.sh:19`
- **Description**: Some artifacts assume Canton JSON API on `7575`; others default to `6865`.
- **Impact**: Operators troubleshooting bridge outages can “fix” one component while silently breaking another.
- **Recommendation**: Standardize JSON API port assumptions for this stack (devnet: `7575`) and reserve `6865` only where explicitly needed.
- **References**: CWE-16 (Configuration)

## Finding BRIDGE-RELAY-M-02: README startup path under-specifies required relay config
- **Severity**: MEDIUM
- **Files**: `README.md`
- **Lines**: `README.md:387`
- **Description**: README instructs `docker compose up` for relay stack without documenting mandatory bridge env/secret values and host profile requirements.
- **Impact**: New operator workflows converge on misconfigured defaults and non-obvious startup failures.
- **Recommendation**: Add a minimal validated `.env` profile for local devnet and a separate production profile checklist.
- **References**: CWE-16 (Configuration)

## Finding BRIDGE-RELAY-L-01: Monitoring script checks wrong gRPC forwarder container name
- **Severity**: LOW
- **Files**: `scripts/canton-monitor.sh`
- **Lines**: `scripts/canton-monitor.sh:52`
- **Description**: Script checks `canton-port-fwd-grpc`, while active environment uses `canton-grpc-fwd`.
- **Impact**: False-negative readiness signal for gRPC forwarder can mislead incident response.
- **Recommendation**: Use configurable container name with default fallback list or detect by published port.
- **References**: CWE-703 (Improper Check for Exceptional Conditions)

### Notes & Context
- Verified local Canton endpoint behavior directly:
  - Host request to `http://127.0.0.1:7575/v2/users` returns `200`.
  - In-container request to `http://localhost:7575` fails (`000`), while `http://host.docker.internal:7575` succeeds (`200`).
  - In-container TLS request to `https://host.docker.internal:7575` fails with TLS protocol error.
- Relay unit tests and relay utility integration tests pass (`29` Jest + `43` Hardhat/Chai checks), but these do not cover live Canton/Ethereum bridge path.
- Next deep-pass priority for bridge domain: end-to-end attestation flow test harness with real Canton endpoint profile matrix (devnet HTTP vs production TLS).
