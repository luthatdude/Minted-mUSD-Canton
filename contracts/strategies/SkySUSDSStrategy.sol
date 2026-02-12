// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";

/**
 * @title SkySUSDSStrategy
 * @notice Yield strategy that deposits USDC into MakerDAO/Sky sUSDS vault
 * @dev Flow: USDC → PSM → USDS → sUSDS vault → earns Sky Savings Rate
 *
 * Target Performance:
 *   Sky Savings Rate:  ~6.0% (as of market conditions)
 *   No leverage risk — simple deposit/redeem
 *
 * Safety Features:
 *   - No leverage (1x exposure only)
 *   - MakerDAO/Sky S-tier security
 *   - PSM 1:1 peg for USDC↔USDS conversion
 *   - Configurable deposit/withdrawal caps
 *   - Emergency withdrawal by guardian
 */

/// @notice Sky PSM (Peg Stability Module) — swaps USDC ↔ USDS at 1:1
interface ISkyPSM {
    /// @notice Swap USDC for USDS (scales 6→18 decimals internally)
    /// @param usr Recipient of USDS
    /// @param gemAmt Amount of USDC (6 decimals)
    function sellGem(address usr, uint256 gemAmt) external;

    /// @notice Swap USDS for USDC (scales 18→6 decimals internally)
    /// @param usr Recipient of USDC
    /// @param gemAmt Amount of USDC to receive (6 decimals)
    function buyGem(address usr, uint256 gemAmt) external;

    /// @notice Fee on sellGem (typically 0 for USDC)
    function tin() external view returns (uint256);

    /// @notice Fee on buyGem (typically 0 for USDC)
    function tout() external view returns (uint256);
}

/// @notice ERC-4626 sUSDS Vault — deposit USDS, earn Sky Savings Rate
interface ISUSDSVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function maxDeposit(address) external view returns (uint256);
    function maxRedeem(address) external view returns (uint256);
    function asset() external view returns (address);
}

