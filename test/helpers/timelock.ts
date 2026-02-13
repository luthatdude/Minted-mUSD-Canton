/**
 * Timelock Helper — direct admin calls for test convenience.
 *
 * After the TimelockGoverned refactor, all admin setters are gated by
 * `onlyTimelock`.  In tests the deployer address IS the timelock, so
 * these helpers simply call the setter directly — no 3-step pattern.
 *
 * NOTE: refreshFeeds() is still needed after time-advancing operations.
 */

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
  await oracle.connect(admin).setFeed(token, feed, stalePeriod, tokenDecimals, 0);
}

export async function timelockRemoveFeed(oracle: any, admin: HardhatEthersSigner, token: string) {
  await oracle.connect(admin).removeFeed(token);
}

export async function timelockSetMaxDeviation(oracle: any, admin: HardhatEthersSigner, bps: number) {
  await oracle.connect(admin).setMaxDeviation(bps);
}

export async function timelockSetCircuitBreakerEnabled(oracle: any, admin: HardhatEthersSigner, enabled: boolean) {
  await oracle.connect(admin).setCircuitBreakerEnabled(enabled);
}

// ─── CollateralVault ─────────────────────────────────────────

export async function timelockAddCollateral(
  vault: any, admin: HardhatEthersSigner,
  token: string, factorBps: number, liqThresholdBps: number, liqPenaltyBps: number
) {
  await vault.connect(admin).addCollateral(token, factorBps, liqThresholdBps, liqPenaltyBps);
}

export async function timelockUpdateCollateral(
  vault: any, admin: HardhatEthersSigner,
  token: string, factorBps: number, liqThresholdBps: number, liqPenaltyBps: number
) {
  await vault.connect(admin).updateCollateral(token, factorBps, liqThresholdBps, liqPenaltyBps);
}

export async function timelockSetBorrowModule(vault: any, admin: HardhatEthersSigner, module: string) {
  await vault.connect(admin).setBorrowModule(module);
}

// ─── BorrowModule ────────────────────────────────────────────

export async function timelockSetInterestRateModel(bm: any, admin: HardhatEthersSigner, model: string) {
  await bm.connect(admin).setInterestRateModel(model);
}

export async function timelockSetSMUSD(bm: any, admin: HardhatEthersSigner, smusd: string) {
  await bm.connect(admin).setSMUSD(smusd);
}

export async function timelockSetTreasury(bm: any, admin: HardhatEthersSigner, treasury: string) {
  await bm.connect(admin).setTreasury(treasury);
}

export async function timelockSetInterestRate(bm: any, admin: HardhatEthersSigner, rateBps: number) {
  await bm.connect(admin).setInterestRate(rateBps);
}

export async function timelockSetMinDebt(bm: any, admin: HardhatEthersSigner, minDebt: bigint) {
  await bm.connect(admin).setMinDebt(minDebt);
}

// ─── LiquidationEngine ──────────────────────────────────────

export async function timelockSetCloseFactor(engine: any, admin: HardhatEthersSigner, bps: number) {
  await engine.connect(admin).setCloseFactor(bps);
}

export async function timelockSetFullLiquidationThreshold(engine: any, admin: HardhatEthersSigner, bps: number) {
  await engine.connect(admin).setFullLiquidationThreshold(bps);
}

// ─── TreasuryV2 ──────────────────────────────────────────────

export async function timelockAddStrategy(
  treasury: any, admin: HardhatEthersSigner,
  strategy: string, targetBps: number, minBps: number, maxBps: number, autoAllocate: boolean
) {
  await treasury.connect(admin).addStrategy(strategy, targetBps, minBps, maxBps, autoAllocate);
}

export async function timelockRemoveStrategy(treasury: any, admin: HardhatEthersSigner, strategy: string) {
  await treasury.connect(admin).removeStrategy(strategy);
}

export async function timelockSetFeeConfig(
  treasury: any, admin: HardhatEthersSigner, feeBps: number, recipient: string
) {
  await treasury.connect(admin).setFeeConfig(feeBps, recipient);
}

export async function timelockSetReserveBps(treasury: any, admin: HardhatEthersSigner, bps: number) {
  await treasury.connect(admin).setReserveBps(bps);
}

// ─── DirectMintV2 ────────────────────────────────────────────

export async function timelockSetFees(dm: any, admin: HardhatEthersSigner, mintBps: number, redeemBps: number) {
  await dm.connect(admin).setFees(mintBps, redeemBps);
}

export async function timelockSetFeeRecipient(dm: any, admin: HardhatEthersSigner, recipient: string) {
  await dm.connect(admin).setFeeRecipient(recipient);
}

export async function timelockSetLimits(
  dm: any, admin: HardhatEthersSigner,
  minMint: bigint | number, maxMint: bigint | number,
  minRedeem: bigint | number, maxRedeem: bigint | number
) {
  await dm.connect(admin).setLimits(minMint, maxMint, minRedeem, maxRedeem);
}

// ─── InterestRateModel ───────────────────────────────────────

export async function timelockSetIRMParams(
  irm: any, admin: HardhatEthersSigner,
  baseRate: number, multiplier: number, kink: number,
  jumpMultiplier: number, reserveFactor: number
) {
  await irm.connect(admin).setParams(baseRate, multiplier, kink, jumpMultiplier, reserveFactor);
}
