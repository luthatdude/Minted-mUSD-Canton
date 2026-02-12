// Flashbots Integration for MEV Protection
// Sends transactions via Flashbots relay to avoid front-running

import { ethers, Wallet } from "ethers";
import { createLogger, format, transports } from "winston";

// FIX BE-003: Crash handlers to prevent silent failures
process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL: Unhandled promise rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('FATAL: Uncaught exception:', error);
  process.exit(1);
});

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new transports.Console()],
});

// Flashbots relay URLs
const FLASHBOTS_RELAYS: Record<number, string> = {
  1: "https://relay.flashbots.net",           // Mainnet
  5: "https://relay-goerli.flashbots.net",    // Goerli
  11155111: "https://relay-sepolia.flashbots.net", // Sepolia
};

// MEV-Share (for sharing MEV with users)
const MEV_SHARE_RELAYS: Record<number, string> = {
  1: "https://relay.flashbots.net",
};

interface FlashbotsBundle {
  signedTransactions: string[];
  blockNumber: number;
  minTimestamp?: number;
  maxTimestamp?: number;
}

interface FlashbotsBundleResponse {
  bundleHash: string;
}

interface FlashbotsSimulation {
  success: boolean;
  error?: string;
  results: {
    txHash: string;
    gasUsed: number;
    revert?: string;
  }[];
}

export class FlashbotsProvider {
  private provider: ethers.JsonRpcProvider;
  private authSigner: Wallet;
  private relayUrl: string;
  private chainId: number;

  constructor(
    provider: ethers.JsonRpcProvider,
    authSigner: Wallet,
    chainId: number = 1
  ) {
    this.provider = provider;
    this.authSigner = authSigner;
    this.chainId = chainId;
    this.relayUrl = FLASHBOTS_RELAYS[chainId] || FLASHBOTS_RELAYS[1];
  }

  /**
   * Sign a message for Flashbots authentication
   */
  private async signAuthMessage(body: string): Promise<string> {
    const messageHash = ethers.id(body);
    const signature = await this.authSigner.signMessage(
      ethers.getBytes(messageHash)
    );
    return `${this.authSigner.address}:${signature}`;
  }

  /**
   * Send a request to the Flashbots relay
   */
  private async sendRequest(method: string, params: any[]): Promise<any> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });

    const signature = await this.signAuthMessage(body);

    const response = await fetch(this.relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": signature,
      },
      body,
    });

    const json = await response.json();

    if (json.error) {
      throw new Error(`Flashbots error: ${json.error.message}`);
    }

    return json.result;
  }

  /**
   * Simulate a bundle before sending
   */
  async simulateBundle(
    signedTransactions: string[],
    blockNumber: number
  ): Promise<FlashbotsSimulation> {
    const result = await this.sendRequest("eth_callBundle", [
      {
        txs: signedTransactions,
        blockNumber: `0x${blockNumber.toString(16)}`,
        stateBlockNumber: "latest",
      },
    ]);

    return {
      success: !result.error,
      error: result.error,
      results: result.results || [],
    };
  }

  /**
   * Send a bundle to the Flashbots relay
   */
  async sendBundle(
    signedTransactions: string[],
    targetBlockNumber: number,
    options?: {
      minTimestamp?: number;
      maxTimestamp?: number;
      revertingTxHashes?: string[];
    }
  ): Promise<FlashbotsBundleResponse> {
    const params: any = {
      txs: signedTransactions,
      blockNumber: `0x${targetBlockNumber.toString(16)}`,
    };

    if (options?.minTimestamp) {
      params.minTimestamp = options.minTimestamp;
    }
    if (options?.maxTimestamp) {
      params.maxTimestamp = options.maxTimestamp;
    }
    if (options?.revertingTxHashes) {
      params.revertingTxHashes = options.revertingTxHashes;
    }

    const result = await this.sendRequest("eth_sendBundle", [params]);
    return { bundleHash: result.bundleHash };
  }

  /**
   * Get bundle stats (was it included?)
   */
  async getBundleStats(
    bundleHash: string,
    blockNumber: number
  ): Promise<{
    isSimulated: boolean;
    isSentToMiners: boolean;
    isHighPriority: boolean;
    simulatedAt?: string;
    submittedAt?: string;
    sentToMinersAt?: string;
  }> {
    return this.sendRequest("flashbots_getBundleStats", [
      {
        bundleHash,
        blockNumber: `0x${blockNumber.toString(16)}`,
      },
    ]);
  }

  /**
   * Cancel a pending bundle
   */
  async cancelBundle(bundleHash: string): Promise<boolean> {
    const result = await this.sendRequest("flashbots_cancelBundle", [
      { bundleHash },
    ]);
    return result.success;
  }

  /**
   * Get current Flashbots user stats
   */
  async getUserStats(): Promise<{
    isHighPriority: boolean;
    allTimeMinersPayments: string;
    allTimeGasSimulated: string;
    last7dMinersPayments: string;
    last7dGasSimulated: string;
    last1dMinersPayments: string;
    last1dGasSimulated: string;
  }> {
    return this.sendRequest("flashbots_getUserStats", []);
  }
}

