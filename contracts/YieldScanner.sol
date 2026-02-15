// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title YieldScanner
 * @notice On-chain DeFi yield aggregator that batch-queries multiple protocols
 *         in a single RPC call and returns ranked opportunities.
 *
 * @dev Protocols scanned:
 *   1. Aave V3          — supply APY for USDC/USDT/DAI reserve data
 *   2. Compound V3      — supply rate from Comet (USDC market)
 *   3. Morpho Blue      — supply + borrow APY per whitelisted market
 *   4. Pendle           — implied APY from PT discount on whitelisted markets
 *   5. Sky sUSDS        — savings rate from ERC4626 vault
 *   6. Ethena sUSDe     — sUSDe staking yield
 *   7. Spark            — Aave V3 fork (SparkLend) supply rate
 *   8. Curve/Convex     — LP base APY + CRV/CVX boost
 *   9. Yearn V3         — vault APY for USDC
 *  10. Contango         — Multi-money-market leveraged loop strategies
 *
 * All queries are view-only (no state changes). The contract never holds funds.
 * External protocol failures are caught — scanner returns partial results
 * rather than reverting the entire batch.
 *
 * Yield is reported in **basis points** (1 bps = 0.01%).
 * TVL is reported in the protocol's native precision (varies per protocol).
 */

// ═══════════════════════════════════════════════════════════════════════════
// PROTOCOL INTERFACES (minimal — view-only)
// ═══════════════════════════════════════════════════════════════════════════

