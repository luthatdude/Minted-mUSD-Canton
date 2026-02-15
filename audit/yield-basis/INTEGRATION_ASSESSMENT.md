# Yield Basis ↔ Minted mUSD Integration Assessment

## Overview

This document maps how the Yield Basis protocol could integrate with Minted mUSD, identifying synergies, risks, and required modifications.

---

## Integration Vectors

### 1. mUSD as Borrowed Stablecoin (PRIMARY)

**How it works:**
- Yield Basis LPs borrow stablecoins to lever up their ETH/BTC positions
- mUSD could be whitelisted as a borrowable stablecoin alongside USDC/USDT/DAI
- Interest paid by borrowers flows to mUSD lenders (i.e., smUSD holders)

**Minted Components Affected:**
| Component | Change Required |
|-----------|----------------|
| `TreasuryV2.sol` | New strategy adapter: `YieldBasisStrategy.sol` |
| `MUSD.sol` | Grant MINTER_ROLE to the YB strategy (via governance) |
| `SMUSD.sol` | Yield from YB interest → smUSD share price increase |
| `PriceOracle.sol` | May need YB pool price feeds |
| `BorrowModule.sol` | Reference implementation for rate model comparison |

**Risks:**
- Bad debt in Yield Basis → loss for mUSD lenders
- Liquidation cascades if ETH/BTC crash → mass mUSD repayment pressure
- Oracle divergence between YB and Minted price feeds

### 2. YB LP Tokens as Collateral (SECONDARY)

**How it works:**
- YB LP tokens (representing IL-free yield positions) used as collateral in Minted's CDP
- Users deposit YB-LP → borrow mUSD against it

**Minted Components Affected:**
| Component | Change Required |
|-----------|----------------|
| `CollateralVault.sol` | Add YB-LP as accepted collateral token |
| `PriceOracle.sol` | YB-LP price feed (NAV-based or market) |
| `LiquidationEngine.sol` | YB-LP liquidation path (swap to USDC) |

**Risks:**
- YB-LP price oracle manipulation
- Illiquid YB-LP market → liquidation slippage
- Recursive leverage: borrow mUSD → deposit in YB → use YB-LP as collateral

### 3. TreasuryV2 Yield Strategy (TERTIARY)

**How it works:**
- Treasury USDC deposited into Yield Basis as a lender
- Earns interest from YB borrowers (leveraged LPs)
- Similar to existing `PendleStrategyV2` and `MorphoLoopStrategy`

**Implementation:**
```solidity
// contracts/strategies/YieldBasisStrategy.sol
contract YieldBasisStrategy is IStrategy, Ownable {
    IYieldBasisPool public pool;
    IERC20 public usdc;
    
    function deposit(uint256 amount) external onlyOwner { ... }
    function withdraw(uint256 amount) external onlyOwner returns (uint256) { ... }
    function totalValue() external view returns (uint256) { ... }
    function harvest() external { ... }
}
```

---

## Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| YB smart contract exploit | Medium | CRITICAL | Audit + exposure cap in TreasuryV2 |
| Bad debt from leveraged LPs | Medium | HIGH | Monitor utilization, circuit breakers |
| Oracle manipulation | Low | CRITICAL | Multi-oracle, TWAP, deviation checks |
| Liquidation cascade | Low | HIGH | Cross-protocol health monitoring |
| Recursive leverage | Medium | MEDIUM | Whitelist collateral, no YB-LP for mUSD |
| Governance attack on YB | Low | MEDIUM | Timelock monitoring, emergency pause |

---

## Canton Implications

### Bridge Attestations
- If mUSD is lent to YB on Ethereum, Canton supply tracking must account for locked mUSD
- Attestation: `totalMUSDInYB` field in bridge state for transparency

### Compliance
- YB pools are permissionless — Minted's `ComplianceRegistry` cannot enforce blacklists in YB
- Mitigation: Only Treasury (protocol-controlled) interacts with YB, not end users directly
- Alternative: Wrapped YB pool with compliance hooks (significant engineering effort)

### Risk Isolation
- Maximum allocation to YB strategy capped at X% of Treasury (governance parameter)
- Independent circuit breaker: if YB utilization > 95%, pause deposits
- Daily reporting: YB position value attested to Canton for transparency

---

## Recommended Approach

1. **Phase 1 — Audit Only** (current): Full security review of YB contracts
2. **Phase 2 — Strategy Adapter**: Build `YieldBasisStrategy.sol` for TreasuryV2
3. **Phase 3 — Testnet Integration**: Deploy on Sepolia with capped exposure
4. **Phase 4 — Mainnet**: Gradual exposure increase with monitoring
