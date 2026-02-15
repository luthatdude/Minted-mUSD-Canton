// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ═══════════════════════════════════════════════════════════════════════════
// FLUID VAULT INTERFACES — Consolidated for Minted Loop Strategies
// ═══════════════════════════════════════════════════════════════════════════
// Reference: https://github.com/Instadapp/fluid-contracts-public
//
// Vault Types:
//   T1 = Normal Collateral & Normal Debt        (syrupUSDC / USDC)
//   T2 = Smart Collateral & Normal Debt         (weETH-ETH / wstETH)
//   T4 = Smart Collateral & Smart Debt          (wstETH-ETH / wstETH-ETH)
//
// All positions are NFT-based (nftId). Pass 0 to create a new position.
// Positive values = deposit/borrow, negative values = withdraw/repay.
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Common Fluid Vault interface (shared across all types)
interface IFluidVaultCommon {
    /// @notice Returns the vault ID
    function VAULT_ID() external view returns (uint256);

    /// @notice Returns the vault type constant
    function TYPE() external view returns (uint256);

    /// @notice Read raw storage slot
    function readFromStorage(bytes32 slot) external view returns (uint256 result);

    struct Tokens {
        address token0;
        address token1;
    }

    struct ConstantViews {
        address liquidity;
        address factory;
        address operateImplementation;
        address adminImplementation;
        address secondaryImplementation;
        address deployer;
        address supply;       // liquidity layer or DEX protocol
        address borrow;       // liquidity layer or DEX protocol
        Tokens supplyToken;
        Tokens borrowToken;
        uint256 vaultId;
        uint256 vaultType;
        bytes32 supplyExchangePriceSlot;
        bytes32 borrowExchangePriceSlot;
        bytes32 userSupplySlot;
        bytes32 userBorrowSlot;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// VAULT T1 — Normal Collateral / Normal Debt
// Used for: syrupUSDC (supply) / USDC (borrow) — Vault #146
// ═══════════════════════════════════════════════════════════════════════════

interface IFluidVaultT1 {
    /// @notice Returns the vault ID
    function VAULT_ID() external view returns (uint256);

    struct ConstantViews {
        address liquidity;
        address factory;
        address adminImplementation;
        address secondaryImplementation;
        address supplyToken;
        address borrowToken;
        uint8 supplyDecimals;
        uint8 borrowDecimals;
        uint256 vaultId;
        bytes32 liquiditySupplyExchangePriceSlot;
        bytes32 liquidityBorrowExchangePriceSlot;
        bytes32 liquidityUserSupplySlot;
        bytes32 liquidityUserBorrowSlot;
    }

    /// @notice All vault constants
    function constantsView() external view returns (ConstantViews memory);

    /// @notice Update exchange prices and return latest values
    function updateExchangePrices(uint256 vaultVariables2_)
        external
        returns (
            uint256 liqSupplyExPrice,
            uint256 liqBorrowExPrice,
            uint256 vaultSupplyExPrice,
            uint256 vaultBorrowExPrice
        );

    /// @notice Single function for supply, withdraw, borrow & payback
    /// @param nftId_   NFT ID (0 = create new position)
    /// @param newCol_  Positive = deposit, negative = withdraw
    /// @param newDebt_ Positive = borrow, negative = payback
    /// @param to_      Where withdraw/borrow funds go (address(0) = msg.sender)
    /// @return nftId   Position NFT ID
    /// @return supplyAmt Final supply amount (negative = withdrawal)
    /// @return borrowAmt Final borrow amount (negative = payback)
    function operate(
        uint256 nftId_,
        int256 newCol_,
        int256 newDebt_,
        address to_
    )
        external
        payable
        returns (uint256, int256, int256);

    /// @notice Liquidate an unhealthy position
    function liquidate(
        uint256 debtAmt_,
        uint256 colPerUnitDebt_,
        address to_,
        bool absorb_
    ) external payable returns (uint256 actualDebtAmt, uint256 actualColAmt);

    /// @notice Rebalance vault (keeper)
    function rebalance() external payable returns (int256 supplyAmt, int256 borrowAmt);
}

// ═══════════════════════════════════════════════════════════════════════════
// VAULT T2 — Smart Collateral / Normal Debt
// Used for: weETH-ETH (supply DEX LP) / wstETH (borrow) — Vault #74
// ═══════════════════════════════════════════════════════════════════════════

interface IFluidVaultT2 {
    /// @notice Returns the vault ID
    function VAULT_ID() external view returns (uint256);

