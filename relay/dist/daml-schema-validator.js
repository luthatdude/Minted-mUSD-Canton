"use strict";
/**
 * DAML Schema Validation Layer
 *
 * Validates relay payloads against DAML template signatures and ensure constraints
 * BEFORE submitting to Canton. Catches mismatches that would cause
 * DAML_INTERPRETATION_ERROR at the ledger level.
 *
 * Coverage:
 *   - BridgeInRequest  (V3)       — ensure requiredSignatures > 0 && amount > 0.0
 *   - BridgeOutRequest (V3)       — ensure fromOptional 1 requiredSignatures > 0
 *   - CantonMUSD                  — ensure amount > 0.0
 *   - CantonMUSD_Transfer         — choice arg: { newOwner, complianceRegistryCid }
 *   - AttestationRequest          — structural validation
 *   - RedemptionRequest           — structural validation
 *
 * Usage:
 *   import { validateCreatePayload, validateExerciseArgs } from "./daml-schema-validator";
 *   validateCreatePayload("BridgeInRequest", payload); // throws DamlValidationError on failure
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRegisteredChoices = exports.getRegisteredTemplates = exports.validatedExercise = exports.validatedCreate = exports.validateExerciseArgs = exports.validateCreatePayload = exports.DamlValidationError = void 0;
// ============================================================
//  Error Type
// ============================================================
class DamlValidationError extends Error {
    templateName;
    field;
    reason;
    payload;
    constructor(templateName, field, reason, payload) {
        super(`DAML validation failed for ${templateName}.${field}: ${reason}`);
        this.templateName = templateName;
        this.field = field;
        this.reason = reason;
        this.payload = payload;
        this.name = "DamlValidationError";
    }
}
exports.DamlValidationError = DamlValidationError;
// ============================================================
//  Type Validators (reusable primitives)
// ============================================================
function assertParty(value, template, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new DamlValidationError(template, field, `expected non-empty Party string, got ${typeof value}: ${JSON.stringify(value)?.slice(0, 80)}`);
    }
}
function assertMoney(value, template, field) {
    if (typeof value === "number") {
        // Acceptable — Canton JSON API accepts numeric
        return;
    }
    if (typeof value !== "string") {
        throw new DamlValidationError(template, field, `expected Money (Numeric 18 string), got ${typeof value}`);
    }
    const n = parseFloat(value);
    if (isNaN(n)) {
        throw new DamlValidationError(template, field, `expected numeric string, got "${value}"`);
    }
}
function assertPositiveMoney(value, template, field) {
    assertMoney(value, template, field);
    const n = typeof value === "number" ? value : parseFloat(value);
    if (n <= 0) {
        throw new DamlValidationError(template, field, `must be > 0.0, got ${n}`);
    }
}
function assertNonNegativeMoney(value, template, field) {
    assertMoney(value, template, field);
    const n = typeof value === "number" ? value : parseFloat(value);
    if (n < 0) {
        throw new DamlValidationError(template, field, `must be >= 0.0, got ${n}`);
    }
}
function assertInt(value, template, field) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new DamlValidationError(template, field, `expected Int, got ${typeof value}: ${JSON.stringify(value)}`);
    }
}
function assertPositiveInt(value, template, field) {
    assertInt(value, template, field);
    if (value <= 0) {
        throw new DamlValidationError(template, field, `must be > 0, got ${value}`);
    }
}
function assertText(value, template, field) {
    if (typeof value !== "string") {
        throw new DamlValidationError(template, field, `expected Text, got ${typeof value}`);
    }
}
function assertNonEmptyText(value, template, field) {
    assertText(value, template, field);
    if (value.length === 0) {
        throw new DamlValidationError(template, field, `must be non-empty`);
    }
}
function assertTime(value, template, field) {
    if (typeof value !== "string") {
        throw new DamlValidationError(template, field, `expected Time (ISO string), got ${typeof value}`);
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) {
        throw new DamlValidationError(template, field, `invalid ISO timestamp: "${value}"`);
    }
}
function assertPartyList(value, template, field) {
    if (!Array.isArray(value)) {
        throw new DamlValidationError(template, field, `expected [Party] array, got ${typeof value}`);
    }
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string" || value[i].length === 0) {
            throw new DamlValidationError(template, `${field}[${i}]`, `expected non-empty Party string, got ${typeof value[i]}`);
        }
    }
}
function assertNonEmptyPartyList(value, template, field) {
    assertPartyList(value, template, field);
    if (value.length === 0) {
        throw new DamlValidationError(template, field, `must contain at least one Party`);
    }
}
function assertBool(value, template, field) {
    if (typeof value !== "boolean") {
        throw new DamlValidationError(template, field, `expected Bool, got ${typeof value}`);
    }
}
function assertContractId(value, template, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new DamlValidationError(template, field, `expected ContractId (non-empty string), got ${typeof value}: ${JSON.stringify(value)?.slice(0, 60)}`);
    }
}
function assertOptional(value, template, field, inner) {
    if (value === null || value === undefined)
        return;
    inner(value, template, field);
}
// ============================================================
//  Template Schemas
// ============================================================
/**
 * Validate BridgeInRequest create payload.
 * DAML ensure: requiredSignatures > 0 && amount > 0.0
 */
