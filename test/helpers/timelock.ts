/**
 * Timelock Helper — wraps the propose→advance→execute pattern for test convenience.
 * All admin operations require a 48h timelock. These helpers let tests call the
 * 3-step pattern in a single line.
 *
 * NOTE: Each helper advances block time by 48h. After calling multiple helpers
 * in a fixture, call refreshFeeds() to update mock Chainlink feed timestamps
 * so price lookups don't revert with STALE_PRICE.
 */

import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ADMIN_DELAY = 48 * 60 * 60; // 48 hours in seconds

/**
 * Refresh mock Chainlink feeds so their updatedAt equals the current block time.
 * Call this after timelock setup calls that advance time, before any price lookups.
 * Each feed's setAnswer(currentAnswer) updates the timestamp automatically.
 */
export async function refreshFeeds(...feeds: any[]) {
  for (const feed of feeds) {
    const [, answer] = await feed.latestRoundData();
    await feed.setAnswer(answer);
  }
}

// ─── PriceOracle ─────────────────────────────────────────────

export async function timelockSetFeed(
  oracle: any, admin: HardhatEthersSigner,
  token: string, feed: string, stalePeriod: number, tokenDecimals: number
) {
  await oracle.connect(admin).requestSetFeed(token, feed, stalePeriod, tokenDecimals);
  await time.increase(ADMIN_DELAY);
  await oracle.connect(admin).executeSetFeed();
}

export async function timelockRemoveFeed(oracle: any, admin: HardhatEthersSigner, token: string) {
  await oracle.connect(admin).requestRemoveFeed(token);
  await time.increase(ADMIN_DELAY);
  await oracle.connect(admin).executeRemoveFeed();
}

export async function timelockSetMaxDeviation(oracle: any, admin: HardhatEthersSigner, bps: number) {
  await oracle.connect(admin).requestSetMaxDeviation(bps);
  await time.increase(ADMIN_DELAY);
  await oracle.connect(admin).executeSetMaxDeviation();
}

export async function timelockSetCircuitBreakerEnabled(oracle: any, admin: HardhatEthersSigner, enabled: boolean) {
  await oracle.connect(admin).requestSetCircuitBreakerEnabled(enabled);
  await time.increase(ADMIN_DELAY);
  await oracle.connect(admin).executeSetCircuitBreakerEnabled();
}

// ─── CollateralVault ─────────────────────────────────────────

export async function timelockAddCollateral(
  vault: any, admin: HardhatEthersSigner,
  token: string, factorBps: number, liqThresholdBps: number, liqPenaltyBps: number
) {
  await vault.connect(admin).requestAddCollateral(token, factorBps, liqThresholdBps, liqPenaltyBps);
  await time.increase(ADMIN_DELAY);
  await vault.connect(admin).executeAddCollateral();
}

export async function timelockUpdateCollateral(
  vault: any, admin: HardhatEthersSigner,
  token: string, factorBps: number, liqThresholdBps: number, liqPenaltyBps: number
) {
  await vault.connect(admin).requestUpdateCollateral(token, factorBps, liqThresholdBps, liqPenaltyBps);
  await time.increase(ADMIN_DELAY);
  await vault.connect(admin).executeUpdateCollateral();
}

export async function timelockSetBorrowModule(vault: any, admin: HardhatEthersSigner, module: string) {
  await vault.connect(admin).requestBorrowModule(module);
  await time.increase(ADMIN_DELAY);
  await vault.connect(admin).executeBorrowModule();
}

// ─── BorrowModule ────────────────────────────────────────────

export async function timelockSetInterestRateModel(bm: any, admin: HardhatEthersSigner, model: string) {
  await bm.connect(admin).requestInterestRateModel(model);
  await time.increase(ADMIN_DELAY);
  await bm.connect(admin).executeInterestRateModel();
}

export async function timelockSetSMUSD(bm: any, admin: HardhatEthersSigner, smusd: string) {
  await bm.connect(admin).requestSMUSD(smusd);
  await time.increase(ADMIN_DELAY);
  await bm.connect(admin).executeSMUSD();
}

export async function timelockSetTreasury(bm: any, admin: HardhatEthersSigner, treasury: string) {
  await bm.connect(admin).requestTreasury(treasury);
  await time.increase(ADMIN_DELAY);
  await bm.connect(admin).executeTreasury();
}