    /// @notice Operate on a T2 vault position (smart collateral, normal debt)
    /// @param nftId_           NFT ID (0 = create new)
    /// @param newColToken0_    Change in collateral token0 (positive=deposit, negative=withdraw)
    /// @param newColToken1_    Change in collateral token1 (positive=deposit, negative=withdraw)
    /// @param colSharesMinMax_ Min/max shares (positive=deposit, negative=withdraw)
    /// @param newDebt_         Change in debt (positive=borrow, negative=repay)
    /// @param to_              Where withdraw/borrow goes
    function operate(
        uint256 nftId_,
        int256 newColToken0_,
        int256 newColToken1_,
        int256 colSharesMinMax_,
        int256 newDebt_,
        address to_
    )
        external
        payable
        returns (uint256, int256, int256);

    /// @notice Operate with perfect shares (more gas efficient for full deposits/withdrawals)
    function operatePerfect(
        uint256 nftId_,
        int256 perfectColShares_,
        int256 colToken0MinMax_,
        int256 colToken1MinMax_,
        int256 newDebt_,
        address to_
    )
        external
        payable
        returns (uint256, int256[] memory);

    /// @notice Liquidate T2 position
    function liquidate(
        uint256 debtAmt_,
        uint256 colPerUnitDebt_,
        address to_,
        bool absorb_
    ) external payable returns (uint256 actualDebtAmt, uint256 actualColAmt);
}

// ═══════════════════════════════════════════════════════════════════════════
// VAULT T4 — Smart Collateral / Smart Debt
// Used for: wstETH-ETH (supply DEX LP) / wstETH-ETH (borrow DEX LP) — Vault #44
// ═══════════════════════════════════════════════════════════════════════════

interface IFluidVaultT4 {
    /// @notice Returns the vault ID
    function VAULT_ID() external view returns (uint256);

    /// @notice Operate on a T4 vault position (smart collateral + smart debt)
    function operate(
        uint256 nftId_,
        int256 newColToken0_,
        int256 newColToken1_,
        int256 colSharesMinMax_,
        int256 newDebtToken0_,
        int256 newDebtToken1_,
        int256 debtSharesMinMax_,
        address to_
    )
        external
        payable
        returns (uint256, int256, int256);

    /// @notice Operate with perfect shares for both sides
    function operatePerfect(
        uint256 nftId_,
        int256 perfectColShares_,
        int256 colToken0MinMax_,
        int256 colToken1MinMax_,
        int256 perfectDebtShares_,
        int256 debtToken0MinMax_,
        int256 debtToken1MinMax_,
        address to_
    )
        external
        payable
        returns (uint256, int256[] memory);

    /// @notice Liquidate T4 position
    function liquidate(
        uint256 token0DebtAmt_,
        uint256 token1DebtAmt_,
        uint256 colPerUnitDebt_,
        address to_,
        bool absorb_
    ) external payable returns (uint256 actualDebtAmt, uint256 actualColAmt);
}

// ═══════════════════════════════════════════════════════════════════════════
// VAULT FACTORY — Creates vaults, mints position NFTs
// ═══════════════════════════════════════════════════════════════════════════

interface IFluidVaultFactory {
    /// @notice Get total number of deployed vaults
    function totalVaults() external view returns (uint256);

    /// @notice Get vault address by vault ID
    function getVaultAddress(uint256 vaultId) external view returns (address);

    /// @notice Get owner of a position NFT
    function ownerOf(uint256 nftId) external view returns (address);

    /// @notice Transfer position NFT
    function transferFrom(address from, address to, uint256 nftId) external;

    /// @notice Approve address for position NFT
    function approve(address to, uint256 nftId) external;
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUID LIQUIDITY LAYER — Underlying lending pool
// ═══════════════════════════════════════════════════════════════════════════

interface IFluidLiquidity {
    /// @notice Core operate function of Liquidity layer
    function operate(
        address token,
        int256 supplyAmount,
        int256 borrowAmount,
        address withdrawTo,
        address borrowTo,
        bytes calldata callbackData
    ) external payable returns (uint256 memVar3, uint256 memVar4);

