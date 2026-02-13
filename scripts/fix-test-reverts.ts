/**
 * Script to convert all test files from:
 *   .to.be.revertedWith("SOME_STRING")
 * to:
 *   .to.be.revertedWithCustomError(<contract>, "ErrorName")
 *
 * Run with: npx ts-node scripts/fix-test-reverts.ts
 */
import * as fs from "fs";
import * as path from "path";

// ─── Mapping from old require string → new custom error name ─────────────────
const ERROR_MAP: Record<string, string> = {
  // Address Validation
  INVALID_ADDRESS: "InvalidAddress",
  ZERO_ADDRESS: "ZeroAddress",
  INVALID_MODULE: "InvalidModule",
  INVALID_VAULT: "InvalidVault",
  INVALID_ORACLE: "InvalidOracle",
  INVALID_MUSD: "InvalidMusd",
  INVALID_USDC: "InvalidUsdc",
  INVALID_TREASURY: "InvalidTreasury",
  INVALID_FEE_RECIPIENT: "InvalidFeeRecipient",
  INVALID_BORROW_MODULE: "InvalidBorrowModule",
  INVALID_ROUTER: "InvalidRouter",
  INVALID_BORROW: "InvalidBorrow",
  INVALID_TOKEN: "InvalidToken",
  INVALID_FEED: "InvalidFeed",
  INVALID_USER: "InvalidUser",
  INVALID_RECIPIENT: "InvalidRecipient",
  INVALID_PREVIOUS_BRIDGE: "InvalidPreviousBridge",
  INVALID_MUSD_ADDRESS: "InvalidMusdAddress",
  ZERO_ADMIN: "InvalidAdmin",

  // Amount / Value
  INVALID_AMOUNT: "InvalidAmount",
  ZERO_AMOUNT: "ZeroAmount",
  ZERO_ASSETS: "ZeroAssets",
  ZERO_OUTPUT: "ZeroOutput",
  DUST_AMOUNT: "DustAmount",
  DUST_LIQUIDATION: "DustLiquidation",
  BELOW_MIN: "BelowMin",
  ABOVE_MAX: "AboveMax",

  // Capacity / Limits
  EXCEEDS_SUPPLY_CAP: "ExceedsSupplyCap",
  EXCEEDS_LOCAL_CAP: "ExceedsLocalCap",
  EXCEEDS_BORROW_CAPACITY: "ExceedsBorrowCapacity",
  EXCEEDS_RESERVES: "ExceedsReserves",
  SUPPLY_CAP_REACHED: "SupplyCapReached",
  DAILY_CAP_LIMIT_EXHAUSTED: "DailyCapLimitExhausted",
  BATCH_TOO_LARGE: "BatchTooLarge",
  TOO_MANY_TOKENS: "TooManyTokens",
  MAX_MARKETS_REACHED: "MaxMarketsReached",

  // Debt / Position
  NO_DEBT: "NoDebt",
  BELOW_MIN_DEBT: "BelowMinDebt",
  POSITION_EXISTS: "PositionExists",
  NO_POSITION: "NoPosition",
  POSITION_HEALTHY: "PositionHealthy",
  CANNOT_SELF_LIQUIDATE: "CannotSelfLiquidate",
  WITHDRAWAL_WOULD_LIQUIDATE: "WithdrawalWouldLiquidate",

  // Token / Collateral Config
  TOKEN_NOT_SUPPORTED: "TokenNotSupported",
  TOKEN_NOT_ENABLED: "TokenNotEnabled",
  NOT_SUPPORTED: "NotSupported",
  ALREADY_ADDED: "AlreadyAdded",
  ALREADY_ENABLED: "AlreadyEnabled",
  NOT_PREVIOUSLY_ADDED: "NotPreviouslyAdded",
  INVALID_FACTOR: "InvalidFactor",
  THRESHOLD_TOO_HIGH: "ThresholdTooHigh",
  PENALTY_TOO_HIGH: "PenaltyTooHigh",
  INSUFFICIENT_DEPOSIT: "InsufficientDeposit",
  INSUFFICIENT_COLLATERAL: "InsufficientCollateral",
  TOKEN_DECIMALS_TOO_HIGH: "TokenDecimalsTooHigh",

  // Fee Validation
  MINT_FEE_TOO_HIGH: "MintFeeTooHigh",
  REDEEM_FEE_TOO_HIGH: "RedeemFeeTooHigh",
  INVALID_MINT_LIMITS: "InvalidMintLimits",
  INVALID_REDEEM_LIMITS: "InvalidRedeemLimits",
  NO_FEES: "NoFees",
  NO_REDEEM_FEES: "NoRedeemFees",
  CANNOT_RECOVER_USDC: "CannotRecoverUsdc",
  CANNOT_RECOVER_MUSD: "CannotRecoverMusd",
  CANNOT_RECOVER_ASSET: "CannotRecoverAsset",
  ZERO_MIN_AMOUNT: "ZeroMinAmount",
  "Fee too high": "FeeTooHigh",
  "Reserve too high": "ReserveTooHigh",

  // Interest Rate
  RATE_TOO_HIGH: "RateTooHigh",
  MIN_DEBT_ZERO: "MinDebtZero",
  MIN_DEBT_TOO_HIGH: "MinDebtTooHigh",
  INTEREST_EXCEEDS_CAP: "InterestExceedsCap",

  // Circuit Breaker / Oracle
  FEED_NOT_ENABLED: "FeedNotEnabled",
  FEED_NOT_FOUND: "FeedNotFound",
  INVALID_PRICE: "InvalidPrice",
  STALE_PRICE: "StalePrice",
  INVALID_STALE_PERIOD: "InvalidStalePeriod",
  DEVIATION_OUT_OF_RANGE: "DeviationOutOfRange",
  CIRCUIT_BREAKER_TRIGGERED: "CircuitBreakerActive",

  // Leverage
  LEVERAGE_TOO_LOW: "LeverageTooLow",
  LEVERAGE_EXCEEDS_MAX: "LeverageExceedsMax",
  INVALID_MAX_LEVERAGE: "InvalidMaxLeverage",
  INVALID_MAX_LOOPS: "InvalidMaxLoops",
  SLIPPAGE_TOO_HIGH: "SlippageTooHigh",
  SLIPPAGE_EXCEEDED: "SlippageExceeded",
  INVALID_FEE_TIER: "InvalidFeeTier",
  INSUFFICIENT_MUSD_PROVIDED: "InsufficientMusdProvided",

  // Bridge / Attestation
  MIN_SIGS_TOO_LOW: "MinSigsTooLow",
  MIN_SIGS_TOO_HIGH: "MinSigsTooHigh",
  RATIO_BELOW_100_PERCENT: "RatioBelow100Percent",
  INVALID_DAILY_LIMIT: "InvalidDailyLimit",
  INVALID_LIMIT: "InvalidLimit",
  RATIO_CHANGE_COOLDOWN: "RatioChangeCooldown",
  RATIO_CHANGE_TOO_LARGE: "RatioChangeTooLarge",
  NOT_PAUSED: "NotPaused",
  NO_UNPAUSE_REQUEST: "NoUnpauseRequest",
  TIMELOCK_NOT_ELAPSED: "TimelockNotElapsed",
  REASON_REQUIRED: "ReasonRequired",
  NOT_A_REDUCTION: "NotAReduction",
  CAP_BELOW_SUPPLY: "CapBelowSupply",
  ALREADY_USED: "AlreadyUsed",
  INSUFFICIENT_SIGNATURES: "InsufficientSignatures",
  INVALID_NONCE: "InvalidNonce",
  ATTESTATION_REUSED: "AttestationReused",
  FUTURE_TIMESTAMP: "FutureTimestamp",
  ATTESTATION_TOO_CLOSE: "AttestationTooClose",
  UNSORTED_SIGNATURES: "UnsortedSignatures",

  // SMUSD / Shares
  COOLDOWN_ACTIVE: "CooldownActive",
  NO_SHARES_EXIST: "NoSharesExist",
  YIELD_EXCEEDS_CAP: "YieldExceedsCap",
  EPOCH_NOT_SEQUENTIAL: "EpochNotSequential",
  SYNC_TOO_FREQUENT: "SyncTooFrequent",
  INITIAL_SHARES_TOO_LARGE: "InitialSharesTooLarge",
  SHARE_INCREASE_TOO_LARGE: "ShareIncreaseTooLarge",
  SHARE_DECREASE_TOO_LARGE: "ShareDecreaseTooLarge",

  // Queue / Redemption
  INVALID_ID: "InvalidId",
  NOT_OWNER: "NotOwner",
  ALREADY_FULFILLED: "AlreadyFulfilled",
  ALREADY_CANCELLED: "AlreadyCancelled",

  // Access
  UNAUTHORIZED: "Unauthorized",
  COMPLIANCE_REJECT: "ComplianceReject",
  INSUFFICIENT_RESERVES: "InsufficientReserves",
  RECIPIENT_MUST_BE_TREASURY: "RecipientMustBeTreasury",

  // Strategy
  DISCOUNT_TOO_HIGH: "DiscountTooHigh",
  INVALID_THRESHOLD: "InvalidThreshold",
  NO_VALID_MARKET: "NoValidMarket",
  INVALID_PT_TOKEN: "InvalidPtToken",
  ZERO_RECIPIENT: "ZeroRecipient",
  "Length mismatch": "LengthMismatch",

  // Timelock
  DELAY_TOO_SHORT: "DelayTooShort",

  // SMUSDPriceAdapter
  MIN_ZERO: "MinZero",
  MAX_LTE_MIN: "MaxLteMin",
  MAX_TOO_HIGH: "MaxTooHigh",
  MIN_SUPPLY_ZERO: "MinSupplyZero",
  MAX_CHANGE_ZERO: "MaxChangeZero",
  MAX_CHANGE_TOO_HIGH: "MaxChangeTooHigh",

  // Miscellaneous
  INVALID_CLOSE_FACTOR: "InvalidCloseFactor",
  INVALID_SUPPLY_CAP: "InvalidSupplyCap",
  INSUFFICIENT_BALANCE: "InsufficientBalance",
  INSUFFICIENT_LIQUIDITY: "InsufficientLiquidity",
  DEPOSIT_NOT_FOUND: "InsufficientDeposit", // maps to InsufficientDeposit
  ATTESTATION_TOO_OLD: "AttestationTooOld",

  // Special cases - mixed case strings from contracts
  "Cannot recover PT": "CannotRecoverPt",
  "Cannot recover USDC": "CannotRecoverUsdc",
};