export async function timelockSetInterestRate(bm: any, admin: HardhatEthersSigner, rateBps: number) {
  await bm.connect(admin).requestInterestRate(rateBps);
  await time.increase(ADMIN_DELAY);
  await bm.connect(admin).executeInterestRate();
}

export async function timelockSetMinDebt(bm: any, admin: HardhatEthersSigner, minDebt: bigint) {
  await bm.connect(admin).requestMinDebt(minDebt);
  await time.increase(ADMIN_DELAY);
  await bm.connect(admin).executeMinDebt();
}

// ─── LiquidationEngine ──────────────────────────────────────

export async function timelockSetCloseFactor(engine: any, admin: HardhatEthersSigner, bps: number) {
  await engine.connect(admin).requestCloseFactor(bps);
  await time.increase(ADMIN_DELAY);
  await engine.connect(admin).executeCloseFactor();
}

export async function timelockSetFullLiquidationThreshold(engine: any, admin: HardhatEthersSigner, bps: number) {
  await engine.connect(admin).requestFullLiquidationThreshold(bps);
  await time.increase(ADMIN_DELAY);
  await engine.connect(admin).executeFullLiquidationThreshold();
}

// ─── TreasuryV2 ──────────────────────────────────────────────

export async function timelockAddStrategy(
  treasury: any, admin: HardhatEthersSigner,
  strategy: string, targetBps: number, minBps: number, maxBps: number, autoAllocate: boolean
) {
  await treasury.connect(admin).requestAddStrategy(strategy, targetBps, minBps, maxBps, autoAllocate);
  await time.increase(ADMIN_DELAY);
  await treasury.connect(admin).executeAddStrategy();
}

export async function timelockRemoveStrategy(treasury: any, admin: HardhatEthersSigner, strategy: string) {
  await treasury.connect(admin).requestRemoveStrategy(strategy);
  await time.increase(ADMIN_DELAY);
  await treasury.connect(admin).executeRemoveStrategy();
}

export async function timelockSetFeeConfig(
  treasury: any, admin: HardhatEthersSigner, feeBps: number, recipient: string
) {
  await treasury.connect(admin).requestFeeConfig(feeBps, recipient);
  await time.increase(ADMIN_DELAY);
  await treasury.connect(admin).executeFeeConfig();
}

export async function timelockSetReserveBps(treasury: any, admin: HardhatEthersSigner, bps: number) {
  await treasury.connect(admin).requestReserveBps(bps);
  await time.increase(ADMIN_DELAY);
  await treasury.connect(admin).executeReserveBps();
}

// ─── DirectMintV2 ────────────────────────────────────────────

export async function timelockSetFees(dm: any, admin: HardhatEthersSigner, mintBps: number, redeemBps: number) {
  await dm.connect(admin).requestFees(mintBps, redeemBps);
  await time.increase(ADMIN_DELAY);
  await dm.connect(admin).executeFees();
}

export async function timelockSetFeeRecipient(dm: any, admin: HardhatEthersSigner, recipient: string) {
  await dm.connect(admin).requestFeeRecipient(recipient);
  await time.increase(ADMIN_DELAY);
  await dm.connect(admin).executeFeeRecipient();
}

export async function timelockSetLimits(
  dm: any, admin: HardhatEthersSigner,
  minMint: bigint | number, maxMint: bigint | number,
  minRedeem: bigint | number, maxRedeem: bigint | number
) {
  await dm.connect(admin).requestLimits(minMint, maxMint, minRedeem, maxRedeem);
  await time.increase(ADMIN_DELAY);
  await dm.connect(admin).executeLimits();
}

// ─── InterestRateModel ───────────────────────────────────────

export async function timelockSetIRMParams(
  irm: any, admin: HardhatEthersSigner,
  baseRate: number, multiplier: number, kink: number,
  jumpMultiplier: number, reserveFactor: number
) {
  await irm.connect(admin).requestSetParams(baseRate, multiplier, kink, jumpMultiplier, reserveFactor);
  await time.increase(ADMIN_DELAY);
  await irm.connect(admin).executeSetParams();
}
