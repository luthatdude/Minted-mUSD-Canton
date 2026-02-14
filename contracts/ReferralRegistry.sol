// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/**
 * @title ReferralRegistry
 * @notice On-chain referral tracking with TVL-based point multipliers (Ethena-style shards).
 *         Each referrer earns boosted points proportional to the TVL their referees contribute.
 *
 * Multiplier Tiers (by cumulative referred TVL):
 *   ≥ $1M   → 3.0x
 *   ≥ $500K  → 2.5x
 *   ≥ $100K  → 2.0x
 *   ≥ $10K   → 1.5x
 *   < $10K   → 1.0x (base)
 *
 * @dev Upgradeable, pausable via OPERATOR_ROLE. The off-chain points server
 *      reads ReferralLinked events + multiplier view to compute final scores.
 */
contract ReferralRegistry is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ═══════════════════════════════════════════════════════════
    // Roles
    // ═══════════════════════════════════════════════════════════

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ═══════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════

    struct ReferralInfo {
        address referrer;
        uint64  linkedAt;
        bool    active;
    }

    struct ReferrerStats {
        uint32  totalReferees;
        uint256 totalReferredTvl;  // USD value (18 decimals)
        uint256 totalKickbackPts;
    }

    struct MultiplierTier {
        uint256 minTvl;    // 18-decimal USD threshold
        uint256 multiplier; // 18-decimal (1e18 = 1.0x)
    }

    /// @notice referee → referral info
    mapping(address => ReferralInfo) public referrals;

    /// @notice referrer → aggregated stats
    mapping(address => ReferrerStats) public referrerStats;

    /// @notice referrer → list of referee addresses
    mapping(address => address[]) public referrerToReferees;

    /// @notice referral code hash → owner
    mapping(bytes32 => address) public codeOwners;

    /// @notice owner → referral code hashes
    mapping(address => bytes32[]) public ownerCodes;

    /// @notice Multiplier tiers (sorted descending by minTvl)
    MultiplierTier[] public tiers;

    /// @notice Max codes per user
    uint8 public maxCodesPerUser;

    /// @notice Max referral chain depth for multi-level kickback
    uint8 public maxDepth;

    /// @notice Base kickback percentage (bps, e.g. 1000 = 10%)
    uint16 public kickbackBps;

    /// @notice Depth decay (bps, e.g. 5000 = 50% decay per level)
    uint16 public depthDecayBps;

    /// @notice Global pause
    bool public paused;

    /// @notice Total unique referrers
    uint256 public totalReferrers;

    /// @notice Total referral links
    uint256 public totalLinks;

    // ═══════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════

    event CodeCreated(address indexed owner, bytes32 indexed codeHash, string code);
    event ReferralLinked(address indexed referee, address indexed referrer, bytes32 indexed codeHash);
    event TvlUpdated(address indexed referrer, uint256 newTotalTvl, uint256 multiplier);
    event KickbackAwarded(address indexed referrer, address indexed referee, uint256 points, uint8 depth);
    event TiersUpdated(uint256 tierCount);
    event Paused(bool status);

    // ═══════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════

    error RegistryPaused();
    error InvalidCode();
    error SelfReferral();
    error AlreadyReferred();
    error MaxCodesReached();
    error CircularReferral();
    error CodeAlreadyExists();

    // ═══════════════════════════════════════════════════════════
    // Initializer
    // ═══════════════════════════════════════════════════════════

    function initialize(address admin) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);

        maxCodesPerUser = 5;
        maxDepth = 2;
        kickbackBps = 1000;     // 10%
        depthDecayBps = 5000;   // 50% decay

        // Default tiers (descending by minTvl)
        tiers.push(MultiplierTier(1_000_000e18, 3.0e18));   // ≥ $1M → 3x
        tiers.push(MultiplierTier(500_000e18,   2.5e18));    // ≥ $500K → 2.5x
        tiers.push(MultiplierTier(100_000e18,   2.0e18));    // ≥ $100K → 2x
        tiers.push(MultiplierTier(10_000e18,    1.5e18));    // ≥ $10K → 1.5x
    }

    // ═══════════════════════════════════════════════════════════
    // Code Management
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Register a referral code on-chain.
     * @param code The human-readable code (e.g. "MNTD-ABC123")
     */
    function registerCode(string calldata code) external {
        if (paused) revert RegistryPaused();
        if (ownerCodes[msg.sender].length >= maxCodesPerUser) revert MaxCodesReached();

        bytes32 h = keccak256(abi.encodePacked(code));
        if (codeOwners[h] != address(0)) revert CodeAlreadyExists();

        codeOwners[h] = msg.sender;
        ownerCodes[msg.sender].push(h);

        emit CodeCreated(msg.sender, h, code);
    }

    // ═══════════════════════════════════════════════════════════
    // Referral Linking
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Link the caller as a referee under a referral code.
     * @param code The referral code string
     */
    function linkReferral(string calldata code) external nonReentrant {
        if (paused) revert RegistryPaused();

        bytes32 h = keccak256(abi.encodePacked(code));
        address referrer = codeOwners[h];
        if (referrer == address(0)) revert InvalidCode();
        if (referrer == msg.sender) revert SelfReferral();
        if (referrals[msg.sender].active) revert AlreadyReferred();
        if (_wouldCreateCycle(msg.sender, referrer)) revert CircularReferral();

        referrals[msg.sender] = ReferralInfo({
            referrer: referrer,
            linkedAt: uint64(block.timestamp),
            active: true
        });

        referrerToReferees[referrer].push(msg.sender);

        if (referrerStats[referrer].totalReferees == 0) {
            totalReferrers++;
        }
        referrerStats[referrer].totalReferees++;
        totalLinks++;

        emit ReferralLinked(msg.sender, referrer, h);
    }

    // ═══════════════════════════════════════════════════════════
    // TVL & Multiplier Updates (Operator only)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Update the cumulative referred TVL for a referrer.
     *         Called by the off-chain points server after scanning balances.
     * @param referrer The referrer address
     * @param newTvl   The new total referred TVL (18-decimal USD)
     */
    function updateReferredTvl(address referrer, uint256 newTvl)
        external
        onlyRole(OPERATOR_ROLE)
    {
        referrerStats[referrer].totalReferredTvl = newTvl;
        uint256 mult = getMultiplier(referrer);
        emit TvlUpdated(referrer, newTvl, mult);
    }

    /**
     * @notice Batch-update referred TVL for multiple referrers.
     */
    function batchUpdateReferredTvl(
        address[] calldata referrers,
        uint256[] calldata tvls
    ) external onlyRole(OPERATOR_ROLE) {
        require(referrers.length == tvls.length, "LENGTH_MISMATCH");
        for (uint256 i = 0; i < referrers.length; i++) {
            referrerStats[referrers[i]].totalReferredTvl = tvls[i];
            emit TvlUpdated(referrers[i], tvls[i], getMultiplier(referrers[i]));
        }
    }

    /**
     * @notice Record kickback points awarded to a referrer.
     */
    function recordKickback(
        address referrer,
        address referee,
        uint256 points,
        uint8 depth
    ) external onlyRole(OPERATOR_ROLE) {
        referrerStats[referrer].totalKickbackPts += points;
        emit KickbackAwarded(referrer, referee, points, depth);
    }

    // ═══════════════════════════════════════════════════════════
    // View Functions
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Get the current multiplier for a referrer based on referred TVL.
     * @return multiplier 18-decimal (1e18 = 1.0x). Returns 1e18 if below all tiers.
     */
    function getMultiplier(address referrer) public view returns (uint256) {
        uint256 tvl = referrerStats[referrer].totalReferredTvl;
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tvl >= tiers[i].minTvl) {
                return tiers[i].multiplier;
            }
        }
        return 1e18; // Base 1.0x
    }

    /**
     * @notice Get the list of referee addresses for a referrer.
     */
    function getReferees(address referrer) external view returns (address[] memory) {
        return referrerToReferees[referrer];
    }

    /**
     * @notice Get the number of codes a user owns.
     */
    function getCodeCount(address owner) external view returns (uint256) {
        return ownerCodes[owner].length;
    }

    /**
     * @notice Get all code hashes for an owner.
     */
    function getCodeHashes(address owner) external view returns (bytes32[] memory) {
        return ownerCodes[owner];
    }

    /**
     * @notice Get the referral chain for a user (who referred them, up the tree).
     */
    function getReferralChain(address user, uint8 depth)
        external
        view
        returns (address[] memory chain)
    {
        chain = new address[](depth);
        address current = user;
        for (uint8 i = 0; i < depth; i++) {
            ReferralInfo storage info = referrals[current];
            if (!info.active) {
                // Truncate array
                assembly { mstore(chain, i) }
                return chain;
            }
            chain[i] = info.referrer;
            current = info.referrer;
        }
    }

    /**
     * @notice Get all tier definitions.
     */
    function getTiers() external view returns (MultiplierTier[] memory) {
        return tiers;
    }

    /**
     * @notice Check whether an address has been referred.
     */
    function isReferred(address user) external view returns (bool) {
        return referrals[user].active;
    }

    /**
     * @notice Get full dashboard data for a referrer in a single call.
     */
    function getDashboard(address referrer)
        external
        view
        returns (
            uint32 numReferees,
            uint256 referredTvl,
            uint256 multiplier,
            uint256 kickbackPts,
            address[] memory referees
        )
    {
        ReferrerStats storage s = referrerStats[referrer];
        numReferees = s.totalReferees;
        referredTvl = s.totalReferredTvl;
        multiplier = getMultiplier(referrer);
        kickbackPts = s.totalKickbackPts;
        referees = referrerToReferees[referrer];
    }

    // ═══════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════

    function setPaused(bool _paused) external onlyRole(OPERATOR_ROLE) {
        paused = _paused;
        emit Paused(_paused);
    }

    function setMaxCodesPerUser(uint8 _max) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxCodesPerUser = _max;
    }

    function setKickbackBps(uint16 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= 5000, "MAX_50_PCT");
        kickbackBps = _bps;
    }

    function setDepthDecayBps(uint16 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= 10000, "MAX_100_PCT");
        depthDecayBps = _bps;
    }

    function setMaxDepth(uint8 _depth) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_depth <= 5, "MAX_5");
        maxDepth = _depth;
    }

    /**
     * @notice Replace multiplier tiers. Must be sorted descending by minTvl.
     */
    function setTiers(MultiplierTier[] calldata _tiers) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete tiers;
        for (uint256 i = 0; i < _tiers.length; i++) {
            if (i > 0) {
                require(_tiers[i].minTvl < _tiers[i - 1].minTvl, "NOT_DESCENDING");
            }
            tiers.push(_tiers[i]);
        }
        emit TiersUpdated(_tiers.length);
    }

    // ═══════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════

    function _wouldCreateCycle(address referee, address referrer) internal view returns (bool) {
        address current = referrer;
        for (uint8 i = 0; i < 10; i++) {
            if (current == referee) return true;
            ReferralInfo storage info = referrals[current];
            if (!info.active) return false;
            current = info.referrer;
        }
        return false;
    }
}