function validateBridgeInRequest(payload) {
    const T = "BridgeInRequest";
    // Required fields
    assertParty(payload.operator, T, "operator");
    assertParty(payload.user, T, "user");
    assertPositiveMoney(payload.amount, T, "amount"); // ensure amount > 0.0
    assertNonNegativeMoney(payload.feeAmount, T, "feeAmount");
    assertInt(payload.sourceChainId, T, "sourceChainId");
    assertInt(payload.nonce, T, "nonce");
    assertTime(payload.createdAt, T, "createdAt");
    assertText(payload.status, T, "status");
    // validators and requiredSignatures are optional — the deployed DAML package
    // may not include these fields (V3 source has them but the on-ledger package
    // predates their addition).
    assertOptional(payload.validators, T, "validators", (v, t, f) => {
        assertNonEmptyPartyList(v, t, f);
    });
    assertOptional(payload.requiredSignatures, T, "requiredSignatures", (v, t, f) => {
        assertPositiveInt(v, t, f);
    });
}
/**
 * Validate BridgeOutRequest create payload (V3 module).
 * DAML ensure: fromOptional 1 requiredSignatures > 0
 */
function validateBridgeOutRequestV3(payload) {
    const T = "BridgeOutRequest(V3)";
    assertParty(payload.operator, T, "operator");
    assertParty(payload.user, T, "user");
    assertPositiveMoney(payload.amount, T, "amount");
    assertInt(payload.sourceChainId, T, "sourceChainId");
    assertText(payload.agreementHash, T, "agreementHash");
    assertInt(payload.nonce, T, "nonce");
    assertTime(payload.createdAt, T, "createdAt");
    assertText(payload.status, T, "status");
    // Optional but if present must be > 0 (fromOptional 1 requiredSignatures > 0)
    assertOptional(payload.requiredSignatures, T, "requiredSignatures", (v, t, f) => {
        assertPositiveInt(v, t, f);
    });
    assertOptional(payload.validators, T, "validators", (v, t, f) => {
        assertPartyList(v, t, f);
    });
}
/**
 * Validate CantonMUSD create payload.
 * DAML ensure: amount > 0.0
 */
function validateCantonMUSD(payload) {
    const T = "CantonMUSD";
    assertParty(payload.issuer, T, "issuer");
    assertParty(payload.owner, T, "owner");
    assertPositiveMoney(payload.amount, T, "amount"); // ensure amount > 0.0
    assertText(payload.agreementHash, T, "agreementHash");
    assertText(payload.agreementUri, T, "agreementUri");
    assertPartyList(payload.privacyObservers, T, "privacyObservers");
}
/**
 * Validate AttestationRequest create payload.
 */
