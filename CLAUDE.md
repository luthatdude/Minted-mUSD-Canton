# Minted mUSD Protocol

Cross-chain stablecoin protocol spanning Canton Network (DAML) and Ethereum (Solidity), with TypeScript services for bridging, monitoring, and frontend.

## Architecture

- **contracts/** — Solidity smart contracts (ERC-20, ERC-4626 vaults, bridge, governance). Compiler: 0.8.26.
- **daml/** — Canton Network DAML templates for institutional accounting, compliance, and settlement.
- **relay/** — TypeScript relay service bridging Canton attestations to Ethereum. 3-of-5 multi-sig validator setup.
- **bot/** — TypeScript liquidation bot with monitoring and Telegram alerts.
- **frontend/** — Next.js 15 UI with wallet integration.
- **k8s/** — Kubernetes manifests for Canton participant node, PostgreSQL, NGINX, monitoring.
- **test/** — Hardhat tests (60+ files) and Foundry fuzz/invariant tests.

## Build & Test

```bash
# Solidity (Foundry)
forge build
forge test
forge test --fuzz-runs 1024  # extended fuzz

# Solidity (Hardhat)
npx hardhat compile
npx hardhat test
npx hardhat coverage  # 90% threshold enforced

# DAML
daml build
daml test

# Relay / Bot / Frontend
cd relay && npm install && npm run build
cd bot && npm install && npm run build
cd frontend && npm install && npm run build

# Static analysis
slither . --config-file slither.config.json
```

## Key Conventions

- Solidity follows CEI pattern (Checks-Effects-Interactions) and uses OpenZeppelin v5.
- DAML uses propose-accept pattern for multi-party workflows.
- All token amounts use highest precision types: `uint256` (Solidity), `Decimal` (DAML), `bigint` (TypeScript).
- Custom errors preferred over require strings in Solidity.
- TypeScript uses strict mode and zod for environment validation.

## Agent Teams

This project uses Claude Code agent teams. Specialized agents are defined in `.github/agents/`:

- **solidity-auditor** — Reviews Solidity contracts for security vulnerabilities, gas optimization, and DeFi-specific risks.
- **daml-auditor** — Reviews DAML templates for authorization, privacy, lifecycle, and Canton-specific issues.
- **typescript-reviewer** — Reviews TypeScript services for type safety, error handling, and blockchain interaction patterns.
- **infra-reviewer** — Reviews Kubernetes manifests, Docker configs, CI/CD pipelines, and deployment scripts.

## Security

- No hardcoded secrets. Uses environment variables and Docker secrets.
- Bridge uses 3-of-5 multi-sig with AWS KMS signing.
- CI runs Slither, Mythril, Trivy, and npm audit.
- 90% code coverage enforced.
