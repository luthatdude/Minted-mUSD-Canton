// SPDX-License-Identifier: BUSL-1.1
// Minted Protocol — ETH Pool with Multi-Asset Staking, Fluid Strategy, and smUSD-E Issuance
// Security: CEI pattern, ReentrancyGuard, Pausable, oracle price validation
//
// Architecture:
//   Ethereum: User deposits ETH/USDC/USDT → mUSD minted at oracle price → staked → smUSD-E issued
//   Canton:   No ETH exists — mUSD minted directly into pool → staked → smUSD-E issued
//   smUSD-E is a lending/borrowing-enabled token (depositable in CollateralVault)
//   Yield: Fluid Protocol smart collateral (T2) + smart debt (T4) leveraged loops
//
// Accepted assets (Ethereum):
//   - ETH (native, converted via oracle price)
//   - USDC (6 decimals, 1:1 USD)
//   - USDT (6 decimals, 1:1 USD)
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
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IMUSD.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/ILeverageLoopStrategy.sol";
import "./Errors.sol";

/// @dev Minimal interface for smUSD-E mint/burn (avoids circular import)
interface ISMUSDE_Pool {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @title ETHPool
/// @notice Multi-asset staking pool with Fluid Protocol yield strategy
/// @dev Accepts ETH/USDC/USDT, deploys capital to Fluid T2/T4 leveraged loops
contract ETHPool is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant STRATEGY_MANAGER_ROLE = keccak256("STRATEGY_MANAGER_ROLE");
    /// @notice SOL-H-02: TIMELOCK_ROLE for critical parameter changes (48h governance delay)
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    //                     EXTERNAL CONTRACTS
    // ═══════════════════════════════════════════════════════════════════════

    IMUSD public immutable musd;
    ISMUSDE_Pool public immutable smUsdE;
    IPriceOracle public priceOracle;
    address public immutable weth;

    // ═══════════════════════════════════════════════════════════════════════
    //                     ACCEPTED STABLECOINS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Whitelisted stablecoins that can be deposited (USDC, USDT)
    mapping(address => bool) public acceptedStablecoins;

    /// @notice Decimal precision for each accepted stablecoin
    mapping(address => uint8) public stablecoinDecimals;

    // ═══════════════════════════════════════════════════════════════════════
    //                     FLUID STRATEGY
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Fluid strategy for ETH-denominated yield (T2 or T4 vault)
    ILeverageLoopStrategy public fluidStrategy;

