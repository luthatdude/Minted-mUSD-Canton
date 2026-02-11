/**
 * Canton Ledger API Integration — Boost Pool & Canton Coin Operations
 *
 * Provides typed hooks for the frontend to interact with Canton DAML templates:
 *   - CantonBoostPool (deposit/withdraw Canton coin, claim rewards)
 *   - CantonCoin (transfer, split, merge, balance queries)
 *   - CantonBPPosition (position queries, boosted APY)
 *
 * Uses the existing useCanton() hook for raw ledger access and
 * useLoopWallet() for Loop SDK session management.
 */

import { useState, useCallback, useEffect } from "react";
import { useCanton } from "./useCanton";
import { useLoopWallet } from "./useLoopWallet";

// ═══════════════════════════════════════════════════════════════
// DAML Template IDs
// ═══════════════════════════════════════════════════════════════

const TEMPLATES = {
  CANTON_COIN: "CantonBoostPool:CantonCoin",
  BOOST_POOL: "CantonBoostPool:CantonBoostPool",
  BP_POSITION: "CantonBoostPool:CantonBPPosition",
  BP_DEPOSIT_REQ: "CantonBoostPool:BPDepositRequest",
  BP_WITHDRAW_REQ: "CantonBoostPool:BPWithdrawRequest",
  CANTON_SMUSD: "CantonSMUSD:CantonSMUSD",
  CANTON_MUSD: "CantonDirectMint:CantonMUSD",
} as const;

// ═══════════════════════════════════════════════════════════════
// Types — Mirror DAML contract payloads
// ═══════════════════════════════════════════════════════════════

export interface CantonCoinHolding {
  contractId: string;
  amount: number;
  issuer: string;
  owner: string;
}

export interface BoostPoolInfo {
  contractId: string;
  operator: string;
  totalDeposits: number;
  totalRewardsDistributed: number;
  rewardRate: number;
  entryFeeBps: number;
  exitFeeBps: number;
  paused: boolean;
  maxLtvBps: number;
}

export interface BPPosition {
  contractId: string;
  user: string;
  depositedCanton: number;
  depositTimestamp: string;
  accumulatedRewards: number;
  smusdContractId: string;
  smusdValue: number;
  maxCantonAllowed: number;
  boostedAPY: number;
}

