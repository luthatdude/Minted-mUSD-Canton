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
export declare class DamlValidationError extends Error {
    readonly templateName: string;
    readonly field: string;
    readonly reason: string;
    readonly payload?: unknown;
    constructor(templateName: string, field: string, reason: string, payload?: unknown);
}
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
export declare function validateCreatePayload(templateName: string, payload: Record<string, unknown>): void;
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
export declare function validateExerciseArgs(choiceName: string, args: Record<string, unknown>): void;
/**
 * Wrap a Canton client's createContract method with automatic schema validation.
 *
 * @param templateName    Short template name
 * @param payload         Create arguments
 * @param submitFn        Actual create function to call if validation passes
 * @returns The result of submitFn
 */
export declare function validatedCreate<T>(templateName: string, payload: Record<string, unknown>, submitFn: () => Promise<T>): Promise<T>;
/**
 * Wrap a Canton client's exerciseChoice method with automatic schema validation.
 *
 * @param choiceName      Choice name
 * @param args            Choice arguments
 * @param submitFn        Actual exercise function to call if validation passes
 * @returns The result of submitFn
 */
export declare function validatedExercise<T>(choiceName: string, args: Record<string, unknown>, submitFn: () => Promise<T>): Promise<T>;
export declare function getRegisteredTemplates(): string[];
export declare function getRegisteredChoices(): string[];
//# sourceMappingURL=daml-schema-validator.d.ts.map