    /// @notice Total value deployed to the Fluid strategy
    uint256 public totalDeployedToStrategy;

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
        address depositAsset;     // Asset deposited (address(0) = ETH)
        uint256 depositAmount;    // Original amount deposited (in deposit asset decimals)
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
    uint256 public totalStablecoinDeposited;  // Normalized to 18 decimals
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
        address indexed depositAsset,
        uint256 depositAmount,
        uint256 musdAmount,
        uint256 smUsdEShares,
        TimeLockTier tier,
        uint256 unlockAt
    );
    event Unstaked(
        address indexed user,
        uint256 indexed positionId,
        address depositAsset,
        uint256 amountReturned,
        uint256 smUsdEBurned
    );
    event SharePriceUpdated(uint256 oldPrice, uint256 newPrice);
    event PoolCapUpdated(uint256 oldCap, uint256 newCap);
    event TierConfigUpdated(TimeLockTier indexed tier, uint256 duration, uint256 multiplierBps);
    event PriceOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event StablecoinAdded(address indexed token, uint8 decimals);
    event StablecoinRemoved(address indexed token);
    event FluidStrategyUpdated(address indexed oldStrategy, address indexed newStrategy);
    event DeployedToStrategy(uint256 amount);
    event WithdrawnFromStrategy(uint256 amount);

    constructor(
        address _musd,
        address _smUsdE,
        address _priceOracle,
        address _weth,
        uint256 _poolCap,
        address _timelockController
    ) {
        if (_musd == address(0)) revert InvalidMusd();
        if (_smUsdE == address(0)) revert InvalidAddress();
        if (_priceOracle == address(0)) revert InvalidOracle();
        if (_weth == address(0)) revert InvalidAddress();
        if (_poolCap == 0) revert InvalidAmount();
        if (_timelockController == address(0)) revert InvalidAddress();

        musd = IMUSD(_musd);
        smUsdE = ISMUSDE_Pool(_smUsdE);
        priceOracle = IPriceOracle(_priceOracle);
        weth = _weth;
        poolCap = _poolCap;
        sharePrice = 1e18;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        // SOL-H-02: Critical admin ops go through 48h timelock
        _grantRole(TIMELOCK_ROLE, _timelockController);
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);

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

        // Get ETH/USD price from oracle (18 decimals)
        uint256 ethPrice = priceOracle.getPrice(weth);
        if (ethPrice == 0) revert InvalidPrice();

        // Calculate mUSD to mint: ethAmount * ethPrice / 1e18
        uint256 musdAmount = (msg.value * ethPrice) / 1e18;
        if (musdAmount == 0) revert ZeroOutput();

        // Pool cap check in mUSD terms
        if (totalMUSDMinted + musdAmount > poolCap) revert ExceedsSupplyCap();

        positionId = _createPosition(msg.sender, address(0), msg.value, musdAmount, tier);

        totalETHDeposited += msg.value;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     STAKING: USDC/USDT → mUSD → smUSD-E
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Deposit USDC or USDT, mint mUSD 1:1 (minus oracle deviation), stake, receive smUSD-E
    /// @param token Stablecoin address (must be whitelisted)
    /// @param amount Amount of stablecoin to deposit (in token decimals)
    /// @param tier Time-lock tier for yield multiplier boost
    /// @return positionId The ID of the created stake position
    function stakeWithToken(
        address token,
        uint256 amount,
        TimeLockTier tier
    ) external nonReentrant whenNotPaused returns (uint256 positionId) {
        if (amount == 0) revert ZeroAmount();
        if (!acceptedStablecoins[token]) revert TokenNotSupported();

        // Transfer stablecoin from user (SafeERC20 handles USDT's non-standard return)
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Normalize to 18 decimals for mUSD (stablecoins are 1:1 with USD)
        uint8 decimals = stablecoinDecimals[token];
        uint256 musdAmount = amount * (10 ** (18 - decimals));
        if (musdAmount == 0) revert ZeroOutput();

        // Pool cap check in mUSD terms
        if (totalMUSDMinted + musdAmount > poolCap) revert ExceedsSupplyCap();

        positionId = _createPosition(msg.sender, token, amount, musdAmount, tier);

        totalStablecoinDeposited += musdAmount;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     INTERNAL: POSITION CREATION
    // ═══════════════════════════════════════════════════════════════════════

    function _createPosition(
        address user,
        address depositAsset,
        uint256 depositAmount,
        uint256 musdAmount,
        TimeLockTier tier
    ) internal returns (uint256 positionId) {
        TierConfig memory config = tierConfigs[tier];

        // Calculate smUSD-E shares with tier multiplier
        uint256 baseShares = (musdAmount * 1e18) / sharePrice;
        uint256 boostedShares = (baseShares * config.multiplierBps) / 10000;
        if (boostedShares == 0) revert ZeroOutput();

        // Mint mUSD into pool (this contract holds as backing)
        musd.mint(address(this), musdAmount);

        // Mint smUSD-E to user
        smUsdE.mint(user, boostedShares);

        // Create position
        positionId = nextPositionId[user]++;
        uint256 unlockTime = config.duration > 0 ? block.timestamp + config.duration : 0;

        positions[user][positionId] = StakePosition({
            depositAsset: depositAsset,
            depositAmount: depositAmount,
            musdMinted: musdAmount,
            smUsdEShares: boostedShares,
            tier: tier,
            stakedAt: block.timestamp,
            unlockAt: unlockTime,
            active: true
        });

        totalMUSDMinted += musdAmount;
        totalSMUSDEIssued += boostedShares;

        emit Staked(user, positionId, depositAsset, depositAmount, musdAmount, boostedShares, tier, unlockTime);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     UNSTAKING
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Unstake: burn smUSD-E, return original deposit
    /// @param positionId The position to unstake
    function unstake(uint256 positionId) external nonReentrant whenNotPaused {
        StakePosition storage pos = positions[msg.sender][positionId];
        if (!pos.active) revert NoPosition();
        if (pos.unlockAt > 0 && block.timestamp < pos.unlockAt) revert CooldownActive();

        uint256 sharesToBurn = pos.smUsdEShares;

        // Check user still holds the smUSD-E shares
        if (smUsdE.balanceOf(msg.sender) < sharesToBurn) revert InsufficientBalance();

        address depositAsset = pos.depositAsset;
        uint256 amountToReturn = pos.depositAmount;

        // Effects: close position before interactions
        pos.active = false;
        totalMUSDMinted -= pos.musdMinted;
        totalSMUSDEIssued -= sharesToBurn;

        if (depositAsset == address(0)) {
            // ETH position
            totalETHDeposited -= amountToReturn;
        } else {
            // Stablecoin position — denormalize
            uint8 decimals = stablecoinDecimals[depositAsset];
            uint256 normalized = amountToReturn * (10 ** (18 - decimals));
            totalStablecoinDeposited -= normalized;
        }

        // Interactions: burn smUSD-E
        smUsdE.burn(msg.sender, sharesToBurn);

        // Return original deposit
        if (depositAsset == address(0)) {
            // slither-disable-next-line arbitrary-send-eth
            (bool success, ) = payable(msg.sender).call{value: amountToReturn}("");
            if (!success) revert ETHTransferFailed();
        } else {
            IERC20(depositAsset).safeTransfer(msg.sender, amountToReturn);
        }

        emit Unstaked(msg.sender, positionId, depositAsset, amountToReturn, sharesToBurn);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     FLUID STRATEGY DEPLOYMENT
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Deploy idle pool capital to the Fluid leveraged loop strategy
    /// @param amount Amount of input asset to deploy (in strategy asset decimals)
    function deployToStrategy(uint256 amount) external onlyRole(STRATEGY_MANAGER_ROLE) nonReentrant {
        if (address(fluidStrategy) == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (!fluidStrategy.isActive()) revert NotActive();

        address strategyAsset = fluidStrategy.asset();
        IERC20(strategyAsset).forceApprove(address(fluidStrategy), amount);
        uint256 deposited = fluidStrategy.deposit(amount);

        totalDeployedToStrategy += deposited;
        emit DeployedToStrategy(deposited);
    }

    /// @notice Withdraw capital from the Fluid strategy back to pool
    /// @param amount Amount to withdraw
    function withdrawFromStrategy(uint256 amount) external onlyRole(STRATEGY_MANAGER_ROLE) nonReentrant {
        if (address(fluidStrategy) == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 withdrawn = fluidStrategy.withdraw(amount);
        totalDeployedToStrategy = withdrawn > totalDeployedToStrategy
            ? 0
            : totalDeployedToStrategy - withdrawn;

        emit WithdrawnFromStrategy(withdrawn);
    }

    /// @notice Get the total value held in pool + strategy
    function totalPoolValue() external view returns (uint256) {
        uint256 strategyValue = address(fluidStrategy) != address(0)
            ? fluidStrategy.totalValue()
            : 0;
        return totalMUSDMinted + strategyValue;
    }

    /// @notice Get Fluid strategy health factor (1e18 = 1.0x)
    function strategyHealthFactor() external view returns (uint256) {
        if (address(fluidStrategy) == address(0)) return type(uint256).max;
        return fluidStrategy.getHealthFactor();
    }

    /// @notice Get Fluid strategy position details
    function strategyPosition() external view returns (
        uint256 collateral,
        uint256 borrowed,
        uint256 principal,
        uint256 netValue
    ) {
        if (address(fluidStrategy) == address(0)) return (0, 0, 0, 0);
        return fluidStrategy.getPosition();
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

    /// @notice Add an accepted stablecoin (USDC, USDT)
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE (48h governance delay)
    /// @param token Stablecoin contract address
    /// @param decimals Token decimal precision (6 for USDC/USDT)
    function addStablecoin(address token, uint8 decimals) external onlyRole(TIMELOCK_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (decimals > 18) revert TokenDecimalsTooHigh();
        if (acceptedStablecoins[token]) revert AlreadyAdded();

        acceptedStablecoins[token] = true;
        stablecoinDecimals[token] = decimals;
        emit StablecoinAdded(token, decimals);
    }

    /// @notice Remove an accepted stablecoin
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE
    function removeStablecoin(address token) external onlyRole(TIMELOCK_ROLE) {
        if (!acceptedStablecoins[token]) revert NotPreviouslyAdded();
        acceptedStablecoins[token] = false;
        emit StablecoinRemoved(token);
    }

    /// @notice Set the Fluid leveraged loop strategy
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — strategy swap is critical
    function setFluidStrategy(address _strategy) external onlyRole(TIMELOCK_ROLE) {
        address old = address(fluidStrategy);
        fluidStrategy = ILeverageLoopStrategy(_strategy);
        emit FluidStrategyUpdated(old, _strategy);
    }

    /// @notice Update pool cap (in mUSD terms, 18 decimals)
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE
    function setPoolCap(uint256 newCap) external onlyRole(TIMELOCK_ROLE) {
        if (newCap == 0) revert InvalidAmount();
        uint256 oldCap = poolCap;
        poolCap = newCap;
        emit PoolCapUpdated(oldCap, newCap);
    }

    /// @notice Update a time-lock tier configuration
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE
    function setTierConfig(
        TimeLockTier tier,
        uint256 duration,
        uint256 multiplierBps
    ) external onlyRole(TIMELOCK_ROLE) {
        if (multiplierBps < 10000) revert MultiplierTooLow();
        if (multiplierBps > 30000) revert MultiplierTooHigh();
        tierConfigs[tier] = TierConfig({ duration: duration, multiplierBps: multiplierBps });
        emit TierConfigUpdated(tier, duration, multiplierBps);
    }

    /// @notice Update price oracle
    /// @dev SOL-H-02: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — oracle is critical
    function setPriceOracle(address newOracle) external onlyRole(TIMELOCK_ROLE) {
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

    /// @notice Unpause — requires timelock for governance separation of duties
    /// @dev SOL-H-02/SOL-H-17: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE (48h delay)
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }

    /// @notice Accept ETH (for yield distribution or refunds)
    receive() external payable {}
}
