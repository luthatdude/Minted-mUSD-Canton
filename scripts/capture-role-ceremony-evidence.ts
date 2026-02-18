import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type Json = Record<string, any>;

type RoleCheck = {
  contract: string;
  role: string;
  roleHash: string;
  granteeLabel: string;
  grantee: string;
  hasRole: boolean;
};

const ACCESS_CONTROL_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

function roleHash(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function ensureAddress(name: string, value?: string): string {
  if (!value) {
    throw new Error(`Missing address for ${name}`);
  }
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${name}: ${value}`);
  }
  return ethers.getAddress(value);
}

function loadJson(filePath: string): Json {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveDeploymentFile(): string {
  const explicit = process.env.DEPLOYMENT_FILE;
  if (explicit) {
    return path.resolve(process.cwd(), explicit);
  }

  // Prefer network-scoped deployment files, then fall back to repository-level map.
  const candidates = [
    path.resolve(process.cwd(), `deployments/${network.name}.json`),
    path.resolve(process.cwd(), "deployed-addresses.json"),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  throw new Error(
    "No deployment file found. Set DEPLOYMENT_FILE or provide deployments/<network>.json / deployed-addresses.json."
  );
}

function extractContracts(deployment: Json): Record<string, string> {
  const c = deployment.contracts;
  if (!c || typeof c !== "object") {
    throw new Error("Deployment file missing `contracts` object");
  }

  // Some manifests store contract entries as objects with `address`.
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(c)) {
    if (typeof value === "string") {
      out[name] = value;
      continue;
    }
    if (value && typeof value === "object" && typeof (value as any).address === "string") {
      out[name] = (value as any).address;
    }
  }
  return out;
}

async function main() {
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId === 31337) {
    throw new Error("Refusing to produce role ceremony evidence on local chainId 31337.");
  }

  const requiredChainId = process.env.REQUIRE_CHAIN_ID
    ? Number(process.env.REQUIRE_CHAIN_ID)
    : undefined;
  if (requiredChainId && chainId !== requiredChainId) {
    throw new Error(`Expected chainId ${requiredChainId}, got ${chainId}`);
  }

  const deploymentFile = resolveDeploymentFile();
  const deployment = loadJson(deploymentFile);
  const contracts = extractContracts(deployment);

  if (typeof deployment.dryRun === "boolean" && deployment.dryRun) {
    throw new Error(`Deployment file ${deploymentFile} indicates dryRun=true; need non-dry-run evidence.`);
  }

  const addresses = {
    MUSD: ensureAddress("MUSD", contracts.MUSD),
    CollateralVault: ensureAddress("CollateralVault", contracts.CollateralVault),
    BorrowModule: ensureAddress("BorrowModule", contracts.BorrowModule),
    LiquidationEngine: ensureAddress("LiquidationEngine", contracts.LiquidationEngine),
    DirectMintV2: ensureAddress("DirectMintV2", contracts.DirectMintV2 || contracts.DirectMint),
    BLEBridgeV9: ensureAddress("BLEBridgeV9", contracts.BLEBridgeV9),
    LeverageVault: ensureAddress("LeverageVault", contracts.LeverageVault),
  };

  const checks: Array<{
    contract: string;
    contractAddress: string;
    role: string;
    granteeLabel: string;
    grantee: string;
  }> = [
    {
      contract: "MUSD",
      contractAddress: addresses.MUSD,
      role: "BRIDGE_ROLE",
      granteeLabel: "DirectMintV2",
      grantee: addresses.DirectMintV2,
    },
    {
      contract: "MUSD",
      contractAddress: addresses.MUSD,
      role: "BRIDGE_ROLE",
      granteeLabel: "BorrowModule",
      grantee: addresses.BorrowModule,
    },
    {
      contract: "MUSD",
      contractAddress: addresses.MUSD,
      role: "BRIDGE_ROLE",
      granteeLabel: "BLEBridgeV9",
      grantee: addresses.BLEBridgeV9,
    },
    {
      contract: "MUSD",
      contractAddress: addresses.MUSD,
      role: "LIQUIDATOR_ROLE",
      granteeLabel: "LiquidationEngine",
      grantee: addresses.LiquidationEngine,
    },
    {
      contract: "MUSD",
      contractAddress: addresses.MUSD,
      role: "CAP_MANAGER_ROLE",
      granteeLabel: "BLEBridgeV9",
      grantee: addresses.BLEBridgeV9,
    },
    {
      contract: "CollateralVault",
      contractAddress: addresses.CollateralVault,
      role: "BORROW_MODULE_ROLE",
      granteeLabel: "BorrowModule",
      grantee: addresses.BorrowModule,
    },
    {
      contract: "CollateralVault",
      contractAddress: addresses.CollateralVault,
      role: "LIQUIDATION_ROLE",
      granteeLabel: "LiquidationEngine",
      grantee: addresses.LiquidationEngine,
    },
    {
      contract: "CollateralVault",
      contractAddress: addresses.CollateralVault,
      role: "LEVERAGE_VAULT_ROLE",
      granteeLabel: "LeverageVault",
      grantee: addresses.LeverageVault,
    },
    {
      contract: "BorrowModule",
      contractAddress: addresses.BorrowModule,
      role: "LIQUIDATION_ROLE",
      granteeLabel: "LiquidationEngine",
      grantee: addresses.LiquidationEngine,
    },
  ];

  const results: RoleCheck[] = [];

  for (const check of checks) {
    const c = new ethers.Contract(check.contractAddress, ACCESS_CONTROL_ABI, ethers.provider);
    const h = roleHash(check.role);
    const hasRole = await c.hasRole(h, check.grantee);
    results.push({
      contract: check.contract,
      role: check.role,
      roleHash: h,
      granteeLabel: check.granteeLabel,
      grantee: check.grantee,
      hasRole,
    });
  }

  const passCount = results.filter((r) => r.hasRole).length;
  const failCount = results.length - passCount;

  const outDir = path.resolve(process.cwd(), "artifacts/test-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = process.env.OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.OUTPUT_FILE)
    : path.join(outDir, `role-ceremony-${network.name}-proof.log`);

  const lines: string[] = [];
  lines.push(`timestamp=${new Date().toISOString()}`);
  lines.push(`network=${network.name}`);
  lines.push(`chainId=${chainId}`);
  lines.push(`mode=live-readonly`);
  lines.push(`deployment_file=${deploymentFile}`);
  if (deployment.network) lines.push(`deployment_network=${deployment.network}`);
  if (deployment.chainId !== undefined) lines.push(`deployment_chainId=${deployment.chainId}`);
  lines.push(`checks_total=${results.length}`);
  lines.push(`checks_pass=${passCount}`);
  lines.push(`checks_fail=${failCount}`);

  for (const r of results) {
    lines.push(
      [
        "role_check",
        `${r.contract}.${r.role}`,
        `grantee_label=${r.granteeLabel}`,
        `grantee=${r.grantee}`,
        `role_hash=${r.roleHash}`,
        `result=${r.hasRole ? "PASS" : "FAIL"}`,
      ].join(" ")
    );
  }

  lines.push(`status=${failCount === 0 ? "PASS" : "FAIL"}`);
  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");

  console.log(`Wrote role ceremony evidence: ${outFile}`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
