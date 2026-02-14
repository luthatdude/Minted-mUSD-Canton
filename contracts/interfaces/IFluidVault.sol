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
