# Minted mUSD Protocol — Sepolia Deployment Addresses

> Deployed: February 2026 | Network: Ethereum Sepolia | Chain ID: 11155111

## Core Protocol Contracts

| Contract | Proxy Address |
|---|---|
| MUSD | `0xEAf4EFECA6d312b02A168A8ffde696bc61bf870B` |
| SMUSD | `0x8036D2bB19b20C1dE7F9b0742E2B0bB3D8b8c540` |
| TreasuryV2 | `0xf2051bDfc738f638668DF2f8c00d01ba6338C513` |
| CollateralVault | `0x155d6618dcdeb2F4145395CA57C80e6931D7941e` |
| BorrowModule | `0xC5A1c2F5CF40dCFc33e7FCda1e6042EF4456Eae8` |
| LiquidationEngine | `0xbaf131Ee1AfdA4207f669DCd9F94634131D111f8` |
| BLEBridgeV9 | `0x708957bFfA312D1730BdF87467E695D3a9F26b0f` |
| PriceOracle | `0x8eF615b3b87dfad172030087Ad0cFA5bAdCEa025` |
| GlobalPauseRegistry | `0x471e9dceB2AB7398b63677C70c6C638c7AEA375F` |
| Timelock | `0xcF1473dFdBFf5BDAd66730a01316d4A74B2dA410` |
| MockUSDC | `0xA1f4ADf3Ea3dBD0D7FdAC7849a807A3f408D7474` |

## Strategy Proxy Contracts

| Strategy | Proxy Address |
|---|---|
| PendleMarketSelector | `0x17Fb251e4580891590633848f3ea9d8d99DA77F6` |
| PendleStrategyV2 | `0x8C952A04C45f0DCF6711DaC320f8cc3797d5c818` |
| MorphoLoopStrategy | `0xAcdA435Ec29903f323D7c35241141378A5473B4E` |
| SkySUSDSStrategy | `0x1c82FE5136F4904D2292CdAA114761352c2af07F` |
| FluidLoopStrategy | `0xB0A97dE1D886e43DA9662D4DBD980A1221473C2b` |
| EulerV2LoopStrategy | `0x32434BD86906EC51c72E1d6C90F3ce5C011F26A5` |
| EulerV2CrossStableLoopStrategy | `0xC7fe1a733Ed75b1377070dF929851e9f2a2A33eC` |
| MetaVault | `0x75DdAef7C17Aa0C068935222505A1676c45a0aeD` |

## Mock Infrastructure (Devnet/Testnet Only)

| Mock | Address |
|---|---|
| RLUSD | `0xe435F3B9B772e4349547774251eed2ec1220D2CA` |
| USDS | `0xb4A219CbA22f37A4Fc609525f7baE6bc5119FbE8` |
| MorphoBlue | `0xFf4F89dD40D83dA008f88366d1e4066eB1c12D17` |
| AaveV3Pool | `0x10cFdF253484E75bC746a0F0be6C194595C6cE6b` |
| EVC | `0x36E5a1359BD3ff326C86E7AEaAed5E35932BFd5B` |
| EulerSupplyVault (USDC) | `0x7A78fD4eAf59ff5484Cd4E1cE386CC557f7a57D8` |
| EulerBorrowVault (USDC) | `0x520f88b39342021548C675330A42f7Eb5c0564EE` |
| EulerSupplyVault (RLUSD) | `0x2f875630902b2290Bdba853513a7c2d3D353d2cF` |
| EulerBorrowVault (USDC-cross) | `0xAEC852F71367f1B7e70529685575461fC251A1d4` |
| RLUSD/USD PriceFeed | `0x233f74d6DbB2253d53DccdaB5B39B012AA60a65B` |
| MerklDistributor | `0xf2d880B60834aF2Ab6C8Ed20Ac74CC76346F21b4` |
| SwapRouter | `0x1652Fee80c7038ab87828D77F21EA8F7FECBbf65` |
| FluidVaultT1 | `0xcf54A9bF5c82B1EC9cde70Ed15614451F46936a3` |
| FluidVaultFactory | `0x650Cb51e46D27765c71B61AB3c23468bEF2d5938` |
| SkyPSM | `0x4120b088463B76AE7776f5C32518AECd3b762ABC` |
| sUSDS | `0xC59B9d8Abf5d23BF90E1fC83bFb1D58cb1Dd31BA` |
| MorphoMarketId | `0xf8bd2203f7d53e90bb1d2304ecdb443737e4848ecf65e1f3cd9e674011eb9872` |

## Canton/DAML (Localhost)

| Component | Status |
|---|---|
| Canton Participant | Running on `localhost:7575` (Splice Validator 0.5.11) |
| BLE Protocol DAR | `ble-protocol-2.2.0.dar` |
| Package ID | `7099645784168d1f0eed6e6151f586ff72ba341690d131af42ee2d042baa0509` |
| Active Contracts | 5 (ComplianceRegistry, MUSDSupplyService, PriceOracle, VaultManager, BridgeService) |

## Configuration

| Parameter | Value |
|---|---|
| Deployer | `0xe640db3Ad56330BFF39Da36Ef01ab3aEB699F8e0` |
| Deploy Gas Cost | ~0.016 ETH (strategies only) |
| Total Gas Cost | ~0.17 ETH (all contracts including core) |
| Compiler | Solidity 0.8.26, optimizer 200 runs |
| PendleStrategyV2 | Compiled with `viaIR: true` (EIP-3860 compliance) |
