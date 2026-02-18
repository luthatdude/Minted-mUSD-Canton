import { HardhatUserConfig, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";

dotenv.config();

// ── KMS-OR-RAW SIGNER SELECTION ──────────────────────────────────────────────
// SEC-GATE-01: Mainnet MUST use KMS. Raw private keys are forbidden on chain 1.
// For testnets, raw keys are tolerated but emit a deprecation warning.
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const DEPLOYER_KMS_KEY_ID = process.env.DEPLOYER_KMS_KEY_ID || "";
const RPC_URL = process.env.RPC_URL || "";
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || "";
const FORBIDDEN_SOURCE_SEGMENTS = ["/certora/", "/harness/"] as const;

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, async (_taskArgs, _hre, runSuper) => {
  const sourcePaths: string[] = await runSuper();
  return sourcePaths.filter((sourcePath) => {
    const normalizedPath = sourcePath.replace(/\\/g, "/").toLowerCase();
    return !FORBIDDEN_SOURCE_SEGMENTS.some((segment) => normalizedPath.includes(segment));
  });
});

// Hard gate: reject raw private key on mainnet at config-load time
if (MAINNET_RPC_URL && DEPLOYER_PRIVATE_KEY && !DEPLOYER_KMS_KEY_ID) {
  throw new Error(
    "SECURITY: DEPLOYER_PRIVATE_KEY is forbidden on mainnet. " +
    "Set DEPLOYER_KMS_KEY_ID (AWS KMS key ARN) instead. " +
    "Raw keys stay in V8 heap memory and are extractable via core dumps."
  );
}

// Deprecation warning for testnet raw key usage
if (DEPLOYER_PRIVATE_KEY && !DEPLOYER_KMS_KEY_ID) {
  console.warn(
    "⚠️  DEPRECATED: DEPLOYER_PRIVATE_KEY is deprecated and will be removed. " +
    "Migrate to DEPLOYER_KMS_KEY_ID for HSM-backed signing. " +
    "See relay/kms-ethereum-signer.ts for setup."
  );
}

// solidity-coverage sets SOLIDITY_COVERAGE=true during instrumented compilation.
// viaIR is needed to avoid "Stack too deep" errors from the extra instrumentation
// variables, but it slows compilation ~3x so we only enable it for coverage runs.
const isCoverage = process.env.SOLIDITY_COVERAGE === "true";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.26",
        settings: {
          viaIR: isCoverage,
          optimizer: {
            enabled: true,
            runs: isCoverage ? 1 : 200, // low runs + viaIR avoids stack-too-deep
          },
        },
      },
    ],
    overrides: {
      // PendleStrategyV2 exceeds EIP-3860 initcode limit (49 KB) without viaIR.
      // Always enable viaIR + runs=1 to shrink bytecode enough for deployment.
      "contracts/strategies/PendleStrategyV2.sol": {
        version: "0.8.26",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
          },
        },
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: RPC_URL,
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // ─── MAINNET (chain 1) ─────────────────────────────────────────────
    // SEC-GATE-01: Mainnet requires KMS signing — no raw accounts array.
    // Deploy scripts must use the KMS signer from relay/kms-ethereum-signer.ts.
    // The empty accounts array ensures `npx hardhat run --network mainnet`
    // fails fast if someone tries to use the default signer.
    mainnet: {
      url: MAINNET_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/PLACEHOLDER",
      chainId: 1,
      accounts: [], // KMS only — raw keys forbidden (see SEC-GATE-01)

      // Production-grade gas & timeout settings
      gas: "auto",
      gasPrice: "auto",
      gasMultiplier: 1.2,             // 20% buffer for fluctuations
      timeout: 300_000,               // 5 min — mainnet inclusion can be slow
      httpHeaders: {},

      // Require multiple confirmations before treating a tx as finalized
      // Hardhat default is 1; for mainnet we want more assurance
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
    },
  },
};

export default config;
