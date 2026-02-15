// SPDX-License-Identifier: BUSL-1.1
// Minted Protocol — ETH Pool with Time-Locked Staking and smUSD-E Issuance
// Security: CEI pattern, ReentrancyGuard, Pausable, oracle price validation
//
// Architecture:
//   Ethereum: User deposits ETH → mUSD minted at oracle price → staked → smUSD-E issued
//   Canton:   No ETH exists — mUSD minted directly into pool → staked → smUSD-E issued
//   smUSD-E is a lending/borrowing-enabled token (depositable in CollateralVault)
//
// Time-Lock Tiers (yield multipliers):
//   None:   0 days  — 1.0x  (no lock, no boost)
//   Short:  30 days — 1.25x
//   Medium: 90 days — 1.5x
//   Long:   180 days — 2.0x

pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IMUSD.sol";
import "./interfaces/IPriceOracle.sol";
import "./Errors.sol";

/// @dev Minimal interface for smUSD-E mint/burn (avoids circular import)
interface ISMUSDE_Pool {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @title ETHPool
/// @notice ETH-denominated staking pool: deposit ETH → mint mUSD → stake → receive smUSD-E
/// @dev On Canton (no native ETH), mUSD is minted directly into the pool and staked
contract ETHPool is AccessControl, ReentrancyGuard, Pausable {

    bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    //                     EXTERNAL CONTRACTS
    // ═══════════════════════════════════════════════════════════════════════

    IMUSD public immutable musd;
    ISMUSDE_Pool public immutable smUsdE;
    IPriceOracle public priceOracle;
    address public immutable weth;

    // ═══════════════════════════════════════════════════════════════════════
    //                     TIME-LOCK TIERS
    // ═══════════════════════════════════════════════════════════════════════

    enum TimeLockTier { None, Short, Medium, Long }

    struct TierConfig {
        uint256 duration;        // Lock duration in seconds
        uint256 multiplierBps;   // Yield multiplier (10000 = 1.0x)
    }

    mapping(TimeLockTier => TierConfig) public tierConfigs;

    // ═══════════════════════════════════════════════════════════════════════
    //                     STAKING POSITIONS
    // ═══════════════════════════════════════════════════════════════════════

    struct StakePosition {
        uint256 ethDeposited;     // Original ETH deposited
        uint256 musdMinted;       // mUSD minted at deposit time
        uint256 smUsdEShares;     // smUSD-E shares received (after multiplier)
        TimeLockTier tier;        // Selected time-lock tier
        uint256 stakedAt;         // Deposit timestamp
        uint256 unlockAt;         // When position can be withdrawn (0 = no lock)
        bool active;              // Position still open
    }

    /// @notice user => positionId => StakePosition
    mapping(address => mapping(uint256 => StakePosition)) public positions;

    /// @notice Next position ID per user (auto-incrementing)
    mapping(address => uint256) public nextPositionId;

    // ═══════════════════════════════════════════════════════════════════════
    //                     POOL STATE
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public totalETHDeposited;
    uint256 public totalMUSDMinted;
    uint256 public totalSMUSDEIssued;
    uint256 public poolCap;

    /// @notice smUSD-E share price (18 decimals, starts at 1e18)
    uint256 public sharePrice;

    /// @notice Maximum share price change per update (10% = 1000 bps)
    uint256 public constant MAX_SHARE_PRICE_CHANGE_BPS = 1000;

    // ═══════════════════════════════════════════════════════════════════════
    //                     EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Staked(
        address indexed user,
        uint256 indexed positionId,
        uint256 ethAmount,
        uint256 musdAmount,
        uint256 smUsdEShares,
        TimeLockTier tier,
        uint256 unlockAt
    );
    event Unstaked(
        address indexed user,
        uint256 indexed positionId,
        uint256 ethReturned,
        uint256 smUsdEBurned
    );
    event SharePriceUpdated(uint256 oldPrice, uint256 newPrice);
    event PoolCapUpdated(uint256 oldCap, uint256 newCap);
    event TierConfigUpdated(TimeLockTier indexed tier, uint256 duration, uint256 multiplierBps);
    event PriceOracleUpdated(address indexed oldOracle, address indexed newOracle);

