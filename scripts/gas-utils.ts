/**
 * Gas utilities for Sepolia testnet scripts
 * 
 * Public RPCs (e.g., publicnode.com) require explicit gasLimit overrides
 * because estimateGas() often fails or returns incorrect values.
 * This module provides consistent gas constants and helpers.
 */

import { ethers, type TransactionResponse, type TransactionReceipt } from "ethers";

// ============================================================
//                    GAS LIMIT PRESETS
// ============================================================

/** Standard gas override for simple state-changing calls (approve, grant/revoke role, setFeed, etc.) */
export const GAS = { gasLimit: 300_000 } as const;

/** Gas override for moderate-complexity calls (DirectMintV2.mint, treasury deposits, etc.) */
export const GAS_MEDIUM = { gasLimit: 500_000 } as const;

/** Gas override for complex multi-step calls (openLeveragedPosition, closeLeveragedPosition, etc.) */
export const GAS_HIGH = { gasLimit: 1_000_000 } as const;

/** Gas override for deployments */
export const GAS_DEPLOY = { gasLimit: 5_000_000 } as const;

// ============================================================
//                    NONCE DELAY HELPERS
// ============================================================

/**
 * Wait for public RPC nonce propagation.
 * Public RPCs (publicnode, etc.) have 4-8 second lag between
 * when a tx is mined and when the nonce is reflected in pending state.
 * Without this delay, the next tx may get "replacement transaction underpriced".
 */
export function waitForNonce(ms: number = 5000): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
//                    TX HELPERS
// ============================================================

/**
 * Send a transaction, wait for confirmation, and return the receipt.
 * Includes automatic nonce delay after confirmation.
 * 
 * @example
 * const receipt = await sendAndWait(token.approve(spender, amount, GAS));
 * console.log(`Gas used: ${receipt.gasUsed}`);
 */
export async function sendAndWait(
  txPromise: Promise<TransactionResponse>,
  nonceDelay: number = 5000
): Promise<TransactionReceipt> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Transaction receipt is null");
  if (receipt.status === 0) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }
  if (nonceDelay > 0) {
    await waitForNonce(nonceDelay);
  }
  return receipt;
}

/**
 * Format ETH gas cost from a receipt for logging.
 */
export function formatGasCost(receipt: TransactionReceipt): string {
  const cost = receipt.gasUsed * receipt.gasPrice;
  return `${ethers.formatEther(cost)} ETH (${receipt.gasUsed} gas @ ${ethers.formatUnits(receipt.gasPrice, "gwei")} gwei)`;
}

// ============================================================
//                  COMMON ADDRESSES (Sepolia)
// ============================================================

export const SEPOLIA_CONTRACTS = {
  GlobalPauseRegistry:     "0x471e9dceB2AB7398b63677C70c6C638c7AEA375F",
  MintedTimelockController: "0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410",
  MUSD:                    "0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B",
  PriceOracle:             "0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025",
  InterestRateModel:       "0x501265BeF81E6E96e4150661e2b9278272e9177B",
  CollateralVault:         "0x155d6618dcdeb2F4145395CA57C80e6931D7941e",
  BorrowModule:            "0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8",
  SMUSD:                   "0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540",
  LiquidationEngine:       "0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8",
  DirectMintV2:            "0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7",
  LeverageVault:           "0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4",
  TreasuryV2Proxy:         "0xf2051bDfc738f638668DF2f8c00d01ba6338C513",
  BLEBridgeV9Proxy:        "0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125",
  MockUSDC:                "0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474",
  MockWETH:                "0x7999F2894290F2Ce34a508eeff776126D9a7D46e",
  MockWBTC:                "0xC0D0618dDBE7407EBFB12ca7d7cD53e90f5BC29F",
  MockSwapRouter:          "0x510379a06bBb260E0442BCE7e519Fbf7Dd4ba77e",
} as const;

export const SEPOLIA_FEEDS = {
  ETH_USD: "0xc82116f198C582C2570712Cbe514e17dC9E8e01A",
  BTC_USD: "0xE9A0164efA641Aa14142aF3754545A61cD224106",
  USDC_USD: "0x33721a15b1b3431C78E461CF97EA3DbFB9dba3c7",
} as const;