/// @notice Aave V3 Pool — getReserveData for supply/borrow rates
interface IAaveV3Pool {
    struct ReserveData {
        // Only fields we need (Aave V3 struct has ~15 fields, we read select ones)
        uint256 configuration;          // slot 0
        uint128 liquidityIndex;         // slot 1
        uint128 currentLiquidityRate;   // supply APY in RAY (1e27)
        uint128 variableBorrowIndex;    // slot 2
        uint128 currentVariableBorrowRate; // borrow APY in RAY
        uint128 currentStableBorrowRate;   // stable borrow APY
        uint40  lastUpdateTimestamp;
        uint16  id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
}

/// @notice Compound V3 Comet — supply rate per second
interface IComet {
    function getSupplyRate(uint256 utilization) external view returns (uint64);
    function getUtilization() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalBorrow() external view returns (uint256);
    function baseToken() external view returns (address);
}

/// @notice Morpho Blue singleton — market state
interface IMorphoBlueScanner {
    struct MarketData {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }
    function market(bytes32 id) external view returns (MarketData memory);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
}

/// @notice Morpho IRM — borrow rate view
interface IMorphoIRMScanner {
    function borrowRateView(
        IMorphoBlueScanner.MarketParams calldata params,
        IMorphoBlueScanner.MarketData calldata data
    ) external view returns (uint256);
}

/// @notice Morpho Market Registry (our own)
interface IMorphoMarketRegistry {
    function getWhitelistedMarkets() external view returns (bytes32[] memory);
}

/// @notice Pendle Market — implied rate + state
interface IPendleMarketScanner {
    function readTokens() external view returns (address sy, address pt, address yt);
    function expiry() external view returns (uint256);
    // _storage returns packed market state
    function _storage() external view returns (
        int128 totalPt,
        int128 totalSy,
        uint96 lastLnImpliedRate,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext
    );
}

/// @notice PendleMarketSelector (our own) — whitelisted markets
interface IPendleMarketSelector {
    function getWhitelistedMarkets() external view returns (address[] memory);
    function getMarketLabel(address mkt) external view returns (string memory);
}

/// @notice ERC4626 vault interface (Sky sUSDS, Ethena sUSDe, Yearn V3)
interface IERC4626Scanner {
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function asset() external view returns (address);
}

/// @notice Curve StableSwap pool — get_virtual_price for base APY tracking
interface ICurvePool {
    function get_virtual_price() external view returns (uint256);
    function balances(uint256 i) external view returns (uint256);
}

/// @notice Curve gauge — for reading boost/reward info
interface ICurveGauge {
    function inflation_rate() external view returns (uint256);
    function working_supply() external view returns (uint256);
}

/// @notice Contango Lens — view-only rates, balances, leverage for loop strategies
/// Mainnet: 0xe03835Dfae2644F37049c1feF13E8ceD6b1Bb72a
interface IContangoLensScanner {
    function rates(bytes32 positionId)
        external
        view
        returns (uint256 borrowing, uint256 lending);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

contract YieldScanner is AccessControl {

    // ═════════════════════════════════════════════════════════════════════
    // TYPES
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Protocol identifier
    enum Protocol {
        AaveV3,        // 0
        CompoundV3,    // 1
        MorphoBlue,    // 2
        Pendle,        // 3
        SkySUSDS,      // 4
        EthenaSUSDe,   // 5
        Spark,         // 6
        CurveConvex,   // 7
        YearnV3,       // 8
        Contango       // 9  — Multi-money-market leverage protocol
    }

    /// @notice Risk tier classification
    enum RiskTier {
        Low,           // Blue-chip lending (Aave, Compound, Spark)
        Medium,        // Structured yield (Morpho, Pendle PT, Sky)
        High,          // Synthetic/derivative (Ethena, Curve LP, Yearn)
        Unclassified   // Fallback
    }

    /// @notice Investment tranche
    enum Tranche {
        Senior,        // Lowest risk, lowest yield — capital preservation
        Mezzanine,     // Medium risk, medium yield — balanced
        Junior         // Highest risk, highest yield — yield maximization
    }

    /// @notice A single yield opportunity discovered by the scanner
    struct Opportunity {
        Protocol protocol;           // Which protocol
        RiskTier risk;               // Risk classification
        string   label;              // Human-readable name (e.g., "Aave V3 USDC")
        address  venue;              // Contract address (pool/market/vault)
        bytes32  marketId;           // For Morpho markets (0x0 otherwise)
        uint256  supplyApyBps;       // Annualized supply APY in basis points
        uint256  borrowApyBps;       // Annualized borrow APY in bps (0 if N/A)
        uint256  tvlUsd6;            // Total value locked in USDC-equivalent (6 decimals)
        uint256  utilizationBps;     // Utilization in bps (0-10000)
        uint256  extraData;          // Protocol-specific (LLTV for Morpho, expiry for Pendle, etc.)
        bool     available;          // Whether deposits are currently possible
    }

    /// @notice Suggestion based on scan results (legacy — kept for compatibility)
    struct Suggestion {
        uint8    rank;               // 1 = best
        Protocol protocol;
        string   label;
        address  venue;
        bytes32  marketId;
        uint256  supplyApyBps;
        RiskTier risk;
        string   reason;             // "Highest risk-adjusted yield", etc.
    }

    /// @notice Multi-factor scored suggestion within a tranche
    struct TrancheSuggestion {
        uint8    rank;               // 1 = best within tranche
        Tranche  tranche;            // Senior / Mezzanine / Junior
        Protocol protocol;
        string   label;
        address  venue;
        bytes32  marketId;
        uint256  supplyApyBps;
        uint256  borrowApyBps;
        uint256  tvlUsd6;
        uint256  utilizationBps;
        RiskTier risk;
        uint256  compositeScore;     // Multi-factor score (higher = better fit)
        string   reason;
    }

    /// @notice Full tranche result set
    struct TrancheResult {
        TrancheSuggestion[] senior;     // Capital preservation picks
        TrancheSuggestion[] mezzanine;  // Balanced picks
        TrancheSuggestion[] junior;     // Yield maximization picks
    }

    // ═════════════════════════════════════════════════════════════════════
    // PROTOCOL REGISTRY
    // ═════════════════════════════════════════════════════════════════════

    struct ProtocolEntry {
        Protocol protocol;
        string   label;
        address  target;             // Pool / Comet / Vault / Market address
        bytes32  marketId;           // For Morpho (bytes32(0) for others)
        bool     enabled;
    }

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice All registered yield sources
    ProtocolEntry[] public entries;

    /// @notice External protocol addresses (set once)
    address public aaveV3Pool;        // Aave V3 LendingPool
    address public compoundComet;     // Compound V3 cUSDCv3
    address public sparkPool;         // Spark LendingPool (Aave V3 fork)
    address public sUsdsVault;        // Sky sUSDS ERC4626
    address public sUsdeVault;        // Ethena sUSDe ERC4626
    address public morphoBlue;        // Morpho Blue singleton
    address public morphoRegistry;    // Our MorphoMarketRegistry
    address public pendleSelector;    // Our PendleMarketSelector
    address public yearnVault;        // Yearn V3 USDC vault
    address public curvePool;         // Curve 3pool / crvUSD pool
    address public curveGauge;        // Curve gauge for boost info
    address public contangoLens;      // Contango Lens — rates, balances, leverage
    address public contangoCore;      // Contango Core — instrument discovery

    /// @notice USDC address for Aave/Compound queries
    address public usdc;

    /// @notice Seconds per year for rate conversion
    uint256 private constant SECONDS_PER_YEAR = 365.25 days;
    /// @notice Aave RAY precision
    uint256 private constant RAY = 1e27;
    /// @notice Basis points denominator
    uint256 private constant BPS = 10_000;

    // ═════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═════════════════════════════════════════════════════════════════════

    event ProtocolConfigured(Protocol indexed protocol, address target);
    event EntryAdded(uint256 indexed index, Protocol protocol, string label, address target);
    event EntryToggled(uint256 indexed index, bool enabled);

    // ═════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═════════════════════════════════════════════════════════════════════

    constructor(address _admin, address _usdc) {
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
        usdc = _usdc;
    }

    // ═════════════════════════════════════════════════════════════════════
    // ADMIN: CONFIGURE PROTOCOLS
    // ═════════════════════════════════════════════════════════════════════

    function configureAaveV3(address _pool) external onlyRole(MANAGER_ROLE) {
        aaveV3Pool = _pool;
        emit ProtocolConfigured(Protocol.AaveV3, _pool);
    }

    function configureCompoundV3(address _comet) external onlyRole(MANAGER_ROLE) {
        compoundComet = _comet;
        emit ProtocolConfigured(Protocol.CompoundV3, _comet);
    }

    function configureSpark(address _pool) external onlyRole(MANAGER_ROLE) {
        sparkPool = _pool;
        emit ProtocolConfigured(Protocol.Spark, _pool);
    }

    function configureSkySUSDS(address _vault) external onlyRole(MANAGER_ROLE) {
        sUsdsVault = _vault;
        emit ProtocolConfigured(Protocol.SkySUSDS, _vault);
    }

    function configureEthenaSUSDe(address _vault) external onlyRole(MANAGER_ROLE) {
        sUsdeVault = _vault;
        emit ProtocolConfigured(Protocol.EthenaSUSDe, _vault);
    }

    function configureMorpho(address _blue, address _registry) external onlyRole(MANAGER_ROLE) {
        morphoBlue = _blue;
        morphoRegistry = _registry;
        emit ProtocolConfigured(Protocol.MorphoBlue, _blue);
    }

    function configurePendle(address _selector) external onlyRole(MANAGER_ROLE) {
        pendleSelector = _selector;
        emit ProtocolConfigured(Protocol.Pendle, _selector);
    }

    function configureYearnV3(address _vault) external onlyRole(MANAGER_ROLE) {
        yearnVault = _vault;
        emit ProtocolConfigured(Protocol.YearnV3, _vault);
    }

    function configureCurve(address _pool, address _gauge) external onlyRole(MANAGER_ROLE) {
        curvePool = _pool;
        curveGauge = _gauge;
        emit ProtocolConfigured(Protocol.CurveConvex, _pool);
    }

    function configureContango(address _lens, address _core) external onlyRole(MANAGER_ROLE) {
        contangoLens = _lens;
        contangoCore = _core;
        emit ProtocolConfigured(Protocol.Contango, _lens);
    }

    /// @notice Add a custom yield entry (manual)
    function addEntry(
        Protocol _protocol,
        string calldata _label,
        address _target,
        bytes32 _marketId
    ) external onlyRole(MANAGER_ROLE) {
        entries.push(ProtocolEntry({
            protocol: _protocol,
            label: _label,
            target: _target,
            marketId: _marketId,
            enabled: true
        }));
        emit EntryAdded(entries.length - 1, _protocol, _label, _target);
    }

    function toggleEntry(uint256 index, bool enabled) external onlyRole(MANAGER_ROLE) {
        require(index < entries.length, "Invalid index");
        entries[index].enabled = enabled;
        emit EntryToggled(index, enabled);
    }

    function entryCount() external view returns (uint256) {
        return entries.length;
    }

    // ═════════════════════════════════════════════════════════════════════
    // CORE: FULL SCAN
    // ═════════════════════════════════════════════════════════════════════

    /**
     * @notice Scan ALL configured protocols and return every opportunity found.
     * @dev This is a view function — no gas cost when called off-chain.
     *      Individual protocol failures are caught; partial results are returned.
     * @return opportunities Array of all yield opportunities discovered
     * @return count Number of valid opportunities (may be < array length)
     */
    function scanAll() external view returns (Opportunity[] memory opportunities, uint256 count) {
        // Pre-allocate generous array (will trim later)
        Opportunity[] memory raw = new Opportunity[](100);
        uint256 idx = 0;

        // 1. Aave V3
        if (aaveV3Pool != address(0) && usdc != address(0)) {
            (bool ok, Opportunity memory opp) = _scanAaveV3(aaveV3Pool, "Aave V3 USDC", Protocol.AaveV3);
            if (ok) { raw[idx++] = opp; }
        }

        // 2. Compound V3
        if (compoundComet != address(0)) {
            (bool ok, Opportunity memory opp) = _scanCompoundV3();
            if (ok) { raw[idx++] = opp; }
        }

        // 3. Spark (Aave V3 fork)
        if (sparkPool != address(0) && usdc != address(0)) {
            (bool ok, Opportunity memory opp) = _scanAaveV3(sparkPool, "Spark USDC", Protocol.Spark);
            if (ok) { raw[idx++] = opp; }
        }

        // 4. Sky sUSDS
        if (sUsdsVault != address(0)) {
            (bool ok, Opportunity memory opp) = _scanERC4626(
                sUsdsVault, "Sky sUSDS", Protocol.SkySUSDS, RiskTier.Medium
            );
            if (ok) { raw[idx++] = opp; }
        }

        // 5. Ethena sUSDe
        if (sUsdeVault != address(0)) {
            (bool ok, Opportunity memory opp) = _scanERC4626(
                sUsdeVault, "Ethena sUSDe", Protocol.EthenaSUSDe, RiskTier.High
            );
            if (ok) { raw[idx++] = opp; }
        }

        // 6. Yearn V3
        if (yearnVault != address(0)) {
            (bool ok, Opportunity memory opp) = _scanERC4626(
                yearnVault, "Yearn V3 USDC", Protocol.YearnV3, RiskTier.High
            );
            if (ok) { raw[idx++] = opp; }
        }

        // 7. Morpho Blue markets (batch via registry)
        if (morphoBlue != address(0) && morphoRegistry != address(0)) {
            uint256 added = _scanMorphoMarkets(raw, idx);
            idx += added;
        }

        // 8. Pendle markets (batch via selector)
        if (pendleSelector != address(0)) {
            uint256 added = _scanPendleMarkets(raw, idx);
            idx += added;
        }

        // 9. Curve pool
        if (curvePool != address(0)) {
            (bool ok, Opportunity memory opp) = _scanCurve();
            if (ok) { raw[idx++] = opp; }
        }

        // 10. Contango — multi-money-market leveraged loop strategies
        if (contangoLens != address(0)) {
            (bool ok, Opportunity memory opp) = _scanContango();
            if (ok) { raw[idx++] = opp; }
        }

        // 11. Manual entries
        for (uint256 i = 0; i < entries.length; i++) {
            if (!entries[i].enabled) continue;
            if (idx >= 100) break;

            ProtocolEntry memory e = entries[i];
            // Try to read rate from the target based on protocol type
            (bool ok, Opportunity memory opp) = _scanEntry(e);
            if (ok) { raw[idx++] = opp; }
        }

        // Trim to actual size
        opportunities = new Opportunity[](idx);
        for (uint256 i = 0; i < idx; i++) {
            opportunities[i] = raw[i];
        }
        count = idx;
    }

    /**
     * @notice Generate ranked suggestions from scan results (legacy).
     * @dev Sorts by risk-adjusted APY and returns top N.
     * @param maxSuggestions Maximum number of suggestions to return (1-10)
     * @return suggestions Ranked suggestions
     */
    function getSuggestions(uint256 maxSuggestions)
        external
        view
        returns (Suggestion[] memory suggestions)
    {
        if (maxSuggestions == 0) maxSuggestions = 5;
        if (maxSuggestions > 10) maxSuggestions = 10;

        (Opportunity[] memory opps, uint256 count) = this.scanAll();
        if (count == 0) return new Suggestion[](0);

        uint256[] memory scores = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            scores[i] = _riskAdjustedScore(opps[i]);
        }

        uint256[] memory indices = _sortDescending(scores, count);

        uint256 n = count < maxSuggestions ? count : maxSuggestions;
        suggestions = new Suggestion[](n);

        for (uint256 i = 0; i < n; i++) {
            Opportunity memory opp = opps[indices[i]];
            suggestions[i] = Suggestion({
                rank: uint8(i + 1),
                protocol: opp.protocol,
                label: opp.label,
                venue: opp.venue,
                marketId: opp.marketId,
                supplyApyBps: opp.supplyApyBps,
                risk: opp.risk,
                reason: _suggestionReason(opp, i)
            });
        }
    }

