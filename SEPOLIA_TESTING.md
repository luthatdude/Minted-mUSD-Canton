# Sepolia Testnet Testing Guide

## Deployed Contracts (Sepolia)

> **Updated 2026-02-16** — Redeployed with audit fixes (commit `041d154`). All verified on Etherscan.

| Contract | Address | Verified |
|----------|---------|----------|
| GlobalPauseRegistry | [`0x471e9dceB2AB7398b63677C70c6C638c7AEA375F`](https://sepolia.etherscan.io/address/0x471e9dceB2AB7398b63677C70c6C638c7AEA375F#code) | ✅ |
| MintedTimelockController | [`0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410`](https://sepolia.etherscan.io/address/0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410#code) | ✅ |
| MUSD | [`0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B`](https://sepolia.etherscan.io/address/0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B#code) | ✅ |
| PriceOracle | [`0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025`](https://sepolia.etherscan.io/address/0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025#code) | ✅ |
| InterestRateModel | [`0x501265BeF81E6E96e4150661e2b9278272e9177B`](https://sepolia.etherscan.io/address/0x501265BeF81E6E96e4150661e2b9278272e9177B#code) | ✅ |
| CollateralVault | [`0x155d6618dcdeb2F4145395CA57C80e6931D7941e`](https://sepolia.etherscan.io/address/0x155d6618dcdeb2F4145395CA57C80e6931D7941e#code) | ✅ |
| BorrowModule | [`0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8`](https://sepolia.etherscan.io/address/0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8#code) | ✅ |
| SMUSD | [`0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540`](https://sepolia.etherscan.io/address/0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540#code) | ✅ |
| LiquidationEngine | [`0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8`](https://sepolia.etherscan.io/address/0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8#code) | ✅ |
| DirectMintV2 | [`0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7`](https://sepolia.etherscan.io/address/0xaA3e42f2AfB5DF83d6a33746c2927bce8B22Bae7#code) | ✅ (redeployed 2026-02-17) |
| LeverageVault | [`0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4`](https://sepolia.etherscan.io/address/0x3b49d47f9714836F2aF21F13cdF79aafd75f1FE4#code) | ✅ | Redeployed 2026-02-17 (swapRouter fix) |
| TreasuryV2 (proxy) | [`0xf2051bDfc738f638668DF2f8c00d01ba6338C513`](https://sepolia.etherscan.io/address/0xf2051bDfc738f638668DF2f8c00d01ba6338C513) | ✅ (redeployed 2026-02-17) |
| BLEBridgeV9 (proxy) | [`0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125`](https://sepolia.etherscan.io/address/0xB466be5F516F7Aa45E61bA2C7d2Db639c7B3D125) | ⏳ upgrade via timelock |

---

## Test Scripts Available

### 1. Deploy Mock Oracles (Required First)
```bash
npx hardhat run scripts/deploy-mock-oracles.ts --network sepolia
```
Creates mock Chainlink price feeds for testnet since real oracles don't exist.

### 2. Deploy Leverage Vault
```bash
npx hardhat run scripts/deploy-leverage-vault.ts --network sepolia
```
Deploys LeverageVault with MockSwapRouter for testing leveraged positions.

### 3. Test Staking & Yield Distribution
```bash
npx hardhat run scripts/test-staking-yield.ts --network sepolia
```
Tests:
- Minting mUSD from MockUSDC
- Staking mUSD to get smUSD
- Simulating yield distribution
- Verifying share value increases

### 4. Test Leverage Vault
```bash
npx hardhat run scripts/test-leverage-vault.ts --network sepolia
```
Tests:
- Opening 2x leveraged positions
- Checking health factors
- Price manipulation and liquidation scenarios
- Closing positions

### 5. Test Treasury Distribution
```bash
npx hardhat run scripts/test-treasury-distribution.ts --network sepolia
```
Tests:
- Treasury receiving yield
- Distribution to SMUSD stakers
- Yield flow verification

### 6. Update Pendle Parameters
```bash
npx hardhat run scripts/update-pendle-params.ts --network sepolia
```
Changes the Pendle market selector TVL requirement from $50M to $10M.

---

## Recommended Testing Order

1. **Mock Infrastructure** (if not already deployed)
   ```bash
   npx hardhat run scripts/deploy-mock-oracles.ts --network sepolia
   npx hardhat run scripts/deploy-leverage-vault.ts --network sepolia
   ```

2. **Core Functionality Tests**
   ```bash
   npx hardhat run scripts/test-staking-yield.ts --network sepolia
   npx hardhat run scripts/test-treasury-distribution.ts --network sepolia
   ```

3. **Leverage & Liquidation Tests**
   ```bash
   npx hardhat run scripts/test-leverage-vault.ts --network sepolia
   ```

4. **Parameter Updates**
   ```bash
   npx hardhat run scripts/update-pendle-params.ts --network sepolia
   ```

---

## Environment Setup

Ensure your `.env` has:
```env
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=your_deployer_private_key
ETHERSCAN_API_KEY=your_etherscan_key
```

Get Sepolia ETH from:
- https://sepoliafaucet.com
- https://faucet.chainstack.com/sepolia-testnet-faucet

---

## Key Changes Made

### PendleMarketSelector TVL Limit
- **Before:** $50M minimum TVL
- **After:** $10M minimum TVL
- Location: [contracts/PendleMarketSelector.sol](contracts/PendleMarketSelector.sol#L165)

For deployed contracts, use `update-pendle-params.ts` to call `setParams()`.

---

## Troubleshooting

### "Missing role" errors
The admin wallet needs to grant roles. Check which roles are needed:
- `MINTER_ROLE` - For DirectMint to mint mUSD
- `YIELD_DISTRIBUTOR_ROLE` - For Treasury to distribute yield
- `PARAMS_ADMIN_ROLE` - For updating PendleMarketSelector parameters
- `LEVERAGE_VAULT_ROLE` - For LeverageVault to interact with BorrowModule

### "Oracle price stale" errors
Deploy mock oracles first - testnet doesn't have Chainlink feeds:
```bash
npx hardhat run scripts/deploy-mock-oracles.ts --network sepolia
```

### Transaction reverts on liquidation
Liquidation requires:
1. Mock oracle prices to be manipulated
2. Sufficient liquidity in MockSwapRouter
3. LiquidationEngine to have LIQUIDATOR_ROLE

### Granting RELAYER_ROLE on BLEBridgeV9 (BRIDGE-M-04)

After the BRIDGE-M-04 audit fix, `processAttestation` requires `RELAYER_ROLE`.
The relay EOA (`0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0`) must be granted this
role via the timelock upgrade script:

```bash
# Phase 1 — Deploy new impl + schedule upgrade (creates timelock proposal)
npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia

# Phase 2 — Execute after 24h timelock delay
PHASE=execute npx hardhat run scripts/upgrade-bridge-relayer-role.ts --network sepolia
```

See `scripts/upgrade-bridge-relayer-role.ts` for full details.
