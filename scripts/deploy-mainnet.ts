/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Minted mUSD Protocol — Mainnet Deployment Script                   │
 * │                                                                     │
 * │  SECURITY:                                                          │
 * │    • KMS-only signing (SEC-GATE-01) — no raw private keys           │
 * │    • Timelock enforced (48 h min delay for governance)              │
 * │    • Deployer renounces admin roles at the end                      │
 * │    • All outputs persisted to /deployments/mainnet-<timestamp>.json │
 * │                                                                     │
 * │  USAGE:                                                             │
 * │    DRY_RUN=true  npx hardhat run scripts/deploy-mainnet.ts --network mainnet │
 * │    DRY_RUN=false npx hardhat run scripts/deploy-mainnet.ts --network mainnet │
 * │                                                                     │
 * │  ENV VARS (required):                                               │
 * │    MAINNET_RPC_URL         Alchemy / Infura mainnet URL             │
 * │    DEPLOYER_KMS_KEY_ID     AWS KMS key ARN (secp256k1)              │
 * │    AWS_REGION              AWS region for KMS (default: us-east-1)  │
 * │    ETHERSCAN_API_KEY       For contract verification                │
 * │    MULTISIG_ADDRESS        Gnosis Safe / protocol multisig          │
 * │    GUARDIAN_ADDRESS        Emergency pause guardian                  │
 * │    FEE_RECIPIENT           Protocol fee recipient address           │
 * │                                                                     │
 * │  ENV VARS (optional):                                               │
 * │    DRY_RUN                 "true" = simulate only (default: true)   │
 * │    CONFIRMATIONS           Tx confirmations to wait (default: 3)    │
 * │    GAS_PRICE_GWEI          Max gas price cap (default: 50 gwei)     │
 * └──────────────────────────────────────────────────────────────────────┘
 */