    constructor(
        address _musd,
        address _smUsdE,
        address _priceOracle,
        address _weth,
        uint256 _poolCap
    ) {
        if (_musd == address(0)) revert InvalidMusd();
        if (_smUsdE == address(0)) revert InvalidAddress();
        if (_priceOracle == address(0)) revert InvalidOracle();
        if (_weth == address(0)) revert InvalidAddress();
        if (_poolCap == 0) revert InvalidAmount();

        musd = IMUSD(_musd);
        smUsdE = ISMUSDE_Pool(_smUsdE);
        priceOracle = IPriceOracle(_priceOracle);
        weth = _weth;
        poolCap = _poolCap;
        sharePrice = 1e18;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        // Configure time-lock tiers
        tierConfigs[TimeLockTier.None]   = TierConfig({ duration: 0,        multiplierBps: 10000 });  // 1.0x
        tierConfigs[TimeLockTier.Short]  = TierConfig({ duration: 30 days,  multiplierBps: 12500 });  // 1.25x
        tierConfigs[TimeLockTier.Medium] = TierConfig({ duration: 90 days,  multiplierBps: 15000 });  // 1.5x
        tierConfigs[TimeLockTier.Long]   = TierConfig({ duration: 180 days, multiplierBps: 20000 });  // 2.0x
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     STAKING: ETH → mUSD → smUSD-E
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Deposit ETH, mint mUSD at oracle price, stake, receive smUSD-E
    /// @param tier Time-lock tier for yield multiplier boost
    /// @return positionId The ID of the created stake position
    function stake(TimeLockTier tier) external payable nonReentrant whenNotPaused returns (uint256 positionId) {
        if (msg.value == 0) revert ZeroAmount();
        if (totalETHDeposited + msg.value > poolCap) revert ExceedsSupplyCap();

        TierConfig memory config = tierConfigs[tier];

        // Get ETH/USD price from oracle (18 decimals)
        uint256 ethPrice = priceOracle.getPrice(weth);
        if (ethPrice == 0) revert InvalidPrice();

        // Calculate mUSD to mint: ethAmount * ethPrice / 1e18
        uint256 musdAmount = (msg.value * ethPrice) / 1e18;
        if (musdAmount == 0) revert ZeroOutput();

        // Calculate smUSD-E shares with tier multiplier
        uint256 baseShares = (musdAmount * 1e18) / sharePrice;
        uint256 boostedShares = (baseShares * config.multiplierBps) / 10000;
        if (boostedShares == 0) revert ZeroOutput();

        // Mint mUSD into pool (this contract holds as backing)
        musd.mint(address(this), musdAmount);

        // Mint smUSD-E to user
        smUsdE.mint(msg.sender, boostedShares);

        // Create position (Effects before Interactions — ETH already received via payable)
        positionId = nextPositionId[msg.sender]++;
        uint256 unlockTime = config.duration > 0 ? block.timestamp + config.duration : 0;

        positions[msg.sender][positionId] = StakePosition({
            ethDeposited: msg.value,
            musdMinted: musdAmount,
            smUsdEShares: boostedShares,
            tier: tier,
            stakedAt: block.timestamp,
            unlockAt: unlockTime,
            active: true
        });

        totalETHDeposited += msg.value;
        totalMUSDMinted += musdAmount;
        totalSMUSDEIssued += boostedShares;

        emit Staked(msg.sender, positionId, msg.value, musdAmount, boostedShares, tier, unlockTime);
    }

    /// @notice Unstake: burn smUSD-E, return original ETH deposit
    /// @param positionId The position to unstake
    function unstake(uint256 positionId) external nonReentrant whenNotPaused {
        StakePosition storage pos = positions[msg.sender][positionId];
        if (!pos.active) revert NoPosition();
        if (pos.unlockAt > 0 && block.timestamp < pos.unlockAt) revert CooldownActive();

        uint256 sharesToBurn = pos.smUsdEShares;
        uint256 ethToReturn = pos.ethDeposited;

        // Check user still holds the smUSD-E shares
        if (smUsdE.balanceOf(msg.sender) < sharesToBurn) revert InsufficientBalance();

        // Effects: close position before interactions
        pos.active = false;
        totalETHDeposited -= ethToReturn;
        totalMUSDMinted -= pos.musdMinted;
        totalSMUSDEIssued -= sharesToBurn;

        // Interactions: burn smUSD-E, then transfer ETH
        smUsdE.burn(msg.sender, sharesToBurn);

        // slither-disable-next-line arbitrary-send-eth
        (bool success, ) = payable(msg.sender).call{value: ethToReturn}("");
        if (!success) revert ETHTransferFailed();

        emit Unstaked(msg.sender, positionId, ethToReturn, sharesToBurn);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     YIELD MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Update smUSD-E share price after yield distribution
    /// @dev Rate-limited to ±10% change per update to prevent manipulation
    function updateSharePrice(uint256 newSharePrice) external onlyRole(YIELD_MANAGER_ROLE) {
        if (newSharePrice == 0) revert InvalidAmount();

        uint256 maxPrice = (sharePrice * (10000 + MAX_SHARE_PRICE_CHANGE_BPS)) / 10000;
        uint256 minPrice = (sharePrice * (10000 - MAX_SHARE_PRICE_CHANGE_BPS)) / 10000;
        if (newSharePrice > maxPrice || newSharePrice < minPrice) revert SharePriceChangeTooLarge();

        uint256 oldPrice = sharePrice;
        sharePrice = newSharePrice;
        emit SharePriceUpdated(oldPrice, newSharePrice);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Update pool cap
    function setPoolCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCap == 0) revert InvalidAmount();
        uint256 oldCap = poolCap;
        poolCap = newCap;
        emit PoolCapUpdated(oldCap, newCap);
    }

    /// @notice Update a time-lock tier configuration
    /// @param tier The tier to update
    /// @param duration Lock duration in seconds
    /// @param multiplierBps Yield multiplier (10000 = 1.0x, max 30000 = 3.0x)
    function setTierConfig(
        TimeLockTier tier,
        uint256 duration,
        uint256 multiplierBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (multiplierBps < 10000) revert MultiplierTooLow();
        if (multiplierBps > 30000) revert MultiplierTooHigh();
        tierConfigs[tier] = TierConfig({ duration: duration, multiplierBps: multiplierBps });
        emit TierConfigUpdated(tier, duration, multiplierBps);
    }

    /// @notice Update price oracle
    function setPriceOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOracle == address(0)) revert InvalidOracle();
        address oldOracle = address(priceOracle);
        priceOracle = IPriceOracle(newOracle);
        emit PriceOracleUpdated(oldOracle, newOracle);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Get a user's stake position
    function getPosition(address user, uint256 positionId) external view returns (StakePosition memory) {
        return positions[user][positionId];
    }

    /// @notice Check if a position can be unstaked
    function canUnstake(address user, uint256 positionId) external view returns (bool) {
        StakePosition memory pos = positions[user][positionId];
        if (!pos.active) return false;
        if (pos.unlockAt > 0 && block.timestamp < pos.unlockAt) return false;
        return true;
    }

    /// @notice Get remaining lock time for a position
    function getRemainingLockTime(address user, uint256 positionId) external view returns (uint256) {
        StakePosition memory pos = positions[user][positionId];
        if (!pos.active || pos.unlockAt == 0 || block.timestamp >= pos.unlockAt) return 0;
        return pos.unlockAt - block.timestamp;
    }

    /// @notice Get tier configuration
    function getTierConfig(TimeLockTier tier) external view returns (uint256 duration, uint256 multiplierBps) {
        TierConfig memory config = tierConfigs[tier];
        return (config.duration, config.multiplierBps);
    }

    /// @notice Total number of positions created by a user (including closed)
    function getPositionCount(address user) external view returns (uint256) {
        return nextPositionId[user];
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     EMERGENCY CONTROLS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Pause all staking and unstaking
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause — requires admin for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Accept ETH (for yield distribution or refunds)
    receive() external payable {}
}
