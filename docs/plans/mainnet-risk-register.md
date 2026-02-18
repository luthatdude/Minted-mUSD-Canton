# Mainnet Risk Register (Medium Findings)

- Created: 2026-02-18
- Scope: Open medium recommendations from security audit required for mainnet decisioning
- Sources:
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:649`
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:650`
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:1289`
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:1290`
  - `/Users/luiscuello/Documents/New project/Minted-mUSD-Canton/audit/SECURITY_AUDIT.md:1291`

## Decision Rules

For each row, select exactly one:

1. `FIX_BEFORE_LAUNCH`
2. `RISK_ACCEPT_TEMPORARY`

If `RISK_ACCEPT_TEMPORARY` is selected, all fields below are mandatory:

- Compensating controls
- Expiry date
- Evidence link
- Security approver
- Engineering approver

No row may remain with empty owner or decision.

## Risk Register

| ID | Severity | Finding | Source | Owner | Proposed Decision | Final Decision | Compensating Controls | Expiry | Evidence Link | Security Approver | Engineering Approver | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R-M-001 | Medium | No timelock on critical admin functions | `SECURITY_AUDIT.md:649` | Protocol Engineering | `FIX_BEFORE_LAUNCH` | `TBD` | Emergency pause roles active; admin role activity alerting; change-window policy | `TBD` | `TBD` | `TBD` | `TBD` | Open |
| R-M-002 | Medium | Single oracle failure can cause DoS (fallback missing) | `SECURITY_AUDIT.md:650` | Protocol Engineering | `FIX_BEFORE_LAUNCH` | `TBD` | Circuit breaker monitoring; stale feed paging; manual fallback runbook | `TBD` | `TBD` | `TBD` | `TBD` | Open |
| R-M-003 | Medium | `BridgeIn_Sign` replay-hardening gap from audit observation | `SECURITY_AUDIT.md:1289` | Protocol Engineering (DAML) | `FIX_BEFORE_LAUNCH` | `FIX_BEFORE_LAUNCH` | Quorum dedup checks at finalize; validator signature anomaly alerting | `N/A` | `daml/BLEBridgeProtocol.daml` + `artifacts/test-results/canton-quorum-boundary.log` | `TBD` | `TBD` | Implemented (pending sign-off) |
| R-M-004 | Medium | Canton operator centralization on critical controls | `SECURITY_AUDIT.md:1290` | Security Lead + Protocol Engineering | `FIX_BEFORE_LAUNCH` | `TBD` | Multisig governance policy; emergency-only runbook; admin action monitoring | `TBD` | `TBD` | `TBD` | `TBD` | Open |
| R-M-005 | Medium | No cooldown on `CantonStakingService` unstake path | `SECURITY_AUDIT.md:1291` | Protocol Engineering (DAML) | `FIX_BEFORE_LAUNCH` | `TBD` | Withdrawal velocity alerting; manual pause trigger for abnormal outflows | `TBD` | `TBD` | `TBD` | `TBD` | Open |

## Sign-Off

This register is considered launch-ready only when:

- Every row has owner + final decision + evidence.
- No medium finding is unowned.
- Security and Engineering approvals are complete.

| Role | Name | Signature | Date |
|---|---|---|---|
| Security Lead | `TBD` | `TBD` | `TBD` |
| Protocol Engineering Lead | `TBD` | `TBD` | `TBD` |
| Release Manager (ack) | `TBD` | `TBD` | `TBD` |