contract SkySUSDSStrategy is
    IStrategy,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BPS = 10000;
    uint256 public constant USDC_DECIMALS = 6;
    uint256 public constant USDS_DECIMALS = 18;
    uint256 public constant SCALING_FACTOR = 10 ** 12; // 6→18 decimal conversion

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token (6 decimals)
    IERC20 public usdc;

    /// @notice USDS token (18 decimals)
    IERC20 public usds;

    /// @notice Sky PSM for USDC ↔ USDS swaps
    ISkyPSM public psm;

    /// @notice sUSDS ERC-4626 vault
    ISUSDSVault public sUsdsVault;

    /// @notice Whether strategy is active for deposits
    bool public active;

    /// @notice Total principal deposited (USDC, 6 decimals)
    uint256 public totalPrincipal;

    /// @notice Maximum single deposit (USDC, 6 decimals). 0 = unlimited
    uint256 public maxDepositAmount;

    /// @notice Minimum deposit amount (USDC, 6 decimals)
    uint256 public minDepositAmount;

    /// @notice Maximum total value in strategy (USDC, 6 decimals). 0 = unlimited
    uint256 public maxTotalValue;

    /// @notice Slippage tolerance for PSM operations (in BPS, e.g., 10 = 0.1%)
    uint256 public slippageToleranceBps;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(address indexed caller, uint256 usdcAmount, uint256 usdsConverted, uint256 sharesReceived);
    event Withdrawn(address indexed caller, uint256 sharesRedeemed, uint256 usdsReceived, uint256 usdcReturned);
    event WithdrawnAll(address indexed caller, uint256 totalUsdcReturned);
    event EmergencyWithdraw(address indexed guardian, uint256 usdcRecovered);
    event MaxDepositUpdated(uint256 newMax);
    event MinDepositUpdated(uint256 newMin);
    event MaxTotalValueUpdated(uint256 newMax);
    event SlippageUpdated(uint256 newBps);
    event StrategyActivated();
    event StrategyDeactivated();

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error StrategyInactive();
    error ZeroAmount();
    error BelowMinDeposit(uint256 amount, uint256 minimum);
    error ExceedsMaxDeposit(uint256 amount, uint256 maximum);
    error ExceedsMaxTotalValue(uint256 newTotal, uint256 maximum);
    error InsufficientBalance(uint256 requested, uint256 available);
    error PSMConversionFailed();
    error SlippageExceeded(uint256 expected, uint256 actual);
    error InvalidSlippage();

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _usdc,
        address _usds,
        address _psm,
        address _sUsdsVault,
        address _treasury,
        address _admin
    ) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        require(_usdc != address(0), "Zero USDC");
        require(_usds != address(0), "Zero USDS");
        require(_psm != address(0), "Zero PSM");
        require(_sUsdsVault != address(0), "Zero sUSDS vault");
        require(_treasury != address(0), "Zero treasury");
        require(_admin != address(0), "Zero admin");

        usdc = IERC20(_usdc);
        usds = IERC20(_usds);
        psm = ISkyPSM(_psm);
        sUsdsVault = ISUSDSVault(_sUsdsVault);

        // Verify sUSDS vault asset is USDS
        require(sUsdsVault.asset() == _usds, "Vault asset mismatch");

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);

        active = true;
        slippageToleranceBps = 10; // 0.1%
        minDepositAmount = 100e6; // 100 USDC minimum

        // FIX: Removed infinite approvals. Using per-operation forceApprove instead
        // to minimize approval exposure window.
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IStrategy
    function deposit(uint256 amount) external override nonReentrant whenNotPaused returns (uint256 deposited) {
        if (!active) revert StrategyInactive();
        if (amount == 0) revert ZeroAmount();
        if (amount < minDepositAmount) revert BelowMinDeposit(amount, minDepositAmount);
        if (maxDepositAmount > 0 && amount > maxDepositAmount) revert ExceedsMaxDeposit(amount, maxDepositAmount);

        uint256 newTotal = totalValue() + amount;
        if (maxTotalValue > 0 && newTotal > maxTotalValue) revert ExceedsMaxTotalValue(newTotal, maxTotalValue);

        _checkRole(TREASURY_ROLE);

        // 1. Transfer USDC from Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // 2. Convert USDC → USDS via PSM (1:1 minus fee)
        usdc.forceApprove(address(psm), amount);
        uint256 usdsBefore = usds.balanceOf(address(this));
        psm.sellGem(address(this), amount);
        uint256 usdsReceived = usds.balanceOf(address(this)) - usdsBefore;

        // 3. Verify PSM conversion (account for fee)
        uint256 expectedUsds = amount * SCALING_FACTOR; // Scale 6→18 decimals
        uint256 minUsds = expectedUsds * (BPS - slippageToleranceBps) / BPS;
        if (usdsReceived < minUsds) revert SlippageExceeded(minUsds, usdsReceived);

        // 4. Deposit USDS into sUSDS vault
        usds.forceApprove(address(sUsdsVault), usdsReceived);
        uint256 shares = sUsdsVault.deposit(usdsReceived, address(this));

        totalPrincipal += amount;
        deposited = amount;

        emit Deposited(msg.sender, amount, usdsReceived, shares);
    }

    /// @inheritdoc IStrategy
    function withdraw(uint256 amount) external override nonReentrant returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        _checkRole(TREASURY_ROLE);

        // Calculate how many sUSDS shares to redeem for `amount` USDC
        uint256 usdsNeeded = amount * SCALING_FACTOR; // 6→18 decimal scaling
        uint256 sharesNeeded = sUsdsVault.convertToShares(usdsNeeded);
        uint256 ourShares = sUsdsVault.balanceOf(address(this));

        if (sharesNeeded > ourShares) {
            // Redeem all if insufficient
            sharesNeeded = ourShares;
        }

        // 1. Redeem sUSDS shares → USDS
        uint256 usdsReceived = sUsdsVault.redeem(sharesNeeded, address(this), address(this));

        // 2. Convert USDS → USDC via PSM
        uint256 usdcToReceive = usdsReceived / SCALING_FACTOR; // 18→6 decimal scaling
        usds.forceApprove(address(psm), usdsReceived);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        psm.buyGem(address(this), usdcToReceive);
        uint256 usdcActual = usdc.balanceOf(address(this)) - usdcBefore;

        // 3. Transfer USDC back to Treasury
        usdc.safeTransfer(msg.sender, usdcActual);

        // Update principal (cap at 0)
        if (usdcActual >= totalPrincipal) {
            totalPrincipal = 0;
        } else {
            totalPrincipal -= usdcActual;
        }

        withdrawn = usdcActual;
        emit Withdrawn(msg.sender, sharesNeeded, usdsReceived, usdcActual);
    }

    /// @inheritdoc IStrategy
    function withdrawAll() external override nonReentrant returns (uint256 withdrawn) {
        _checkRole(TREASURY_ROLE);

        uint256 shares = sUsdsVault.balanceOf(address(this));
        if (shares == 0) return 0;

        // 1. Redeem all sUSDS → USDS
        uint256 usdsReceived = sUsdsVault.redeem(shares, address(this), address(this));

        // 2. Convert all USDS → USDC via PSM
        uint256 usdcToReceive = usdsReceived / SCALING_FACTOR;
        usds.forceApprove(address(psm), usdsReceived);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        psm.buyGem(address(this), usdcToReceive);
        uint256 usdcActual = usdc.balanceOf(address(this)) - usdcBefore;

        // 3. Transfer all USDC back to Treasury
        usdc.safeTransfer(msg.sender, usdcActual);

        totalPrincipal = 0;
        withdrawn = usdcActual;
        emit WithdrawnAll(msg.sender, usdcActual);
    }

    /// @inheritdoc IStrategy
    function totalValue() public view override returns (uint256) {
        uint256 shares = sUsdsVault.balanceOf(address(this));
        if (shares == 0) return 0;

        // Convert sUSDS shares → USDS amount → USDC amount
        uint256 usdsValue = sUsdsVault.convertToAssets(shares);
        uint256 usdcValue = usdsValue / SCALING_FACTOR;

        // Include any idle USDC sitting in this contract
        uint256 idleUsdc = usdc.balanceOf(address(this));

        return usdcValue + idleUsdc;
    }

    /// @inheritdoc IStrategy
    function asset() external view override returns (address) {
        return address(usdc);
    }

    /// @inheritdoc IStrategy
    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Current sUSDS shares held by this strategy
    function sharesHeld() external view returns (uint256) {
        return sUsdsVault.balanceOf(address(this));
    }

    /// @notice Profit/loss since deployment (in USDC, 6 decimals)
    function unrealizedPnL() external view returns (int256) {
        return int256(totalValue()) - int256(totalPrincipal);
    }

    /// @notice Current Sky Savings Rate implied APY (rough estimate)
    /// @dev Compares share price to 1:1 baseline. For accurate APY, use off-chain calculation
    function estimatedAPY() external view returns (uint256) {
        uint256 sharePrice = sUsdsVault.convertToAssets(1e18);
        if (sharePrice <= 1e18) return 0;

        // Annualized return: (sharePrice / 1e18 - 1) * 365 / daysSinceGenesis
        // This is a rough estimate — actual APY requires time-weighted calculation
        uint256 returnPct = ((sharePrice - 1e18) * BPS) / 1e18;
        return returnPct;
    }

    /// @notice PSM fee for converting USDC → USDS
    function psmEntryFee() external view returns (uint256) {
        return psm.tin();
    }

    /// @notice PSM fee for converting USDS → USDC
    function psmExitFee() external view returns (uint256) {
        return psm.tout();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function activate() external onlyRole(STRATEGIST_ROLE) {
        active = true;
        emit StrategyActivated();
    }

    function deactivate() external onlyRole(STRATEGIST_ROLE) {
        active = false;
        emit StrategyDeactivated();
    }

    function setMaxDepositAmount(uint256 _max) external onlyRole(STRATEGIST_ROLE) {
        maxDepositAmount = _max;
        emit MaxDepositUpdated(_max);
    }

    function setMinDepositAmount(uint256 _min) external onlyRole(STRATEGIST_ROLE) {
        minDepositAmount = _min;
        emit MinDepositUpdated(_min);
    }

    function setMaxTotalValue(uint256 _max) external onlyRole(STRATEGIST_ROLE) {
        maxTotalValue = _max;
        emit MaxTotalValueUpdated(_max);
    }

    function setSlippageTolerance(uint256 _bps) external onlyRole(STRATEGIST_ROLE) {
        if (_bps > 500) revert InvalidSlippage(); // Max 5%
        slippageToleranceBps = _bps;
        emit SlippageUpdated(_bps);
    }

    /// @notice Emergency withdraw all to Treasury, bypassing normal flow
    function emergencyWithdraw(address recipient) external onlyRole(GUARDIAN_ROLE) {
        require(recipient != address(0), "Zero recipient");

        // Redeem all sUSDS
        uint256 shares = sUsdsVault.balanceOf(address(this));
        if (shares > 0) {
            sUsdsVault.redeem(shares, address(this), address(this));
        }

        // Convert all USDS to USDC
        uint256 usdsBalance = usds.balanceOf(address(this));
        if (usdsBalance > 0) {
            uint256 usdcToReceive = usdsBalance / SCALING_FACTOR;
            if (usdcToReceive > 0) {
                // FIX: Approve USDS for PSM before conversion
                usds.forceApprove(address(psm), usdsBalance);
                psm.buyGem(address(this), usdcToReceive);
            }
        }

        // Transfer all USDC out
        uint256 usdcBalance = usdc.balanceOf(address(this));
        if (usdcBalance > 0) {
            usdc.safeTransfer(recipient, usdcBalance);
        }

        totalPrincipal = 0;
        active = false;

        emit EmergencyWithdraw(msg.sender, usdcBalance);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UUPS UPGRADE (TIMELOCKED)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice FIX INSTITUTIONAL: Pending implementation for timelocked upgrade
    address public pendingImplementation;

    /// @notice FIX INSTITUTIONAL: Timestamp of upgrade request
    uint256 public upgradeRequestTime;

    /// @notice FIX INSTITUTIONAL: 48-hour upgrade delay
    uint256 public constant UPGRADE_DELAY = 48 hours;

    event UpgradeRequested(address indexed newImplementation, uint256 executeAfter);
    event UpgradeCancelled(address indexed cancelledImplementation);

    /// @notice Request a timelocked upgrade
    /// @dev FIX SOL-002: Prevent overwriting pending upgrade (bait-and-switch protection)
    function requestUpgrade(address newImplementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newImplementation != address(0), "ZERO_ADDRESS");
        require(pendingImplementation == address(0), "UPGRADE_ALREADY_PENDING");
        pendingImplementation = newImplementation;
        upgradeRequestTime = block.timestamp;
        emit UpgradeRequested(newImplementation, block.timestamp + UPGRADE_DELAY);
    }

    /// @notice Cancel a pending upgrade
    function cancelUpgrade() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address cancelled = pendingImplementation;
        pendingImplementation = address(0);
        upgradeRequestTime = 0;
        emit UpgradeCancelled(cancelled);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(pendingImplementation == newImplementation, "UPGRADE_NOT_REQUESTED");
        require(block.timestamp >= upgradeRequestTime + UPGRADE_DELAY, "UPGRADE_TIMELOCK_ACTIVE");
        pendingImplementation = address(0);
        upgradeRequestTime = 0;
    }

    /// @dev Storage gap for future upgrades
    uint256[38] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // RESCUE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Rescue tokens accidentally sent to this contract
    /// @dev Cannot rescue USDC, USDS, or sUSDS (strategy assets)
    function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(usdc), "Cannot rescue USDC");
        require(token != address(usds), "Cannot rescue USDS");
        require(token != address(sUsdsVault), "Cannot rescue sUSDS");
        IERC20(token).safeTransfer(to, amount);
    }
}
