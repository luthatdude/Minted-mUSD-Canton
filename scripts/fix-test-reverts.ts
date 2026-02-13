/**
 * Script to convert all test files from:
 *   .to.be.revertedWith("SOME_STRING")
 * to:
 *   .to.be.revertedWithCustomError(<contract>, "ErrorName")
 *
 * The contract variable is extracted from the await expect() call.
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
  DEPOSIT_NOT_FOUND: "InsufficientDeposit",
  ATTESTATION_TOO_OLD: "AttestationTooOld",

  // Special cases - mixed case strings from contracts
  "Cannot recover PT": "CannotRecoverPt",
  "Cannot recover USDC": "CannotRecoverUsdc",
};

// ─── Contract variable name mapping (filename → primary contract var) ───────
const FILE_CONTRACT_MAP: Record<string, string> = {
  "BLEBridgeV9.test.ts": "bridge",
  "BorrowModule.test.ts": "borrowModule",
  "CollateralVault.test.ts": "vault",
  "CoverageBoost_BLEBridgeV9.test.ts": "bridge",
  "CoverageBoost_BLEBridgeV9_Branches.test.ts": "bridge",
  "CoverageBoost_DirectMintV2.test.ts": "directMint",
  "CoverageBoost_MiscContracts.test.ts": "__MULTI__", // handled specially
  "CoverageBoost_PendleMarketSelector.test.ts": "selector",
  "CoverageBoost_PendleMarketSelector_Full.test.ts": "selector",
  "CoverageBoost_PendleStrategyV2.test.ts": "strategy",
  "CoverageBoost_PendleStrategyV2_Full.test.ts": "strategy",
  "DeepAudit.test.ts": "__MULTI__",
  "DeepAuditV2.test.ts": "__MULTI__",
  "DirectMintV2.test.ts": "directMint",
  "InstitutionalAudit.test.ts": "__MULTI__",
  "LeverageVault.test.ts": "leverageVault",
  "LeverageVaultFlashLoan.test.ts": "leverageVault",
  "MUSD.test.ts": "musd",
  "PendleMarketSelector.test.ts": "selector",
  "PendleStrategyV2.test.ts": "strategy",
  "PriceOracle.test.ts": "oracle",
  "RedemptionQueue.test.ts": "queue",
  "SMUSD.test.ts": "smusd",
  "SMUSDPriceAdapter.test.ts": "adapter",
  "SkySUSDSStrategy.test.ts": "strategy",
  "TimelockWiring.test.ts": "__MULTI__",
  "TreasuryV2.test.ts": "treasury",
};

// ─── Test files to process ──────────────────────────────────────────────────
const testDir = path.resolve(__dirname, "../test");
const testFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"));

let totalReplacements = 0;
let totalSkipped = 0;
const unmappedStrings = new Set<string>();
const manualFixNeeded: Array<{ file: string; line: number; revertString: string }> = [];

for (const file of testFiles) {
  const filePath = path.join(testDir, file);
  let content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  let fileReplacements = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match .revertedWith("STRING") or .revertedWith('STRING')
    const revertMatch = line.match(/\.revertedWith\(["']([^"']+)["']\)/);
    if (!revertMatch) continue;

    const revertString = revertMatch[1];
    const errorName = ERROR_MAP[revertString];
    if (!errorName) {
      unmappedStrings.add(revertString);
      totalSkipped++;
      continue;
    }

    // Extract contract variable by looking at the `await expect(...)` block
    const contractVar = extractContractVar(lines, i, file);

    if (contractVar) {
      lines[i] = line.replace(
        revertMatch[0],
        `.revertedWithCustomError(${contractVar}, "${errorName}")`
      );
      fileReplacements++;
    } else {
      // Fall back to file-level default
      const defaultVar = FILE_CONTRACT_MAP[file];
      if (defaultVar && defaultVar !== "__MULTI__") {
        lines[i] = line.replace(
          revertMatch[0],
          `.revertedWithCustomError(${defaultVar}, "${errorName}")`
        );
        fileReplacements++;
      } else {
        manualFixNeeded.push({ file, line: i + 1, revertString });
        totalSkipped++;
      }
    }
  }

  if (fileReplacements > 0) {
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    console.log(`  ✅ ${file}: ${fileReplacements} replacements`);
    totalReplacements += fileReplacements;
  }
}

console.log(`\nTotal: ${totalReplacements} replacements, ${totalSkipped} skipped`);
if (unmappedStrings.size > 0) {
  console.log("Unmapped strings:", [...unmappedStrings]);
}
if (manualFixNeeded.length > 0) {
  console.log("\nManual fix needed:");
  for (const fix of manualFixNeeded) {
    console.log(`  ${fix.file}:${fix.line} → "${fix.revertString}"`);
  }
}

/**
 * Extract the contract variable from the await expect() call preceding the revertedWith line.
 * Looks backwards from the current line to find:
 *   await expect(contractVar.method(...))
 *   await expect(contractVar.connect(signer).method(...))
 *   expect(contractVar.method(...))
 */
function extractContractVar(lines: string[], currentLine: number, filename: string): string | null {
  // Search backwards up to 10 lines for the expect( call
  for (let j = currentLine; j >= Math.max(0, currentLine - 10); j--) {
    const l = lines[j];
    // Pattern 1: await expect(contractVar.connect(signer).method(
    let m = l.match(/expect\(\s*(\w+)\.connect\(/);
    if (m) return m[1];

    // Pattern 2: await expect(contractVar.method(
    m = l.match(/expect\(\s*(\w+)\.\w+\(/);
    if (m && m[1] !== "ethers" && m[1] !== "upgrades") return m[1];

    // Pattern 3: upgrades.deployProxy(Factory, ...) → need factory variable
    // For deploy proxy calls, extract the factory variable
    m = l.match(/upgrades\.deployProxy\(\s*(\w+)/);
    if (m) return m[1];

    // Pattern 4: expect(upgrades.deployProxy(Factory, ...)
    m = l.match(/expect\(\s*upgrades\.deployProxy\(\s*(\w+)/);
    if (m) return m[1];
  }
  return null;
}

