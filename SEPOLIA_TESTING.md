# Sepolia Testnet Testing Guide

## Deployed Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| MockUSDC | `0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474` |
| MUSD | `0x2bD1671c378A525dDA911Cc53eE9E8929D54fd9b` |
| SMUSD | `0xbe47E05f8aE025D03D034a50bE0Efd23E591AA68` |
| PriceOracle | `0x3F761A52091DB1349aF08C54336d1E5Ae6636901` |
| CollateralVault | `0x3a11571879f5CAEB2CA881E8899303453a800C8c` |
| BorrowModule | `0x114109F3555Ee75DD343710a63926B9899A6A4a8` |
| LiquidationEngine | `0x4cF182a0E3440175338033B49E84d0d5b55d987E` |
| TreasuryV2 (proxy) | `0x76c6bFB36931293D3e4BAC6564074d5B5C494EB5` |
| DirectMintV2 | `0x14a728791716d3898d073eA408B458773F7ABeC1` |
| BLEBridgeV9 (proxy) | `0xF5D1584c281F12a1a99b5Fa76a6CeD674e041005` |

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
