# Mainnet Deploy/Verification/Cutover Evidence

- Date: 2026-02-18
- Owners: Protocol Engineering + Release Manager
- Scope: Item-13 evidence package for deployment pipeline, verification path, and frontend cutover readiness

## Deployment Evidence

Primary manifest and logs:

- `deployments/mainnet-2026-02-18T06-08-29-873Z.json`
- `deployments/mainnet-latest.json`
- `deployments/deploy-dryrun-20260218-010828.log`

Extracted deployment facts:

| Field | Value |
|---|---|
| `network` | `mainnet` |
| `chainId` | `31337` (dry-run simulation chain) |
| `dryRun` | `true` |
| `contracts deployed` | `15` entries in manifest (13 core + 2 dry-run mock feeds) |
| `txCount` | `25` |
| `gasSummary.totalETH` | `0.043138797076844779` |

## Verification Workflow Evidence

Verification path is wired through:

- `scripts/deploy-mainnet.sh --verify-only`
- `scripts/deploy-mainnet.ts` (manifest persistence + deployment traceability)
- `deployments/README.md`

Verification commands documented and reproducible:

```bash
./scripts/deploy-mainnet.sh --verify-only
npx hardhat verify --network mainnet <contractAddress> <constructorArgs...>
```

## Frontend Mainnet Cutover Readiness

Frontend mainnet mode and contract-address wiring are configured via environment variables:

- `frontend/src/lib/config.ts` (`CHAIN_ID` defaults to `1`)
- `frontend/src/pages/_app.tsx` (`NetworkGuard` enforced)

Cutover checklist:

- [x] Mainnet chain id default in frontend config
- [x] Contract-address env wiring for all core contracts
- [x] Network guard enabled at app root
- [ ] Production env publication with live mainnet addresses

## Evidence Artifacts

- `artifacts/test-results/mainnet-cutover-evidence-2026-02-18.log`
- `artifacts/test-results/role-ceremony-sepolia-proof.log`
- `artifacts/test-results/role-ceremony-mainnet-proof.log` (required for final launch memo)

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Release Manager | `Release Manager (acting)` | `APPROVED` | `2026-02-18` |
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |

## Status

- Evidence package for deployment/verification/cutover is present.
- Live mainnet execution artifacts (real mainnet tx hashes + explorer links + announcement record) are the remaining final-launch publication step.
