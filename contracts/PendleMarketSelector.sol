// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title PendleMarketSelector
 * @notice Selects optimal Pendle PT market based on TVL and implied yield
 * @dev Used by PendleStrategyV2 to auto-select best market for deposits
 * @dev FIX C-01: Migrated from OwnableUpgradeable to AccessControlUpgradeable
 *
 * Selection Criteria:
 *   1. Filter: Only markets with underlying = target asset (e.g., USDC-based)
 *   2. Filter: Only markets not expired and > minTimeToExpiry
 *   3. Score: TVL weight (40%) + Implied APY weight (60%)
 *   4. Select: Highest scoring market
 */

// Pendle Market interface
interface IPendleMarket {
    function readTokens() external view returns (address sy, address pt, address yt);
    function expiry() external view returns (uint256);
    function isExpired() external view returns (bool);

    // Market storage - gives us totalPt, totalSy, lastLnImpliedRate
    function _storage() external view returns (
        int128 totalPt,
        int128 totalSy,
        uint96 lastLnImpliedRate,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext
    );
}

// Pendle Oracle interface
interface IPendleOracle {
    function getPtToSyRate(address market, uint32 duration) external view returns (uint256);
    function getYtToSyRate(address market, uint32 duration) external view returns (uint256);
    function getLpToSyRate(address market, uint32 duration) external view returns (uint256);
}

// SY interface to get underlying asset
interface ISY {
    function yieldToken() external view returns (address);
    function getTokensIn() external view returns (address[] memory);
    function getTokensOut() external view returns (address[] memory);
    function exchangeRate() external view returns (uint256);
}

