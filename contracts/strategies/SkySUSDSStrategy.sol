// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";
import "../TimelockGoverned.sol";

/**
 * @title SkySUSDSStrategy
 * @notice Yield strategy wrapping Sky Protocol's sUSDS (Savings USDS)
 * @dev Deposits USDC → swaps to USDS → deposits into sUSDS (savings vault)
 *
 * Target Performance:
 *   Sky Savings Rate:   ~8% APY (variable, set by Sky governance)
 *   Slippage:           ~0.05% (USDC↔USDS is tight on major DEXs)
 *   Net APY:            ~7.9%
 *
 * Flow:
 *   1. deposit(): USDC → PSM swap to USDS → deposit into sUSDS
 *   2. totalValue(): sUSDS.maxWithdraw(address(this)) converted back to USDC
 *   3. withdraw(): sUSDS.withdraw → USDS → PSM swap to USDC
 *
 * Safety:
 *   - USDC↔USDS swap via Sky PSM (Peg Stability Module) — zero slippage
 *   - sUSDS is non-rebasing ERC4626 vault — share price only increases
 *   - Emergency withdraw pulls all and holds USDC in contract
 *
 * Allocation: Receives 20% of TreasuryV2 deposits
 */

/// @notice Sky Protocol PSM (Peg Stability Module) — swap USDC↔USDS at 1:1
interface ISkyPSM {
    /// @notice Swap gem (USDC) for USDS at 1:1 via PSM
    /// @param usr Recipient of USDS
    /// @param gemAmt Amount of gem (USDC, 6 decimals)
    function sellGem(address usr, uint256 gemAmt) external;

    /// @notice Swap USDS for gem (USDC) at 1:1 via PSM
    /// @param usr Recipient of gem (USDC)
    /// @param gemAmt Amount of gem to receive (USDC, 6 decimals)
    function buyGem(address usr, uint256 gemAmt) external;

    /// @notice Fee for selling gem (USDC→USDS), in WAD (e.g., 0 = no fee)
    function tin() external view returns (uint256);

    /// @notice Fee for buying gem (USDS→USDC), in WAD
    function tout() external view returns (uint256);
}

/// @notice Sky sUSDS (Savings USDS) — ERC4626 vault for USDS yield
interface ISUSDS {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function maxWithdraw(address owner) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function asset() external view returns (address);
}