function validateAttestationRequest(payload) {
    const T = "AttestationRequest";
    assertParty(payload.aggregator, T, "aggregator");
    assertNonEmptyPartyList(payload.validatorGroup, T, "validatorGroup");
    // payload.payload is the nested attestation data
    if (!payload.payload || typeof payload.payload !== "object") {
        throw new DamlValidationError(T, "payload", "expected attestation payload object");
    }
    if (!Array.isArray(payload.positionCids)) {
        throw new DamlValidationError(T, "positionCids", "expected [ContractId] array");
    }
    assertPartyList(payload.collectedSignatures, T, "collectedSignatures");
    if (payload.ecdsaSignatures !== undefined && !Array.isArray(payload.ecdsaSignatures)) {
        throw new DamlValidationError(T, "ecdsaSignatures", "expected [Text] array");
    }
    assertPositiveInt(payload.requiredSignatures, T, "requiredSignatures");
    assertNonEmptyText(payload.direction, T, "direction");
}
/**
 * Validate RedemptionRequest create payload (if relay ever creates one directly).
 */
function validateRedemptionRequest(payload) {
    const T = "RedemptionRequest";
    assertParty(payload.operator, T, "operator");
    assertParty(payload.user, T, "user");
    assertPositiveMoney(payload.musdBurned, T, "musdBurned");
    assertNonNegativeMoney(payload.usdcOwed, T, "usdcOwed");
    assertNonNegativeMoney(payload.feeAmount, T, "feeAmount");
    assertTime(payload.createdAt, T, "createdAt");
    assertBool(payload.fulfilled, T, "fulfilled");
}
/**
 * Validate BridgeOutRequest create payload (CantonDirectMint module).
 *
 * DAML template fields:
 *   operator       : Party
 *   user           : Party
 *   amount         : Money         (ensure amount > 0.0)
 *   targetChainId  : Int
 *   targetTreasury : Text
 *   nonce          : Int
 *   createdAt      : Time
 *   status         : Text
 *   source         : Text          ("directmint" | "ethpool")
 *   validators     : [Party]
 */
function validateStandaloneBridgeOutRequest(payload) {
    const T = "BridgeOutRequest(CDM)";
    assertParty(payload.operator, T, "operator");
    assertParty(payload.user, T, "user");
    assertPositiveMoney(payload.amount, T, "amount");
    assertInt(payload.targetChainId, T, "targetChainId");
    assertText(payload.targetTreasury, T, "targetTreasury");
    assertInt(payload.nonce, T, "nonce");
    assertTime(payload.createdAt, T, "createdAt");
    assertText(payload.status, T, "status");
    assertText(payload.source, T, "source");
    assertPartyList(payload.validators, T, "validators");
}
// ============================================================
//  Choice Argument Schemas
// ============================================================
/**
 * Validate CantonMUSD_Transfer choice arguments.
 */
function validateCantonMUSD_Transfer(args) {
    const T = "CantonMUSD_Transfer";
    assertParty(args.newOwner, T, "newOwner");
    assertContractId(args.complianceRegistryCid, T, "complianceRegistryCid");
}
/**
 * Validate BridgeIn_Complete choice arguments.
 */
function validateBridgeIn_Complete(args) {
    const T = "BridgeIn_Complete";
    assertContractId(args.attestationCid, T, "attestationCid");
}
/**
 * Validate BridgeOut_Complete choice arguments.
 */
function validateBridgeOut_Complete(args) {
    const T = "BridgeOut_Complete";
    assertContractId(args.attestationCid, T, "attestationCid");
}
/**
 * Validate ReceiveYield choice arguments (CantonStakingService or CantonETHPoolService).
 */
function validateReceiveYield(args) {
    const T = "ReceiveYield";
    assertContractId(args.musdCid, T, "musdCid");
}
/**
 * Validate CantonMUSD_Split choice arguments.
 */
