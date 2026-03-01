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

# DAML (requires SDK 3.4.10)
# LF2 migration complete — all modules compile under LF2.
cd daml && daml build                     # full build (all modules)
cd daml && daml test                      # run DAML test suites
bash scripts/daml-lf2-guard.sh            # regression guard (no key declarations)
bash scripts/daml-build-lf2.sh            # legacy wrapper (still works)

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

This project uses agent teams for coordinated development. Agents are defined in `.github/agents/`:

### Leadership
- **team-leader** — Oversees the entire build. Coordinates all agents, sequences changes across the cross-chain stack, and ensures quality gates are met.
- **auditor** — Lead auditor that orchestrates security reviews and synthesizes findings from specialist reviewers.

### Builders
- **solidity-coder** — Writes and modifies Solidity smart contracts (18 core contracts, ERC-20/4626, bridge, governance).
- **daml-coder** — Writes and modifies DAML/Canton templates (14 templates in V3 module).
- **frontend-agent** — Builds Next.js 15 UI (pages, components, hooks, wallet integration).
- **relay-bridge-agent** — Builds the cross-chain relay service, validator nodes, and bridge logic.
- **devops-agent** — Manages CI/CD, Docker, Kubernetes, and deployment infrastructure.
- **gas-optimizer** — Analyzes and optimizes Solidity gas costs on hot-path functions.
- **docs-agent** — Maintains NatSpec, DAML doc comments, architecture docs, and READMEs.

### Reviewers
- **solidity-auditor** — Reviews Solidity contracts for security vulnerabilities and DeFi-specific risks.
- **daml-auditor** — Reviews DAML templates for authorization, privacy, lifecycle, and Canton issues.
- **typescript-reviewer** — Reviews TypeScript services for type safety, error handling, and security.
- **infra-reviewer** — Reviews Kubernetes manifests, Docker configs, CI/CD pipelines, and deployment scripts.
- **testing-agent** — Writes and runs tests across Foundry, Hardhat, DAML scripts, and TypeScript.

## Security

- No hardcoded secrets. Uses environment variables and Docker secrets.
- Bridge uses 3-of-5 multi-sig with AWS KMS signing.
- CI runs Slither, Mythril, Trivy, and npm audit.
- 90% code coverage enforced.