/**
 * MEV-protected liquidation executor
 */
export class MEVProtectedExecutor {
  private flashbots: FlashbotsProvider;
  private wallet: Wallet;
  private provider: ethers.JsonRpcProvider;
  private maxBlocksToTry: number;

  constructor(
    provider: ethers.JsonRpcProvider,
    wallet: Wallet,
    chainId: number = 1,
    maxBlocksToTry: number = 5
  ) {
    this.provider = provider;
    this.wallet = wallet;
    this.flashbots = new FlashbotsProvider(provider, wallet, chainId);
    this.maxBlocksToTry = maxBlocksToTry;
  }

  /**
   * Execute a liquidation via Flashbots
   */
  async executeLiquidation(
    liquidationEngine: ethers.Contract,
    borrower: string,
    collateralToken: string,
    debtToRepay: bigint,
    priorityFeeGwei: number = 3
  ): Promise<{ success: boolean; txHash?: string; blockNumber?: number; error?: string }> {
    logger.info(`Preparing Flashbots bundle for liquidation of ${borrower}`);

    // Build the transaction
    const tx = await liquidationEngine.liquidate.populateTransaction(
      borrower,
      collateralToken,
      debtToRepay
    );

    // Get current block and nonce
    const currentBlock = await this.provider.getBlockNumber();
    const nonce = await this.provider.getTransactionCount(this.wallet.address);
    const feeData = await this.provider.getFeeData();

    // Set gas parameters
    tx.from = this.wallet.address;
    tx.nonce = nonce;
    tx.gasLimit = 500000n;
    tx.chainId = (await this.provider.getNetwork()).chainId;
    tx.type = 2; // EIP-1559
    tx.maxFeePerGas = feeData.maxFeePerGas! * 2n; // 2x buffer
    tx.maxPriorityFeePerGas = ethers.parseUnits(priorityFeeGwei.toString(), "gwei");

    // Sign the transaction
    const signedTx = await this.wallet.signTransaction(tx);
    logger.info(`Transaction signed, nonce: ${nonce}`);

    // Try to include in the next N blocks
    for (let i = 0; i < this.maxBlocksToTry; i++) {
      const targetBlock = currentBlock + 1 + i;
      logger.info(`Attempting inclusion in block ${targetBlock}`);

      try {
        // Simulate first
        const simulation = await this.flashbots.simulateBundle([signedTx], targetBlock);

        if (!simulation.success) {
          logger.error(`Simulation failed: ${simulation.error}`);
          return { success: false, error: simulation.error };
        }

        logger.info(`Simulation successful, gas used: ${simulation.results[0]?.gasUsed}`);

        // Send bundle
        const bundleResponse = await this.flashbots.sendBundle([signedTx], targetBlock);
        logger.info(`Bundle submitted: ${bundleResponse.bundleHash}`);

        // Wait for block
        await this.waitForBlock(targetBlock);

        // Check if included
        const stats = await this.flashbots.getBundleStats(
          bundleResponse.bundleHash,
          targetBlock
        );

        if (stats.isSentToMiners) {
          // Check if transaction was actually included
          const receipt = await this.provider.getTransactionReceipt(
            ethers.keccak256(signedTx)
          );

          if (receipt && receipt.blockNumber === targetBlock) {
            logger.info(`✅ Bundle included in block ${targetBlock}!`);
            return {
              success: true,
              txHash: receipt.hash,
              blockNumber: targetBlock,
            };
          }
        }

        logger.warn(`Bundle not included in block ${targetBlock}, retrying...`);
      } catch (error: any) {
        logger.error(`Error submitting to block ${targetBlock}: ${error.message}`);
      }
    }

    logger.error(`Failed to include bundle after ${this.maxBlocksToTry} blocks`);
    return { success: false, error: "Bundle not included after max attempts" };
  }

