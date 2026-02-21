/**
 * Relay DAML Schema Validation — Integration Tests
 *
 * Verifies that the DAML schema validation layer catches all constraint
 * violations that would cause DAML_INTERPRETATION_ERROR on Canton.
 *
 * Tests cover every template the relay creates and every choice it exercises:
 *   - BridgeInRequest (ensure requiredSignatures > 0 && amount > 0.0)
 *   - CantonMUSD (ensure amount > 0.0)
 *   - CantonMUSD_Transfer (requires newOwner + complianceRegistryCid)
 *   - AttestationRequest (structural validation)
 *   - BridgeIn_Complete (requires attestationCid)
 *   - ReceiveYield (requires musdCid)
 *
 * Also tests that well-formed payloads pass validation.
 */

import { expect } from "chai";
import {
  validateCreatePayload,
  validateExerciseArgs,
  DamlValidationError,
  getRegisteredTemplates,
  getRegisteredChoices,
} from "../relay/daml-schema-validator";

// ============================================================
//  Valid Payload Factories
// ============================================================

const OPERATOR_PARTY = "minted-validator-1::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";
const USER_PARTY = "user-1::1220abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
const GOVERNANCE_PARTY = "governance::1220aaaa";
const MOCK_CONTRACT_ID = "#mock:1:0";

function validBridgeInRequest(): Record<string, unknown> {
  return {
    operator: OPERATOR_PARTY,
    user: USER_PARTY,
    amount: "100.0",
    feeAmount: "0.0",
    sourceChainId: 11155111,
    nonce: 42,
    createdAt: new Date().toISOString(),
    status: "pending",
    validators: [OPERATOR_PARTY, GOVERNANCE_PARTY],
    requiredSignatures: 1,
  };
}

function validCantonMUSD(): Record<string, unknown> {
  return {
    issuer: OPERATOR_PARTY,
    owner: OPERATOR_PARTY,
    amount: "500.0",
    agreementHash: "a".repeat(64),
    agreementUri: "ethereum:bridge-in:0x708957bFfA312D1730BdF87467E695D3a9F26b0f:nonce:42",
    privacyObservers: [],
  };
}

function validAttestationRequest(): Record<string, unknown> {
  return {
    aggregator: OPERATOR_PARTY,
    validatorGroup: [OPERATOR_PARTY, GOVERNANCE_PARTY],
    payload: {
      attestationId: "bridge-in-attest-42",
      globalCantonAssets: "0.0",
      targetAddress: "0x0000000000000000000000000000000000000000",
      amount: "100.0",
      isMint: false,
      nonce: "42",
      chainId: "11155111",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      entropy: "0x" + "ab".repeat(32),
      cantonStateHash: "0x" + "00".repeat(32),
    },
    positionCids: [],
    collectedSignatures: [OPERATOR_PARTY],
    ecdsaSignatures: [],
    requiredSignatures: 1,
    direction: "EthereumToCanton",
  };
}

// ============================================================
//  1. Registry Tests
// ============================================================

describe("DAML Schema Validator — Registry", function () {
  it("should have all relay-used templates registered", function () {
    const templates = getRegisteredTemplates();
    expect(templates).to.include("BridgeInRequest");
    expect(templates).to.include("CantonMUSD");
    expect(templates).to.include("AttestationRequest");
    expect(templates).to.include("BridgeOutRequest");
    expect(templates).to.include("RedemptionRequest");
    expect(templates).to.include("StandaloneBridgeOutRequest");
  });

  it("should have all relay-used choices registered", function () {
    const choices = getRegisteredChoices();
    expect(choices).to.include("CantonMUSD_Transfer");
    expect(choices).to.include("BridgeIn_Complete");
    expect(choices).to.include("BridgeOut_Complete");
    expect(choices).to.include("ReceiveYield");
    expect(choices).to.include("CantonMUSD_Split");
    expect(choices).to.include("BridgeIn_Cancel");
  });

  it("should not throw for unknown templates (warns but passes)", function () {
    expect(() => validateCreatePayload("UnknownTemplate", { foo: "bar" })).to.not.throw();
  });

  it("should not throw for unknown choices (warns but passes)", function () {
    expect(() => validateExerciseArgs("UnknownChoice", { foo: "bar" })).to.not.throw();
  });
});

// ============================================================
//  2. BridgeInRequest — Ensure: requiredSignatures > 0 && amount > 0.0
// ============================================================

