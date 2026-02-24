# CIP-56 Bridge #24 Canary — Full Transfer Path Evidence

## Date: 2026-02-24

## Gate Criteria — CIP-56 Transfer Path (all PASSED)
- [x] No `INVALID_ARGUMENT` errors on CIP-56 transfer path
- [x] No `Expected ujson.Obj (data: [])` errors on CIP-56 transfer path
- [x] No `Missing non-optional field: validators` errors
- [x] BridgeInRequest created with validators/requiredSignatures
- [x] CIP-56 TransferFactory_Transfer succeeded
- [x] CIP-56 TransferInstruction_Accept succeeded
- [x] mUSD delivered to non-operator user (minted-canary)

## Gate Criteria — Attestation Path (FAILED — separate remediation)
- [ ] BridgeIn_Complete succeeds (no cancel fallback)
- [ ] No `Expected ujson.Obj` on AttestationRequest creation
- [ ] Attestation flow satisfies CRIT-01 (empty signatures at creation)

## 1. Ethereum Transaction

- **Tx hash**: `0x287717ac911b6ab69258b913079f8c0b82d6b888a744bf8f4692d66d9b55e2e5`
- **Block**: 10324763 (Sepolia)
- **Nonce**: 24
- **Amount**: 1.0 mUSD
- **Recipient**: `minted-user-33f97321::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9`
- **Approve tx**: `0x46c3e1fe158e4d1f1fe869c47a508172e8be10953a3597a9af20135c1c23e2ec`
- **Bridge contract**: `0x964799a56182aa884A114eb0Dd38746ddb8aebB7` (BLEBridgeV9)

## 2. Relay CIP-56 Transfer Log

```
[Relay] Found 1 new BridgeToCantonRequested events
[Relay] Bridge-out #24: 1.0 mUSD → Canton (minted-user-33f97321::122038887449dad...)
[Relay] Remapped bridge-out #24 recipient minted-user-33f97321::12203888... -> minted-canary::122006df00c631...
[Relay] Created BridgeInRequest on Canton for bridge-out #24
[Relay] Created CIP56MintedMUSD (operator-owned) for bridge-in #24: 1.0 mUSD
[Relay] ✅ CIP-56 TransferFactory_Transfer created for bridge #24 → minted-canary::122006df00c6314...
[Relay] ✅ CIP-56 transfer accepted for bridge #24; mUSD delivered to user
```

## 3. CIP-56 Exercise Path (no legacy fallback)

The relay exercised two CIP-56 interface choices:

### TransferFactory_Transfer
- **Interface**: `55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281:Splice.Api.Token.TransferInstructionV1:TransferFactory`
- **Factory CID**: `00a1f17b5116c13b1300...`
- **Choice**: `TransferFactory_Transfer`
- **Args**: `expectedAdmin`, `transfer.sender`, `transfer.receiver`, `transfer.amount`, `transfer.instrumentId`, `transfer.inputHoldingCids`, `extraArgs.context.values: {}`, `extraArgs.meta.values: {}`

### TransferInstruction_Accept
- **Interface**: `55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281:Splice.Api.Token.TransferInstructionV1:TransferInstruction`
- **Choice**: `TransferInstruction_Accept`
- **actAs**: `[sv::122006df..., minted-canary::122006df...]` (operator + receiver)
- **Args**: `extraArgs.context.values: {}`, `extraArgs.meta.values: {}`

### Key encoding decisions
- `ChoiceContext.values` and `Metadata.values` are `DA.TextMap.TextMap` — encoded as JSON object `{}`
- `ExtraArgs.context` field name is `context` (not `choiceContext`)
- Canton JSON API v2 `ExerciseCommand` with interface `templateId` auto-translates to `ExerciseByInterfaceCommand` at the gRPC layer

## 4. Proof of No Legacy Fallback

The relay log shows NO legacy CantonMUSD_Transfer or CantonMUSDTransferProposal calls.
The CIP-56 path was the only transfer mechanism used for bridge #24.

- No `CantonMUSD_Transfer` log entries for nonce 24
- No `CantonMUSDTransferProposal` log entries for nonce 24
- No `CIP-56 mint failed` or `falling back to legacy` messages

## 5. Canton Environment