    /**
     * @notice Generate tranche-based suggestions: Senior, Mezzanine, Junior.
     *
     * @dev Each tranche uses different scoring weights:
     *
     *   SENIOR (Capital Preservation):
     *     Security/Trust:  40%  — protocol maturity, audit history, blue-chip status
     *     TVL/Liquidity:   30%  — deep liquidity = low exit risk
     *     Utilization:     20%  — low utilization = healthy protocol
     *     Yield:           10%  — yield matters least, but still a tiebreaker
     *
     *   MEZZANINE (Balanced):
     *     Yield:           30%
     *     Security/Trust:  25%
     *     TVL/Liquidity:   25%
     *     Utilization:     20%
     *
     *   JUNIOR (Yield Maximization):
     *     Yield:           50%  — chase the highest APY
     *     TVL/Liquidity:   20%  — still check liquidity to ensure exit
     *     Utilization:     15%  — high util can mean high demand
     *     Security/Trust:  15%  — accept higher risk for higher yield
     *
     * @param perTranche Number of suggestions per tranche (1-5, default 3)
     * @return senior Top picks for capital preservation
     * @return mezzanine Top picks for balanced risk/reward
     * @return junior Top picks for yield maximization
     */
    function getTranches(uint256 perTranche)
        external
        view
        returns (
            TrancheSuggestion[] memory senior,
            TrancheSuggestion[] memory mezzanine,
            TrancheSuggestion[] memory junior
        )
    {
        if (perTranche == 0) perTranche = 3;
        if (perTranche > 5) perTranche = 5;

        (Opportunity[] memory opps, uint256 count) = this.scanAll();
        if (count == 0) {
            return (
                new TrancheSuggestion[](0),
                new TrancheSuggestion[](0),
                new TrancheSuggestion[](0)
            );
        }

        // Score every opportunity under each tranche's weights
        uint256[] memory seniorScores   = new uint256[](count);
        uint256[] memory mezzScores     = new uint256[](count);
        uint256[] memory juniorScores   = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            seniorScores[i]  = _trancheScore(opps[i], Tranche.Senior);
            mezzScores[i]    = _trancheScore(opps[i], Tranche.Mezzanine);
            juniorScores[i]  = _trancheScore(opps[i], Tranche.Junior);
        }

