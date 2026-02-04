// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockMorphoBlue
 * @notice Mock Morpho Blue for testing MorphoLoopStrategy
 */
contract MockMorphoBlue {
    using SafeERC20 for IERC20;

    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    // Storage
    mapping(bytes32 => MarketParams) public marketParams;
    mapping(bytes32 => mapping(address => Position)) public positions;
    
    // Market totals
    uint128 public totalSupplyAssets;
    uint128 public totalSupplyShares;
    uint128 public totalBorrowAssets;
    uint128 public totalBorrowShares;
    
    IERC20 public usdc;
    bytes32 public activeMarketId;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        totalSupplyAssets = 100_000_000e6;
        totalSupplyShares = 100_000_000e6;
        totalBorrowAssets = 50_000_000e6;
        totalBorrowShares = 50_000_000e6;
    }

    function setMarketParams(
        bytes32 marketId,
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) external {
        marketParams[marketId] = MarketParams({
            loanToken: loanToken,
            collateralToken: collateralToken,
            oracle: oracle,
            irm: irm,
            lltv: lltv
        });
        activeMarketId = marketId;
    }

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory) {
        return marketParams[id];
    }

    function position(bytes32 id, address user) external view returns (Position memory) {
        return positions[id][user];
    }

    function market(bytes32) external view returns (
        uint128, uint128, uint128, uint128, uint128, uint128
    ) {
        return (
            totalSupplyAssets,
            totalSupplyShares,
            totalBorrowAssets,
            totalBorrowShares,
            uint128(block.timestamp),
            0 // fee
        );
    }

    function supply(
        MarketParams memory,
        uint256 assets,
        uint256,
        address onBehalf,
        bytes memory
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied) {
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        
        // 1:1 shares for simplicity
        positions[activeMarketId][onBehalf].supplyShares += assets;
        totalSupplyAssets += uint128(assets);
        totalSupplyShares += uint128(assets);
        
        return (assets, assets);
    }

    function withdraw(
        MarketParams memory,
        uint256 assets,
        uint256,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        require(positions[activeMarketId][onBehalf].supplyShares >= assets, "Insufficient supply");
        
        positions[activeMarketId][onBehalf].supplyShares -= assets;
        totalSupplyAssets -= uint128(assets);
        totalSupplyShares -= uint128(assets);
        
        usdc.safeTransfer(receiver, assets);
        
        return (assets, assets);
    }

    function borrow(
        MarketParams memory,
        uint256 assets,
        uint256,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
        positions[activeMarketId][onBehalf].borrowShares += uint128(assets);
        totalBorrowAssets += uint128(assets);
        totalBorrowShares += uint128(assets);
        
        usdc.safeTransfer(receiver, assets);
        
        return (assets, assets);
    }

    function repay(
        MarketParams memory,
        uint256 assets,
        uint256,
        address onBehalf,
        bytes memory
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        
        uint128 repayShares = uint128(assets);
        if (repayShares > positions[activeMarketId][onBehalf].borrowShares) {
            repayShares = positions[activeMarketId][onBehalf].borrowShares;
        }
        
        positions[activeMarketId][onBehalf].borrowShares -= repayShares;
        totalBorrowAssets -= uint128(assets);
        totalBorrowShares -= repayShares;
        
        return (assets, repayShares);
    }

    function supplyCollateral(
        MarketParams memory,
        uint256 assets,
        address onBehalf,
        bytes memory
    ) external {
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        positions[activeMarketId][onBehalf].collateral += uint128(assets);
    }

    function withdrawCollateral(
        MarketParams memory,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        require(positions[activeMarketId][onBehalf].collateral >= assets, "Insufficient collateral");
        positions[activeMarketId][onBehalf].collateral -= uint128(assets);
        usdc.safeTransfer(receiver, assets);
    }

    // Helper to seed liquidity for testing
    function seedLiquidity(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }
}
