// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IYieldBasis.sol";
import "./TimelockGoverned.sol";
import "./Errors.sol";

/**
 * @title YBStakingVault
 * @notice UUPS-upgradeable ERC-4626 vault for staking mUSD → earn Yield Basis pool yield
 * @dev V2: Upgraded from non-upgradeable to UUPS proxy pattern.
 *      This allows:
 *        - Pool migration (point to new MintedYBPool when external YB has no capacity)
 *        - Dynamic deposit cap changes without redeployment
 *        - Logic upgrades via timelock governance
 *
 * Two instances are deployed:
 *      - ybBTC (Yield Basis BTC/USDC pool yield → mUSD stakers)
 *      - ybETH (Yield Basis ETH/USDC pool yield → mUSD stakers)
 *
 * User Flow:
 *   1. User deposits mUSD into this vault → receives ybBTC or ybETH shares
 *   2. mUSD is held by the vault
 *   3. Corresponding USDC from Treasury is deployed to MintedYBPool via YieldBasisStrategy
 *   4. Yield from pool is distributed to this vault by YIELD_MANAGER
 *   5. Share price increases → user redeems more mUSD than deposited
 *
 * Key difference from smUSD:
 *   - smUSD = general yield from all Treasury strategies (Pendle, Morpho, Sky, etc.)
 *   - ybBTC = yield specifically from Minted's BTC/USDC LP pool
 *   - ybETH = yield specifically from Minted's ETH/USDC LP pool
 *
 * This gives users 3 staking choices:
 *   1. smUSD  → Diversified yield (~6% APY)
 *   2. ybBTC  → BTC market-making yield (variable, correlated to BTC volatility)
 *   3. ybETH  → ETH market-making yield (variable, correlated to ETH volatility)
 *
 * Safety: 24h withdrawal cooldown, max yield cap, pausable, timelock-governed upgrades
 */
