import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

// Changed from well-known private key (0x...001 = known address 0x7E5F...) to empty string.
// The old default loaded a real private key into memory even when not deploying.
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const RPC_URL = process.env.RPC_URL || "";

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
    // Removed deprecated Goerli (shut down). Keeping stale testnets creates confusion.
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};

export default config;
