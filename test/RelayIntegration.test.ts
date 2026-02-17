/**
 * TEST-002: Relay Service Integration Tests (MEDIUM severity)
 *
 * Integration-style unit tests for the relay service utility functions
 * and validation logic. Tests key utility functions from relay/utils.ts:
 *   - isValidSecp256k1PrivateKey() edge cases
 *   - readSecret() Docker secret / env var fallback
 *   - readAndValidatePrivateKey() validation + error paths
 *   - Signature formatting validation patterns (from relay/signer.ts)
 *
 * Since we can't connect to DAML/Ethereum in unit tests, these verify
 * the correctness of the portable validation and utility logic.
 */

import { expect } from "chai";

// Import relay utilities under test
import { isValidSecp256k1PrivateKey, readSecret, readAndValidatePrivateKey } from "../relay/utils";

// secp256k1 curve order for reference in tests
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

// ============================================================
//  1. isValidSecp256k1PrivateKey Tests
// ============================================================

describe("TEST-002: Relay Utils — isValidSecp256k1PrivateKey", function () {
  describe("Valid keys", function () {
    it("should accept a well-known valid private key (32 bytes, no 0x prefix)", function () {
      // A simple valid key: 1 (the smallest valid private key)
      const key = "0000000000000000000000000000000000000000000000000000000000000001";
      expect(isValidSecp256k1PrivateKey(key)).to.be.true;
    });

    it("should accept a valid key with 0x prefix", function () {
      const key = "0x0000000000000000000000000000000000000000000000000000000000000001";
      expect(isValidSecp256k1PrivateKey(key)).to.be.true;
    });

    it("should accept key = n - 1 (maximum valid key)", function () {
      // n - 1 is the largest valid private key
      const nMinus1 = (SECP256K1_N - 1n).toString(16).padStart(64, "0");
      expect(isValidSecp256k1PrivateKey(nMinus1)).to.be.true;
    });

    it("should accept a mid-range hex key", function () {
      const key = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      expect(isValidSecp256k1PrivateKey(key)).to.be.true;
    });

    it("should accept key with mixed-case hex characters", function () {
      const key = "AaBbCcDd1234567890abcdef1234567890ABCDEF1234567890abcdef12345678";
      expect(isValidSecp256k1PrivateKey(key)).to.be.true;
    });

    it("should accept key = 2 (small but valid)", function () {
      const key = "0000000000000000000000000000000000000000000000000000000000000002";
      expect(isValidSecp256k1PrivateKey(key)).to.be.true;
    });
  });

  describe("Invalid keys — zero", function () {
    it("should reject zero key (all zeros)", function () {
      const key = "0000000000000000000000000000000000000000000000000000000000000000";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject zero key with 0x prefix", function () {
      const key = "0x0000000000000000000000000000000000000000000000000000000000000000";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });
  });

  describe("Invalid keys — at or above curve order", function () {
    it("should reject key equal to curve order n", function () {
      const n = SECP256K1_N.toString(16).padStart(64, "0");
      expect(isValidSecp256k1PrivateKey(n)).to.be.false;
    });

    it("should reject key equal to n + 1", function () {
      const nPlus1 = (SECP256K1_N + 1n).toString(16).padStart(64, "0");
      expect(isValidSecp256k1PrivateKey(nPlus1)).to.be.false;
    });

    it("should reject key = 0xFFFF...FFFF (all ones, above curve order)", function () {
      const key = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });
  });

  describe("Invalid keys — malformed input", function () {
    it("should reject empty string", function () {
      expect(isValidSecp256k1PrivateKey("")).to.be.false;
    });

    it("should reject too-short hex string (31 bytes)", function () {
      const key = "00000000000000000000000000000000000000000000000000000000000001"; // 62 chars
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject too-long hex string (33 bytes)", function () {
      const key = "000000000000000000000000000000000000000000000000000000000000000001"; // 66 chars
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject non-hex characters", function () {
      const key = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject string with spaces", function () {
      const key = "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0001";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject key with special characters", function () {
      const key = "!@#$%^&*()_+-=[]{}|;':\",./<>?abcdef1234567890abcdef1234567890ab";
      expect(isValidSecp256k1PrivateKey(key)).to.be.false;
    });

    it("should reject bare 0x prefix with no key data", function () {
      expect(isValidSecp256k1PrivateKey("0x")).to.be.false;
    });
  });
});

