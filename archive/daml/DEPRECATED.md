# Archived DAML Templates — DO NOT DEPLOY

These templates have been archived because they are **deprecated** and contain security vulnerabilities that are remediated in the production V3 modules.

## Why These Were Archived

| File | Reason | Security Issue |
|------|--------|----------------|
| `BLEProtocol.daml` | Superseded by `Minted.Protocol.V3` | **CRITICAL**: `ValidatorSignature` uses `signatory aggregator` — a compromised aggregator can forge validator signatures and bypass BFT validation |
| `BLEBridgeProtocol.daml` | Intermediate version, superseded by V3 | Not imported by any active module. V3 BridgeService + AttestationRequest replace this entirely |
| `MintedMUSD.daml` | Early draft token template | No compliance enforcement, no rate limits, no dual-signatory model |
| `MUSD_Protocol.daml` | Monolithic V1 protocol | Explicitly marked deprecated. No compliance, no governance integration, no supply coordination |
| `TokenInterface.daml` | Draft interface file | Explicitly marked deprecated. Empty stub with no production use |
| `InstitutionalAssetV4.daml` | Standalone institutional module | Not integrated with V3 compliance/governance framework |

## Production Modules

The active production DAML modules are in `daml/`:
- `Minted/Protocol/V3.daml` — Unified Canton protocol (tokens, vaults, bridge, staking)
- `CantonDirectMint.daml` — Production minting with mandatory compliance
- `CantonLending.daml` — CDP borrowing with compliance + rate limits
- `CantonSMUSD.daml` — Yield vault with attestation-based share price sync
- `CantonLoopStrategy.daml` — Leveraged strategy module
- `CantonBoostPool.daml` — Boost pool for yield amplification
- `Compliance.daml` — Sanctions/AML enforcement
- `Governance.daml` — Multi-sig governance with timelocks
- `Upgrade.daml` — Safe contract migration framework

## Audit Reference

Archived per CRIT-01 and CRIT-02 of the Institutional Audit (2026-02-13).
Deprecated templates were still compilable and deployable, creating a bypass vector around all V3 security controls.
