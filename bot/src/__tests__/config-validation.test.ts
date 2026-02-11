/**
 * Bot Configuration & Security Tests
 * FIX INFRA: Validates secret management, key formats, and timeout configs
 */

import * as fs from "fs";
import * as path from "path";

describe("Bot Configuration Security", () => {
  describe("readSecret pattern", () => {
    // Verify all bot entry points use readSecret for private keys
    const botFiles = ["index.ts", "pendle-sniper.ts"];

    for (const file of botFiles) {
      it(`${file} should use readSecret for private key`, () => {
        const content = fs.readFileSync(
          path.join(__dirname, "..", file),
          "utf-8"
        );
        expect(content).toContain("readSecret");
        // Should NOT have bare process.env.PRIVATE_KEY without Docker secret fallback
        expect(content).not.toMatch(
          /privateKey\s*[:=]\s*process\.env\.PRIVATE_KEY(?!\s*\|\|)/
        );
      });
    }
  });

  describe("RPC timeout configuration", () => {
    const providerFiles = ["index.ts", "pendle-sniper.ts", "pool-alerts.ts"];

    for (const file of providerFiles) {
      it(`${file} should configure RPC timeout via FetchRequest`, () => {
        const content = fs.readFileSync(
          path.join(__dirname, "..", file),
          "utf-8"
        );
        expect(content).toContain("FetchRequest");
        expect(content).toContain("timeout");
      });
    }
  });

  describe("WebSocket reconnect guard", () => {
    const wsFiles = ["pendle-sniper.ts", "pool-alerts.ts"];

    for (const file of wsFiles) {
      it(`${file} should have reconnect guard`, () => {
        const content = fs.readFileSync(
          path.join(__dirname, "..", file),
          "utf-8"
        );
        expect(content).toContain("isReconnecting");
        expect(content).toContain("removeAllListeners");
        expect(content).toContain("destroy");
      });
    }
  });

  describe("private key validation", () => {
    it("index.ts should validate private key format on startup", () => {
      const content = fs.readFileSync(
        path.join(__dirname, "..", "index.ts"),
        "utf-8"
      );
      // Should have hex format validation
      expect(content).toMatch(/[0-9a-fA-F]{64}/);
      expect(content).toContain("process.exit");
    });
  });

  describe("no hardcoded secrets", () => {
    const allBotFiles = fs
      .readdirSync(path.join(__dirname, ".."))
      .filter((f) => f.endsWith(".ts") && !f.includes("test"));

    for (const file of allBotFiles) {
      it(`${file} should not contain hardcoded private keys`, () => {
        const content = fs.readFileSync(
          path.join(__dirname, "..", file),
          "utf-8"
        );
        // Should not have actual private key hex strings (64+ hex chars)
        const matches = content.match(/["']0x[0-9a-fA-F]{64,}["']/g) || [];
        // Filter out contract addresses (40 hex chars) and known test patterns
        const realKeys = matches.filter(
          (m) => m.replace(/['"0x]/g, "").length >= 64
        );
        expect(realKeys).toHaveLength(0);
      });
    }
  });
});