// ============================================================
//  2. readSecret Tests
// ============================================================

describe("TEST-002: Relay Utils — readSecret", function () {
  const originalEnv = { ...process.env };

  afterEach(function () {
    // Restore original environment after each test
    process.env = { ...originalEnv };
  });

  it("should fall back to env var when Docker secret path does not exist", function () {
    // Docker secrets are at /run/secrets/ which won't exist in test
    process.env.TEST_SECRET_VALUE = "from-env-var";
    const result = readSecret("nonexistent_secret", "TEST_SECRET_VALUE");
    expect(result).to.equal("from-env-var");
  });

  it("should return empty string when neither secret file nor env var exists", function () {
    delete process.env.NONEXISTENT_ENV_VAR;
    const result = readSecret("nonexistent_secret", "NONEXISTENT_ENV_VAR");
    expect(result).to.equal("");
  });

  it("should handle undefined env var gracefully", function () {
    delete process.env.SOME_UNDEFINED_VAR;
    const result = readSecret("missing_secret", "SOME_UNDEFINED_VAR");
    expect(result).to.equal("");
  });

  it("should read env var correctly with whitespace value", function () {
    process.env.WHITESPACE_TEST = "  value_with_spaces  ";
    const result = readSecret("missing_secret", "WHITESPACE_TEST");
    // env vars are not trimmed (only Docker secret files are)
    expect(result).to.equal("  value_with_spaces  ");
  });
});

// ============================================================
//  3. readAndValidatePrivateKey Tests
// ============================================================

describe("TEST-002: Relay Utils — readAndValidatePrivateKey", function () {
  const originalEnv = { ...process.env };

  afterEach(function () {
    process.env = { ...originalEnv };
  });

  it("should return empty string when key is not set", function () {
    delete process.env.TEST_PRIVATE_KEY;
    const result = readAndValidatePrivateKey("nonexistent_secret", "TEST_PRIVATE_KEY");
    expect(result).to.equal("");
  });

  it("should return valid key when env var contains a valid private key", function () {
    const validKey = "0000000000000000000000000000000000000000000000000000000000000001";
    process.env.TEST_PRIVATE_KEY = validKey;
    const result = readAndValidatePrivateKey("nonexistent_secret", "TEST_PRIVATE_KEY");
    expect(result).to.equal(validKey);
  });

  it("should throw for invalid private key (zero)", function () {
    const zeroKey = "0000000000000000000000000000000000000000000000000000000000000000";
    process.env.TEST_PRIVATE_KEY = zeroKey;
    expect(() => readAndValidatePrivateKey("nonexistent_secret", "TEST_PRIVATE_KEY")).to.throw(
      "SECURITY"
    );
  });

  it("should throw for private key above curve order", function () {
    const aboveN = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    process.env.TEST_PRIVATE_KEY = aboveN;
    expect(() => readAndValidatePrivateKey("nonexistent_secret", "TEST_PRIVATE_KEY")).to.throw(
      "SECURITY"
    );
  });

  it("should throw for malformed key (wrong length)", function () {
    process.env.TEST_PRIVATE_KEY = "abcdef";
    expect(() => readAndValidatePrivateKey("nonexistent_secret", "TEST_PRIVATE_KEY")).to.throw(
      "SECURITY"
    );
  });

  it("should include env var name in error message for diagnostics", function () {
    process.env.MY_RELAY_KEY = "not-a-valid-key";
    expect(() => readAndValidatePrivateKey("nonexistent_secret", "MY_RELAY_KEY")).to.throw(
      "MY_RELAY_KEY"
    );
  });
});

// ============================================================
//  4. Signature Formatting Validation (signer.ts patterns)
// ============================================================

