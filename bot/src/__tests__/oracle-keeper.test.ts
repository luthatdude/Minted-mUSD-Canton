/**
 * Oracle Keeper Unit Tests
 * Tests PriceOracle circuit breaker keeper logic
 */

import {
  OracleKeeperConfig,
  DEFAULT_KEEPER_CONFIG,
  shouldResetCircuitBreaker,
} from "../oracle-keeper";

describe("OracleKeeper", () => {
  describe("DEFAULT_KEEPER_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_KEEPER_CONFIG.pollIntervalMs).toBeGreaterThan(0);
      expect(DEFAULT_KEEPER_CONFIG.maxStalenessSeconds).toBeGreaterThan(0);
      expect(DEFAULT_KEEPER_CONFIG.maxDeviationBps).toBeGreaterThan(0);
      expect(DEFAULT_KEEPER_CONFIG.maxDeviationBps).toBeLessThan(10000);
    });
  });

  describe("shouldResetCircuitBreaker", () => {
    it("should return true when oracle is stale beyond threshold", () => {
      const now = Math.floor(Date.now() / 1000);
      const lastUpdate = now - 700; // 700 seconds stale
      expect(
        shouldResetCircuitBreaker(lastUpdate, now, 600)
      ).toBe(true);
    });

    it("should return false when oracle is fresh", () => {
      const now = Math.floor(Date.now() / 1000);
      const lastUpdate = now - 100; // 100 seconds, well within 600
      expect(
        shouldResetCircuitBreaker(lastUpdate, now, 600)
      ).toBe(false);
    });

    it("should return false when exactly at threshold", () => {
      const now = Math.floor(Date.now() / 1000);
      const lastUpdate = now - 600;
      expect(
        shouldResetCircuitBreaker(lastUpdate, now, 600)
      ).toBe(false);
    });

    it("should handle zero lastUpdate", () => {
      const now = Math.floor(Date.now() / 1000);
      expect(
        shouldResetCircuitBreaker(0, now, 600)
      ).toBe(true);
    });
  });
});