function validateCantonMUSD_Split(args) {
    const T = "CantonMUSD_Split";
    assertPositiveMoney(args.splitAmount, T, "splitAmount");
}
// ============================================================
//  Registry Maps
// ============================================================
/** Map of template short name → create payload validator */
const CREATE_VALIDATORS = {
    BridgeInRequest: validateBridgeInRequest,
    BridgeOutRequest: validateBridgeOutRequestV3,
    CantonMUSD: validateCantonMUSD,
    AttestationRequest: validateAttestationRequest,
    RedemptionRequest: validateRedemptionRequest,
    StandaloneBridgeOutRequest: validateStandaloneBridgeOutRequest,
};
/** Map of choice name → argument validator */
const EXERCISE_VALIDATORS = {
    CantonMUSD_Transfer: validateCantonMUSD_Transfer,
    BridgeIn_Complete: validateBridgeIn_Complete,
    BridgeOut_Complete: validateBridgeOut_Complete,
    ReceiveYield: validateReceiveYield,
    CantonMUSD_Split: validateCantonMUSD_Split,
    BridgeIn_Cancel: () => { }, // No arguments needed
    BridgeOut_Cancel: () => { }, // No arguments needed
    CantonMUSD_Burn: () => { }, // No arguments needed
};
// ============================================================
//  Public API
// ============================================================
/**
 * Validate a create payload against the DAML template schema.
 *
 * @param templateName  Short template name (e.g., "BridgeInRequest", "CantonMUSD")
 * @param payload       The create arguments to validate
 * @throws DamlValidationError if validation fails
 *
 * Usage:
 *   validateCreatePayload("BridgeInRequest", payload);
 */
function validateCreatePayload(templateName, payload) {
    const validator = CREATE_VALIDATORS[templateName];
    if (!validator) {
        // Unknown template — skip validation (don't block unknown templates)
        console.warn(`[DamlValidator] No schema registered for template "${templateName}" — skipping validation`);
        return;
    }
    validator(payload);
}
exports.validateCreatePayload = validateCreatePayload;
/**
 * Validate choice exercise arguments against the DAML choice schema.
 *
 * @param choiceName  Choice name (e.g., "CantonMUSD_Transfer", "BridgeIn_Complete")
 * @param args        The choice arguments to validate
 * @throws DamlValidationError if validation fails
 *
 * Usage:
 *   validateExerciseArgs("CantonMUSD_Transfer", { newOwner, complianceRegistryCid });
 */
function validateExerciseArgs(choiceName, args) {
    const validator = EXERCISE_VALIDATORS[choiceName];
    if (!validator) {
        // Unknown choice — skip validation
        console.warn(`[DamlValidator] No schema registered for choice "${choiceName}" — skipping validation`);
        return;
    }
    validator(args);
}
exports.validateExerciseArgs = validateExerciseArgs;
/**
 * Wrap a Canton client's createContract method with automatic schema validation.
 *
 * @param templateName    Short template name
 * @param payload         Create arguments
 * @param submitFn        Actual create function to call if validation passes
 * @returns The result of submitFn
 */
async function validatedCreate(templateName, payload, submitFn) {
    validateCreatePayload(templateName, payload);
    return submitFn();
}
exports.validatedCreate = validatedCreate;
/**
 * Wrap a Canton client's exerciseChoice method with automatic schema validation.
 *
 * @param choiceName      Choice name
 * @param args            Choice arguments
 * @param submitFn        Actual exercise function to call if validation passes
 * @returns The result of submitFn
 */
async function validatedExercise(choiceName, args, submitFn) {
    validateExerciseArgs(choiceName, args);
    return submitFn();
}
exports.validatedExercise = validatedExercise;
// ============================================================
//  Convenience: get all registered template/choice names
// ============================================================
function getRegisteredTemplates() {
    return Object.keys(CREATE_VALIDATORS);
}
exports.getRegisteredTemplates = getRegisteredTemplates;
function getRegisteredChoices() {
    return Object.keys(EXERCISE_VALIDATORS);
}
exports.getRegisteredChoices = getRegisteredChoices;
//# sourceMappingURL=daml-schema-validator.js.map