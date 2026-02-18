# /deployments

This directory stores deployment manifests and logs for the Minted mUSD protocol.

## Structure

```
deployments/
├── mainnet-latest.json              ← symlink-like: always points to most recent
├── mainnet-2026-02-17T12-00-00Z.json  ← timestamped manifest
├── deploy-mainnet-20260217-120000.log ← raw deploy console output
├── deploy-dryrun-*.log              ← dry-run logs
└── README.md                        ← this file
```

## Manifest Schema

Each manifest JSON contains:

| Field | Type | Description |
|-------|------|-------------|
| `network` | string | Network name (`mainnet`, `sepolia`) |
| `chainId` | number | EIP-155 chain ID |
| `deployer` | address | Deployer wallet address |
| `timestamp` | ISO 8601 | Deployment timestamp |
| `blockNumber` | number | Starting block number |
| `dryRun` | boolean | Whether this was a simulation |
| `gitCommit` | string | Full git commit hash for traceability |
| `contracts` | object | Map of contract name → `{ address, txHash, type }` |
| `roles` | array | List of `{ contract, role, grantee, txHash }` |
| `gasSummary` | object | `{ totalETH, txCount }` |

## Usage

```bash
# Dry-run (default — safe)
./scripts/deploy-mainnet.sh

# Live deploy
./scripts/deploy-mainnet.sh --live

# Verify on Etherscan
./scripts/deploy-mainnet.sh --verify-only

# Read latest addresses
cat deployments/mainnet-latest.json | jq '.contracts'
```

## Security

- Manifest files are committed to git for auditability
- Deploy logs (`.log` files) are gitignored to avoid leaking gas details
- `DRY_RUN=true` is the default — live mode requires explicit `--live` flag + interactive confirmation
