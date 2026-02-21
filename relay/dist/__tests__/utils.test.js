"use strict";
/**
 * Unit tests for relay/utils.ts
 * Tests secret reading, secp256k1 key validation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("../utils");
// ═══════════════════════════════════════════════
// isValidSecp256k1PrivateKey
// ═══════════════════════════════════════════════
describe("isValidSecp256k1PrivateKey", () => {
    const VALID_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    it("should accept a valid 64-hex-char key", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)(VALID_KEY)).toBe(true);
    });
    it("should accept a valid key with 0x prefix", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)("0x" + VALID_KEY)).toBe(true);
    });
    it("should reject zero key", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)("0".repeat(64))).toBe(false);
    });
    it("should reject key >= curve order", () => {
        // secp256k1 curve order n
        const n = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";
        expect((0, utils_1.isValidSecp256k1PrivateKey)(n)).toBe(false);
    });
    it("should reject key above curve order", () => {
        // n+1
        const nPlus1 = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364142";
        expect((0, utils_1.isValidSecp256k1PrivateKey)(nPlus1)).toBe(false);
    });
    it("should accept n-1 (maximum valid key)", () => {
        const nMinus1 = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140";
        expect((0, utils_1.isValidSecp256k1PrivateKey)(nMinus1)).toBe(true);
    });
    it("should reject short keys", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)("abcd")).toBe(false);
    });
    it("should reject non-hex characters", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)("zz" + "a".repeat(62))).toBe(false);
    });
    it("should reject empty string", () => {
        expect((0, utils_1.isValidSecp256k1PrivateKey)("")).toBe(false);
    });
    it("should accept key = 1 (minimum valid)", () => {
        const one = "0".repeat(63) + "1";
        expect((0, utils_1.isValidSecp256k1PrivateKey)(one)).toBe(true);
    });
});
// ═══════════════════════════════════════════════
// readSecret
// ═══════════════════════════════════════════════
describe("readSecret", () => {
    const ORIGINAL_ENV = process.env;
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });
    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });
    it("should fall back to env var when /run/secrets/ doesn't exist", () => {
        process.env.TEST_SECRET = "my_secret_value";
        const result = (0, utils_1.readSecret)("nonexistent_secret", "TEST_SECRET");
        expect(result).toBe("my_secret_value");
    });
    it("should return empty string when neither secret nor env var exists", () => {
        delete process.env.MISSING_VAR;
        const result = (0, utils_1.readSecret)("nonexistent", "MISSING_VAR");
        expect(result).toBe("");
    });
});
// ═══════════════════════════════════════════════
// readAndValidatePrivateKey
// ═══════════════════════════════════════════════
describe("readAndValidatePrivateKey", () => {
    const ORIGINAL_ENV = process.env;
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });
    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });
    it("should return a valid key from env", () => {
        const validKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        process.env.PK_TEST = validKey;
        expect((0, utils_1.readAndValidatePrivateKey)("missing", "PK_TEST")).toBe(validKey);
    });
    it("should throw for invalid key from env", () => {
        process.env.PK_INVALID = "0".repeat(64); // zero key
        expect(() => (0, utils_1.readAndValidatePrivateKey)("missing", "PK_INVALID")).toThrow("SECURITY");
    });
    it("should return empty string when key is missing", () => {
        delete process.env.PK_EMPTY;
        expect((0, utils_1.readAndValidatePrivateKey)("missing", "PK_EMPTY")).toBe("");
    });
});
//# sourceMappingURL=utils.test.js.map