contract SkySUSDSStrategy is
    IStrategy,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant WAD = 1e18;

    /// @notice USDC/USDS decimal conversion factor (USDS has 18 decimals, USDC has 6)
    uint256 public constant USDC_TO_USDS_SCALE = 1e12;

    // ═══════════════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice FIX C-02: Declare TIMELOCK_ROLE explicitly — was undefined, defaulting to
    /// bytes32(0) (DEFAULT_ADMIN_ROLE), which allowed admin to bypass 48h timelock delay
    /// on unpause() and recoverToken().
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice USDC token (6 decimals)
    IERC20 public usdc;

    /// @notice USDS token (18 decimals)
    IERC20 public usds;

    /// @notice Sky PSM for USDC↔USDS swaps
    ISkyPSM public psm;

    /// @notice Sky sUSDS savings vault
    ISUSDS public sUsds;

    /// @notice Whether strategy is active for deposits
    bool public active;

    /// @notice Total USDC principal deposited (before yield)
    uint256 public totalPrincipal;

    /// @dev Storage gap for future upgrades
    uint256[40] private __gap;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Deposited(uint256 usdcIn, uint256 usdsDeposited, uint256 sharesReceived);
    event Withdrawn(uint256 requested, uint256 usdcReturned);
    event EmergencyWithdrawn(uint256 sharesRedeemed, uint256 usdcRecovered);
    event ActiveUpdated(bool active);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error ZeroAmount();
    error StrategyNotActive();
    error InsufficientBalance();
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Sky sUSDS strategy
     * @param _usdc USDC token address
     * @param _usds USDS token address
     * @param _psm Sky PSM address for USDC↔USDS
     * @param _sUsds Sky sUSDS savings vault address
     * @param _treasury TreasuryV2 address
     * @param _admin Admin/timelock address
     */
    function initialize(
        address _usdc,
        address _usds,
        address _psm,
        address _sUsds,
        address _treasury,
        address _admin,
        address _timelock
    ) external initializer {
        if (_usdc == address(0) || _usds == address(0) || _psm == address(0)
            || _sUsds == address(0) || _treasury == address(0) || _admin == address(0))
        {
            revert ZeroAddress();
        }
        require(_timelock != address(0), "ZERO_TIMELOCK");

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        usdc = IERC20(_usdc);
        usds = IERC20(_usds);
        psm = ISkyPSM(_psm);
        sUsds = ISUSDS(_sUsds);

        active = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _treasury);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        // TimelockGoverned replaces TIMELOCK_ROLE — upgrades go through MintedTimelockController

        // FIX C-06: Make TIMELOCK_ROLE its own admin — DEFAULT_ADMIN cannot grant/revoke it
        // Without this, DEFAULT_ADMIN can grant itself TIMELOCK_ROLE and bypass the 48h
        // upgrade delay, enabling instant implementation swap to drain all funds
        _setRoleAdmin(TIMELOCK_ROLE, TIMELOCK_ROLE);

        // FIX HIGH-07: Removed infinite approvals from initialize().
        // Per-operation approvals are set before each PSM/sUSDS interaction
        // in deposit(), withdraw(), and withdrawAll() to limit exposure
        // if PSM or sUSDS contracts are compromised.
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC → USDS via PSM → sUSDS savings vault
     * @param amount Amount of USDC to deposit (6 decimals)
     * @return deposited Actual amount deposited
     */
    function deposit(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 deposited)
    {
        if (amount == 0) revert ZeroAmount();
        if (!active) revert StrategyNotActive();

        // Transfer USDC from Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // FIX HIGH-07: Per-operation approval (replaces infinite approval)
        usdc.forceApprove(address(psm), amount);

        // Step 1: Swap USDC → USDS via PSM (1:1, zero slippage)
        psm.sellGem(address(this), amount);

        // Step 2: Deposit USDS into sUSDS savings vault
        uint256 usdsAmount = amount * USDC_TO_USDS_SCALE; // Scale 6→18 decimals
        // FIX HIGH-07: Per-operation approval for sUSDS deposit
        usds.forceApprove(address(sUsds), usdsAmount);
        uint256 shares = sUsds.deposit(usdsAmount, address(this));

        totalPrincipal += amount;
        deposited = amount;

        emit Deposited(amount, usdsAmount, shares);
    }

    /**
     * @notice Withdraw USDC by redeeming sUSDS → USDS → USDC
     * @param amount Amount of USDC to withdraw (6 decimals)
     * @return withdrawn Actual USDC withdrawn
     */
    function withdraw(uint256 amount)
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();

        // Calculate USDS needed (18 decimals)
        uint256 usdsNeeded = amount * USDC_TO_USDS_SCALE;

        // Check how much we can withdraw
        uint256 maxUsds = sUsds.maxWithdraw(address(this));
        if (usdsNeeded > maxUsds) {
            usdsNeeded = maxUsds;
        }

        // Step 1: Withdraw USDS from sUSDS
        sUsds.withdraw(usdsNeeded, address(this), address(this));

        // Step 2: Swap USDS → USDC via PSM
        uint256 usdcAmount = usdsNeeded / USDC_TO_USDS_SCALE;
        // FIX HIGH-07: Per-operation approval for PSM buyGem
        usds.forceApprove(address(psm), usdsNeeded);
        psm.buyGem(address(this), usdcAmount);

        // Update principal tracking
        if (usdcAmount >= totalPrincipal) {
            totalPrincipal = 0;
        } else {
            totalPrincipal -= usdcAmount;
        }

        // Transfer USDC to Treasury
        usdc.safeTransfer(msg.sender, usdcAmount);
        withdrawn = usdcAmount;

        emit Withdrawn(amount, withdrawn);
    }

    /**
     * @notice Withdraw all USDC from strategy
     * @return withdrawn Total USDC withdrawn
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        // Redeem all sUSDS shares
        uint256 shares = sUsds.balanceOf(address(this));
        if (shares == 0) {
            // Return any dust USDC sitting in the contract
            uint256 dust = usdc.balanceOf(address(this));
            if (dust > 0) {
                usdc.safeTransfer(msg.sender, dust);
            }
            totalPrincipal = 0;
            return dust;
        }

        // Step 1: Redeem all sUSDS → USDS
        uint256 usdsOut = sUsds.redeem(shares, address(this), address(this));

        // Step 2: Swap all USDS → USDC via PSM
        uint256 usdcAmount = usdsOut / USDC_TO_USDS_SCALE;
        if (usdcAmount > 0) {
            // FIX HIGH-07: Per-operation approval for PSM buyGem
            usds.forceApprove(address(psm), usdsOut);
            psm.buyGem(address(this), usdcAmount);
        }

        totalPrincipal = 0;

        // Transfer all USDC to Treasury
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            usdc.safeTransfer(msg.sender, balance);
        }

        withdrawn = balance;
        emit Withdrawn(type(uint256).max, withdrawn);
    }

    /**
     * @notice Total value of strategy position in USDC terms (6 decimals)
     * @return Total USDC value including accrued yield
     */
    function totalValue() external view override returns (uint256) {
        // sUSDS value in USDS (18 decimals)
        uint256 usdsValue = sUsds.maxWithdraw(address(this));

        // Convert USDS (18 decimals) → USDC (6 decimals)
        uint256 usdcValue = usdsValue / USDC_TO_USDS_SCALE;

        // Add any USDC dust sitting in the contract
        return usdcValue + usdc.balanceOf(address(this));
    }

    /**
     * @notice The underlying asset (USDC)
     */
    function asset() external view override returns (address) {
        return address(usdc);
    }

    /**
     * @notice Whether strategy is accepting deposits
     */
    function isActive() external view override returns (bool) {
        return active && !paused();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Current sUSDS shares held
     */
    function sUsdsShares() external view returns (uint256) {
        return sUsds.balanceOf(address(this));
    }

    /**
     * @notice Current yield earned above principal (in USDC terms)
     */
    function unrealizedYield() external view returns (uint256) {
        uint256 current = sUsds.maxWithdraw(address(this)) / USDC_TO_USDS_SCALE;
        if (current > totalPrincipal) {
            return current - totalPrincipal;
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Activate/deactivate strategy
     */
    function setActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        active = _active;
        emit ActiveUpdated(_active);
    }

    /**
     * @notice Emergency withdraw all to USDC and pause
     */
    function emergencyWithdraw() external onlyRole(GUARDIAN_ROLE) {
        _pause();

        uint256 shares = sUsds.balanceOf(address(this));
        uint256 usdcRecovered = 0;

        if (shares > 0) {
            uint256 usdsOut = sUsds.redeem(shares, address(this), address(this));
            uint256 usdcAmount = usdsOut / USDC_TO_USDS_SCALE;
            if (usdcAmount > 0) {
                // FIX C-REL-01: Add missing USDS approval for PSM buyGem
                // Without this approval the PSM cannot pull USDS, causing emergencyWithdraw to revert
                usds.forceApprove(address(psm), usdsOut);
                psm.buyGem(address(this), usdcAmount);
            }
            usdcRecovered = usdc.balanceOf(address(this));
        }

        totalPrincipal = 0;
        emit EmergencyWithdrawn(shares, usdcRecovered);
        // USDC stays in contract for Treasury to withdraw via withdrawAll()
    }

    /**
     * @notice Pause strategy
     */
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause strategy
     */
    /// @notice FIX C-06: Unpause requires timelock to prevent premature recovery after exploit
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }

    /**
     * @notice Recover stuck tokens (not USDC, USDS, or sUSDS)
     */
    /// @notice FIX C-06: Recovery requires timelock delay to prevent instant drain
    function recoverToken(address token, uint256 amount) external onlyRole(TIMELOCK_ROLE) {
        require(token != address(usdc), "Cannot recover USDC");
        require(token != address(usds), "Cannot recover USDS");
        require(token != address(sUsds), "Cannot recover sUSDS");
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UPGRADES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice FIX CRIT-06: Only MintedTimelockController can authorize upgrades (48h delay enforced)
    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
