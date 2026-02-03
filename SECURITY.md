# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security Assumptions

This document outlines the security assumptions that the Minted mUSD Protocol relies upon. Auditors and security researchers should evaluate these assumptions as part of their review.

### 1. Cryptographic Assumptions

| Assumption | Dependency | Impact if Broken |
|------------|------------|------------------|
| ECDSA signatures are unforgeable | secp256k1 curve security | Attestation forgery possible |
| SHA-256 is collision-resistant | Hash function security | Agreement hash spoofing |
| Solidity 0.8.26 overflow protection | Compiler correctness | Integer overflow attacks |

### 2. Infrastructure Assumptions

| Assumption | How We Verify |
|------------|---------------|
| Canton Ledger provides Byzantine fault tolerance | Canton Network SLA, independent validators |
| Ethereum achieves finality after ~13 minutes | Wait for 2 epochs before bridging |
| AWS KMS keys cannot be extracted | AWS SOC2 Type II compliance |
| TLS protects Ledger API communications | mTLS enforcement, certificate pinning |

### 3. Operational Assumptions

| Assumption | Control |
|------------|---------|
| Admin keys are stored in hardware wallets | Operational policy, not enforced on-chain |
| No single entity controls 3+ of 5 validators | Validator selection policy, geographic distribution |
| Monitoring systems detect anomalies within 1 hour | 24/7 on-call, automated alerting |
| Incident response is executed within SLA | Runbooks, regular drills |

### 4. External Protocol Assumptions

| Protocol | Assumption | Fallback |
|----------|------------|----------|
| Chainlink | Price feeds are accurate ± deviation bound | Staleness check reverts, multi-source option |
| Pendle Finance | PT markets are liquid at maturity | Auto-rollover, slippage limits |
| Morpho | Lending pools maintain solvency | Max LTV limits, health factor monitoring |
| Circle USDC | USDC maintains 1:1 USD peg | Collateral ratio buffer (110%) |

---

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### Disclosure Process

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Email security findings to: **security@minted.finance** (placeholder)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 24 hours |
| Initial Assessment | Within 72 hours |
| Fix Development | Depends on severity |
| Public Disclosure | After fix deployed + 30 days |

### Bug Bounty Program

A formal bug bounty program will be announced prior to mainnet launch. Severity classifications:

| Severity | Criteria | Reward Range |
|----------|----------|--------------|
| **Critical** | Direct loss of funds, supply manipulation | $50,000 - $250,000 |
| **High** | Indirect loss, governance takeover | $10,000 - $50,000 |
| **Medium** | DoS, information disclosure | $2,500 - $10,000 |
| **Low** | Best practice violations | $500 - $2,500 |

---

## Security Contacts

| Role | Contact |
|------|---------|
| Security Lead | security@minted.finance |
| Emergency Hotline | TBD |
| PGP Key | Available on request |

---

## Audit History

| Date | Auditor | Scope | Report |
|------|---------|-------|--------|
| Feb 2026 | CredShield | Solidity + DAML | Pending |

---

## Security Measures Summary

### Access Control

- **Solidity**: OpenZeppelin `AccessControl` with roles:
  - `DEFAULT_ADMIN_ROLE`: Protocol governance
  - `MINTER_ROLE`: Authorized minting (bridge, DirectMint)
  - `PAUSER_ROLE`: Emergency pause capability
  - `VALIDATOR_ROLE`: Bridge attestation signing
  - `STRATEGY_ROLE`: Treasury yield strategies

- **DAML**: Signatory model with:
  - Dual-signatory for asset transfers
  - M-of-N governance proposals
  - Role-based minter registry with quotas

### Rate Limiting

| Layer | Limit | Window |
|-------|-------|--------|
| NGINX API Gateway | 10 req/s read, 2 req/s write | Per IP |
| BLEBridgeV9 | $50M supply cap increase | 24 hours |
| DirectMintV2 | Configurable mint limit | 24 hours |
| CantonDirectMint | Configurable mint limit | 24 hours |

### Pause Functionality

All critical contracts implement `Pausable`:

```solidity
// Emergency pause stops all state-changing operations
function pause() external onlyRole(PAUSER_ROLE);
function unpause() external onlyRole(DEFAULT_ADMIN_ROLE);
```

### Upgrade Safety

- **UUPS Pattern**: Upgrades require `DEFAULT_ADMIN_ROLE`
- **Storage Layout**: Documented in `docs/MIGRATION_V8_TO_V9.md`
- **Canton**: `Upgrade.daml` provides migration framework with:
  - M-of-N approval for upgrade proposals
  - User opt-in migration tickets
  - Rollback window for emergency reversion

### Reentrancy Protection

All external functions with state changes use `nonReentrant` modifier:

```solidity
function mint(uint256 amount) external nonReentrant whenNotPaused {
    // ...
}
```

### Oracle Safety

```solidity
// Chainlink with staleness check
function getPrice(address token) external view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
    require(block.timestamp - updatedAt <= maxStaleness, "STALE_PRICE");
    require(answer > 0, "INVALID_PRICE");
    return uint256(answer);
}
```

---

## Invariants

The following invariants should always hold:

### Solidity Invariants

1. **Supply Conservation**: `MUSD.totalSupply() <= attestedCantonAssets + directMintBacking`
2. **Collateral Ratio**: `collateralValue >= debtValue * minHealthFactor / 1e18` for all positions
3. **Treasury Backing**: `Treasury.totalValue() >= DirectMint.totalDeposited()`
4. **Rate Limit**: `dailyCapIncreased - dailyCapDecreased <= dailyCapIncreaseLimit`

### DAML Invariants

1. **Dual Signatory**: All `MintedMUSD` transfers require `issuer` + `owner` signatures
2. **Positive Amounts**: All token amounts satisfy `ensure amount > 0.0`
3. **Blacklist Enforcement**: `ValidateTransfer` rejects blacklisted parties
4. **Supply Cap**: `currentSupply <= supplyCap` in `MUSDSupplyService`

---

## Deployment Checklist

Before mainnet deployment:

- [ ] All contracts verified on Etherscan
- [ ] Admin roles transferred to multi-sig
- [ ] Rate limits configured for production
- [ ] Monitoring and alerting enabled
- [ ] Incident response runbooks tested
- [ ] Bug bounty program launched
- [ ] Audit findings remediated
- [ ] Emergency contacts distributed