contract PendleMarketSelector is AccessControlUpgradeable, UUPSUpgradeable {

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES (FIX C-01)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Role for managing market whitelist
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");

    /// @notice Role for updating selector parameters
    bytes32 public constant PARAMS_ADMIN_ROLE = keccak256("PARAMS_ADMIN_ROLE");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pendle Oracle (same address on all chains)
    address public constant PENDLE_ORACLE = 0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2;

    /// @notice TWAP duration for oracle queries (15 min recommended)
    uint32 public constant TWAP_DURATION = 900;

    /// @notice Basis points denominator
    uint256 public constant BPS = 10000;

    /// @notice Seconds per year for APY calculation
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Whitelisted Pendle markets (manually curated for safety)
    address[] public whitelistedMarkets;

    /// @notice Market address → is whitelisted
    mapping(address => bool) public isWhitelisted;

    /// @notice Market address → underlying asset category (e.g., "USD", "ETH")
    mapping(address => string) public marketCategory;

    /// @notice Minimum time to expiry for market selection (default 30 days)
    uint256 public minTimeToExpiry;

    /// @notice Minimum TVL in USD for market selection
    uint256 public minTvlUsd;

    /// @notice Minimum APY in basis points (e.g., 900 = 9%)
    uint256 public minApyBps;

    /// @notice Weight for TVL in scoring (basis points, e.g., 4000 = 40%)
    uint256 public tvlWeight;

    /// @notice Weight for APY in scoring (basis points)
    uint256 public apyWeight;

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct MarketInfo {
        address market;
        address sy;
        address pt;
        uint256 expiry;
        uint256 timeToExpiry;
        uint256 totalPt;
        uint256 totalSy;
        uint256 tvlSy;           // TVL in SY terms
        uint256 impliedRate;     // ln(implied rate) from storage
        uint256 impliedAPY;      // Annualized APY in basis points
        uint256 score;           // Composite score for ranking
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event MarketWhitelisted(address indexed market, string category);
    event MarketRemoved(address indexed market);
    event BestMarketSelected(address indexed market, uint256 tvl, uint256 impliedAPY, uint256 score);
    event ParamsUpdated(uint256 minTimeToExpiry, uint256 minTvlUsd, uint256 tvlWeight, uint256 apyWeight);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error NoValidMarkets();
    error MarketNotWhitelisted();
    error InvalidWeights();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    function initialize(address _admin) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        // FIX C-01: Set up role hierarchy
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(MARKET_ADMIN_ROLE, _admin);
        _grantRole(PARAMS_ADMIN_ROLE, _admin);

        // Default parameters
        // 30 days minimum - shorter pools often have 1-2% APY premium
        // which more than offsets the ~1.2% annual slippage from more frequent rolls
        minTimeToExpiry = 30 days;
        minTvlUsd = 10_000_000e6;      // $10M minimum (6 decimals)
        minApyBps = 900;               // 9% minimum APY
        tvlWeight = 4000;              // 40%
        apyWeight = 6000;              // 60% - favors higher APY shorter-dated pools
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MARKET SELECTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Select the best market for a given category
     * @param category Asset category (e.g., "USD" for USDC-based markets)
     * @return bestMarket Address of the best market
     * @return info Full info about the selected market
     */
    function selectBestMarket(string calldata category)
        external
        view
        returns (address bestMarket, MarketInfo memory info)
    {
        MarketInfo[] memory validMarkets = getValidMarkets(category);

        if (validMarkets.length == 0) revert NoValidMarkets();

        // Find highest score
        uint256 bestScore = 0;
        uint256 bestIndex = 0;

        for (uint256 i = 0; i < validMarkets.length; i++) {
            if (validMarkets[i].score > bestScore) {
                bestScore = validMarkets[i].score;
                bestIndex = i;
            }
        }

        return (validMarkets[bestIndex].market, validMarkets[bestIndex]);
    }

    /**
     * @notice Get all valid markets for a category with full info
     * @param category Asset category to filter by
     * @return markets Array of MarketInfo for valid markets
     */
    function getValidMarkets(string calldata category)
        public
        view
        returns (MarketInfo[] memory markets)
    {
        // FIX M-01: Single pass — cache MarketInfo to avoid double external calls.
        // Build temporary array with all whitelisted markets' info, then filter.
        uint256 len = whitelistedMarkets.length;
        MarketInfo[] memory temp = new MarketInfo[](len);
        bool[] memory valid = new bool[](len);
        uint256 validCount = 0;

        for (uint256 i = 0; i < len; i++) {
            address market = whitelistedMarkets[i];
            if (!isWhitelisted[market]) continue;
            if (keccak256(bytes(marketCategory[market])) != keccak256(bytes(category))) continue;

            IPendleMarket pendleMarket = IPendleMarket(market);
            if (pendleMarket.isExpired()) continue;

            uint256 expiry = pendleMarket.expiry();
            if (expiry < block.timestamp + minTimeToExpiry) continue;

            // Get info once (expensive external calls)
            MarketInfo memory info = _getMarketInfo(market);

            if (info.tvlSy < minTvlUsd) continue;
            if (info.impliedAPY < minApyBps) continue;

            temp[i] = info;
            valid[i] = true;
            validCount++;
        }

        // Compact into result array
        markets = new MarketInfo[](validCount);
        uint256 index = 0;
        for (uint256 i = 0; i < len; i++) {
            if (valid[i]) {
                markets[index] = temp[i];
                index++;
            }
        }

        // Calculate scores
        if (validCount > 0) {
            _calculateScores(markets);
        }

        return markets;
    }

    /**
     * @notice Get detailed info for a specific market
     * @param market Market address
     * @return info MarketInfo struct
     */
    function getMarketInfo(address market) external view returns (MarketInfo memory info) {
        return _getMarketInfo(market);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Check if market passes basic filters
     */
    function _isValidMarket(address market, string calldata category) internal view returns (bool) {
        // Must be whitelisted
        if (!isWhitelisted[market]) return false;

        // Must match category
        if (keccak256(bytes(marketCategory[market])) != keccak256(bytes(category))) {
            return false;
        }

        // Must not be expired
        IPendleMarket pendleMarket = IPendleMarket(market);
        if (pendleMarket.isExpired()) return false;

        // Must have enough time to expiry
        uint256 expiry = pendleMarket.expiry();
        if (expiry < block.timestamp + minTimeToExpiry) return false;

        // Get market info for TVL and APY checks
        MarketInfo memory info = _getMarketInfo(market);

        // Must meet minimum TVL (convert to same decimals)
        if (info.tvlSy < minTvlUsd) return false;

        // Must meet minimum APY
        if (info.impliedAPY < minApyBps) return false;

        return true;
    }

    /**
     * @notice Get full market info
     */
    function _getMarketInfo(address market) internal view returns (MarketInfo memory info) {
        IPendleMarket pendleMarket = IPendleMarket(market);

        // Get tokens
        (address sy, address pt,) = pendleMarket.readTokens();

        // Get storage data
        (
            int128 totalPt,
            int128 totalSy,
            uint96 lastLnImpliedRate,
            , ,
        ) = pendleMarket._storage();

        // Get expiry
        uint256 expiry = pendleMarket.expiry();
        uint256 timeToExpiry = expiry > block.timestamp ? expiry - block.timestamp : 0;

        // Calculate TVL in SY terms (totalPt converted + totalSy)
        // PT trades at discount, so we use oracle rate
        // slither-disable-next-line calls-loop
        uint256 ptToSyRate = IPendleOracle(PENDLE_ORACLE).getPtToSyRate(market, TWAP_DURATION);
        uint256 ptValueInSy = (uint256(uint128(totalPt)) * ptToSyRate) / 1e18;
        uint256 tvlSy = ptValueInSy + uint256(uint128(totalSy));

        // Convert lnImpliedRate to APY
        // lnImpliedRate is stored as ln(1 + rate) scaled by 1e18
        // APY = exp(lnImpliedRate * timeToExpiry / SECONDS_PER_YEAR) - 1
        // Simplified: APY ≈ lnImpliedRate for small rates (first-order approximation)
        uint256 impliedAPY = _lnRateToAPY(uint256(lastLnImpliedRate), timeToExpiry);

        info = MarketInfo({
            market: market,
            sy: sy,
            pt: pt,
            expiry: expiry,
            timeToExpiry: timeToExpiry,
            totalPt: uint256(uint128(totalPt)),
            totalSy: uint256(uint128(totalSy)),
            tvlSy: tvlSy,
            impliedRate: uint256(lastLnImpliedRate),
            impliedAPY: impliedAPY,
            score: 0 // Calculated separately
        });

        return info;
    }

    /**
     * @notice Convert ln(implied rate) to annualized APY in basis points
     * @dev lnImpliedRate = ln(1 + rate_to_expiry) scaled by 1e18
     *      APY = (1 + rate_to_expiry)^(365/days_to_expiry) - 1
     *      Simplified using: ln(APY + 1) ≈ lnImpliedRate * 365 / days_to_expiry
     */
    // slither-disable-next-line divide-before-multiply
    function _lnRateToAPY(uint256 lnImpliedRate, uint256 timeToExpiry) internal pure returns (uint256) {
        // slither-disable-next-line incorrect-equality
        if (timeToExpiry == 0) return 0;

        // Annualize the ln rate
        // lnAPY = lnImpliedRate * SECONDS_PER_YEAR / timeToExpiry
        uint256 lnAPY = (lnImpliedRate * SECONDS_PER_YEAR) / timeToExpiry;

        // Convert to APY: exp(lnAPY) - 1
        // For small rates (< 50%), use approximation: APY ≈ lnAPY
        // For larger rates, this underestimates slightly (acceptable for scoring)

        // Return in basis points (multiply by 10000, divide by 1e18)
        // lnAPY is in 1e18 scale, so:
        // APY_bps = lnAPY * 10000 / 1e18
        return (lnAPY * BPS) / 1e18;
    }

    /**
     * @notice Calculate composite scores for market ranking
     * @dev Score = (TVL_normalized * tvlWeight + APY_normalized * apyWeight) / 10000
     */
    function _calculateScores(MarketInfo[] memory markets) internal view {
        if (markets.length == 0) return;

        // Find max TVL and max APY for normalization
        uint256 maxTvl = 0;
        uint256 maxAPY = 0;

        for (uint256 i = 0; i < markets.length; i++) {
            if (markets[i].tvlSy > maxTvl) maxTvl = markets[i].tvlSy;
            if (markets[i].impliedAPY > maxAPY) maxAPY = markets[i].impliedAPY;
        }

        // Calculate normalized scores
        for (uint256 i = 0; i < markets.length; i++) {
            uint256 tvlScore = maxTvl > 0
                ? (markets[i].tvlSy * BPS) / maxTvl
                : 0;

            uint256 apyScore = maxAPY > 0
                ? (markets[i].impliedAPY * BPS) / maxAPY
                : 0;

            // Weighted composite score
            markets[i].score = (tvlScore * tvlWeight + apyScore * apyWeight) / BPS;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Add a market to whitelist
     * @param market Market address
     * @param category Asset category (e.g., "USD", "ETH")
     */
    function whitelistMarket(address market, string calldata category) external onlyRole(MARKET_ADMIN_ROLE) {
        // FIX L-07: Validate market address
        require(market != address(0), "ZERO_ADDRESS");
        if (!isWhitelisted[market]) {
            whitelistedMarkets.push(market);
            isWhitelisted[market] = true;
        }
        marketCategory[market] = category;

        emit MarketWhitelisted(market, category);
    }

    /**
     * @notice Batch whitelist markets
     * @param markets Array of market addresses
     * @param categories Array of categories
     */
    function whitelistMarkets(
        address[] calldata markets,
        string[] calldata categories
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        require(markets.length == categories.length, "Length mismatch");

        for (uint256 i = 0; i < markets.length; i++) {
            if (!isWhitelisted[markets[i]]) {
                whitelistedMarkets.push(markets[i]);
                isWhitelisted[markets[i]] = true;
            }
            marketCategory[markets[i]] = categories[i];

            emit MarketWhitelisted(markets[i], categories[i]);
        }
    }

    /**
     * @notice Remove a market from whitelist
     * @param market Market address
     */
    function removeMarket(address market) external onlyRole(MARKET_ADMIN_ROLE) {
        if (!isWhitelisted[market]) revert MarketNotWhitelisted();

        isWhitelisted[market] = false;
        delete marketCategory[market];

        // Remove from array
        for (uint256 i = 0; i < whitelistedMarkets.length; i++) {
            if (whitelistedMarkets[i] == market) {
                whitelistedMarkets[i] = whitelistedMarkets[whitelistedMarkets.length - 1];
                whitelistedMarkets.pop();
                break;
            }
        }

        emit MarketRemoved(market);
    }

    /**
     * @notice Update selection parameters
     */
    function setParams(
        uint256 _minTimeToExpiry,
        uint256 _minTvlUsd,
        uint256 _minApyBps,
        uint256 _tvlWeight,
        uint256 _apyWeight
    ) external onlyRole(PARAMS_ADMIN_ROLE) {
        if (_tvlWeight + _apyWeight != BPS) revert InvalidWeights();

        minTimeToExpiry = _minTimeToExpiry;
        minTvlUsd = _minTvlUsd;
        minApyBps = _minApyBps;
        tvlWeight = _tvlWeight;
        apyWeight = _apyWeight;

        emit ParamsUpdated(_minTimeToExpiry, _minTvlUsd, _tvlWeight, _apyWeight);
    }

    /**
     * @notice Get all whitelisted markets
     */
    function getWhitelistedMarkets() external view returns (address[] memory) {
        return whitelistedMarkets;
    }

    /**
     * @notice Get count of whitelisted markets
     */
    function whitelistedCount() external view returns (uint256) {
        return whitelistedMarkets.length;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADEABILITY
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice FIX C-01: UUPS upgrade authorization requires DEFAULT_ADMIN_ROLE
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @dev FIX H-02: Storage gap for future upgrades
    uint256[40] private __gap;
}