        // Sort and pick top N for each tranche
        senior    = _buildTrancheSuggestions(opps, seniorScores, count, perTranche, Tranche.Senior);
        mezzanine = _buildTrancheSuggestions(opps, mezzScores, count, perTranche, Tranche.Mezzanine);
        junior    = _buildTrancheSuggestions(opps, juniorScores, count, perTranche, Tranche.Junior);
    }

    // ═════════════════════════════════════════════════════════════════════
    // INTERNAL: PROTOCOL SCANNERS
    // ═════════════════════════════════════════════════════════════════════

    function _scanAaveV3(
        address pool,
        string memory label,
        Protocol proto
    ) internal view returns (bool success, Opportunity memory opp) {
        try IAaveV3Pool(pool).getReserveData(usdc) returns (
            IAaveV3Pool.ReserveData memory data
        ) {
            // currentLiquidityRate is in RAY (1e27) = per-second compounded rate
            // APY bps = (rate / 1e27) * 10000
            uint256 supplyBps = (uint256(data.currentLiquidityRate) * BPS) / RAY;
            uint256 borrowBps = (uint256(data.currentVariableBorrowRate) * BPS) / RAY;

            opp = Opportunity({
                protocol: proto,
                risk: RiskTier.Low,
                label: label,
                venue: pool,
                marketId: bytes32(0),
                supplyApyBps: supplyBps,
                borrowApyBps: borrowBps,
                tvlUsd6: 0, // Would need aToken totalSupply — skip for gas
                utilizationBps: borrowBps > 0 && supplyBps > 0
                    ? (borrowBps * BPS) / (supplyBps + borrowBps)
                    : 0,
                extraData: 0,
                available: true
            });
            success = true;
        } catch {
            success = false;
        }
    }

    function _scanCompoundV3() internal view returns (bool success, Opportunity memory opp) {
        try IComet(compoundComet).getUtilization() returns (uint256 util) {
            try IComet(compoundComet).getSupplyRate(util) returns (uint64 ratePerSec) {
                // Compound V3: rate is per-second, scale to annual bps
                // APY = ratePerSec * SECONDS_PER_YEAR / 1e18 * 10000
                uint256 supplyBps = (uint256(ratePerSec) * SECONDS_PER_YEAR * BPS) / 1e18;
                uint256 utilBps = (util * BPS) / 1e18;

                uint256 tvl = 0;
                try IComet(compoundComet).totalSupply() returns (uint256 ts) {
                    tvl = ts;
                } catch {}

                opp = Opportunity({
                    protocol: Protocol.CompoundV3,
                    risk: RiskTier.Low,
                    label: "Compound V3 USDC",
                    venue: compoundComet,
                    marketId: bytes32(0),
                    supplyApyBps: supplyBps,
                    borrowApyBps: 0,
                    tvlUsd6: tvl,
                    utilizationBps: utilBps,
                    extraData: 0,
                    available: true
                });
                success = true;
            } catch {
                success = false;
            }
        } catch {
            success = false;
        }
    }