  /**
   * Execute with fallback to regular transaction
   */
  async executeWithFallback(
    liquidationEngine: ethers.Contract,
    borrower: string,
    collateralToken: string,
    debtToRepay: bigint,
    useFlashbots: boolean = true
  ): Promise<{ success: boolean; txHash?: string; method: "flashbots" | "regular" }> {
    if (useFlashbots) {
      const result = await this.executeLiquidation(
        liquidationEngine,
        borrower,
        collateralToken,
        debtToRepay
      );

      if (result.success) {
        return { success: true, txHash: result.txHash, method: "flashbots" };
      }

      logger.warn("Flashbots failed, falling back to regular transaction");
    }

    // Regular transaction fallback
    try {
      const tx = await liquidationEngine.liquidate(
        borrower,
        collateralToken,
        debtToRepay,
        { gasLimit: 500000n }
      );

      const receipt = await tx.wait();
      return {
        success: receipt.status === 1,
        txHash: receipt.hash,
        method: "regular",
      };
    } catch (error: any) {
      logger.error(`Regular transaction failed: ${error.message}`);
      return { success: false, method: "regular" };
    }
  }

  private async waitForBlock(blockNumber: number): Promise<void> {
    return new Promise((resolve) => {
      const checkBlock = async () => {
        const current = await this.provider.getBlockNumber();
        if (current >= blockNumber) {
          resolve();
        } else {
          setTimeout(checkBlock, 1000);
        }
      };
      checkBlock();
    });
  }
}

/**
 * Private transaction sender (for networks with private mempools)
 */
export class PrivateTxSender {
  private provider: ethers.JsonRpcProvider;
  private wallet: Wallet;

  // Private RPC endpoints
  private static PRIVATE_RPCS: Record<string, string> = {
    flashbots_protect: "https://rpc.flashbots.net",
    mev_blocker: "https://rpc.mevblocker.io",
    securerpc: "https://api.securerpc.com/v1",
  };

  constructor(provider: ethers.JsonRpcProvider, wallet: Wallet) {
    this.provider = provider;
    this.wallet = wallet;
  }

  /**
   * Send transaction via Flashbots Protect RPC
   * This prevents your transaction from being seen in the public mempool
   */
  async sendPrivate(
    to: string,
    data: string,
    value: bigint = 0n,
    gasLimit: bigint = 500000n
  ): Promise<string> {
    const privateProvider = new ethers.JsonRpcProvider(
      PrivateTxSender.PRIVATE_RPCS.flashbots_protect
    );
    const privateWallet = this.wallet.connect(privateProvider);

    const tx = await privateWallet.sendTransaction({
      to,
      data,
      value,
      gasLimit,
    });

    logger.info(`Private transaction sent: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Send via MEV Blocker (refunds MEV to user)
   */
  async sendViaMEVBlocker(
    to: string,
    data: string,
    value: bigint = 0n
  ): Promise<string> {
    const mevBlockerProvider = new ethers.JsonRpcProvider(
      PrivateTxSender.PRIVATE_RPCS.mev_blocker
    );
    const mevBlockerWallet = this.wallet.connect(mevBlockerProvider);

    const tx = await mevBlockerWallet.sendTransaction({
      to,
      data,
      value,
    });

    logger.info(`MEV Blocker transaction sent: ${tx.hash}`);
    return tx.hash;
  }
}

export default MEVProtectedExecutor;
