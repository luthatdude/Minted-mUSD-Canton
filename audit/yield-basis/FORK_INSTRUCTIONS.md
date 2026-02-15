# Yield Basis Fork — Setup Instructions

## 1. Fork the Repository

```bash
# Option A: GitHub CLI (recommended)
gh repo fork yield-basis/yb-core --clone --remote
gh repo fork yield-basis/yb-v2 --clone --remote

# Option B: Manual fork via GitHub UI
# 1. Go to https://github.com/yield-basis
# 2. Fork each repo (yb-core, yb-v2, etc.) to your org
# 3. Clone locally:
git clone https://github.com/<YOUR_ORG>/yb-core.git ../yield-basis-fork/yb-core
git clone https://github.com/<YOUR_ORG>/yb-v2.git ../yield-basis-fork/yb-v2
```

## 2. Initial Setup

```bash
cd ../yield-basis-fork/yb-core

# Install dependencies
forge install

# Build
forge build

# Run existing tests
forge test -vvv
```

## 3. Add Upstream Remote

```bash
git remote add upstream https://github.com/yield-basis/yb-core.git
git fetch upstream
```

## 4. Create Audit Branch

```bash
git checkout -b audit/minted-review
```

## 5. Workspace Integration

Add the fork to the VS Code workspace:
```
File → Add Folder to Workspace → select ../yield-basis-fork/yb-core
```

Or update `.code-workspace`:
```json
{
  "folders": [
    { "path": "." },
    { "path": "../yield-basis-fork/yb-core" },
    { "path": "../yield-basis-fork/yb-v2" }
  ]
}
```

## 6. Key Repos in yield-basis Organization

| Repo | Description | Audit Priority |
|------|-------------|----------------|
| `yb-core` | Core AMM contracts (Solidity/Vyper) — LP without impermanent loss | **CRITICAL** |
| `yb-v2` | V2 iteration of the protocol | **HIGH** |

## 7. What to Look For (Pre-Audit)

After cloning, immediately check:
- [ ] `foundry.toml` / `hardhat.config.*` — compiler version, optimizer settings
- [ ] `src/` or `contracts/` — main protocol contracts
- [ ] `test/` — existing test coverage
- [ ] `script/` — deployment scripts
- [ ] Dependencies in `lib/` or `node_modules/`
- [ ] Any existing audit reports in `audits/` or `docs/`