    /// @notice Read raw storage slot
    function readFromStorage(bytes32 slot) external view returns (uint256 result);
}

// ═══════════════════════════════════════════════════════════════════════════
// VAULT RESOLVER — Read-only position + vault data (used by strategies)
// ═══════════════════════════════════════════════════════════════════════════
// Reference: FluidVaultResolver on mainnet
// Returns position data for any NFT ID. For smart col/debt vaults (T2/T3/T4),
// supply and borrow amounts are in DEX shares, not raw token amounts.

interface IFluidVaultResolver {
    struct UserPosition {
        uint256 nftId;
        address owner;
        bool isLiquidated;
        bool isSupplyPosition;  // true = supply-only (no borrow)
        int256 tick;
        uint256 tickId;
        uint256 beforeSupply;   // raw before exchange-price
        uint256 beforeBorrow;
        uint256 beforeDustBorrow;
        uint256 supply;         // final supply (token amount for T1, shares for T2/T4)
        uint256 borrow;         // final borrow (token amount for T1/T2, shares for T3/T4)
        uint256 dustBorrow;
    }

    struct VaultEntireData {
        address vault;
        bool isSmartCol;
        bool isSmartDebt;
        IFluidVaultCommon.ConstantViews constantVariables;
        VaultConfigs configs;
        ExchangePricesAndRates exchangePricesAndRates;
        TotalSupplyAndBorrow totalSupplyAndBorrow;
    }

    struct VaultConfigs {
        uint16 supplyRateMagnifier;
        uint16 borrowRateMagnifier;
        uint16 collateralFactor;
        uint16 liquidationThreshold;
        uint16 liquidationMaxLimit;
        uint16 withdrawalGap;
        uint16 liquidationPenalty;
        uint16 borrowFee;
        address oracle;
        uint256 oraclePriceOperate;
        uint256 oraclePriceLiquidate;
        address rebalancer;
        uint256 lastUpdateTimestamp;
    }

    struct ExchangePricesAndRates {
        uint256 lastStoredLiquiditySupplyExchangePrice;
        uint256 lastStoredLiquidityBorrowExchangePrice;
        uint256 lastStoredVaultSupplyExchangePrice;
        uint256 lastStoredVaultBorrowExchangePrice;
        uint256 liquiditySupplyExchangePrice;  // 1e12 for smart col
        uint256 liquidityBorrowExchangePrice;  // 1e12 for smart debt
        uint256 vaultSupplyExchangePrice;
        uint256 vaultBorrowExchangePrice;
        uint256 supplyRateVault;
        uint256 borrowRateVault;
        uint256 supplyRateLiquidity;
        uint256 borrowRateLiquidity;
        uint256 rewardsOrFeeRateSupply;
        uint256 rewardsOrFeeRateBorrow;
    }

    struct TotalSupplyAndBorrow {
        uint256 totalSupplyVault;
        uint256 totalBorrowVault;
        uint256 totalSupplyLiquidityOrDex;
        uint256 totalBorrowLiquidityOrDex;
        uint256 absorbedSupply;
        uint256 absorbedBorrow;
    }

    /// @notice Look up which vault address an NFT belongs to
    function vaultByNftId(uint256 nftId_) external view returns (address vault_);

    /// @notice Full position + vault data for a given NFT
    function positionByNftId(uint256 nftId_) external view returns (
        UserPosition memory userPosition_,
        VaultEntireData memory vaultData_
    );

    /// @notice All positions owned by a user
    function positionsByUser(address user_) external view returns (
        UserPosition[] memory,
        VaultEntireData[] memory
    );

    /// @notice All NFT IDs owned by a user
    function positionsNftIdOfUser(address user_) external view returns (uint256[] memory nftIds_);

    /// @notice Get complete vault data
    function getVaultEntireData(address vault_) external view returns (VaultEntireData memory);