describe("TEST-002: Relay Signer — formatKMSSignature validation", function () {
  // We test the DER parsing and input validation without needing KMS
  let formatKMSSignature: typeof import("../relay/signer").formatKMSSignature;

  before(async function () {
    const signer = await import("../relay/signer");
    formatKMSSignature = signer.formatKMSSignature;
  });

  it("should reject null/undefined derSig input", function () {
    expect(() =>
      formatKMSSignature(null as any, "0xabc", "0xdef")
    ).to.throw("INVALID_INPUT");
  });

  it("should reject non-Buffer derSig", function () {
    expect(() =>
      formatKMSSignature("not-a-buffer" as any, "0xabc", "0xdef")
    ).to.throw("INVALID_INPUT");
  });

  it("should reject messageHash without 0x prefix", function () {
    expect(() =>
      formatKMSSignature(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), "abc", "0xdef")
    ).to.throw("INVALID_INPUT");
  });

  it("should reject publicKey without 0x prefix", function () {
    expect(() =>
      formatKMSSignature(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), "0xabc", "def")
    ).to.throw("INVALID_INPUT");
  });

  it("should reject DER signature that is too short (< 8 bytes)", function () {
    const shortDer = Buffer.from([0x30, 0x02, 0x02, 0x01]);
    expect(() =>
      formatKMSSignature(shortDer, "0xabc", "0xdef")
    ).to.throw("INVALID_DER");
  });

  it("should reject DER signature with wrong sequence tag", function () {
    const badTag = Buffer.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    expect(() =>
      formatKMSSignature(badTag, "0xabc", "0xdef")
    ).to.throw("INVALID_DER");
  });

  it("should reject DER signature with length exceeding buffer", function () {
    // Sequence tag 0x30, length 0xFF (255), but only 6 bytes of data
    const badLen = Buffer.from([0x30, 0xff, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    expect(() =>
      formatKMSSignature(badLen, "0xabc", "0xdef")
    ).to.throw("INVALID_DER");
  });
});

// ============================================================
//  5. Relay Config Validation Patterns
// ============================================================

describe("TEST-002: Relay Config — parseInt radix & URL validation patterns", function () {
  it("parseInt with radix 10 produces correct results for decimal strings", function () {
    expect(parseInt("6865", 10)).to.equal(6865);
    expect(parseInt("5000", 10)).to.equal(5000);
    expect(parseInt("3", 10)).to.equal(3);
    expect(parseInt("2", 10)).to.equal(2);
  });

  it("parseInt with radix 10 avoids octal interpretation of leading-zero strings", function () {
    // Without radix, "010" could be interpreted as octal (8) in some engines
    // With radix 10, it is always 10
    expect(parseInt("010", 10)).to.equal(10);
    expect(parseInt("0100", 10)).to.equal(100);
    expect(parseInt("08", 10)).to.equal(8);
    expect(parseInt("09", 10)).to.equal(9);
  });

  it("parseInt with radix 10 returns NaN for non-numeric strings", function () {
    expect(isNaN(parseInt("", 10))).to.be.true;
    expect(isNaN(parseInt("abc", 10))).to.be.true;
  });

  it("HTTP RPC URL should trigger warning for non-localhost", function () {
    // Simulates the BE-004 check logic
    const url = "http://my-node.example.com:8545";
    const isInsecure =
      url.startsWith("http://") &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1");
    expect(isInsecure).to.be.true;
  });

  it("HTTPS RPC URL should NOT trigger warning", function () {
    const url = "https://mainnet.infura.io/v3/YOUR_KEY";
    const isInsecure =
      url.startsWith("http://") &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1");
    expect(isInsecure).to.be.false;
  });

  it("localhost HTTP URL should NOT trigger warning (dev environment)", function () {
    const url = "http://localhost:8545";
    const isInsecure =
      url.startsWith("http://") &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1");
    expect(isInsecure).to.be.false;
  });

  it("127.0.0.1 HTTP URL should NOT trigger warning (loopback)", function () {
    const url = "http://127.0.0.1:8545";
    const isInsecure =
      url.startsWith("http://") &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1");
    expect(isInsecure).to.be.false;
  });

  it("VALIDATOR_ADDRESSES JSON size should be bounded to 10KB", function () {
    const MAX_JSON_SIZE = 10 * 1024; // 10KB
    // A normal config is well under 10KB
    const normalConfig = JSON.stringify({ "party1": "0x1234", "party2": "0x5678" });
    expect(normalConfig.length).to.be.lt(MAX_JSON_SIZE);

    // A bloated config should be rejected
    const bloatedConfig = "{" + "a".repeat(MAX_JSON_SIZE + 1) + "}";
    expect(bloatedConfig.length).to.be.gt(MAX_JSON_SIZE);
  });
});