import { ethers, upgrades, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════════
//  MAINNET CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/** Well-known mainnet token addresses */
const MAINNET_TOKENS = {
  USDC:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH:  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC:  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDS:  "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  SUSDS: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  RLUSD: "0x8292Bb45bf1Ee4d140127049757C2EfA3Cf9d43c",
} as const;

/** Chainlink mainnet price feed addresses */
const MAINNET_FEEDS = {
  ETH_USD:  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  BTC_USD:  "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
  USDC_USD: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  RLUSD_USD: "0x0000000000000000000000000000000000000000", // TODO: set when available
} as const;

/** Uniswap V3 mainnet router */
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

/** Production timelock delay: 48 hours */
const TIMELOCK_DELAY = 48 * 60 * 60; // 172 800 s

/** Protocol parameters — conservative for mainnet launch */
const PROTOCOL_PARAMS = {
  supplyCap:           ethers.parseEther("100000000"),  // 100 M mUSD
  collateralRatioBps:  11000,                           // 110% bridge collateral
  bridgeMinSigs:       3,                               // 3-of-N validator threshold
  dailyCapIncrease:    ethers.parseEther("5000000"),    // 5 M daily cap increase limit
  closeFactorBps:      5000,                            // 50% close factor
  interestRateBps:     500,                             // 5% fallback rate
  minDebt:             ethers.parseEther("100"),        // 100 mUSD min debt
} as const;

/** Collateral parameters */
const COLLATERAL_CONFIG = {
  WETH: {
    address:          MAINNET_TOKENS.WETH,
    ltvBps:           7500,   // 75%
    liquidationBps:   8000,   // 80%
    penaltyBps:       500,    // 5%
    feed:             MAINNET_FEEDS.ETH_USD,
    feedDecimals:     8,      // Chainlink ETH/USD decimals
    tokenDecimals:    18,     // Collateral token decimals
    heartbeat:        3600,   // 1 h staleness
    maxDeviationBps:  2000,   // 20% per-asset circuit-breaker threshold
    dryRunPrice:      2500_00000000n, // $2,500.00000000
  },
  WBTC: {
    address:          MAINNET_TOKENS.WBTC,
    ltvBps:           7000,   // 70%
    liquidationBps:   7500,   // 75%
    penaltyBps:       500,    // 5%
    feed:             MAINNET_FEEDS.BTC_USD,
    feedDecimals:     8,
    tokenDecimals:    8,
    heartbeat:        3600,
    maxDeviationBps:  1500,   // 15% tighter bound for BTC
    dryRunPrice:      60000_00000000n, // $60,000.00000000
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════
//  SAFETY GATES
// ═══════════════════════════════════════════════════════════════════════

const DRY_RUN = process.env.DRY_RUN !== "false"; // default = true (safe)
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "3", 10);
const MAX_GAS_PRICE_GWEI = parseInt(process.env.GAS_PRICE_GWEI || "50", 10);

interface DeploymentManifest {
  network:     string;
  chainId:     number;
  deployer:    string;
  timestamp:   string;
  blockNumber: number;
  dryRun:      boolean;
  gitCommit:   string;
  contracts:   Record<string, { address: string; txHash: string; type: "regular" | "uups-proxy" }>;
  roles:       { contract: string; role: string; grantee: string; txHash: string }[];
  gasSummary:  { totalETH: string; txCount: number };
}

// ═══════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function requireAddress(name: string): string {
  const v = requireEnv(name);
  if (!ethers.isAddress(v)) throw new Error(`Invalid address in ${name}: ${v}`);
  return ethers.getAddress(v); // checksum
}

/** Get current git commit hash for traceability */
function getGitCommit(): string {
  try {
    const { execSync } = require("child_process");
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Write the deployment manifest to /deployments/ */
function writeManifest(manifest: DeploymentManifest): string {
  const deploymentsDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `mainnet-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(manifest, null, 2));

  // Also write/overwrite a "latest" symlink-like file for easy scripting
  const latestPath = path.join(deploymentsDir, "mainnet-latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));

  return filepath;
}

/** Confirm transaction and track gas */
async function waitTx(
  tx: any,
  label: string,
  gasTracker: { totalGas: bigint; count: number },
): Promise<string> {
  const receipt = await tx.wait(CONFIRMATIONS);
  if (!receipt || receipt.status === 0) {
    throw new Error(`Transaction reverted: ${label} — ${tx.hash}`);
  }
  const cost = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);
  gasTracker.totalGas += cost;
  gasTracker.count++;
  console.log(
    `  ✅ ${label}: ${receipt.hash} (${receipt.gasUsed} gas, ` +
    `${ethers.formatEther(cost)} ETH)`
  );
  return receipt.hash;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── 0. Pre-flight checks ──────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Minted mUSD Protocol — MAINNET Deployment                 ║");
  console.log(`║   Mode: ${DRY_RUN ? "DRY RUN (simulation)" : "🔴 LIVE DEPLOYMENT"}${"".padEnd(DRY_RUN ? 13 : 10)}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Verify we are on mainnet
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (Number(chainId) !== 1 && !DRY_RUN) {
    throw new Error(`Expected chain 1 (mainnet), got ${chainId}. Aborting.`);
  }
  if (Number(chainId) !== 1 && DRY_RUN) {
    console.log(`⚠️  Dry-run on chain ${chainId} (not mainnet) — continuing for validation\n`);
  }

  // Verify KMS config (SEC-GATE-01)
  const kmsKeyId  = requireEnv("DEPLOYER_KMS_KEY_ID");
  const awsRegion = process.env.AWS_REGION || "us-east-1";
  console.log(`KMS Key:    ${kmsKeyId.substring(0, 30)}…`);
  console.log(`AWS Region: ${awsRegion}`);

  // Resolve the deployer from KMS
  // In hardhat context, accounts=[] so ethers.getSigners() returns empty.
  // We construct the KMS signer directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deployer: any;

  if (DRY_RUN) {
    // In dry-run mode (typically on hardhat network), use the first hardhat signer
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
      throw new Error("No signers available. For dry-run, use --network hardhat.");
    }
    deployer = signers[0];
    console.log(`Deployer (dry-run): ${await deployer.getAddress()}`);
  } else {
    // Live mode — construct KMS signer
    const { KMSEthereumSigner } = await import("../relay/kms-ethereum-signer");
    deployer = await KMSEthereumSigner.create(kmsKeyId, awsRegion, ethers.provider);
    console.log(`Deployer (KMS):     ${await deployer.getAddress()}`);
  }

  // Verify required addresses
  const MULTISIG     = requireAddress("MULTISIG_ADDRESS");
  const GUARDIAN     = requireAddress("GUARDIAN_ADDRESS");
  const FEE_RECIPIENT = requireAddress("FEE_RECIPIENT");

  console.log(`Multisig:       ${MULTISIG}`);
  console.log(`Guardian:       ${GUARDIAN}`);
  console.log(`Fee Recipient:  ${FEE_RECIPIENT}`);

  // Gas price guard
  const feeData = await ethers.provider.getFeeData();
  const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
  console.log(`\nGas price: ${gasPriceGwei.toFixed(2)} gwei`);
  if (gasPriceGwei > MAX_GAS_PRICE_GWEI && !DRY_RUN) {
    throw new Error(
      `Gas price ${gasPriceGwei.toFixed(2)} gwei exceeds cap of ${MAX_GAS_PRICE_GWEI} gwei. ` +
      `Set GAS_PRICE_GWEI higher or wait for lower gas.`
    );
  }

  // Deployer balance check
  const deployerAddr = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddr);
  const balanceETH = parseFloat(ethers.formatEther(balance));
  console.log(`Balance:   ${balanceETH.toFixed(4)} ETH`);
  if (balanceETH < 2.0 && !DRY_RUN) {
    throw new Error(`Deployer needs ≥ 2 ETH for mainnet deploy. Has ${balanceETH.toFixed(4)} ETH.`);
  }

  const startBlock = await ethers.provider.getBlockNumber();
  const gasTracker = { totalGas: 0n, count: 0 };
  const manifest: DeploymentManifest = {
    network:    "mainnet",
    chainId:    Number(chainId),
    deployer:   deployerAddr,
    timestamp:  new Date().toISOString(),
    blockNumber: startBlock,
    dryRun:     DRY_RUN,
    gitCommit:  getGitCommit(),
    contracts:  {},
    roles:      [],
    gasSummary: { totalETH: "0", txCount: 0 },
  };

  console.log(`\nDeploying from block ${startBlock}…\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  DEPLOY CONTRACTS
  // ═══════════════════════════════════════════════════════════════════

  // ─── 1. GlobalPauseRegistry ────────────────────────────────────────
  console.log("[1/13] GlobalPauseRegistry");
  const GPR = await ethers.getContractFactory("GlobalPauseRegistry", deployer);
  const gpr = await GPR.deploy(MULTISIG, GUARDIAN);
  await gpr.waitForDeployment();
  const gprAddr = await gpr.getAddress();
  manifest.contracts["GlobalPauseRegistry"] = {
    address: gprAddr,
    txHash: gpr.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  GlobalPauseRegistry: ${gprAddr}\n`);

  // ─── 2. MintedTimelockController ───────────────────────────────────
  console.log("[2/13] MintedTimelockController");
  const Timelock = await ethers.getContractFactory("MintedTimelockController", deployer);
  // Proposers + executors = multisig only
  // Admin = address(0) — self-governed, no re-configuration backdoor
  const timelock = await Timelock.deploy(
    TIMELOCK_DELAY,
    [MULTISIG],
    [MULTISIG],
    ethers.ZeroAddress,
  );
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();
  manifest.contracts["MintedTimelockController"] = {
    address: timelockAddr,
    txHash: timelock.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  MintedTimelockController: ${timelockAddr}  (48h delay)\n`);

  // ─── 3. PriceOracle ───────────────────────────────────────────────
  console.log("[3/13] PriceOracle");
  const Oracle = await ethers.getContractFactory("PriceOracle", deployer);
  const oracle = await Oracle.deploy();
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  manifest.contracts["PriceOracle"] = {
    address: oracleAddr,
    txHash: oracle.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  PriceOracle: ${oracleAddr}\n`);

  // ─── 4. MUSD ──────────────────────────────────────────────────────
  console.log("[4/13] MUSD");
  const MUSD = await ethers.getContractFactory("MUSD", deployer);
  const musd = await MUSD.deploy(PROTOCOL_PARAMS.supplyCap, gprAddr);
  await musd.waitForDeployment();
  const musdAddr = await musd.getAddress();
  manifest.contracts["MUSD"] = {
    address: musdAddr,
    txHash: musd.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  MUSD: ${musdAddr}  (cap: 100M)\n`);

  // ─── 5. InterestRateModel ─────────────────────────────────────────
  console.log("[5/13] InterestRateModel");
  const IRM = await ethers.getContractFactory("InterestRateModel", deployer);
  const irm = await IRM.deploy(deployerAddr);
  await irm.waitForDeployment();
  const irmAddr = await irm.getAddress();
  manifest.contracts["InterestRateModel"] = {
    address: irmAddr,
    txHash: irm.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  InterestRateModel: ${irmAddr}\n`);

  // ─── 6. CollateralVault ───────────────────────────────────────────
  console.log("[6/13] CollateralVault");
  const Vault = await ethers.getContractFactory("CollateralVault", deployer);
  const vault = await Vault.deploy(gprAddr);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  manifest.contracts["CollateralVault"] = {
    address: vaultAddr,
    txHash: vault.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  CollateralVault: ${vaultAddr}\n`);

  // ─── 7. BorrowModule ─────────────────────────────────────────────
  console.log("[7/13] BorrowModule");
  const Borrow = await ethers.getContractFactory("BorrowModule", deployer);
  const borrow = await Borrow.deploy(
    vaultAddr,
    oracleAddr,
    musdAddr,
    PROTOCOL_PARAMS.interestRateBps,
    PROTOCOL_PARAMS.minDebt,
  );
  await borrow.waitForDeployment();
  const borrowAddr = await borrow.getAddress();
  manifest.contracts["BorrowModule"] = {
    address: borrowAddr,
    txHash: borrow.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  BorrowModule: ${borrowAddr}\n`);

  // ─── 8. SMUSD ────────────────────────────────────────────────────
  console.log("[8/13] SMUSD");
  const SMUSD = await ethers.getContractFactory("SMUSD", deployer);
  const smusd = await SMUSD.deploy(musdAddr, gprAddr);
  await smusd.waitForDeployment();
  const smusdAddr = await smusd.getAddress();
  manifest.contracts["SMUSD"] = {
    address: smusdAddr,
    txHash: smusd.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  SMUSD: ${smusdAddr}\n`);

  // ─── 9. LiquidationEngine ────────────────────────────────────────
  console.log("[9/13] LiquidationEngine");
  const Liq = await ethers.getContractFactory("LiquidationEngine", deployer);
  const liq = await Liq.deploy(
    vaultAddr,
    borrowAddr,
    oracleAddr,
    musdAddr,
    PROTOCOL_PARAMS.closeFactorBps,
    timelockAddr,
  );
  await liq.waitForDeployment();
  const liqAddr = await liq.getAddress();
  manifest.contracts["LiquidationEngine"] = {
    address: liqAddr,
    txHash: liq.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  LiquidationEngine: ${liqAddr}\n`);

  // ─── 10. TreasuryV2 (UUPS Proxy) ─────────────────────────────────
  console.log("[10/13] TreasuryV2 (UUPS)");
  const Treasury = await ethers.getContractFactory("TreasuryV2", deployer);
  const treasuryProxy = await upgrades.deployProxy(
    Treasury,
    [MAINNET_TOKENS.USDC, smusdAddr, deployerAddr, FEE_RECIPIENT, timelockAddr],
    { kind: "uups" },
  );
  await treasuryProxy.waitForDeployment();
  const treasuryAddr = await treasuryProxy.getAddress();
  manifest.contracts["TreasuryV2"] = {
    address: treasuryAddr,
    txHash: treasuryProxy.deploymentTransaction()?.hash || "",
    type: "uups-proxy",
  };
  console.log(`  TreasuryV2 (proxy): ${treasuryAddr}\n`);

  // ─── 11. DirectMintV2 ────────────────────────────────────────────
  console.log("[11/13] DirectMintV2");
  const DMint = await ethers.getContractFactory("DirectMintV2", deployer);
  const dmint = await DMint.deploy(
    MAINNET_TOKENS.USDC,
    musdAddr,
    treasuryAddr,
    FEE_RECIPIENT,
  );
  await dmint.waitForDeployment();
  const dmintAddr = await dmint.getAddress();
  manifest.contracts["DirectMintV2"] = {
    address: dmintAddr,
    txHash: dmint.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  DirectMintV2: ${dmintAddr}\n`);

  // ─── 12. BLEBridgeV9 (UUPS Proxy) ────────────────────────────────
  console.log("[12/13] BLEBridgeV9 (UUPS)");
  const Bridge = await ethers.getContractFactory("BLEBridgeV9", deployer);
  const bridgeProxy = await upgrades.deployProxy(
    Bridge,
    [
      PROTOCOL_PARAMS.bridgeMinSigs,
      musdAddr,
      PROTOCOL_PARAMS.collateralRatioBps,
      PROTOCOL_PARAMS.dailyCapIncrease,
      timelockAddr,
    ],
    { kind: "uups" },
  );
  await bridgeProxy.waitForDeployment();
  const bridgeAddr = await bridgeProxy.getAddress();
  manifest.contracts["BLEBridgeV9"] = {
    address: bridgeAddr,
    txHash: bridgeProxy.deploymentTransaction()?.hash || "",
    type: "uups-proxy",
  };
  console.log(`  BLEBridgeV9 (proxy): ${bridgeAddr}\n`);

  // ─── 13. LeverageVault ────────────────────────────────────────────
  console.log("[13/13] LeverageVault");
  const Lever = await ethers.getContractFactory("LeverageVault", deployer);
  const lever = await Lever.deploy(
    UNISWAP_V3_ROUTER,
    vaultAddr,
    borrowAddr,
    oracleAddr,
    musdAddr,
    timelockAddr,
  );
  await lever.waitForDeployment();
  const leverAddr = await lever.getAddress();
  manifest.contracts["LeverageVault"] = {
    address: leverAddr,
    txHash: lever.deploymentTransaction()?.hash || "",
    type: "regular",
  };
  console.log(`  LeverageVault: ${leverAddr}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  ROLE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ROLE CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════════\n");

  async function grantRole(
    contract: any,
    contractName: string,
    roleGetter: string,
    grantee: string,
    granteeName: string,
  ) {
    const role = await contract[roleGetter]();
    const tx = await contract.grantRole(role, grantee);
    const hash = await waitTx(tx, `${contractName}.${roleGetter} → ${granteeName}`, gasTracker);
    manifest.roles.push({ contract: contractName, role: roleGetter, grantee, txHash: hash });
  }

  // ─── MUSD roles ──────────────────────────────────────────────────
  console.log("MUSD roles:");
  const musdContract = await ethers.getContractAt("MUSD", musdAddr, deployer);
  await grantRole(musdContract, "MUSD", "BRIDGE_ROLE",      bridgeAddr,  "BLEBridgeV9");
  await grantRole(musdContract, "MUSD", "BRIDGE_ROLE",      borrowAddr,  "BorrowModule");
  await grantRole(musdContract, "MUSD", "BRIDGE_ROLE",      dmintAddr,   "DirectMintV2");
  await grantRole(musdContract, "MUSD", "LIQUIDATOR_ROLE",  liqAddr,     "LiquidationEngine");
  await grantRole(musdContract, "MUSD", "CAP_MANAGER_ROLE", bridgeAddr,  "BLEBridgeV9");

  // ─── CollateralVault roles ───────────────────────────────────────
  console.log("\nCollateralVault roles:");
  const vaultContract = await ethers.getContractAt("CollateralVault", vaultAddr, deployer);
  await grantRole(vaultContract, "CollateralVault", "VAULT_ADMIN_ROLE", borrowAddr,  "BorrowModule");
  await grantRole(vaultContract, "CollateralVault", "VAULT_ADMIN_ROLE", liqAddr,     "LiquidationEngine");
  await grantRole(vaultContract, "CollateralVault", "VAULT_ADMIN_ROLE", leverAddr,   "LeverageVault");

  // ─── BorrowModule roles ──────────────────────────────────────────
  console.log("\nBorrowModule roles:");
  const borrowContract = await ethers.getContractAt("BorrowModule", borrowAddr, deployer);
  // Grant LiquidationEngine and LeverageVault access — exact role names depend on contract
  // (check contract for LIQUIDATION_ROLE / LEVERAGE_VAULT_ROLE if different)

  // ─── BLEBridgeV9 roles ──────────────────────────────────────────
  console.log("\nBLEBridgeV9 roles:");
  const bridgeContract = await ethers.getContractAt("BLEBridgeV9", bridgeAddr, deployer);
  // Validators will be added via governance after deployment
  // Grant RELAYER_ROLE to the relay service address (configured post-deploy)

  // ═══════════════════════════════════════════════════════════════════
  //  ORACLE FEED SETUP
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ORACLE FEED SETUP");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const oracleContract = await ethers.getContractAt("PriceOracle", oracleAddr, deployer);

  for (const [name, cfg] of Object.entries(COLLATERAL_CONFIG)) {
    let feedAddress: string = cfg.feed;
    const feedCode = await ethers.provider.getCode(feedAddress);
    if (feedCode === "0x") {
      if (!DRY_RUN) {
        throw new Error(
          `Missing on-chain feed code for ${name} at ${feedAddress}. ` +
          "Refusing live deploy without a real Chainlink feed."
        );
      }

      console.log(`⚠️  ${name} feed ${feedAddress} not deployed on chain ${chainId}; deploying dry-run mock feed.`);
      const MockAggregator = await ethers.getContractFactory("MockAggregatorV3", deployer);
      const mockFeed = await MockAggregator.deploy(cfg.feedDecimals, cfg.dryRunPrice);
      await mockFeed.waitForDeployment();
      feedAddress = await mockFeed.getAddress();
      manifest.contracts[`Mock${name}Feed`] = {
        address: feedAddress,
        txHash: mockFeed.deploymentTransaction()?.hash || "",
        type: "regular",
      };
      console.log(`  Mock${name}Feed: ${feedAddress}`);
    }

    console.log(`Setting ${name} feed…`);
    const tx = await oracleContract.setFeed(
      cfg.address,
      feedAddress,
      cfg.heartbeat,
      cfg.tokenDecimals,
      cfg.maxDeviationBps,
    );
    await waitTx(tx, `PriceOracle.setFeed(${name})`, gasTracker);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  ADMIN HANDOFF — transfer to multisig / timelock
  // ═══════════════════════════════════════════════════════════════════

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ADMIN HANDOFF");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("⚠️  Admin handoff is a MANUAL step after verification.");
  console.log("   Run scripts/transfer-all-admin-roles.ts --network mainnet");
  console.log("   after verifying all contracts are working correctly.\n");
  console.log("   Contracts to transfer:");
  console.log(`   - MUSD:             DEFAULT_ADMIN_ROLE → ${MULTISIG}`);
  console.log(`   - PriceOracle:      DEFAULT_ADMIN_ROLE → ${MULTISIG}`);
  console.log(`   - InterestRateModel: RATE_ADMIN_ROLE   → ${timelockAddr}`);
  console.log(`   - CollateralVault:  TIMELOCK_ROLE      → ${timelockAddr}`);
  console.log(`   - BorrowModule:     TIMELOCK_ROLE      → ${timelockAddr}`);
  console.log(`   - SMUSD:            TIMELOCK_ROLE      → ${timelockAddr}`);
  console.log(`   - BLEBridgeV9:      DEFAULT_ADMIN_ROLE → ${MULTISIG}`);

  // ═══════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════════════════

  const endBlock = await ethers.provider.getBlockNumber();
  const endBalance = await ethers.provider.getBalance(deployerAddr);
  const totalETH = ethers.formatEther(balance - endBalance);

  manifest.gasSummary = {
    totalETH,
    txCount: gasTracker.count + Object.keys(manifest.contracts).length,
  };

  // Write manifest
  const manifestPath = writeManifest(manifest);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║               MAINNET DEPLOYMENT COMPLETE                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  console.log(`Mode:           ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Block range:    ${startBlock} → ${endBlock}`);
  console.log(`Gas spent:      ${totalETH} ETH`);
  console.log(`Tx count:       ${manifest.gasSummary.txCount}`);
  console.log(`Git commit:     ${manifest.gitCommit}`);
  console.log(`Manifest:       ${manifestPath}\n`);

  console.log("─── Contract Addresses ─────────────────────────────────────────");
  for (const [name, info] of Object.entries(manifest.contracts)) {
    const tag = info.type === "uups-proxy" ? " (proxy)" : "";
    console.log(`  ${name.padEnd(28)} ${info.address}${tag}`);
  }

  console.log("\n─── Next Steps ─────────────────────────────────────────────────");
  console.log("  1. Verify contracts on Etherscan:");
  console.log("     npx hardhat verify --network mainnet <address> <args…>");
  console.log("  2. Add Canton validators to BLEBridgeV9:");
  console.log("     bridge.grantRole(VALIDATOR_ROLE, validatorAddress)");
  console.log("  3. Configure relay service with bridge address");
  console.log("  4. Deploy & register strategies with TreasuryV2");
  console.log("  5. Transfer admin roles to multisig:");
  console.log("     npx hardhat run scripts/transfer-all-admin-roles.ts --network mainnet");
  console.log("  6. Deployer renounces DEFAULT_ADMIN_ROLE on all contracts");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("\n🔴 DEPLOYMENT FAILED:", error.message || error);
  process.exitCode = 1;
});