    /// @notice Get vault type constant (10000/20000/30000/40000)
    function getVaultType(address vault_) external view returns (uint256 vaultType_);
}

// ═══════════════════════════════════════════════════════════════════════════
// FLUID DEX T1 — Core DEX interface for Smart Collateral / Smart Debt
// ═══════════════════════════════════════════════════════════════════════════
// When a vault has smart collateral, the supply-side token is actually a
// Fluid DEX pool. Collateral becomes DEX LP, earning trading fees on top
// of the lending spread. Similarly for smart debt.

interface IFluidDexT1 {
    struct PricesAndExchangePrice {
        uint256 lastStoredPrice;           // 1e27 decimals
        uint256 centerPrice;               // 1e27 decimals
        uint256 upperRange;                // 1e27 decimals
        uint256 lowerRange;                // 1e27 decimals
        uint256 geometricMean;             // geometric mean of upper & lower
        uint256 supplyToken0ExchangePrice;
        uint256 borrowToken0ExchangePrice;
        uint256 supplyToken1ExchangePrice;
        uint256 borrowToken1ExchangePrice;
    }

    struct CollateralReserves {
        uint256 token0RealReserves;
        uint256 token1RealReserves;
        uint256 token0ImaginaryReserves;
        uint256 token1ImaginaryReserves;
    }

    struct DebtReserves {
        uint256 token0Debt;
        uint256 token1Debt;
        uint256 token0RealReserves;
        uint256 token1RealReserves;
        uint256 token0ImaginaryReserves;
        uint256 token1ImaginaryReserves;
    }

    struct ConstantViews {
        uint256 dexId;
        address liquidity;
        address factory;
        address token0;
        address token1;
    }

    /// @notice Returns DEX ID
    function DEX_ID() external view returns (uint256);

    /// @notice Returns DEX constants
    function constantsView() external view returns (ConstantViews memory);

    /// @notice Read raw storage slot
    function readFromStorage(bytes32 slot_) external view returns (uint256 result_);

    /// @notice Get reserves (for share → token resolution)
    function getCollateralReserves(
        uint256 geometricMean_,
        uint256 upperRange_,
        uint256 lowerRange_,
        uint256 token0SupplyExchangePrice_,
        uint256 token1SupplyExchangePrice_
    ) external view returns (CollateralReserves memory c_);

    /// @notice Get debt reserves
    function getDebtReserves(
        uint256 geometricMean_,
        uint256 upperRange_,
        uint256 lowerRange_,
        uint256 token0BorrowExchangePrice_,
        uint256 token1BorrowExchangePrice_
    ) external view returns (DebtReserves memory d_);

    // NOTE: getPricesAndExchangePrices() uses revert-based return.
    // Called via try/catch in the resolver. Not callable from on-chain view.
    // Use the DexResolver wrapper instead.
}

// ═══════════════════════════════════════════════════════════════════════════
// DEX RESOLVER — Read-only wrapper for DEX state + share resolution
// ═══════════════════════════════════════════════════════════════════════════
// Converts DEX shares → underlying token amounts.

interface IFluidDexResolver {
    struct DexState {
        uint256 lastToLastStoredPrice;
        uint256 lastStoredPrice;
        uint256 centerPrice;
        uint256 lastUpdateTimestamp;
        uint256 lastPricesTimeDiff;
        uint256 oracleCheckPoint;
        uint256 oracleMapping;
        uint256 totalSupplyShares;
        uint256 totalBorrowShares;
        bool isSwapAndArbitragePaused;
        uint256 token0PerSupplyShare;  // token0 amount per 1e18 supply shares
        uint256 token1PerSupplyShare;  // token1 amount per 1e18 supply shares
        uint256 token0PerBorrowShare;  // token0 amount per 1e18 borrow shares
        uint256 token1PerBorrowShare;  // token1 amount per 1e18 borrow shares
    }

    struct DexEntireData {
        address dex;
        IFluidDexT1.ConstantViews constantViews;
        IFluidDexT1.PricesAndExchangePrice pex;
        IFluidDexT1.CollateralReserves colReserves;
        IFluidDexT1.DebtReserves debtReserves;
        DexState dexState;
    }

    /// @notice Get complete DEX data including share prices
    function getDexEntireData(address dex_) external returns (DexEntireData memory data_);

    /// @notice Get just the DEX state (contains share → token ratios)
    function getDexState(address dex_) external returns (DexState memory state_);

    /// @notice Get exchange prices and price info for a DEX
    function getDexPricesAndExchangePrices(address dex_)
        external returns (IFluidDexT1.PricesAndExchangePrice memory pex_);

    /// @notice Get DEX tokens
    function getDexTokens(address dex_) external view returns (address token0_, address token1_);

    /// @notice Get all DEX addresses
    function getAllDexAddresses() external view returns (address[] memory);
}