describe("DAML Schema Validator — BridgeInRequest", function () {
  it("should accept a valid BridgeInRequest payload", function () {
    expect(() => validateCreatePayload("BridgeInRequest", validBridgeInRequest())).to.not.throw();
  });

  it("should accept amount as numeric string", function () {
    const p = validBridgeInRequest();
    p.amount = "0.001";
    expect(() => validateCreatePayload("BridgeInRequest", p)).to.not.throw();
  });

  // ── CRITICAL: ensure requiredSignatures > 0 ──

  it("should REJECT requiredSignatures = 0 (violates ensure)", function () {
    const p = validBridgeInRequest();
    p.requiredSignatures = 0;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "requiredSignatures");
  });

  it("should REJECT requiredSignatures = -1 (violates ensure)", function () {
    const p = validBridgeInRequest();
    p.requiredSignatures = -1;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT missing requiredSignatures", function () {
    const p = validBridgeInRequest();
    delete p.requiredSignatures;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT non-integer requiredSignatures", function () {
    const p = validBridgeInRequest();
    p.requiredSignatures = 1.5;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  // ── CRITICAL: ensure amount > 0.0 ──

  it("should REJECT amount = 0 (violates ensure)", function () {
    const p = validBridgeInRequest();
    p.amount = "0.0";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "amount");
  });

  it("should REJECT negative amount", function () {
    const p = validBridgeInRequest();
    p.amount = "-1.0";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT amount = '' (empty string)", function () {
    const p = validBridgeInRequest();
    p.amount = "";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  // ── validators must be non-empty [Party] ──

  it("should REJECT empty validators array", function () {
    const p = validBridgeInRequest();
    p.validators = [];
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "validators");
  });

  it("should REJECT missing validators", function () {
    const p = validBridgeInRequest();
    delete p.validators;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT validators with empty string entry", function () {
    const p = validBridgeInRequest();
    p.validators = [OPERATOR_PARTY, ""];
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });

  // ── Party fields ──

  it("should REJECT missing operator", function () {
    const p = validBridgeInRequest();
    delete p.operator;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "operator");
  });

  it("should REJECT empty user", function () {
    const p = validBridgeInRequest();
    p.user = "";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "user");
  });

  // ── Int fields ──

  it("should REJECT non-integer nonce", function () {
    const p = validBridgeInRequest();
    p.nonce = "42" as unknown;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "nonce");
  });

  it("should REJECT non-integer sourceChainId", function () {
    const p = validBridgeInRequest();
    p.sourceChainId = "11155111" as unknown;
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "sourceChainId");
  });

  // ── Time field ──

  it("should REJECT invalid createdAt timestamp", function () {
    const p = validBridgeInRequest();
    p.createdAt = "not-a-date";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "createdAt");
  });

  // ── feeAmount ──

  it("should accept feeAmount = 0", function () {
    const p = validBridgeInRequest();
    p.feeAmount = "0.0";
    expect(() => validateCreatePayload("BridgeInRequest", p)).to.not.throw();
  });

  it("should REJECT negative feeAmount", function () {
    const p = validBridgeInRequest();
    p.feeAmount = "-0.5";
    expect(() => validateCreatePayload("BridgeInRequest", p))
      .to.throw(DamlValidationError);
  });
});

// ============================================================
//  3. CantonMUSD — Ensure: amount > 0.0
// ============================================================

describe("DAML Schema Validator — CantonMUSD", function () {
  it("should accept a valid CantonMUSD payload", function () {
    expect(() => validateCreatePayload("CantonMUSD", validCantonMUSD())).to.not.throw();
  });

  it("should REJECT amount = 0.0 (violates ensure)", function () {
    const p = validCantonMUSD();
    p.amount = "0.0";
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError)
      .with.property("field", "amount");
  });

  it("should REJECT negative amount (violates ensure)", function () {
    const p = validCantonMUSD();
    p.amount = "-100.0";
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT missing issuer", function () {
    const p = validCantonMUSD();
    delete p.issuer;
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError)
      .with.property("field", "issuer");
  });

  it("should REJECT missing owner", function () {
    const p = validCantonMUSD();
    delete p.owner;
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError)
      .with.property("field", "owner");
  });

  it("should REJECT missing agreementHash", function () {
    const p = validCantonMUSD();
    delete p.agreementHash;
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT privacyObservers as non-array", function () {
    const p = validCantonMUSD();
    p.privacyObservers = "not-an-array";
    expect(() => validateCreatePayload("CantonMUSD", p))
      .to.throw(DamlValidationError);
  });

  it("should accept very small positive amount", function () {
    const p = validCantonMUSD();
    p.amount = "0.000000000000000001"; // 1 wei
    expect(() => validateCreatePayload("CantonMUSD", p)).to.not.throw();
  });
});

// ============================================================
//  4. AttestationRequest — Structural validation
// ============================================================

