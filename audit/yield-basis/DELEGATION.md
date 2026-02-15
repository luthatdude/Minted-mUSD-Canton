# Audit Delegation Plan — Yield Basis Protocol

**Date:** 2026-02-14
**Lead Auditor:** auditor (orchestrator)
**Scope:** Full security review of Yield Basis protocol fork for potential integration with Minted mUSD

---

## Protocol Overview

**Yield Basis** (by Dan Elitzer) is a DeFi protocol designed to provide yield on BTC and ETH LP positions **without impermanent loss**. It achieves this through a novel AMM design that uses leveraged LP positions with borrowed stablecoins to offset IL.

### Core Mechanics
- Concentrated liquidity AMM with IL compensation
- Leveraged LP positions (borrow stablecoins to boost LP yield)
- Interest rate model balancing borrower/lender economics
- Fee redistribution to offset IL for LPs

### Why This Matters for Minted mUSD
- mUSD could serve as the borrowed stablecoin in Yield Basis vaults
- Yield Basis strategies could be added to `TreasuryV2` as yield sources
- The IL-free yield proposition complements smUSD's yield generation
- Leveraged vault mechanics overlap with our `BorrowModule` / `CollateralVault`

---

## Team Delegation

### 1. `solidity-auditor` — CRITICAL PATH

**Scope:** All Solidity/Vyper contracts in the Yield Basis fork

**Focus Areas:**
| Area | Priority | Rationale |
|------|----------|-----------|
| AMM core invariants | CRITICAL | Price manipulation, sandwich attacks, rounding errors |
| Leveraged LP logic | CRITICAL | Liquidation edge cases, bad debt, cascading failures |
| Interest rate model | HIGH | Utilization curve, rate manipulation, MEV extraction |
| Oracle integration | HIGH | Price feed manipulation, staleness, TWAP vs spot |
| Flash loan resistance | HIGH | Single-block manipulation of pool state |
| Reentrancy surface | HIGH | Callback patterns in swap/deposit/withdraw |
| Token handling | MEDIUM | Fee-on-transfer, rebasing, non-standard ERC-20s |
| Access control | MEDIUM | Admin key management, timelock, upgrade paths |
| Gas efficiency | LOW | Hot-path optimization (delegate to gas-optimizer) |

**Deliverable:** Findings report with severity ratings (CRITICAL/HIGH/MEDIUM/LOW/INFO)

**Cross-reference with Minted:**
- Compare interest rate model with our `InterestRateModel.sol`
- Compare liquidation mechanics with our `LiquidationEngine.sol`
- Assess oracle approach vs our `PriceOracle.sol`

---

### 2. `gas-optimizer` — SECONDARY

**Scope:** Hot-path contracts identified by solidity-auditor

**Focus Areas:**
| Area | Priority | Rationale |
|------|----------|-----------|
| Swap execution path | HIGH | Most frequent operation, directly impacts UX |
| LP deposit/withdraw | HIGH | User-facing gas costs |
| Interest accrual | MEDIUM | Called on every interaction |
| Storage layout | MEDIUM | Slot packing, cold vs warm reads |
| Loop bounds | LOW | Iteration limits in multi-position operations |

**Deliverable:** Gas report with before/after estimates for proposed optimizations

---

### 3. `testing-agent` — CRITICAL PATH

**Scope:** Test coverage analysis + regression test creation

**Focus Areas:**
| Area | Priority | Rationale |
|------|----------|-----------|
| Existing test coverage | CRITICAL | Identify untested code paths |
| Invariant tests | CRITICAL | Pool solvency, share accounting, no-IL guarantee |
| Fuzz tests | HIGH | Edge cases in AMM math, rounding, overflow |
| Integration tests | HIGH | Multi-contract interaction sequences |
| Regression tests | MEDIUM | Tests for every finding from solidity-auditor |

**Deliverable:**
- Coverage report (line, branch, function)
- New test files for untested paths
- Invariant test suite for core AMM properties

**Key Invariants to Test:**
1. Total pool value ≥ sum of all LP positions
2. No IL for depositors over any time horizon (the core promise)
3. Interest paid by borrowers ≥ interest earned by lenders (no subsidized bad debt)
4. Liquidation always recovers at least the debt value (minus penalty)
5. Share price is monotonically non-decreasing (absent liquidation losses)

---

### 4. `typescript-reviewer` — IF APPLICABLE

**Scope:** Any TypeScript/JavaScript in the Yield Basis repo (SDK, scripts, frontend)

**Focus Areas:**
| Area | Priority | Rationale |
|------|----------|-----------|
| Deployment scripts | HIGH | Parameter validation, network checks |
| SDK/client library | MEDIUM | Input validation, BigNumber handling |
| Off-chain computation | MEDIUM | Price calculation parity with on-chain |
| Frontend (if any) | LOW | Standard web security review |

**Deliverable:** Findings report focused on deployment safety and off-chain/on-chain parity

---

### 5. `infra-reviewer` — LOW PRIORITY (DEFERRED)

**Scope:** CI/CD, Docker, deployment infra in the Yield Basis repo

**Rationale:** Yield Basis is primarily a smart contract protocol. Infra review is secondary unless we plan to run our own deployment infrastructure.

**Trigger:** Activate if we decide to deploy Yield Basis infrastructure alongside Minted.

---

### 6. `daml-auditor` — NOT APPLICABLE (ADVISORY ONLY)

**Scope:** None directly (Yield Basis is Ethereum-only)

**Advisory Role:**
- Review any Canton ↔ Yield Basis integration designs
- Assess bridge implications if mUSD is used as the borrowed stablecoin
- Validate that Yield Basis pool state can be attested to Canton for compliance

---

## Execution Order

```
Phase 1 (Parallel):
├── solidity-auditor: Full contract review
├── testing-agent: Coverage analysis + invariant tests
└── (Fork setup and initial build verification)

Phase 2 (After Phase 1):
├── gas-optimizer: Review hot paths identified in Phase 1
├── typescript-reviewer: Scripts and SDK review
└── solidity-auditor: Re-review after test findings

Phase 3 (Synthesis):
├── auditor (lead): Consolidate all findings
├── Cross-reference with Minted mUSD contracts
└── Integration risk assessment
```

## Timeline Estimate

| Phase | Duration | Agents |
|-------|----------|--------|
| Fork + Setup | 1 day | Lead auditor |
| Phase 1 | 3-5 days | solidity-auditor, testing-agent |
| Phase 2 | 2-3 days | gas-optimizer, typescript-reviewer |
| Phase 3 | 1-2 days | Lead auditor (synthesis) |
| **Total** | **7-11 days** | |

---

## Success Criteria

- [ ] All CRITICAL and HIGH findings resolved or accepted with documented rationale
- [ ] Invariant test suite passes with 10,000+ runs
- [ ] Fuzz test suite achieves ≥90% branch coverage
- [ ] No unmitigated oracle manipulation vectors
- [ ] No bad debt scenarios under normal market conditions
- [ ] Gas costs within acceptable bounds for target chain
- [ ] Integration path with Minted mUSD documented and validated