contract YBStakingVault is
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Cooldown period before withdrawal after deposit
    uint256 public constant WITHDRAW_COOLDOWN = 24 hours;

    /// @notice Maximum yield per distribution (10% of total assets)
    uint256 public constant MAX_YIELD_BPS = 1000;

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Per-user deposit timestamp for cooldown
    mapping(address => uint256) public lastDeposit;

    /// @notice The Yield Basis pool this vault's yield comes from
    IYieldBasisPool public ybPool;

    /// @notice Label: "BTC" or "ETH"
    string public poolLabel;

    /// @notice Canton shares for cross-chain unified yield
    uint256 public cantonTotalShares;
    uint256 public lastCantonSyncEpoch;
    uint256 public lastCantonSyncTime;

    /// @notice Rate limit for Canton sync
    uint256 public constant MIN_SYNC_INTERVAL = 1 hours;
    uint256 public constant MAX_SHARE_CHANGE_BPS = 500;

    /// @notice Maximum deposit cap (prevents over-concentration)
    uint256 public maxTotalDeposits;

    /// @notice Total yield distributed to this vault
    uint256 public totalYieldReceived;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event YieldDistributed(address indexed from, uint256 amount, uint256 newSharePrice);
    event CooldownUpdated(address indexed account, uint256 timestamp);
    event CantonSharesSynced(uint256 cantonShares, uint256 epoch, uint256 sharePrice);
    event MaxDepositsUpdated(uint256 oldMax, uint256 newMax);
    event PoolMigrated(address indexed oldPool, address indexed newPool);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error DepositCapReached();
    error InvalidPool();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the YB Staking Vault (replaces constructor)
     * @param _musd mUSD token (the asset users deposit/withdraw)
     * @param _ybPool Yield Basis pool for yield tracking (MintedYBPool or external)
     * @param _name Vault token name (e.g., "Yield Basis BTC Staked mUSD")
     * @param _symbol Vault token symbol (e.g., "ybBTC")
     * @param _maxDeposits Initial deposit cap
     * @param _admin Admin address
     * @param _timelock Timelock controller address
     */
    function initialize(
        address _musd,
        address _ybPool,
        string memory _name,
        string memory _symbol,
        uint256 _maxDeposits,
        address _admin,
        address _timelock
    ) external initializer {
        if (_musd == address(0)) revert ZeroAddress();
        if (_ybPool == address(0)) revert InvalidPool();
        if (_admin == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        __ERC4626_init(IERC20(_musd));
        __ERC20_init(_name, _symbol);
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        ybPool = IYieldBasisPool(_ybPool);
        poolLabel = _getLabel(_ybPool);
        maxTotalDeposits = _maxDeposits;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-4626 OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (totalAssets() + assets > maxTotalDeposits) revert DepositCapReached();
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        uint256 assets = previewMint(shares);
        if (totalAssets() + assets > maxTotalDeposits) revert DepositCapReached();
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Propagate cooldown on transfer (same as SMUSD)
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fromCooldown = lastDeposit[from];
            uint256 toCooldown = lastDeposit[to];
            if (fromCooldown > toCooldown) {
                lastDeposit[to] = fromCooldown;
                emit CooldownUpdated(to, fromCooldown);
            }
        }
        super._update(from, to, value);
    }

    /// @notice Donation attack mitigation (same as SMUSD)
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-4626 COMPLIANCE: max* returns 0 when operation would revert
    // ═══════════════════════════════════════════════════════════════════════

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 currentAssets = totalAssets();
        if (currentAssets >= maxTotalDeposits) return 0;
        uint256 remaining = maxTotalDeposits - currentAssets;
        uint256 parentMax = super.maxDeposit(receiver);
        return remaining < parentMax ? remaining : parentMax;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused()) return 0;
        return super.maxMint(receiver);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) return 0;
        return super.maxWithdraw(owner);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) return 0;
        return super.maxRedeem(owner);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // YIELD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute yield from YB pool earnings to this vault
     * @dev Called by YIELD_MANAGER (off-chain keeper or Treasury)
     *      mUSD is transferred in, increasing totalAssets() → share price rises
     * @param amount mUSD yield to distribute
     */
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        if (amount == 0) revert InvalidAmount();
        uint256 shares_ = totalSupply();
        if (shares_ == 0) revert NoSharesExist();

        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        if (amount > maxYield) revert YieldExceedsCap();

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        totalYieldReceived += amount;

        uint256 newPrice = globalSharePrice();
        emit YieldDistributed(msg.sender, amount, newPrice);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CANTON CROSS-CHAIN (mirrors SMUSD pattern)
    // ═══════════════════════════════════════════════════════════════════════

    function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
        if (epoch <= lastCantonSyncEpoch) revert EpochNotSequential();
        if (block.timestamp < lastCantonSyncTime + MIN_SYNC_INTERVAL) revert SyncTooFrequent();

        if (cantonTotalShares == 0) {
            uint256 ethShares = totalSupply();
            uint256 maxInitial = ethShares > 0 ? ethShares * 2 : _cantonShares;
            if (_cantonShares > maxInitial) revert InitialSharesTooLarge();
        } else {
            uint256 maxInc = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
            uint256 maxDec = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
            if (_cantonShares > maxInc) revert ShareIncreaseTooLarge();
            if (_cantonShares < maxDec) revert ShareDecreaseTooLarge();
        }

        cantonTotalShares = _cantonShares;
        lastCantonSyncEpoch = epoch;
        lastCantonSyncTime = block.timestamp;

        emit CantonSharesSynced(_cantonShares, epoch, globalSharePrice());
    }

    function globalTotalShares() public view returns (uint256) {
        return totalSupply() + cantonTotalShares;
    }

    function globalTotalAssets() public view returns (uint256) {
        return totalAssets(); // YB vault is local — no Treasury dependency
    }

    function globalSharePrice() public view returns (uint256) {
        uint256 shares_ = globalTotalShares();
        if (shares_ == 0) return 10 ** _decimalsOffset();
        return (globalTotalAssets() * (10 ** _decimalsOffset())) / shares_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Current APY from the underlying YB pool
    function currentAPY() external view returns (uint256) {
        return ybPool.lendingAPY();
    }

    /// @notice Current pool utilization
    function currentUtilization() external view returns (uint256) {
        return ybPool.utilization();
    }

    /// @notice Remaining cooldown for an account
    function getRemainingCooldown(address account) external view returns (uint256) {
        uint256 cooldownEnd = lastDeposit[account] + WITHDRAW_COOLDOWN;
        if (block.timestamp >= cooldownEnd) return 0;
        return cooldownEnd - block.timestamp;
    }

    /// @notice Whether an account can withdraw
    function canWithdraw(address account) external view returns (bool) {
        return block.timestamp >= lastDeposit[account] + WITHDRAW_COOLDOWN;
    }

    /// @notice The base volatile asset of the YB pool (WBTC or WETH)
    function baseAsset() external view returns (address) {
        return ybPool.baseAsset();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setMaxTotalDeposits(uint256 _max) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_max == 0) revert ZeroAmount();
        uint256 old = maxTotalDeposits;
        maxTotalDeposits = _max;
        emit MaxDepositsUpdated(old, _max);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TIMELOCK — CRITICAL OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Migrate to a new Yield Basis pool (e.g., external YB → MintedYBPool)
     * @dev Requires timelock for safety. Does NOT move user funds — only changes
     *      which pool is referenced for APY/utilization display and yield sourcing.
     * @param _newPool New IYieldBasisPool address (MintedYBPool)
     */
    function migratePool(address _newPool) external onlyTimelock {
        if (_newPool == address(0)) revert InvalidPool();
        address oldPool = address(ybPool);
        ybPool = IYieldBasisPool(_newPool);
        poolLabel = _getLabel(_newPool);
        emit PoolMigrated(oldPool, _newPool);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════

    function _getLabel(address _pool) internal view returns (string memory) {
        try IYieldBasisPool(_pool).baseAsset() returns (address) {
            // Label will be set based on deployment
            return "";
        } catch {
            return "";
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADE
    // ═══════════════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