export interface CantonSMUSDPosition {
  contractId: string;
  owner: string;
  shares: number;
  entrySharePrice: number;
  stakedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// Hook: useCantonBoostPool
// ═══════════════════════════════════════════════════════════════

export function useCantonBoostPool() {
  const canton = useCanton();
  const loop = useLoopWallet();

  const [pool, setPool] = useState<BoostPoolInfo | null>(null);
  const [position, setPosition] = useState<BPPosition | null>(null);
  const [cantonBalance, setCantonBalance] = useState<CantonCoinHolding[]>([]);
  const [smusdPositions, setSmusdPositions] = useState<CantonSMUSDPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Query Canton Coin balance ──────────────────────────────
  const refreshCantonCoins = useCallback(async () => {
    if (!canton.connected || !canton.party) return;
    try {
      const contracts = await canton.query(TEMPLATES.CANTON_COIN, {
        owner: canton.party,
      });
      setCantonBalance(
        contracts.map((c) => ({
          contractId: c.contractId,
          amount: Number(c.payload.amount || 0),
          issuer: String(c.payload.issuer || ""),
          owner: String(c.payload.owner || ""),
        }))
      );
    } catch (e) {
      setError("Failed to fetch Canton coin balance");
    }
  }, [canton]);

  // ─── Query Boost Pool state ─────────────────────────────────
  const refreshPool = useCallback(async () => {
    if (!canton.connected) return;
    try {
      const contracts = await canton.query(TEMPLATES.BOOST_POOL);
      if (contracts.length > 0) {
        const p = contracts[0].payload;
        setPool({
          contractId: contracts[0].contractId,
          operator: String(p.operator || ""),
          totalDeposits: Number(p.totalDeposits || 0),
          totalRewardsDistributed: Number(p.totalRewardsDistributed || 0),
          rewardRate: Number(p.rewardRate || 0),
          entryFeeBps: Number(p.entryFeeBps || 25),
          exitFeeBps: Number(p.exitFeeBps || 25),
          paused: Boolean(p.paused),
          maxLtvBps: Number(p.maxLtvBps || 2500), // 25% cap
        });
      }
    } catch (e) {
      setError("Failed to fetch pool info");
    }
  }, [canton]);

  // ─── Query user position ────────────────────────────────────
  const refreshPosition = useCallback(async () => {
    if (!canton.connected || !canton.party) return;
    try {
      const contracts = await canton.query(TEMPLATES.BP_POSITION, {
        user: canton.party,
      });
      if (contracts.length > 0) {
        const p = contracts[0].payload;
        setPosition({
          contractId: contracts[0].contractId,
          user: String(p.user || ""),
          depositedCanton: Number(p.depositedCanton || 0),
          depositTimestamp: String(p.depositTimestamp || ""),
          accumulatedRewards: Number(p.accumulatedRewards || 0),
          smusdContractId: String(p.smusdContractId || ""),
          smusdValue: Number(p.smusdValue || 0),
          maxCantonAllowed: Number(p.maxCantonAllowed || 0),
          boostedAPY: Number(p.boostedAPY || 0),
        });
      } else {
        setPosition(null);
      }
    } catch (e) {
      setError("Failed to fetch position");
    }
  }, [canton]);

  // ─── Query sMUSD positions ──────────────────────────────────
  const refreshSMUSD = useCallback(async () => {
    if (!canton.connected || !canton.party) return;
    try {
      const contracts = await canton.query(TEMPLATES.CANTON_SMUSD, {
        owner: canton.party,
      });
      setSmusdPositions(
        contracts.map((c) => ({
          contractId: c.contractId,
          owner: String(c.payload.owner || ""),
          shares: Number(c.payload.shares || 0),
          entrySharePrice: Number(c.payload.entrySharePrice || 1),
          stakedAt: String(c.payload.stakedAt || ""),
        }))
      );
    } catch (e) {
      setError("Failed to fetch sMUSD positions");
    }
  }, [canton]);

  // ─── Load all data ──────────────────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([
      refreshPool(),
      refreshCantonCoins(),
      refreshPosition(),
      refreshSMUSD(),
    ]);
    setLoading(false);
  }, [refreshPool, refreshCantonCoins, refreshPosition, refreshSMUSD]);

  // Auto-refresh on connection
  useEffect(() => {
    if (canton.connected) {
      refresh();
    }
  }, [canton.connected, refresh]);

  // ═════════════════════════════════════════════════════════════
  // ACTIONS
  // ═════════════════════════════════════════════════════════════

  /**
   * Deposit Canton coin into the Boost Pool.
   * Requires: user has sMUSD position, amount ≤ maxCantonAllowed
   */
  const deposit = useCallback(
    async (cantonCoinContractId: string, amount: number, smusdContractId: string) => {
      if (!pool) throw new Error("Pool not loaded");

      // Use Loop SDK for transaction signing if available
      if (loop.provider) {
        await loop.exerciseChoice(
          TEMPLATES.BOOST_POOL,
          pool.contractId,
          "BPPool_RequestDeposit",
          {
            user: canton.party,
            cantonCoinCid: cantonCoinContractId,
            amount: amount.toString(),
            smusdCid: smusdContractId,
          }
        );
      } else {
        // Fallback to raw Canton API
        await canton.exercise(
          TEMPLATES.BOOST_POOL,
          pool.contractId,
          "BPPool_RequestDeposit",
          {
            user: canton.party,
            cantonCoinCid: cantonCoinContractId,
            amount: amount.toString(),
            smusdCid: smusdContractId,
          }
        );
      }

      await refresh();
    },
    [pool, loop, canton, refresh]
  );

  /**
   * Withdraw Canton coin from the Boost Pool.
   */
  const withdraw = useCallback(
    async (amount: number) => {
      if (!position) throw new Error("No position found");

      const exerciseFn = loop.provider
        ? loop.exerciseChoice.bind(loop)
        : canton.exercise.bind(canton);

      await exerciseFn(
        TEMPLATES.BP_POSITION,
        position.contractId,
        "BPPosition_Withdraw",
        { amount: amount.toString() }
      );

      await refresh();
    },
    [position, loop, canton, refresh]
  );

  /**
   * Claim accumulated validator rewards.
   */
  const claimRewards = useCallback(async () => {
    if (!position) throw new Error("No position found");

    const exerciseFn = loop.provider
      ? loop.exerciseChoice.bind(loop)
      : canton.exercise.bind(canton);

    await exerciseFn(
      TEMPLATES.BP_POSITION,
      position.contractId,
      "BPPosition_ClaimRewards",
      {}
    );

    await refresh();
  }, [position, loop, canton, refresh]);

  /**
   * Transfer Canton coin between users.
   */
  const transferCanton = useCallback(
    async (cantonCoinContractId: string, recipient: string) => {
      const exerciseFn = loop.provider
        ? loop.exerciseChoice.bind(loop)
        : canton.exercise.bind(canton);

      await exerciseFn(
        TEMPLATES.CANTON_COIN,
        cantonCoinContractId,
        "CantonCoin_Transfer",
        { newOwner: recipient }
      );

      await refreshCantonCoins();
    },
    [loop, canton, refreshCantonCoins]
  );

  // ─── Computed values ────────────────────────────────────────
  const totalCantonBalance = cantonBalance.reduce((sum, c) => sum + c.amount, 0);
  const totalSMUSDValue = smusdPositions.reduce(
    (sum, p) => sum + p.shares * p.entrySharePrice,
    0
  );
  const maxDepositAllowed = totalSMUSDValue * 0.25; // 80/20 ratio: max Canton = 25% of sMUSD value

  return {
    // State
    pool,
    position,
    cantonBalance,
    smusdPositions,
    totalCantonBalance,
    totalSMUSDValue,
    maxDepositAllowed,
    loading,
    error,

    // Actions
    deposit,
    withdraw,
    claimRewards,
    transferCanton,
    refresh,
  };
}
