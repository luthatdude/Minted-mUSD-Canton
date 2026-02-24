# CIP-56 Attestation Path Canary — Full Evidence

## Date: 2026-02-24

## Summary

Bridge nonces #19 and #20 completed the full attestation path end-to-end using the
fixed LF2 package (`f9481d29...`). This resolves the CRIT-01 violation and
PreconditionFailed errors from the `eff3bf30...` package.

## Gate Criteria — ALL PASSED

- [x] CIP-56 TransferFactory_Transfer succeeds
- [x] CIP-56 TransferInstruction_Accept succeeds (mUSD delivered to user)
- [x] AttestationRequest created with empty signatures (CRIT-01 compliant)
- [x] Attestation_Sign succeeds (ValidatorSelfAttestation consumed)
- [x] BridgeIn_Complete succeeds with SignedAttestation CID
- [x] No cancel fallback triggered
- [x] No `Expected ujson.Obj` errors
- [x] No `PreconditionFailed` errors on new package

## Package Details

| Item | Value |
|------|-------|
| Old (broken) package | `eff3bf30edb508b2d052f969203db972e59c66e974344ed43016cfccfa618f06` (ble-protocol v2.4.0) |
| New (fixed) package | `f9481d29611628c7145d3d9a856aed6bb318d7fdd371a0262dbac7ca22b0142b` (ble-protocol-v3-mini v0.0.1) |
| SDK version | 3.4.10 (LF 2.x) |
| Canton version | 3.4.12-SNAPSHOT |

## Root Cause (resolved)

The deployed `eff3bf30` package had a self-contradictory state:
- `AttestationRequest` ensure clause: `Set.null collectedSignatures` (must be empty)
- `Attestation_Sign` choice: creates new `AttestationRequest` with `Set.insert validator collectedSignatures` (non-empty)
- These are incompatible — `Attestation_Sign` can NEVER succeed in `eff3bf30`

The fixed `f9481d29` package corrects this:
- `Attestation_Sign` returns `ContractId SignedAttestation` (separate template, non-empty sigs allowed)
- `BridgeIn_Complete.attestationCid` takes `ContractId SignedAttestation`

## Bridge #19 — Full Path Log

```
[Relay] Created BridgeInRequest on Canton for bridge-out #19
[Relay] Created CIP56MintedMUSD (operator-owned) for bridge-in #19: 500.0 mUSD
[Relay] ✅ CIP-56 TransferFactory_Transfer created for bridge #19 → minted-canary::122006df00c6314...
[Relay] ✅ CIP-56 transfer accepted for bridge #19; mUSD delivered to user
[Relay] Attestation signed: validator 1/1 for #19
[Relay] ✅ BridgeIn_Complete exercised for #19 with attestation 00bdd9d098e4a1e1...
```

## Bridge #20 — Full Path Log

```
[Relay] Created BridgeInRequest on Canton for bridge-out #20
[Relay] Created CIP56MintedMUSD (operator-owned) for bridge-in #20: 1000.0 mUSD
[Relay] ✅ CIP-56 TransferFactory_Transfer created for bridge #20 → minted-canary::122006df00c6314...
[Relay] ✅ CIP-56 transfer accepted for bridge #20; mUSD delivered to user
[Relay] Attestation signed: validator 1/1 for #20
[Relay] ✅ BridgeIn_Complete exercised for #20 with attestation 0088ef04db02ab14...
```

## Manual Signing Test

Before the relay canary, a manual diagnostic confirmed the signing flow:

1. Created `AttestationRequest` with `collectedSignatures: {"map": []}` → success (offset 14701)
2. Created `ValidatorSelfAttestation` → success (offset 14707)
3. Exercised `Attestation_Sign` → returned `SignedAttestation` with `collectedSignatures: {"map": [["sv::122006df...", {}]]}` → success (offset 14710)

## Expected Failures

- **Bridge #25**: `INTERPRETATION_UPGRADE_ERROR_VALIDATION_FAILED` — contracts created under `eff3bf30` cannot be completed with `f9481d29` semantics. Expected; old contracts are orphaned.
- **Bridge #21**: `USER_PARTY_NOT_HOSTED` — `minted-validator-1::12203888...` is `isLocal=false` on this participant. Expected; topology hosting not completed.

## Relay Changes

1. **relay-service.ts**: Reverted to Track B (SignedAttestation flow):
   - `Attestation_Sign` on `AttestationRequest` → `SignedAttestation`
   - `SignedAttestation_AddSignature` for subsequent validators
   - `BridgeIn_Complete` with `ContractId SignedAttestation`
   - Null guard on `signedAttestCid` before multi-validator path
   - `pollForAttestations` queries `SignedAttestation`
   - `Attestation_Complete` exercises on `SignedAttestation`

2. **daml-schema-validator.ts**: `assertSetParty` for `collectedSignatures` (Set.Set Party encoding)

3. **.env.development / .env**: `CANTON_PACKAGE_ID=f9481d29...`

## Parties

| Party | Role | isLocal |
|-------|------|---------|
| `sv::122006df...` | Operator/Validator/Aggregator | true |
| `minted-canary::122006df...` | Bridge-in recipient | true |
| `minted-validator-1::12203888...` | (unused — not hosted) | false |