describe("DAML Schema Validator — AttestationRequest", function () {
  it("should accept a valid AttestationRequest payload", function () {
    expect(() => validateCreatePayload("AttestationRequest", validAttestationRequest())).to.not.throw();
  });

  it("should REJECT missing aggregator", function () {
    const p = validAttestationRequest();
    delete p.aggregator;
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "aggregator");
  });

  it("should REJECT empty validatorGroup", function () {
    const p = validAttestationRequest();
    p.validatorGroup = [];
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "validatorGroup");
  });

  it("should REJECT missing payload object", function () {
    const p = validAttestationRequest();
    delete p.payload;
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError)
      .with.property("field", "payload");
  });

  it("should REJECT requiredSignatures = 0", function () {
    const p = validAttestationRequest();
    p.requiredSignatures = 0;
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT missing direction", function () {
    const p = validAttestationRequest();
    delete p.direction;
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError);
  });

  it("should REJECT positionCids as non-array", function () {
    const p = validAttestationRequest();
    p.positionCids = "not-an-array";
    expect(() => validateCreatePayload("AttestationRequest", p))
      .to.throw(DamlValidationError);
  });
});

// ============================================================
//  5. Choice Argument Validation
// ============================================================

describe("DAML Schema Validator — CantonMUSD_Transfer", function () {
  it("should accept valid transfer args", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
      newOwner: USER_PARTY,
      complianceRegistryCid: MOCK_CONTRACT_ID,
    })).to.not.throw();
  });

  it("should REJECT missing newOwner", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
      complianceRegistryCid: MOCK_CONTRACT_ID,
    }))
      .to.throw(DamlValidationError)
      .with.property("field", "newOwner");
  });

  it("should REJECT missing complianceRegistryCid", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
      newOwner: USER_PARTY,
    }))
      .to.throw(DamlValidationError)
      .with.property("field", "complianceRegistryCid");
  });

  it("should REJECT empty complianceRegistryCid", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
      newOwner: USER_PARTY,
      complianceRegistryCid: "",
    }))
      .to.throw(DamlValidationError);
  });

  it("should REJECT empty newOwner", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
      newOwner: "",
      complianceRegistryCid: MOCK_CONTRACT_ID,
    }))
      .to.throw(DamlValidationError);
  });
});

describe("DAML Schema Validator — BridgeIn_Complete", function () {
  it("should accept valid args", function () {
    expect(() => validateExerciseArgs("BridgeIn_Complete", {
      attestationCid: MOCK_CONTRACT_ID,
    })).to.not.throw();
  });

  it("should REJECT missing attestationCid", function () {
    expect(() => validateExerciseArgs("BridgeIn_Complete", {}))
      .to.throw(DamlValidationError)
      .with.property("field", "attestationCid");
  });

  it("should REJECT empty attestationCid", function () {
    expect(() => validateExerciseArgs("BridgeIn_Complete", { attestationCid: "" }))
      .to.throw(DamlValidationError);
  });
});

describe("DAML Schema Validator — ReceiveYield", function () {
  it("should accept valid args", function () {
    expect(() => validateExerciseArgs("ReceiveYield", {
      musdCid: MOCK_CONTRACT_ID,
    })).to.not.throw();
  });

  it("should REJECT missing musdCid", function () {
    expect(() => validateExerciseArgs("ReceiveYield", {}))
      .to.throw(DamlValidationError)
      .with.property("field", "musdCid");
  });
});

describe("DAML Schema Validator — CantonMUSD_Split", function () {
  it("should accept valid split amount", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Split", {
      splitAmount: "50.0",
    })).to.not.throw();
  });

  it("should REJECT splitAmount = 0", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Split", {
      splitAmount: "0.0",
    }))
      .to.throw(DamlValidationError);
  });

  it("should REJECT negative splitAmount", function () {
    expect(() => validateExerciseArgs("CantonMUSD_Split", {
      splitAmount: "-10.0",
    }))
      .to.throw(DamlValidationError);
  });
});

describe("DAML Schema Validator — BridgeIn_Cancel (no args)", function () {
  it("should accept empty args", function () {
    expect(() => validateExerciseArgs("BridgeIn_Cancel", {})).to.not.throw();
  });
});

// ============================================================
//  6. Exact Relay Payload Structure Verification
// ============================================================

