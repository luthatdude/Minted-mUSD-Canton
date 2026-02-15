/**
 * Strategy Rebalance Keeper — Unit Tests
 * Tests pure decision logic for LTV drift, emergency detection, gas gating, compounding
 */

import {
  DEFAULT_REBALANCE_CONFIG,
  shouldRebalance,
  isEmergency,
  isGasTooHigh,
  isCompoundDue,
} from "../strategy-rebalance-keeper";

describe("StrategyRebalanceKeeper", () => {

  // ============================================================
  //  Config defaults
  // ============================================================

  describe("DEFAULT_REBALANCE_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_REBALANCE_CONFIG.pollIntervalMs).toBeGreaterThanOrEqual(10_000);
      expect(DEFAULT_REBALANCE_CONFIG.maxGasGwei).toBeGreaterThan(0);
      expect(DEFAULT_REBALANCE_CONFIG.compoundIntervalHours).toBeGreaterThan(0);
      expect(DEFAULT_REBALANCE_CONFIG.emergencyHfThreshold).toBeGreaterThan(0n);
    });

    it("should default to Flashbots disabled", () => {
      expect(DEFAULT_REBALANCE_CONFIG.useFlashbots).toBe(false);
    });
  });

  // ============================================================
  //  shouldRebalance
  // ============================================================

  describe("shouldRebalance", () => {
    const target = 9000n;  // 90% LTV
    const buffer = 200n;   // 2% buffer

    it("should return 'over' when LTV exceeds target + buffer", () => {
      // 9201bps > 9000 + 200 = 9200
      expect(shouldRebalance(9201n, target, buffer)).toBe("over");
    });

    it("should return 'under' when LTV is below target - buffer", () => {
      // 8799bps < 9000 - 200 = 8800
      expect(shouldRebalance(8799n, target, buffer)).toBe("under");
    });

    it("should return null when within buffer (high side)", () => {
      // 9200bps = exactly at target + buffer boundary
      expect(shouldRebalance(9200n, target, buffer)).toBe(null);
    });

    it("should return null when within buffer (low side)", () => {
      // 8800bps = exactly at target - buffer boundary
      expect(shouldRebalance(8800n, target, buffer)).toBe(null);
    });

    it("should return null when exactly at target", () => {
      expect(shouldRebalance(target, target, buffer)).toBe(null);
    });

    it("should handle zero LTV (no position)", () => {
      // 0 < 9000 - 200 = 8800 → under
      expect(shouldRebalance(0n, target, buffer)).toBe("under");
    });

    it("should not underflow when target < buffer", () => {
      // target=100, buffer=200 → target-buffer would underflow
      // 0n < 100n - 200n → but we guard: targetLtvBps > safetyBufferBps
      expect(shouldRebalance(0n, 100n, 200n)).toBe(null);
    });

    it("should return 'over' for extreme over-leverage", () => {
      expect(shouldRebalance(9900n, 9000n, 200n)).toBe("over");
    });
  });

  // ============================================================
  //  isEmergency
  // ============================================================

  describe("isEmergency", () => {
    const threshold = 1_050_000_000_000_000_000n; // 1.05e18

    it("should return true when HF is below threshold", () => {
      expect(isEmergency(1_020_000_000_000_000_000n, threshold)).toBe(true);
    });

    it("should return false when HF is above threshold", () => {
      expect(isEmergency(1_100_000_000_000_000_000n, threshold)).toBe(false);
    });

    it("should return false when HF equals threshold", () => {
      expect(isEmergency(threshold, threshold)).toBe(false);
    });

    it("should return false when HF is zero (no position)", () => {
      // HF = 0 means no debt → type(uint256).max on-chain → safe
      expect(isEmergency(0n, threshold)).toBe(false);
    });

    it("should return true when HF is just barely below 1.0", () => {
      const nearOne = 999_000_000_000_000_000n; // 0.999e18
      expect(isEmergency(nearOne, threshold)).toBe(true);
    });
  });

  // ============================================================
  //  isGasTooHigh
  // ============================================================

  describe("isGasTooHigh", () => {
    it("should return true when gas exceeds max", () => {
      expect(isGasTooHigh(50, 30)).toBe(true);
    });

    it("should return false when gas is below max", () => {
      expect(isGasTooHigh(15, 30)).toBe(false);
    });

    it("should return false when gas equals max", () => {
      expect(isGasTooHigh(30, 30)).toBe(false);
    });

    it("should return false when maxGasGwei is 0 (no limit)", () => {
      expect(isGasTooHigh(999, 0)).toBe(false);
    });

    it("should return false when maxGasGwei is negative (no limit)", () => {
      expect(isGasTooHigh(999, -1)).toBe(false);
    });
  });

  // ============================================================
  //  isCompoundDue
  // ============================================================

  describe("isCompoundDue", () => {
    const interval = 24; // hours

    it("should return true when enough time has passed", () => {
      const now = Date.now();
      const lastCompound = now - 25 * 3600 * 1000; // 25 hours ago
      expect(isCompoundDue(now, lastCompound, interval)).toBe(true);
    });

    it("should return false when not enough time has passed", () => {
      const now = Date.now();
      const lastCompound = now - 20 * 3600 * 1000; // 20 hours ago
      expect(isCompoundDue(now, lastCompound, interval)).toBe(false);
    });

    it("should return true when lastCompound is 0 (never compounded)", () => {
      expect(isCompoundDue(Date.now(), 0, interval)).toBe(true);
    });

    it("should return true when exactly at boundary", () => {
      const now = Date.now();
      const lastCompound = now - 24 * 3600 * 1000; // exactly 24 hours
      expect(isCompoundDue(now, lastCompound, interval)).toBe(true);
    });

    it("should handle 1-hour interval", () => {
      const now = Date.now();
      const lastCompound = now - 2 * 3600 * 1000;
      expect(isCompoundDue(now, lastCompound, 1)).toBe(true);
    });
  });
});