    function _scanERC4626(
        address vault,
        string memory label,
        Protocol proto,
        RiskTier risk
    ) internal view returns (bool success, Opportunity memory opp) {
        // ERC4626 doesn't expose APY directly — we read share price
        // and report it so the frontend can compute trailing APY
        try IERC4626Scanner(vault).totalAssets() returns (uint256 assets) {
            uint256 supply = 0;
            try IERC4626Scanner(vault).totalSupply() returns (uint256 ts) {
                supply = ts;
            } catch {}

            // sharePrice = assets / supply (in underlying precision)
            uint256 sharePrice = supply > 0 ? (assets * 1e18) / supply : 1e18;

            opp = Opportunity({
                protocol: proto,
                risk: risk,
                label: label,
                venue: vault,
                marketId: bytes32(0),
                supplyApyBps: 0, // Will be computed off-chain from share price history
                borrowApyBps: 0,
                tvlUsd6: assets, // In underlying token precision
                utilizationBps: 0,
                extraData: sharePrice, // Share price for APY computation
                available: true
            });
            success = true;
        } catch {
            success = false;
        }
    }

    function _scanMorphoMarkets(
        Opportunity[] memory raw,
        uint256 startIdx
    ) internal view returns (uint256 added) {
        added = 0;

        bytes32[] memory ids;
        try IMorphoMarketRegistry(morphoRegistry).getWhitelistedMarkets()
            returns (bytes32[] memory _ids) {
            ids = _ids;
        } catch {
            return 0;
        }

        for (uint256 i = 0; i < ids.length; i++) {
            if (startIdx + added >= 100) break;

            (bool ok, Opportunity memory opp) = _scanSingleMorphoMarket(ids[i]);
            if (ok) {
                raw[startIdx + added] = opp;
                added++;
            }
        }
    }

    function _scanSingleMorphoMarket(bytes32 id)
        internal
        view
        returns (bool success, Opportunity memory opp)
    {
        IMorphoBlueScanner.MarketData memory data;
        IMorphoBlueScanner.MarketParams memory params;

        try IMorphoBlueScanner(morphoBlue).market(id) returns (
            IMorphoBlueScanner.MarketData memory _d
        ) { data = _d; } catch { return (false, opp); }

        try IMorphoBlueScanner(morphoBlue).idToMarketParams(id) returns (
            IMorphoBlueScanner.MarketParams memory _p
        ) { params = _p; } catch { return (false, opp); }

        uint256 borrowRateAnnual = _getMorphoBorrowRate(params, data);

        uint256 totalSup = uint256(data.totalSupplyAssets);
        uint256 totalBor = uint256(data.totalBorrowAssets);
        uint256 utilBps = totalSup > 0 ? (totalBor * BPS) / totalSup : 0;
        uint256 feeFrac = uint256(data.fee);

        uint256 supplyRateAnnual = totalSup > 0
            ? (borrowRateAnnual * totalBor * (1e18 - feeFrac)) / (totalSup * 1e18)
            : 0;

        opp = Opportunity({
            protocol: Protocol.MorphoBlue,
            risk: RiskTier.Medium,
            label: "Morpho Blue",
            venue: morphoBlue,
            marketId: id,
            supplyApyBps: supplyRateAnnual / 1e14,
            borrowApyBps: borrowRateAnnual / 1e14,
            tvlUsd6: totalSup,
            utilizationBps: utilBps,
            extraData: params.lltv,
            available: true
        });
        success = true;
    }

    function _getMorphoBorrowRate(
        IMorphoBlueScanner.MarketParams memory params,
        IMorphoBlueScanner.MarketData memory data
    ) internal view returns (uint256) {
        if (params.irm == address(0)) return 0;
        try IMorphoIRMScanner(params.irm).borrowRateView(params, data) returns (
            uint256 ratePerSec
        ) {
            return ratePerSec * SECONDS_PER_YEAR;
        } catch {
            return 0;
        }
    }

    function _scanPendleMarkets(
        Opportunity[] memory raw,
        uint256 startIdx
    ) internal view returns (uint256 added) {
        added = 0;

        address[] memory markets;
        try IPendleMarketSelector(pendleSelector).getWhitelistedMarkets()
            returns (address[] memory _mkts) {
            markets = _mkts;
        } catch {
            return 0;
        }

        for (uint256 i = 0; i < markets.length; i++) {
            if (startIdx + added >= 100) break;

            address mkt = markets[i];

            try IPendleMarketScanner(mkt).expiry() returns (uint256 exp) {
                // Skip expired markets
                if (exp <= block.timestamp) continue;

                // Read implied rate from _storage
                uint256 apyBps = 0;
                try IPendleMarketScanner(mkt)._storage() returns (
                    int128, int128, uint96 lastLnImpliedRate,
                    uint16, uint16, uint16
                ) {
                    // Convert ln(1+r) to APY bps
                    // Approximation: APY ≈ lnRate / 1e18 * 10000
                    if (lastLnImpliedRate > 0) {
                        apyBps = (uint256(lastLnImpliedRate) * BPS) / 1e18;
                    }
                } catch {}

                string memory label = "Pendle PT";
                try IPendleMarketSelector(pendleSelector).getMarketLabel(mkt)
                    returns (string memory lbl) {
                    if (bytes(lbl).length > 0) label = lbl;
                } catch {}

                raw[startIdx + added] = Opportunity({
                    protocol: Protocol.Pendle,
                    risk: RiskTier.Medium,
                    label: label,
                    venue: mkt,
                    marketId: bytes32(0),
                    supplyApyBps: apyBps,
                    borrowApyBps: 0,
                    tvlUsd6: 0, // Would need oracle — skip for gas
                    utilizationBps: 0,
                    extraData: exp, // Expiry timestamp
                    available: exp > block.timestamp + 30 days
                });
                added++;
            } catch {}
        }
    }