// ─── Test files to process ──────────────────────────────────────────────────
const testDir = path.resolve(__dirname, "../test");
const testFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"));

let totalReplacements = 0;
let totalSkipped = 0;
const unmappedStrings = new Set<string>();

for (const file of testFiles) {
  const filePath = path.join(testDir, file);
  let content = fs.readFileSync(filePath, "utf8");
  let fileReplacements = 0;

  // Match patterns like:
  //   .to.be.revertedWith("STRING")
  //   .revertedWith("STRING")
  //   .to.be.revertedWith('STRING')
  //   .revertedWith('STRING')
  const regex = /\.revertedWith\(["']([^"']+)["']\)/g;
  let match;

  // Collect all matches first to avoid modifying while iterating
  const matches: Array<{ full: string; revertString: string }> = [];
  while ((match = regex.exec(content)) !== null) {
    matches.push({ full: match[0], revertString: match[1] });
  }

  for (const m of matches) {
    const errorName = ERROR_MAP[m.revertString];
    if (errorName) {
      // We need to figure out what contract variable to use.
      // The pattern is: await expect(contractVar.method(...)).to.be.revertedWith("STRING")
      // We need to extract the contract variable from the preceding code.
      // For simplicity, we'll just use the error name without a contract reference
      // since revertedWithCustomError in chai-ethers can match by error name alone
      // when used with hardhat-chai-matchers.
      //
      // Actually, revertedWithCustomError requires the contract instance.
      // Let's use a simpler approach: replace with a regex that captures the contract.

      content = content.replace(
        m.full,
        `.revertedWithCustomError(${getContractVarPlaceholder(file)}, "${errorName}")`
      );
      fileReplacements++;
    } else {
      unmappedStrings.add(m.revertString);
      totalSkipped++;
    }
  }

  if (fileReplacements > 0) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`  ✅ ${file}: ${fileReplacements} replacements`);
    totalReplacements += fileReplacements;
  }
}

console.log(`\nTotal: ${totalReplacements} replacements, ${totalSkipped} skipped`);
if (unmappedStrings.size > 0) {
  console.log("Unmapped strings:", [...unmappedStrings]);
}

/**
 * This is a placeholder — we need the actual contract variable.
 * For the Minted test suite, most test files use predictable variable names.
 * We'll need a second pass to fix these.
 */
function getContractVarPlaceholder(filename: string): string {
  // Return a placeholder that we'll fix in a second pass
  return "CONTRACT_REF";
}