describe("DAML Schema Validator — Relay Payload Fidelity", function () {
  describe("BridgeInRequest payload matches relay output", function () {
    it("should validate the exact payload the relay builds for ETH→Canton bridge-out", function () {
      // This is the exact structure built at relay-service.ts ~line 1430-1445
      const relayPayload = {
        operator: OPERATOR_PARTY,
        user: USER_PARTY,
        amount: "1.5",  // ethers.formatEther output is always a string
        feeAmount: "0.0",
        sourceChainId: 11155111,
        nonce: 42,
        createdAt: new Date(Date.now()).toISOString(),
        status: "pending",
        validators: [OPERATOR_PARTY],
        requiredSignatures: Math.max(1, Math.ceil(1 / 2)),
      };

      expect(() => validateCreatePayload("BridgeInRequest", relayPayload)).to.not.throw();
    });

    it("should validate with multiple validators", function () {
      const validators = [OPERATOR_PARTY, USER_PARTY, GOVERNANCE_PARTY];
      const relayPayload = {
        operator: OPERATOR_PARTY,
        user: USER_PARTY,
        amount: "100.0",
        feeAmount: "0.0",
        sourceChainId: 1, // mainnet
        nonce: 1000,
        createdAt: new Date().toISOString(),
        status: "pending",
        validators,
        requiredSignatures: Math.max(1, Math.ceil(validators.length / 2)),
      };

      expect(() => validateCreatePayload("BridgeInRequest", relayPayload)).to.not.throw();
      expect(relayPayload.requiredSignatures).to.equal(2);
    });
  });

  describe("CantonMUSD payload matches relay output", function () {
    it("should validate the exact payload for bridge-in minting", function () {
      const nonce = 42;
      const bridgeAddr = "0x708957bFfA312D1730BdF87467E695D3a9F26b0f";
      const agreementHash = "a".repeat(64);
      const agreementUri = `ethereum:bridge-in:${bridgeAddr}:nonce:${nonce}`;

      const relayPayload = {
        issuer: OPERATOR_PARTY,
        owner: OPERATOR_PARTY,
        amount: "100.0",
        agreementHash,
        agreementUri,
        privacyObservers: [] as string[],
      };

      expect(() => validateCreatePayload("CantonMUSD", relayPayload)).to.not.throw();
    });

    it("should validate the exact payload for yield minting", function () {
      const yieldDistAddr = "0x1234567890123456789012345678901234567890";
      const relayPayload = {
        issuer: OPERATOR_PARTY,
        owner: OPERATOR_PARTY,
        amount: "50.0",
        agreementHash: "yield-epoch-42".padEnd(64, "0"),
        agreementUri: `ethereum:yield-distributor:${yieldDistAddr}`,
        privacyObservers: [] as string[],
      };

      expect(() => validateCreatePayload("CantonMUSD", relayPayload)).to.not.throw();
    });
  });

  describe("CantonMUSD_Transfer matches relay output", function () {
    it("should validate transfer with complianceRegistryCid", function () {
      expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
        newOwner: USER_PARTY,
        complianceRegistryCid: "#mock:compliance:0",
      })).to.not.throw();
    });

    it("should catch the OLD bug: transfer without complianceRegistryCid", function () {
      // This is the exact bug that was in the relay before CRIT-02 fix
      expect(() => validateExerciseArgs("CantonMUSD_Transfer", {
        newOwner: USER_PARTY,
        // Missing complianceRegistryCid!
      }))
        .to.throw(DamlValidationError)
        .with.property("reason")
        .that.includes("ContractId");
    });
  });

  describe("AttestationRequest matches relay bridge-in attestation", function () {
    it("should validate the relay's attestation payload structure", function () {
      const validators = [OPERATOR_PARTY];
      const relayPayload = {
        aggregator: OPERATOR_PARTY,
        validatorGroup: validators,
        payload: {
          attestationId: "bridge-in-attest-42",
          globalCantonAssets: "0.0",
          targetAddress: "0x0000000000000000000000000000000000000000",
          amount: "100.0",
          isMint: false,
          nonce: "42",
          chainId: "11155111",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          entropy: "0x" + "ab".repeat(32),
          cantonStateHash: "0x" + "00".repeat(32),
        },
        positionCids: [],
        collectedSignatures: validators,
        ecdsaSignatures: [],
        requiredSignatures: 1,
        direction: "EthereumToCanton",
      };

      expect(() => validateCreatePayload("AttestationRequest", relayPayload)).to.not.throw();
    });
  });
});

// ============================================================
//  7. DamlValidationError Structure
// ============================================================

describe("DamlValidationError", function () {
  it("should include templateName, field, and reason", function () {
    try {
      validateCreatePayload("BridgeInRequest", { ...validBridgeInRequest(), amount: "0" });
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e).to.be.instanceOf(DamlValidationError);
      expect(e.templateName).to.equal("BridgeInRequest");
      expect(e.field).to.equal("amount");
      expect(e.reason).to.include("> 0.0");
    }
  });

  it("should produce human-readable message", function () {
    try {
      validateCreatePayload("CantonMUSD", { ...validCantonMUSD(), issuer: 123 });
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("CantonMUSD");
      expect(e.message).to.include("issuer");
    }
  });
});
