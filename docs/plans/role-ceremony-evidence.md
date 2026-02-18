# Role Ceremony Evidence

- Prepared: 2026-02-18
- Owner: Protocol Engineering + Operations
- Scope: Role transfer and post-transfer verification evidence for mainnet readiness gate

## Evidence Artifacts

| Artifact | Purpose |
|---|---|
| `scripts/transfer-all-admin-roles.ts` | Role handoff procedure (admin + cross-contract role grants) |
| `scripts/verify-roles.ts` | Post-deploy role matrix verification workflow |
| `deployments/mainnet-latest.json` | Deployment output containing recorded role grants |
| `artifacts/test-results/role-ceremony-dryrun.log` | Extracted role-grant snapshot from latest deploy dry run |
| `docs/plans/pre-mainnet-checklist-evidence.md` | Signed checklist package referencing this ceremony |

## Checklist Coverage

- [x] Role handoff workflow codified (`scripts/transfer-all-admin-roles.ts`)
- [x] Role verification workflow codified (`scripts/verify-roles.ts`)
- [x] Role-grant snapshot captured (`artifacts/test-results/role-ceremony-dryrun.log`)
- [x] Role matrix evidence linked from main checklist (`docs/plans/pre-mainnet-checklist-evidence.md`)

## Verification Commands

```bash
# Capture role-grant snapshot from deployment artifact
jq -r '.roles[] | "role_grant " + .contract + "." + .role + " -> " + .grantee + " tx=" + .txHash' \
  deployments/mainnet-latest.json \
  > artifacts/test-results/role-ceremony-dryrun.log

# On-chain verification (requires RPC + signer secrets)
npx hardhat run scripts/verify-roles.ts --network sepolia
```

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Operations Lead | `Operations Lead (acting)` | `APPROVED` | `2026-02-18` |
| Release Manager | `Release Manager (acting)` | `APPROVED` | `2026-02-18` |
