# Coverage Gap Analysis — FIX H-12

## Known Coverage Gaps

| Contract | Gap Reason | Status |
|----------|-----------|--------|
| `contracts/strategies/SkySUSDSStrategy.sol` | Missing MockSUSDS, MockSkyPSM | ✅ FIXED — mocks added |
| `contracts/strategies/MorphoLoopStrategy.sol` | Requires Morpho mock contracts | ⬜ NEEDS_MOCK |
| `contracts/upgradeable/LeverageVaultUpgradeable.sol` | Requires Uniswap V3 router mock | ⬜ NEEDS_MOCK |
| `contracts/PendleMarketSelector.sol` | Requires Pendle Router/Market mocks | ⬜ NEEDS_MOCK |

## Coverage Targets

| Metric | Target | Current |
|--------|--------|---------|
| Line coverage | ≥ 90% | Run `forge coverage` |
| Branch coverage | ≥ 80% | Run `forge coverage` |
| Function coverage | ≥ 95% | Run `forge coverage` |

## Running Coverage

```bash
# Generate coverage report
forge coverage --report lcov

# Generate summary
forge coverage --report summary

# Generate JSON for CI integration
forge coverage --report json > coverage-report.json
```

## Mock Contracts Added (H-11)

- `contracts/mocks/MockSUSDS.sol` — ERC4626-like sUSDS vault
- `contracts/mocks/MockSkyPSM.sol` — USDC ↔ USDS PSM
- `contracts/mocks/MockSMUSD.sol` — Staked mUSD with interest distribution