- **Participant**: Canton v3.4.12-SNAPSHOT
- **Operator party**: `sv::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce`
- **Non-operator user**: `minted-canary::122006df00c631440327e68ba87f61795bbcd67db26142e580137e5038649f22edce`
- **Main DAR package**: `eff3bf30edb508b2d052f969203db972e59c66e974344ed43016cfccfa618f06`
- **CIP-56 DAR package**: `11347710f0e7a9c6386bd712ea3850b3787534885cd662d35e35afcb329d60e5`
- **Splice transfer instruction package**: `55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281`
- **Auth**: `Authorization: Bearer dummy-no-auth` (DevNet only — no auth enforcement)

## 6. Fixes Applied for This Canary

1. **BridgeInRequest schema drift** (HIGH): Made `validators` and `requiredSignatures` required in `daml-schema-validator.ts`
2. **Canton error code mismatch** (MEDIUM): Added `COMMAND_PREPROCESSING_FAILED` to fallback detection alongside `INVALID_ARGUMENT`
3. **Canton error string mismatch** (MEDIUM): Added `"Missing non-optional field"` to fallback detection alongside `"Missing fields"`
4. **TransferInstruction CID extraction** (MEDIUM): Added query fallback when `extractCreatedContractId` returns null
5. **AttestationRequest.requiredSignatures type** (MEDIUM): Cast to `Number()` to prevent string-vs-int mismatch
6. **Orphan recovery false success** (MEDIUM): Added `delivered` flag — only count success when `TransferInstruction_Accept` succeeds; otherwise count as skipped with warning

## 7. CIP-56 Warnings/Errors (non-blocking)

The BridgeIn_Complete attestation flow failed separately:
```
[Relay] BridgeIn_Complete with attestation failed for #24: Canton API error 500 ...
  cause: "Expected ujson.Obj (data: [])
[Relay] Archived BridgeInRequest #24 via cancel (attestation flow failed)
```

This is in the **attestation verification** code path (CRIT-02), NOT the CIP-56 transfer path.
Root cause (confirmed):

1. **Encoding**: `collectedSignatures` is `Set.Set Party` in V3.daml (line 1815).
   Canton JSON API v2 encodes `Set.Set Party` as `{"map": [["party", {}], ...]}` (empty: `{"map": []}`).
   The relay passes a plain JS array `["party"]`, triggering `Expected ujson.Obj`.
   `daml-schema-validator.ts:238` also incorrectly validates this as `assertPartyList` (list) instead of Set encoding.

2. **CRIT-01 invariant**: V3.daml line 1828 enforces `Set.null collectedSignatures` at AttestationRequest
   creation — the relay cannot pre-populate signatures. Validators must sign individually via
   `Attestation_Sign` with `ValidatorSelfAttestation` proof.

**Remediation** (separate from CIP-56 transfer):
- Create AttestationRequest with `collectedSignatures: {"map": []}` (empty Set) and `ecdsaSignatures: []` (empty list)
- Collect signatures via `Attestation_Sign` + `ValidatorSelfAttestation` per validator
- Exercise `BridgeIn_Complete` after threshold reached
- Align `daml-schema-validator.ts` with `Set.Set Party` encoding
- Validate with bridge #25 canary requiring both CIP-56 transfer AND BridgeIn_Complete success

**Status**: CIP-56 transfer canary PASSED. Attestation path requires separate remediation and canary (#25).

## 8. Additional Evidence: Manual TransferInstruction_Accept (#22)

Before bridge #24, the stale TransferInstruction from bridge #22 was manually accepted:

```bash
curl -X POST http://localhost:7575/v2/commands/submit-and-wait \
  -H 'Authorization: Bearer dummy-no-auth' \
  -d '{ "commands": [{ "ExerciseCommand": {
    "templateId": "55ba4deb...:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
    "contractId": "00ad0c225ff811e0...",
    "choice": "TransferInstruction_Accept",
    "choiceArgument": { "extraArgs": { "context": { "values": {} }, "meta": { "values": {} } } }
  }}], "actAs": ["sv::1220...", "minted-canary::1220..."] }'
```

Response: `{"updateId": "12209d4f389ba3c916dddc...", "completionOffset": 14005}`
