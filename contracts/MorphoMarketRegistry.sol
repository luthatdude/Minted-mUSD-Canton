// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title MorphoMarketRegistry
 * @notice On-chain registry of Morpho Blue markets with live data reader
 * @dev Reads supply/borrow totals, utilization, and borrow rates directly
 *      from the Morpho Blue singleton. No funds held — data layer only.
 *
 *      Usage:
 *        1. Admin whitelists Morpho Blue market IDs via addMarket()
 *        2. Frontend calls getAllMarketInfo() to get live data for all markets
 *        3. Admin picks a market and deploys a MorphoLoopStrategy instance for it
 *        4. Treasury deploys USDC to the strategy via deployToStrategy()
 */

// ═══════════════════════════════════════════════════════════════════════════
// MORPHO BLUE INTERFACES (standalone, matches Morpho Blue singleton ABI)
// ═══════════════════════════════════════════════════════════════════════════

interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function market(bytes32 id) external view returns (
        uint128 totalSupplyAssets,
        uint128 totalSupplyShares,
        uint128 totalBorrowAssets,
        uint128 totalBorrowShares,
        uint128 lastUpdate,
        uint128 fee
    );

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
}

/// @dev Struct matching the Morpho Blue market return layout for IRM calls
struct MorphoMarketData {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

interface IMorphoIRM {
    function borrowRateView(
        IMorphoBlue.MarketParams memory marketParams,
        MorphoMarketData memory market
    ) external view returns (uint256);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

contract MorphoMarketRegistry is AccessControl {

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS & ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    uint256 public constant BPS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 31536000;
    uint256 public constant MAX_MARKETS = 30;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Morpho Blue singleton
    IMorphoBlue public immutable morpho;

    struct MarketEntry {
        bytes32 marketId;
        string label;
    }

    /// @notice Whitelisted markets
    MarketEntry[] public markets;

    /// @notice Lookup: marketId → whitelisted
    mapping(bytes32 => bool) public isWhitelisted;

    // ═══════════════════════════════════════════════════════════════════════
    // RETURN STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct MarketInfo {
        bytes32 marketId;
        string label;
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;                   // Liquidation LTV (WAD, e.g. 0.86e18 = 86%)
        uint256 totalSupplyAssets;       // Total supplied (loan token decimals)
        uint256 totalBorrowAssets;       // Total borrowed (loan token decimals)
        uint256 utilizationBps;          // Utilization in basis points
        uint256 borrowRateAnnualized;    // Borrow APR (WAD, e.g. 0.045e18 = 4.5%)
        uint256 supplyRateAnnualized;    // Supply APR estimate (WAD)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS & ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    event MarketAdded(bytes32 indexed marketId, string label);
    event MarketRemoved(bytes32 indexed marketId);
    event MarketLabelUpdated(bytes32 indexed marketId, string newLabel);

    error AlreadyWhitelisted();
    error NotWhitelisted();
    error MaxMarketsReached();
    error ZeroMarketId();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _morpho, address _admin) {
        require(_morpho != address(0) && _admin != address(0), "Zero address");
        morpho = IMorphoBlue(_morpho);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Add a Morpho Blue market to the whitelist
     * @param marketId The bytes32 market identifier
     * @param label Human-readable label (e.g. "USDC/wETH 86% LLTV")
     */
    function addMarket(bytes32 marketId, string calldata label) external onlyRole(MANAGER_ROLE) {
        if (marketId == bytes32(0)) revert ZeroMarketId();
        if (isWhitelisted[marketId]) revert AlreadyWhitelisted();
        if (markets.length >= MAX_MARKETS) revert MaxMarketsReached();

        markets.push(MarketEntry(marketId, label));
        isWhitelisted[marketId] = true;

        emit MarketAdded(marketId, label);
    }

    /**
     * @notice Remove a market from the whitelist
     */
    function removeMarket(bytes32 marketId) external onlyRole(MANAGER_ROLE) {
        if (!isWhitelisted[marketId]) revert NotWhitelisted();
        isWhitelisted[marketId] = false;

        // Swap-remove
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].marketId == marketId) {
                markets[i] = markets[markets.length - 1];
                markets.pop();
                break;
            }
        }

        emit MarketRemoved(marketId);
    }

    /**
     * @notice Update the label for a whitelisted market
     */
    function updateLabel(bytes32 marketId, string calldata newLabel) external onlyRole(MANAGER_ROLE) {
        if (!isWhitelisted[marketId]) revert NotWhitelisted();
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].marketId == marketId) {
                markets[i].label = newLabel;
                break;
            }
        }
        emit MarketLabelUpdated(marketId, newLabel);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get all whitelisted market IDs
     */
    function getWhitelistedMarkets() external view returns (bytes32[] memory ids) {
        ids = new bytes32[](markets.length);
        for (uint256 i = 0; i < markets.length; i++) {
            ids[i] = markets[i].marketId;
        }
    }

    /**
     * @notice Number of whitelisted markets
     */
    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    /**
     * @notice Get live market info for a single market
     * @dev Reads directly from Morpho Blue singleton + IRM
     */
    function getMarketInfo(bytes32 marketId) public view returns (MarketInfo memory info) {
        IMorphoBlue.MarketParams memory params = morpho.idToMarketParams(marketId);

        (
            uint128 supplyAssets,
            uint128 supplyShares,
            uint128 borrowAssets,
            uint128 borrowShares,
            uint128 lastUpdate,
            uint128 fee
        ) = morpho.market(marketId);

        info.marketId = marketId;
        info.loanToken = params.loanToken;
        info.collateralToken = params.collateralToken;
        info.oracle = params.oracle;
        info.irm = params.irm;
        info.lltv = params.lltv;
        info.totalSupplyAssets = supplyAssets;
        info.totalBorrowAssets = borrowAssets;

        // Find label
        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].marketId == marketId) {
                info.label = markets[i].label;
                break;
            }
        }

        // Utilization
        if (supplyAssets > 0) {
            info.utilizationBps = (uint256(borrowAssets) * BPS) / supplyAssets;
        }

        // Borrow rate from IRM
        if (params.irm != address(0)) {
            MorphoMarketData memory mktData = MorphoMarketData(
                supplyAssets, supplyShares,
                borrowAssets, borrowShares,
                lastUpdate, fee
            );
            try IMorphoIRM(params.irm).borrowRateView(params, mktData) returns (uint256 ratePerSec) {
                info.borrowRateAnnualized = ratePerSec * SECONDS_PER_YEAR;

                // Estimate supply rate: borrowRate * utilization * (1 - protocolFee)
                // fee is in WAD (e.g. 0.1e18 = 10%)
                if (supplyAssets > 0) {
                    uint256 utilWad = (uint256(borrowAssets) * 1e18) / supplyAssets;
                    uint256 grossSupply = (info.borrowRateAnnualized * utilWad) / 1e18;
                    uint256 feeWad = uint256(fee);
                    info.supplyRateAnnualized = grossSupply - (grossSupply * feeWad) / 1e18;
                }
            } catch {}
        }
    }

    /**
     * @notice Get live info for ALL whitelisted markets in one call
     * @dev Designed for frontend batch loading — single RPC call
     */
    function getAllMarketInfo() external view returns (MarketInfo[] memory infos) {
        infos = new MarketInfo[](markets.length);
        for (uint256 i = 0; i < markets.length; i++) {
            infos[i] = getMarketInfo(markets[i].marketId);
        }
    }
}