    function _scanCurve() internal view returns (bool success, Opportunity memory opp) {
        try ICurvePool(curvePool).get_virtual_price() returns (uint256 vp) {
            // Virtual price tracks LP appreciation — report as extraData
            // APY must be computed off-chain from historical virtual prices
            uint256 tvl = 0;
            try ICurvePool(curvePool).balances(0) returns (uint256 b0) {
                tvl = b0; // First token balance as proxy
                try ICurvePool(curvePool).balances(1) returns (uint256 b1) {
                    tvl += b1;
                } catch {}
            } catch {}

            opp = Opportunity({
                protocol: Protocol.CurveConvex,
                risk: RiskTier.High,
                label: "Curve Pool",
                venue: curvePool,
                marketId: bytes32(0),
                supplyApyBps: 0, // Computed off-chain
                borrowApyBps: 0,
                tvlUsd6: tvl,
                utilizationBps: 0,
                extraData: vp, // Virtual price for APY tracking
                available: true
            });
            success = true;
        } catch {
            success = false;
        }
    }

    /**
     * @notice Scan Contango for USDC loop strategy yield
     * @dev Queries ContangoLens.rates() for the USDC instrument's borrow/lending rates
     *      Contango abstracts 10+ money markets (Aave, Morpho, Compound, Euler, Silo, etc.)
     *      behind a unified trade() interface. The scanner reports the best available
     *      lending/borrowing spread across all Contango money markets.
     *
     *      Mainnet addresses:
     *        ContangoLens: 0xe03835Dfae2644F37049c1feF13E8ceD6b1Bb72a
     *        Contango:     0x6Cae28b3D09D8f8Fc74ccD496AC986FC84C0C24E
     */
    function _scanContango() internal view returns (bool success, Opportunity memory opp) {
        // Query Contango Lens for USDC rates across all underlying markets
        // We use a zero positionId to query base rates
        try IContangoLensScanner(contangoLens).rates(bytes32(0))
            returns (uint256 borrowing, uint256 lending)
        {
            // Contango rates are in WAD (1e18 = 100%)
            // Convert to basis points: rate * 10000 / 1e18
            uint256 supplyBps = (lending * BPS) / 1e18;
            uint256 borrowBps = (borrowing * BPS) / 1e18;

            opp = Opportunity({
                protocol: Protocol.Contango,
                risk: RiskTier.Medium,  // Multi-protocol aggregation
                label: "Contango USDC Loop",
                venue: contangoCore != address(0) ? contangoCore : contangoLens,
                marketId: bytes32(0),
                supplyApyBps: supplyBps,
                borrowApyBps: borrowBps,
                tvlUsd6: 0,
                utilizationBps: borrowBps > 0 && supplyBps > 0
                    ? (borrowBps * BPS) / (supplyBps + borrowBps)
                    : 0,
                extraData: 0,
                available: true
            });
            success = true;
        } catch {
            success = false;
        }
    }

