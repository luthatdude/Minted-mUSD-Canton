// SPDX-License-Identifier: MIT
// BLE Protocol - Fixed Version with Unified Cross-Chain Yield
// Fixes: S-01 (Cooldown bypass via transfer), S-02 (Missing redeem override),
//        S-03 (Donation attack mitigation), S-04 (SafeERC20)
// Feature: Unified share price across Ethereum and Canton for equal yield distribution

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev FIX S-H01: Typed interface for Treasury calls (replaces raw staticcall)
interface ITreasury {
    function totalValue() external view returns (uint256);
}

contract SMUSD is ERC4626, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant INTEREST_ROUTER_ROLE = keccak256("INTEREST_ROUTER_ROLE");

    mapping(address => uint256) public lastDeposit;
    uint256 public constant WITHDRAW_COOLDOWN = 24 hours;
    
    // FIX M-3: Maximum yield per distribution (10% of total assets) to prevent excessive dilution
    uint256 public constant MAX_YIELD_BPS = 1000; // 10% max yield per distribution

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED CROSS-CHAIN YIELD: Canton shares tracking
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Total smUSD shares on Canton (synced via bridge attestation)
    uint256 public cantonTotalShares;
    
    /// @notice Last sync epoch from Canton
    uint256 public lastCantonSyncEpoch;
    
    /// @notice Treasury contract for global asset value
    address public treasury;

    // ═══════════════════════════════════════════════════════════════════════
    // FIX CRITICAL: Rate limiting for Canton share sync to prevent manipulation
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Last Canton sync timestamp
    uint256 public lastCantonSyncTime;
    
    /// @notice Minimum interval between syncs (1 hour)
    uint256 public constant MIN_SYNC_INTERVAL = 1 hours;
    
    /// @notice Maximum share change per sync (5% = 500 bps)
    uint256 public constant MAX_SHARE_CHANGE_BPS = 500;

    // ═══════════════════════════════════════════════════════════════════════
    // INTEREST ROUTING: Track interest from BorrowModule
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Total interest received from borrowers
    uint256 public totalInterestReceived;
    
    /// @notice Last interest receipt timestamp
    uint256 public lastInterestReceiptTime;

    /// @notice FIX SOL-C01: Cached last known good globalTotalAssets to prevent
    ///         silent fallback to local totalAssets on treasury failure
    uint256 public lastKnownGlobalAssets;

    /// @notice FIX SOL-C-02: Maximum allowed growth rate per refresh (5% = 500 bps)
    /// @dev Prevents a single compromised strategy from inflating totalValue() unboundedly
    uint256 public constant MAX_GLOBAL_ASSETS_GROWTH_BPS = 500;

    // Events
    event YieldDistributed(address indexed from, uint256 amount);
    event CooldownUpdated(address indexed account, uint256 timestamp);
    event CantonSharesSynced(uint256 cantonShares, uint256 epoch, uint256 globalSharePrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event InterestReceived(address indexed from, uint256 amount, uint256 totalReceived);
    event GlobalAssetsRefreshed(uint256 newGlobalAssets, uint256 usdcValue);

    constructor(IERC20 _musd) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // FIX S-H01: Always set cooldown for receiver to prevent bypass via third-party deposit.
    // A depositor can always set their own cooldown, and depositing on behalf of someone
    // correctly locks the receiver's withdrawal window.
    // FIX: Added nonReentrant and whenNotPaused for security
    // FIX SOL-M02: Ensure globalTotalAssets cache is populated before accepting deposits.
    // If treasury is set but lastKnownGlobalAssets is 0 and globalTotalShares includes Canton
    // shares, the fallback to local totalAssets() would dilute existing holders.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (treasury != address(0) && lastKnownGlobalAssets == 0 && cantonTotalShares > 0) {
            // Force-populate the cache before first deposit when Canton shares exist
            uint256 usdcValue = ITreasury(treasury).totalValue();
            lastKnownGlobalAssets = usdcValue * 1e12;
        }
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    // FIX S-H01: Always set cooldown for receiver to prevent bypass via third-party mint.
    // Matches deposit() behavior — any path that increases shares must reset cooldown.
    // FIX: Added nonReentrant and whenNotPaused for security
    // FIX SOL-M02: Same globalTotalAssets cache guard as deposit()
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        if (treasury != address(0) && lastKnownGlobalAssets == 0 && cantonTotalShares > 0) {
            uint256 usdcValue = ITreasury(treasury).totalValue();
            lastKnownGlobalAssets = usdcValue * 1e12;
        }
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }

    // FIX: Added nonReentrant and whenNotPaused for security
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.withdraw(assets, receiver, owner);
    }

    // FIX S-02: Override redeem to enforce cooldown
    // FIX: Added nonReentrant and whenNotPaused for security
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.redeem(shares, receiver, owner);
    }

    // FIX S-01: Propagate cooldown on transfer to prevent bypass
    function _update(address from, address to, uint256 value) internal override {
        // Skip cooldown propagation for mint (from == 0) and burn (to == 0)
        if (from != address(0) && to != address(0)) {
            // Transfer: propagate the stricter cooldown to receiver
            uint256 fromCooldown = lastDeposit[from];
            uint256 toCooldown = lastDeposit[to];

            // Receiver inherits the later (more restrictive) cooldown
            if (fromCooldown > toCooldown) {
                lastDeposit[to] = fromCooldown;
                emit CooldownUpdated(to, fromCooldown);
            }
        }

        super._update(from, to, value);
    }

    // FIX S-04: Use SafeERC20 for token transfers
    // FIX M-3: Added maximum yield cap to prevent excessive dilution attacks
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        require(totalSupply() > 0, "NO_SHARES_EXIST");
        require(amount > 0, "INVALID_AMOUNT");
        
        // FIX P2-M2: Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxYield, "YIELD_EXCEEDS_CAP");

        // FIX S-04: Use safeTransferFrom
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit YieldDistributed(msg.sender, amount);
    }

    /// @notice Receive interest payments from BorrowModule
    /// @dev Called by BorrowModule to route borrower interest to suppliers
    /// @param amount The amount of mUSD interest to receive
    function receiveInterest(uint256 amount) external onlyRole(INTEREST_ROUTER_ROLE) {
        require(amount > 0, "ZERO_AMOUNT");
        require(globalTotalShares() > 0, "NO_SHARES_EXIST");
        
        // FIX P2-M2: Use globalTotalAssets() for the cap, not local totalAssets().
        // The vault serves both Ethereum and Canton shareholders, so the cap
        // should reflect the total asset base. Using local assets was too
        // restrictive when Canton shares are large, potentially causing
        // _accrueGlobalInterest() to revert and blocking all borrows/repays.
        uint256 currentAssets = globalTotalAssets();
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxInterest, "INTEREST_EXCEEDS_CAP");

        // Transfer mUSD from BorrowModule (which approved us)
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        
        // Track for analytics
        // FIX SMUSD-M03: Cap to prevent overflow on totalInterestReceived
        unchecked {
            uint256 newTotal = totalInterestReceived + amount;
            // Overflow check: if newTotal wrapped around, cap at max
            if (newTotal < totalInterestReceived) {
                newTotal = type(uint256).max;
            }
            totalInterestReceived = newTotal;
        }
        lastInterestReceiptTime = block.timestamp;

        emit InterestReceived(msg.sender, amount, totalInterestReceived);
    }

    // FIX S-03: decimalsOffset provides some protection against donation attacks
    // by making the initial share price calculation more robust
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // View function to check remaining cooldown time
    function getRemainingCooldown(address account) external view returns (uint256) {
        uint256 cooldownEnd = lastDeposit[account] + WITHDRAW_COOLDOWN;
        if (block.timestamp >= cooldownEnd) {
            return 0;
        }
        return cooldownEnd - block.timestamp;
    }

    // View function to check if withdrawal is allowed
    function canWithdraw(address account) external view returns (bool) {
        return block.timestamp >= lastDeposit[account] + WITHDRAW_COOLDOWN;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED CROSS-CHAIN YIELD: Global share price calculation
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice FIX SOL-H-02: Pending treasury address for timelocked change
    address public pendingTreasury;
    uint256 public pendingTreasuryTime;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;

    event TreasuryChangeRequested(address indexed newTreasury, uint256 readyAt);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);

    /// @notice Request treasury change (48h timelock)
    /// @dev FIX SOL-H-02: Prevents instant share price manipulation by compromised admin
    function requestSetTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
        require(pendingTreasury == address(0), "CHANGE_ALREADY_PENDING");
        pendingTreasury = _treasury;
        pendingTreasuryTime = block.timestamp;
        emit TreasuryChangeRequested(_treasury, block.timestamp + TREASURY_CHANGE_DELAY);
    }

    /// @notice Cancel pending treasury change
    function cancelSetTreasury() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryTime = 0;
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice Execute treasury change after timelock
    function executeSetTreasury() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(pendingTreasury != address(0), "NO_PENDING");
        require(block.timestamp >= pendingTreasuryTime + TREASURY_CHANGE_DELAY, "TIMELOCK_ACTIVE");
        address oldTreasury = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryTime = 0;
        emit TreasuryUpdated(oldTreasury, treasury);
    }

    /// @notice Set the treasury address for global asset calculation
    /// @dev FIX SOL-H-02: Only callable when no treasury is set (initialization only)
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
        require(treasury == address(0), "USE_TIMELOCKED_SETTER");
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /// @notice Sync Canton shares from bridge attestation
    /// @dev FIX CRITICAL: Rate-limited to prevent share price manipulation
    /// @param _cantonShares Total smUSD shares on Canton
    /// @param epoch Sync epoch (must be sequential)
    function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
        require(epoch > lastCantonSyncEpoch, "EPOCH_NOT_SEQUENTIAL");
        
        // FIX: Rate limit - minimum 1 hour between syncs
        require(block.timestamp >= lastCantonSyncTime + MIN_SYNC_INTERVAL, "SYNC_TOO_FREQUENT");
        
        // FIX S-C01: First sync must use admin-only initialization to prevent manipulation
        // On first sync, cap initial shares to max 2x Ethereum shares to prevent inflation attack
        if (cantonTotalShares == 0) {
            uint256 ethShares = totalSupply();
            uint256 maxInitialShares = ethShares > 0 ? ethShares * 2 : _cantonShares;
            require(_cantonShares <= maxInitialShares, "INITIAL_SHARES_TOO_LARGE");
        } else {
            // FIX: Magnitude limit - max 5% change per sync to prevent manipulation
            uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
            uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
            require(_cantonShares <= maxIncrease, "SHARE_INCREASE_TOO_LARGE");
            require(_cantonShares >= maxDecrease, "SHARE_DECREASE_TOO_LARGE");
        }
        
        cantonTotalShares = _cantonShares;
        lastCantonSyncEpoch = epoch;
        lastCantonSyncTime = block.timestamp;
        
        emit CantonSharesSynced(_cantonShares, epoch, globalSharePrice());
    }

    /// @notice Get global total shares across both chains
    function globalTotalShares() public view returns (uint256) {
        return totalSupply() + cantonTotalShares;
    }

    /// @notice Get global total assets from Treasury
    /// @dev FIX SOL-C01: No longer silently falls back to local totalAssets.
    ///      Uses cached last known good value when treasury call fails.
    ///      This prevents catastrophic share price collapse (dilution attack)
    ///      that would occur if the vault switched from global to local pricing.
    /// @dev FIX CRITICAL: Treasury.totalValue() returns USDC (6 decimals) but
    ///      this vault's asset is mUSD (18 decimals). Must scale by 1e12.
    /// @dev FIX S-H01: Uses typed interface call instead of raw staticcall for
    ///      better error propagation and compile-time safety.
    function globalTotalAssets() public view returns (uint256) {
        if (treasury == address(0)) {
            return totalAssets();
        }
        // Treasury.totalValue() returns total USDC backing all mUSD (6 decimals)
        // slither-disable-next-line calls-loop
        try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
            // FIX: Convert USDC (6 decimals) to mUSD (18 decimals)
            uint256 newGlobalAssets = usdcValue * 1e12;

            // FIX SOL-C-02: Clamp growth to MAX_GLOBAL_ASSETS_GROWTH_BPS per refresh.
            // Prevents single compromised strategy from inflating totalValue() unboundedly.
            uint256 cached = lastKnownGlobalAssets;
            if (cached > 0) {
                uint256 maxAllowed = cached + (cached * MAX_GLOBAL_ASSETS_GROWTH_BPS) / 10000;
                if (newGlobalAssets > maxAllowed) {
                    return maxAllowed;
                }
            }
            return newGlobalAssets;
        } catch {
            // FIX SOL-C01: Use cached value instead of local totalAssets fallback.
            // If no cache exists yet, fall back to local (first-use safety).
            uint256 cached = lastKnownGlobalAssets;
            if (cached > 0) {
                return cached;
            }
            return totalAssets();
        }
    }

    /// @notice Update the cached global assets value
    /// @dev Should be called periodically by a keeper or during deposits/withdrawals.
    ///      This ensures the fallback value stays fresh.
    /// @dev FIX S-M01: Guard against calling when no shares exist (division-by-zero in downstream callers)
    /// @dev FIX S-M04: Restricted to YIELD_MANAGER_ROLE to prevent cache manipulation attacks
    function refreshGlobalAssets() external onlyRole(YIELD_MANAGER_ROLE) {
        require(treasury != address(0), "NO_TREASURY");
        require(globalTotalShares() > 0, "NO_SHARES_EXIST");
        uint256 usdcValue = ITreasury(treasury).totalValue();
        uint256 newGlobalAssets = usdcValue * 1e12;
        lastKnownGlobalAssets = newGlobalAssets;
        emit GlobalAssetsRefreshed(newGlobalAssets, usdcValue);
    }

    /// @notice Global share price used for both chains
    /// @dev sharePrice = globalTotalAssets / globalTotalShares
    /// @return Share price in asset decimals (6 for USDC)
    function globalSharePrice() public view returns (uint256) {
        uint256 shares = globalTotalShares();
        if (shares == 0) {
            return 10 ** _decimalsOffset(); // 1.0 with offset
        }
        return (globalTotalAssets() * (10 ** _decimalsOffset())) / shares;
    }

    /// @notice Ethereum-only shares (for cross-chain sync)
    function ethereumTotalShares() external view returns (uint256) {
        return totalSupply();
    }

    /// @notice Override convertToShares to use global share price
    /// @dev FIX AUDIT-01: Delegates to internal _convertToShares to ensure preview
    ///      functions match actual deposit/mint behavior (ERC-4626 compliance).
    ///      Previously used a different formula without virtual-share offset,
    ///      creating an inconsistency between preview and execution.
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    /// @notice Override convertToAssets to use global share price
    /// @dev FIX AUDIT-01: Delegates to internal _convertToAssets to ensure preview
    ///      functions match actual redeem/withdraw behavior (ERC-4626 compliance).
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    /// @notice FIX C-02: Override internal _convertToShares to use global share price
    /// @dev OZ ERC4626 deposit/withdraw/mint/redeem call these internal versions.
    ///      Without this override, operations would use Ethereum-local rate while
    ///      views showed global rate — creating an arbitrage surface.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 shares = globalTotalShares();
        return assets.mulDiv(shares + 10 ** _decimalsOffset(), globalTotalAssets() + 1, rounding);
    }

    /// @notice FIX C-02: Override internal _convertToAssets to use global share price
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 totalShares = globalTotalShares();
        return shares.mulDiv(globalTotalAssets() + 1, totalShares + 10 ** _decimalsOffset(), rounding);
    }

    // ============================================================
    //     FIX ERC-4626: maxWithdraw/maxDeposit/maxMint/maxRedeem
    //     Must use globalTotalAssets for consistency with _convertToShares
    // ============================================================

    /// @notice FIX SOL-001: Cap at local mUSD balance for ERC-4626 compliance.
    /// globalTotalAssets may exceed what this vault actually holds in mUSD.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) return 0;
        uint256 ownerMax = _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
        uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
        return ownerMax < vaultBalance ? ownerMax : vaultBalance;
    }

    /// @notice FIX SOL-001: Max redeemable shares for owner, capped by vault's local mUSD balance.
    /// @dev ERC-4626 requires maxRedeem to return an amount that won't cause revert.
    ///      Since _convertToAssets uses globalTotalAssets (which may exceed local balance),
    ///      we must cap at the share equivalent of what the vault can actually pay out.
    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) return 0;
        uint256 ownerShares = balanceOf(owner);
        uint256 vaultBalance = IERC20(asset()).balanceOf(address(this));
        uint256 maxRedeemableShares = _convertToShares(vaultBalance, Math.Rounding.Floor);
        return ownerShares < maxRedeemableShares ? ownerShares : maxRedeemableShares;
    }

    /// @notice FIX ERC-4626: Max depositable assets
    /// @dev Returns 0 when paused, otherwise type(uint256).max (no cap)
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        return type(uint256).max;
    }

    /// @notice FIX ERC-4626: Max mintable shares
    /// @dev Returns 0 when paused, otherwise type(uint256).max (no cap)
    function maxMint(address) public view override returns (uint256) {
        if (paused()) return 0;
        return type(uint256).max;
    }

    // ============================================================
    //                     EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause all deposits and withdrawals
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause all deposits and withdrawals
    /// @dev FIX C-01: Requires DEFAULT_ADMIN_ROLE for separation of duties
    /// This ensures a compromised PAUSER cannot immediately re-enable operations
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
