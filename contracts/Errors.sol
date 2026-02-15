// SPDX-License-Identifier: BUSL-1.1
// GAS-05: Shared custom errors library for all Minted mUSD contracts.
// Custom errors save ~200 gas per revert vs string require() and ~100k deploy gas across all contracts.

pragma solidity 0.8.26;

// ─── Address Validation ──────────────────────────────────────────────────
error InvalidAddress();
error ZeroAddress();
error InvalidModule();
error InvalidVault();
error InvalidOracle();
error InvalidMusd();
error InvalidUsdc();
error InvalidTreasury();
error InvalidFeeRecipient();
error InvalidBorrowModule();
error InvalidRouter();
error InvalidBorrow();
error InvalidAdmin();
error InvalidTimelock();
error InvalidToken();
error InvalidFeed();
error InvalidUser();
error InvalidRecipient();
error InvalidValidator();
error InvalidPreviousBridge();
error InvalidMusdAddress();

// ─── Amount / Value Validation ───────────────────────────────────────────
error InvalidAmount();
error ZeroAmount();
error ZeroAssets();
error ZeroOutput();
error DustAmount();
error DustLiquidation();
error BelowMin();
error AboveMax();

// ─── Capacity / Limits ──────────────────────────────────────────────────
error ExceedsSupplyCap();
error ExceedsLocalCap();
error ExceedsBorrowCapacity();
error ExceedsReserves();
error SupplyCapReached();
error DailyCapLimitExhausted();
error BatchTooLarge();
error TooManyTokens();
error MaxMarketsReached();

// ─── Debt / Position ────────────────────────────────────────────────────
error NoDebt();
error BelowMinDebt();
error RemainingBelowMinDebt();
error PositionExists();
error NoPosition();
error PositionHealthy();
error CannotSelfLiquidate();
error NothingToSeize();
error WithdrawalWouldLiquidate();
error WithdrawalWouldUndercollateralize();
error OracleUnavailable();
error CollateralRemaining();

// ─── Token / Collateral Config ──────────────────────────────────────────
error TokenNotSupported();
error TokenNotEnabled();
error CollateralNotEnabled();
error NotSupported();
error AlreadyAdded();
error AlreadyEnabled();
error NotPreviouslyAdded();
error InvalidFactor();
error ThresholdTooHigh();
error PenaltyTooHigh();
error FactorTooHigh();
error ThresholdMustExceedFactor();
error InsufficientDeposit();
error InsufficientCollateral();
error SkipHcRecipientRestricted();
error TokenAlreadyEnabled();

// ─── Fee Validation ─────────────────────────────────────────────────────
error MintFeeTooHigh();
error RedeemFeeTooHigh();
error InvalidMintLimits();
error InvalidRedeemLimits();
error NoFees();
error NoRedeemFees();
error CannotRecoverUsdc();
error CannotRecoverMusd();
error CannotRecoverAsset();
error CannotRecoverPt();
error CannotRecoverUsds();
error CannotRecoverSusds();
error CannotRecoverActiveUsdc();
error FeeTooHigh();
error InvalidRecipientAddr();
error ReserveTooHigh();
error ZeroMinAmount();

// ─── Interest Rate / Borrowing ──────────────────────────────────────────
error RateTooHigh();
error MinDebtZero();
error MinDebtTooHigh();
error NoPendingInterest();
error DriftExceedsSafetyThreshold();

// ─── Circuit Breaker / Oracle ───────────────────────────────────────────
error CbNotTripped();
error CooldownNotElapsed();
error CooldownOutOfRange();
error FeedNotEnabled();
error FeedNotFound();
error InvalidPrice();
error StalePrice();
error StaleRound();
error UnsupportedFeedDecimals();
error FeedDecimalsTooHigh();
error TokenDecimalsTooHigh();
error StalePeriodTooLong();
error InvalidStalePeriod();
error DeviationOutOfRange();
error AssetDeviationOutOfRange();
error CircuitBreakerActive();

// ─── Leverage ───────────────────────────────────────────────────────────
error LeverageTooLow();
error LeverageExceedsMax();
error InvalidMaxLeverage();
error InvalidMaxLoops();
error SlippageTooHigh();
error SlippageExceeded();
error UserSlippageExceedsMax();
error InvalidFeeTier();
error ExpiredDeadline();
error InsufficientMusdFromSwap();
error InsufficientMusdProvided();
error InsufficientMusdBalance();
error SwapFailedOrphanedDebt();
error SwapReturnedZero();
error MaxTwentyPct();

// ─── Bridge / Attestation ───────────────────────────────────────────────
error MinSigsTooLow();
error MinSigsTooHigh();
error RatioBelow100Percent();
error InvalidDailyLimit();
error InvalidLimit();
error RatioChangeCooldown();
error RatioChangeTooLarge();
error NotPaused();
error NoUnpauseRequest();
error TimelockNotElapsed();
error UseRequestUnpauseAndExecuteUnpause();
error ReasonRequired();
error NotAReduction();
error CapBelowSupply();
error NonceMustIncrease();
error AlreadyUsed();
error InsufficientSignatures();
error InvalidNonce();
error AttestationReused();
error FutureTimestamp();
error AttestationTooClose();
error AttestationTooOld();
error MissingEntropy();
error MissingStateHash();
error InvalidAttestationId();
error InvalidPayloadLength();
error NotTransferWithPayload();
error UnsortedSignatures();

// ─── SMUSD / Shares ─────────────────────────────────────────────────────
error CooldownActive();
error NoSharesExist();
error YieldExceedsCap();
error InterestExceedsCap();
error EpochNotSequential();
error SyncTooFrequent();
error InitialSharesTooLarge();
error ShareIncreaseTooLarge();
error ShareDecreaseTooLarge();
error DailyShareChangeExceeded();
error NoTreasury();
error RefreshTooFrequent();

// ─── Queue / Redemption ─────────────────────────────────────────────────
error InvalidId();
error NotOwner();
error AlreadyFulfilled();
error AlreadyCancelled();

// ─── Access ─────────────────────────────────────────────────────────────
error Unauthorized();
error UnauthorizedBurn();
error ComplianceReject();
error MustDepositOwnFunds();
error InsufficientReserves();
error RecipientMustBeTreasury();

// ─── Strategy ───────────────────────────────────────────────────────────
error NotActive();
error DiscountTooHigh();
error InvalidThreshold();
error DecimalsTooLarge();
error NoValidMarket();
error InvalidPtToken();
error ZeroRecipient();
error LengthMismatch();
error ZeroTimelock();

// ─── Timelock ───────────────────────────────────────────────────────────
error DelayTooShort();

// ─── SMUSDPriceAdapter ──────────────────────────────────────────────────
error MinZero();
error MaxLteMin();
error MaxTooHigh();
error MinSupplyZero();
error MaxChangeZero();
error MaxChangeTooHigh();

// ─── Miscellaneous ──────────────────────────────────────────────────────
error InvalidCloseFactor();
error NoBadDebt();
error NoBorrowers();
error LocalCapOutOfRange();
error InvalidSupplyCap();
error MintToZero();
error CapIncreaseCooldown();
error InsufficientBalance();
error InsufficientLiquidity();
error InvalidBuffer();
error MaxBorrowRateTooHigh();
error MinSupplyRateTooHigh();

// ─── Global Pause ────────────────────────────────────────────────────────
error AlreadyPaused();