    function _scanEntry(ProtocolEntry memory e)
        internal
        view
        returns (bool success, Opportunity memory opp)
    {
        // Try to read the entry based on its protocol type
        if (e.protocol == Protocol.AaveV3 || e.protocol == Protocol.Spark) {
            return _scanAaveV3(e.target, e.label, e.protocol);
        } else if (e.protocol == Protocol.CompoundV3) {
            // Use the entry's target as comet
            try IComet(e.target).getUtilization() returns (uint256 util) {
                try IComet(e.target).getSupplyRate(util) returns (uint64 rate) {
                    uint256 supplyBps = (uint256(rate) * SECONDS_PER_YEAR * BPS) / 1e18;
                    opp = Opportunity({
                        protocol: Protocol.CompoundV3,
                        risk: RiskTier.Low,
                        label: e.label,
                        venue: e.target,
                        marketId: bytes32(0),
                        supplyApyBps: supplyBps,
                        borrowApyBps: 0,
                        tvlUsd6: 0,
                        utilizationBps: (util * BPS) / 1e18,
                        extraData: 0,
                        available: true
                    });
                    return (true, opp);
                } catch {}
            } catch {}
            return (false, opp);
        } else if (
            e.protocol == Protocol.SkySUSDS ||
            e.protocol == Protocol.EthenaSUSDe ||
            e.protocol == Protocol.YearnV3
        ) {
            RiskTier risk = e.protocol == Protocol.SkySUSDS
                ? RiskTier.Medium
                : RiskTier.High;
            return _scanERC4626(e.target, e.label, e.protocol, risk);
        } else if (e.protocol == Protocol.Contango) {
            // Contango entry — query Lens rates for the position/instrument
            try IContangoLensScanner(e.target).rates(e.marketId)
                returns (uint256 borrowing, uint256 lending)
            {
                uint256 supplyBps = (lending * BPS) / 1e18;
                uint256 borrowBps = (borrowing * BPS) / 1e18;
                opp = Opportunity({
                    protocol: Protocol.Contango,
                    risk: RiskTier.Medium,
                    label: e.label,
                    venue: e.target,
                    marketId: e.marketId,
                    supplyApyBps: supplyBps,
                    borrowApyBps: borrowBps,
                    tvlUsd6: 0,
                    utilizationBps: 0,
                    extraData: 0,
                    available: true
                });
                return (true, opp);
            } catch {}
            return (false, opp);
        } else {
            // Generic fallback — just mark it available
            opp = Opportunity({
                protocol: e.protocol,
                risk: RiskTier.Unclassified,
                label: e.label,
                venue: e.target,
                marketId: e.marketId,
                supplyApyBps: 0,
                borrowApyBps: 0,
                tvlUsd6: 0,
                utilizationBps: 0,
                extraData: 0,
                available: true
            });
            return (true, opp);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // INTERNAL: SCORING & SUGGESTIONS
    // ═════════════════════════════════════════════════════════════════════

    /**
     * @dev Risk-adjusted score for legacy ranking.
     *      Low risk:    100% of APY
     *      Medium risk:  80% of APY
     *      High risk:    60% of APY
     *      + bonus for high TVL (liquidity safety)
     *      + bonus for not being fully utilized
     */
    function _riskAdjustedScore(Opportunity memory opp) internal pure returns (uint256) {
        uint256 riskMultiplier;
        if (opp.risk == RiskTier.Low) riskMultiplier = 100;
        else if (opp.risk == RiskTier.Medium) riskMultiplier = 80;
        else if (opp.risk == RiskTier.High) riskMultiplier = 60;
        else riskMultiplier = 50;

        uint256 base = (opp.supplyApyBps * riskMultiplier) / 100;

        if (opp.tvlUsd6 > 100_000_000e6) {
            base = (base * 105) / 100;
        }
        if (opp.utilizationBps > 9500) {
            base = (base * 90) / 100;
        }
        if (opp.available) {
            base = (base * 102) / 100;
        }
        return base;
    }

    // ═════════════════════════════════════════════════════════════════════
    // TRANCHE SCORING ENGINE
    // ═════════════════════════════════════════════════════════════════════

    /**
     * @dev Multi-factor composite score for a given tranche.
     *
     * Factors (each scored 0-10000):
     *   1. yieldScore     — normalized APY
     *   2. securityScore  — protocol risk tier + trust weighting
     *   3. tvlScore       — liquidity depth (log-scaled)
     *   4. utilScore      — healthy utilization (not over-leveraged)
     *
     * Weight vectors per tranche:
     *   Senior:     yield=10, security=40, tvl=30, util=20
     *   Mezzanine:  yield=30, security=25, tvl=25, util=20
     *   Junior:     yield=50, security=15, tvl=20, util=15
     */
    function _trancheScore(Opportunity memory opp, Tranche t)
        internal pure returns (uint256)
    {
        uint256 yieldW; uint256 secW; uint256 tvlW; uint256 utilW;

        if (t == Tranche.Senior) {
            yieldW = 10; secW = 40; tvlW = 30; utilW = 20;
        } else if (t == Tranche.Mezzanine) {
            yieldW = 30; secW = 25; tvlW = 25; utilW = 20;
        } else {
            yieldW = 50; secW = 15; tvlW = 20; utilW = 15;
        }

        uint256 yieldS   = _yieldScore(opp);
        uint256 securityS = _securityScore(opp, t);
        uint256 tvlS     = _tvlScore(opp);
        uint256 utilS    = _utilizationScore(opp);

        // Availability gate — unavailable venues score 0
        if (!opp.available) return 0;

        return (yieldS * yieldW + securityS * secW + tvlS * tvlW + utilS * utilW) / 100;
    }

    /**
     * @dev Yield score: 0-10000 based on supply APY.
     *      0 bps → 0,  500 bps (5%) → 5000,  1000+ bps (10%+) → 10000
     */
    function _yieldScore(Opportunity memory opp) internal pure returns (uint256) {
        uint256 apy = opp.supplyApyBps;
        if (apy >= 1000) return 10000;   // 10%+ → max
        return (apy * 10000) / 1000;     // linear 0-10%
    }

    /**
     * @dev Security/Trust score based on risk tier + protocol reputation.
     *
     *      Low risk protocols (Aave, Compound, Spark):
     *        Base = 10000 (maximum trust — battle-tested, multi-billion TVL,
     *        extensive audits, insurance markets, Chainlink oracles)
     *
     *      Medium risk (Morpho, Pendle, Sky):
     *        Base = 7000 (audited, growing TVL, newer but proven)
     *
     *      High risk (Ethena, Curve LP, Yearn):
     *        Base = 4000 (synthetic, derivative, or complex strategy risk)
     *
     *      For Senior tranche: penalties amplified (harsh on risk)
     *      For Junior tranche: penalties reduced (tolerant of risk)
     */
    function _securityScore(Opportunity memory opp, Tranche t)
        internal pure returns (uint256)
    {
        uint256 base;
        if (opp.risk == RiskTier.Low) base = 10000;
        else if (opp.risk == RiskTier.Medium) base = 7000;
        else if (opp.risk == RiskTier.High) base = 4000;
        else base = 2000;

        // Protocol-specific trust bonuses
        // Aave V3 and Compound V3 get +500 for being the longest-running
        if (opp.protocol == Protocol.AaveV3 || opp.protocol == Protocol.CompoundV3) {
            base += 500;
            if (base > 10000) base = 10000;
        }

        // Tranche modifiers
        if (t == Tranche.Senior) {
            // Senior: penalize anything below Low risk more harshly
            if (opp.risk == RiskTier.Medium) base = (base * 80) / 100;
            if (opp.risk == RiskTier.High) base = (base * 50) / 100;
        } else if (t == Tranche.Junior) {
            // Junior: boost all scores toward center (more tolerant)
            if (opp.risk == RiskTier.High) base = (base * 130) / 100;
            if (base > 10000) base = 10000;
        }

        return base;
    }

    /**
     * @dev TVL/Liquidity score: log-scaled from 0 to 10000.
     *      Tiers (USDC 6 decimals):
     *        TVL >= $1B  → 10000
     *        TVL >= $100M → 8000
     *        TVL >= $10M  → 6000
     *        TVL >= $1M   → 4000
     *        TVL >= $100K → 2000
     *        TVL < $100K  → 500
     *        TVL == 0     → 0 (ERC4626 vaults that don't report TVL get 5000 fallback)
     */
    function _tvlScore(Opportunity memory opp) internal pure returns (uint256) {
        uint256 tvl = opp.tvlUsd6;

        // Special case: ERC4626 vaults may not report USDC-denominated TVL
        if (tvl == 0) {
            // Give benefit of doubt if it's a known protocol
            if (opp.protocol == Protocol.SkySUSDS ||
                opp.protocol == Protocol.EthenaSUSDe ||
                opp.protocol == Protocol.YearnV3) {
                return 5000; // Neutral — we know they have TVL, just can't read it
            }
            return 0;
        }

        if (tvl >= 1_000_000_000e6) return 10000;  // $1B+
        if (tvl >= 100_000_000e6) return 8000;      // $100M+
        if (tvl >= 10_000_000e6) return 6000;        // $10M+
        if (tvl >= 1_000_000e6) return 4000;          // $1M+
        if (tvl >= 100_000e6) return 2000;             // $100K+
        return 500;
    }

    /**
     * @dev Utilization score: healthy utilization = higher score.
     *      Sweet spot is 60-80% utilization (active but not stressed).
     *      > 95% = dangerous (withdrawal risk)
     *      < 20% = underutilized (may indicate low demand / dying market)
     *      0 = not applicable (score neutral 7000)
     */
    function _utilizationScore(Opportunity memory opp) internal pure returns (uint256) {
        uint256 util = opp.utilizationBps;

        // Not applicable (Pendle, ERC4626 vaults)
        if (util == 0) return 7000;

        // Sweet spot: 4000-8000 bps (40-80%)
        if (util >= 4000 && util <= 8000) return 10000;

        // Moderate: 2000-4000 or 8000-9000
        if (util >= 2000 && util < 4000) return 7500;
        if (util > 8000 && util <= 9000) return 8000;

        // Concerning: 9000-9500
        if (util > 9000 && util <= 9500) return 5000;

        // Dangerous: > 9500 (near full utilization — withdrawal risk)
        if (util > 9500) return 2000;

        // Low utilization < 2000 bps
        return 5000;
    }

    // ═════════════════════════════════════════════════════════════════════
    // INTERNAL: SORTING & BUILDING
    // ═════════════════════════════════════════════════════════════════════

    function _sortDescending(uint256[] memory scores, uint256 count)
        internal pure returns (uint256[] memory indices)
    {
        indices = new uint256[](count);
        for (uint256 i = 0; i < count; i++) indices[i] = i;

        for (uint256 i = 0; i < count; i++) {
            uint256 bestIdx = i;
            for (uint256 j = i + 1; j < count; j++) {
                if (scores[indices[j]] > scores[indices[bestIdx]]) {
                    bestIdx = j;
                }
            }
            if (bestIdx != i) {
                (indices[i], indices[bestIdx]) = (indices[bestIdx], indices[i]);
            }
        }
    }

    function _buildTrancheSuggestions(
        Opportunity[] memory opps,
        uint256[] memory scores,
        uint256 count,
        uint256 n,
        Tranche t
    ) internal pure returns (TrancheSuggestion[] memory result) {
        uint256[] memory sorted = _sortDescending(scores, count);
        uint256 take = count < n ? count : n;
        result = new TrancheSuggestion[](take);

        for (uint256 i = 0; i < take; i++) {
            Opportunity memory opp = opps[sorted[i]];
            result[i] = TrancheSuggestion({
                rank: uint8(i + 1),
                tranche: t,
                protocol: opp.protocol,
                label: opp.label,
                venue: opp.venue,
                marketId: opp.marketId,
                supplyApyBps: opp.supplyApyBps,
                borrowApyBps: opp.borrowApyBps,
                tvlUsd6: opp.tvlUsd6,
                utilizationBps: opp.utilizationBps,
                risk: opp.risk,
                compositeScore: scores[sorted[i]],
                reason: _trancheReason(opp, t, i)
            });
        }
    }

    function _trancheReason(Opportunity memory opp, Tranche t, uint256 rank)
        internal pure returns (string memory)
    {
        if (t == Tranche.Senior) {
            if (rank == 0) {
                if (opp.risk == RiskTier.Low) return "Safest yield - blue-chip protocol, deep liquidity";
                return "Best capital preservation option";
            }
            if (rank == 1) return "Strong safety with competitive yield";
            if (opp.risk == RiskTier.Low) return "Battle-tested, institutional-grade";
            return "Acceptable risk for preservation mandate";
        }

        if (t == Tranche.Mezzanine) {
            if (rank == 0) return "Optimal risk/reward balance - strong fundamentals";
            if (rank == 1) return "Well-balanced yield with proven security";
            if (opp.supplyApyBps > 500) return "Attractive yield with manageable risk";
            return "Balanced allocation candidate";
        }

        // Junior
        if (rank == 0) {
            if (opp.supplyApyBps > 1000) return "Highest yield available - elevated risk accepted";
            return "Best yield opportunity in scan";
        }
        if (rank == 1) return "Strong yield with acceptable risk trade-off";
        if (opp.supplyApyBps > 800) return "High yield play - monitor closely";
        return "Yield-maximizing opportunity";
    }

    function _suggestionReason(Opportunity memory opp, uint256 rank)
        internal
        pure
        returns (string memory)
    {
        if (rank == 0) {
            if (opp.risk == RiskTier.Low)
                return "Best risk-adjusted yield (blue-chip)";
            if (opp.risk == RiskTier.Medium)
                return "Highest risk-adjusted yield";
            return "Highest yield (elevated risk)";
        }
        if (rank == 1) return "Strong alternative yield";
        if (rank == 2) return "Diversification pick";
        if (opp.risk == RiskTier.Low) return "Safe harbor option";
        if (opp.supplyApyBps > 1000) return "High yield opportunity";
        return "Additional option";
    }

    // ═════════════════════════════════════════════════════════════════════
    // VIEW HELPERS
    // ═════════════════════════════════════════════════════════════════════

    /// @notice Get all registered entries
    function getAllEntries() external view returns (ProtocolEntry[] memory) {
        return entries;
    }

    /// @notice Get configured protocol addresses
    function getProtocolConfig() external view returns (
        address _aave,
        address _compound,
        address _spark,
        address _sUsds,
        address _sUsde,
        address _morpho,
        address _morphoReg,
        address _pendle,
        address _yearn,
        address _curve,
        address _curveGauge
    ) {
        return (
            aaveV3Pool, compoundComet, sparkPool,
            sUsdsVault, sUsdeVault,
            morphoBlue, morphoRegistry,
            pendleSelector, yearnVault,
            curvePool, curveGauge
        );
    }
}
