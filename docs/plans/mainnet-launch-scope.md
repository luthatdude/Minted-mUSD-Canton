# Mainnet Launch Scope Freeze (Canonical Module Decision)

- Decision Date: 2026-02-18
- Scope Owner: Release Manager
- Status: Approved for mainnet launch gating

## Canonical DAML Module Set

The mainnet launch uses the following canonical Canton modules:

1. `daml/CantonDirectMint.daml` (direct mint + bridge-out request flow)
2. `daml/CantonSMUSD.daml` (Canton staking/yield vault)
3. `daml/CantonLending.daml` (Canton lending/CDP)
4. `daml/CantonLoopStrategy.daml` (Canton loop strategy)
5. `daml/Compliance.daml` (compliance registry + checks)
6. `daml/Governance.daml` (governance controls)

`daml/Minted/Protocol/V3.daml` remains in-repo as audited reference and compatibility surface, but is **not** the canonical standalone mainnet deployment target for the Canton direct-mint stack in this launch scope.

## Explicit Exclusions (Not Canonical for This Launch)

- `daml/MintedProtocolV2Fixed.daml` (legacy compatibility path)
- Any archived templates under `archive/daml/`

## Repository Alignment Rules

1. Any reference to "production module" must point to this decision file.
2. Documentation that discusses V2Fixed/V3/standalone coexistence must mark this decision as the canonical source of truth.
3. Future scope changes require a new signed revision of this file.

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Release Manager | `Release Manager (acting)` | `APPROVED` | `2026-02-18` |
| Protocol Engineering Lead | `Protocol Engineering Lead (acting)` | `APPROVED` | `2026-02-18` |
| Security Lead | `Security Lead (acting)` | `APPROVED` | `2026-02-18` |
