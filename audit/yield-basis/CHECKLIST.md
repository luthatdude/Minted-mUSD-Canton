# Yield Basis Audit Checklist

## Pre-Audit Setup
- [ ] Fork all Yield Basis repos to org
- [ ] Clone and build successfully
- [ ] Run existing test suite — record pass/fail
- [ ] Identify compiler version and dependencies
- [ ] Locate any prior audit reports
- [ ] Map contract architecture (inheritance, proxy, upgradeable)
- [ ] Identify all external calls and integrations

---

## `solidity-auditor` Checklist

### AMM Core
- [ ] Constant product / concentrated liquidity invariant holds
- [ ] Swap math: no rounding exploits (favor protocol on rounding)
- [ ] Fee calculation: no overflow, correct distribution
- [ ] Slippage protection: min output enforced
- [ ] MEV resistance: deadline parameter, price bounds
- [ ] Multi-hop swap atomicity
- [ ] Pool creation: initial liquidity requirements
- [ ] Pool state consistency after every operation

### Leveraged LP Positions
- [ ] Leverage ratio limits enforced
- [ ] Collateral factor correctly applied
- [ ] Health factor calculation matches documentation
- [ ] Liquidation threshold vs borrow factor separation
- [ ] Partial liquidation: close factor bounds
- [ ] Full liquidation: no residual dust positions
- [ ] Bad debt socialization mechanism
- [ ] Interest accrual: compounding frequency, rounding direction
- [ ] Position modification during liquidation (race condition)

### IL Compensation Mechanism
- [ ] IL offset math is economically sound
- [ ] No scenarios where LPs experience net IL
- [ ] Funding source for IL compensation is sustainable
- [ ] Edge cases: extreme price movements (10x, 100x)
- [ ] Edge cases: low liquidity / high utilization

### Oracle & Price Feeds
- [ ] Oracle source (Chainlink, Uniswap TWAP, custom)
- [ ] Staleness check enforced
- [ ] Fallback oracle mechanism
- [ ] Multi-oracle aggregation (if any)
- [ ] Manipulation resistance (TWAP window, etc.)
- [ ] Price deviation circuit breaker

### Access Control
- [ ] Admin functions have proper access control
- [ ] Timelock on sensitive parameters
- [ ] Emergency pause mechanism
- [ ] Upgrade mechanism (UUPS, Transparent, Beacon)
- [ ] No unprotected initializers
- [ ] No storage collision in upgradeable contracts

### Token Handling
- [ ] SafeERC20 used for all transfers
- [ ] Fee-on-transfer token handling
- [ ] Rebasing token handling
- [ ] Non-standard decimals (6, 8, 18)
- [ ] Return value checked on approve/transfer
- [ ] No infinite approval to untrusted contracts

### Reentrancy
- [ ] ReentrancyGuard on all state-changing external functions
- [ ] No cross-contract reentrancy via callbacks
- [ ] CEI pattern followed consistently
- [ ] Read-only reentrancy in view functions

### Flash Loan Vectors
- [ ] Pool state cannot be manipulated in single block
- [ ] Oracle cannot be manipulated via flash loan
- [ ] Share price cannot be inflated via donation
- [ ] No profitable flash loan arbitrage against the protocol

---

## `testing-agent` Checklist

### Coverage
- [ ] Line coverage ≥ 90%
- [ ] Branch coverage ≥ 85%
- [ ] Function coverage = 100%
- [ ] All revert paths tested
- [ ] All modifier paths tested

### Invariant Tests
- [ ] Pool solvency: assets ≥ liabilities
- [ ] Share price monotonicity (absent losses)
- [ ] No-IL guarantee for LPs
- [ ] Total supply consistency
- [ ] Interest accrual correctness
- [ ] Liquidation always profitable for liquidator

### Fuzz Tests
- [ ] Swap amounts (0, 1, max, random)
- [ ] Deposit/withdraw sequences (random ordering)
- [ ] Price movements (random walk, spike, crash)
- [ ] Leverage ratios (min, max, random)
- [ ] Timing (sequential blocks, large gaps)
- [ ] Multi-user concurrent operations

### Edge Cases
- [ ] First depositor advantage / inflation attack
- [ ] Last withdrawer (pool draining)
- [ ] Zero amount operations
- [ ] Max uint256 values
- [ ] Empty pool operations
- [ ] Single-wei precision attacks

---

## `gas-optimizer` Checklist

- [ ] Storage slot packing analysis
- [ ] Redundant SLOAD identification
- [ ] Memory vs calldata for function parameters
- [ ] Loop optimization (bounds, early exit)
- [ ] Event emission cost
- [ ] Comparison: Yield Basis gas vs Uniswap V3 comparable operations

---

## `typescript-reviewer` Checklist

- [ ] Deployment script parameter validation
- [ ] Network safety checks (chain ID verification)
- [ ] BigNumber precision in off-chain calculations
- [ ] ABI encoding matches contract expectations
- [ ] Error handling on RPC calls
- [ ] Secret management in scripts

---

## Cross-Cutting (Lead Auditor)

### Integration with Minted mUSD
- [ ] mUSD as borrowed stablecoin: compatibility assessment
- [ ] Interest rate model alignment with Minted's `InterestRateModel.sol`
- [ ] Oracle compatibility (same Chainlink feeds?)
- [ ] Liquidation cascading risk between protocols
- [ ] Bridge implications: Yield Basis pool state attestation to Canton
- [ ] Compliance: can Yield Basis respect Minted's blacklist/freeze?

### Economic Security
- [ ] Protocol revenue model sustainability
- [ ] Bad debt backstop mechanism
- [ ] Insurance fund (if any)
- [ ] Governance attack vectors (token-weighted voting)
- [ ] Yield source: real vs inflationary

### Deployment Safety
- [ ] Constructor / initializer parameters verified
- [ ] Proxy admin ownership confirmed
- [ ] Timelock configured before mainnet
- [ ] Emergency contacts and runbook documented
