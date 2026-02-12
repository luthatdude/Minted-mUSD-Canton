// SPDX-License-Identifier: BUSL-1.1
// BLE Protocol - Staked mUSD with Unified Cross-Chain Yield
// Unified share price across Ethereum and Canton for equal yield distribution

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Typed interface for Treasury calls
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
    
    // Maximum yield per distribution (10% of total assets) to prevent excessive dilution
    uint256 public constant MAX_YIELD_BPS = 1000;

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
    // Rate limiting for Canton share sync to prevent manipulation
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Last Canton sync timestamp
    uint256 public lastCantonSyncTime;
    
    /// @notice Minimum interval between syncs (1 hour)
    uint256 public constant MIN_SYNC_INTERVAL = 1 hours;
    
    /// @notice Maximum share change per sync (5% = 500 bps)
    uint256 public constant MAX_SHARE_CHANGE_BPS = 500;

    // ═══════════════════════════════════════════════════════════════════════
    // FIX C-02: 24h rolling window to prevent compounding manipulation
    // Without this cap, ±5% per sync × 24 syncs/day = 1.05^24 ≈ 3.22x inflation
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Baseline share count at start of current 24h window
    uint256 public cantonSharesBaseline;

    /// @notice Timestamp when current 24h baseline was set
    uint256 public cantonSharesBaselineTime;

    /// @notice Maximum cumulative deviation from baseline over 24h (20% = 2000 bps)
    uint256 public constant MAX_DAILY_CUMULATIVE_CHANGE_BPS = 2000;

    // ═══════════════════════════════════════════════════════════════════════
    // INTEREST ROUTING: Track interest from BorrowModule
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice Total interest received from borrowers
    uint256 public totalInterestReceived;
    
    /// @notice Last interest receipt timestamp
    uint256 public lastInterestReceiptTime;

    // Events
    event YieldDistributed(address indexed from, uint256 amount);
    event CooldownUpdated(address indexed account, uint256 timestamp);
    event CantonSharesSynced(uint256 cantonShares, uint256 epoch, uint256 globalSharePrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event InterestReceived(address indexed from, uint256 amount, uint256 totalReceived);

    constructor(IERC20 _musd) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /// @notice Deposit assets and reset receiver cooldown
    /// @dev Always sets cooldown for receiver to prevent bypass via third-party deposit.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    /// @notice Mint shares and reset receiver cooldown
    /// @dev Matches deposit() — any path that increases shares must reset cooldown.
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.withdraw(assets, receiver, owner);
    }

    /// @notice Redeem shares with cooldown enforcement
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.redeem(shares, receiver, owner);
    }

    /// @dev Propagate cooldown on transfer to prevent bypass via share movement
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

    /// @notice Distribute yield to shareholders with dilution cap
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        require(totalSupply() > 0, "NO_SHARES_EXIST");
        require(amount > 0, "INVALID_AMOUNT");
        
        // Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxYield, "YIELD_EXCEEDS_CAP");

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit YieldDistributed(msg.sender, amount);
    }

    /// @notice Receive interest payments from BorrowModule
    /// @dev Called by BorrowModule to route borrower interest to suppliers
    /// @param amount The amount of mUSD interest to receive
    function receiveInterest(uint256 amount) external onlyRole(INTEREST_ROUTER_ROLE) {
        require(amount > 0, "ZERO_AMOUNT");
        require(globalTotalShares() > 0, "NO_SHARES_EXIST");
        
        // Use globalTotalAssets() for the cap — the vault serves both Ethereum and Canton
        // shareholders, so the cap must reflect the full asset base.
        uint256 currentAssets = globalTotalAssets();
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxInterest, "INTEREST_EXCEEDS_CAP");

        // Transfer mUSD from BorrowModule (which approved us)
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        
        // Track for analytics
        totalInterestReceived += amount;
        lastInterestReceiptTime = block.timestamp;

        emit InterestReceived(msg.sender, amount, totalInterestReceived);
    }

    /// @dev decimalsOffset mitigates donation attacks on initial share price
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

    /// @notice Set the treasury address for global asset calculation
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /// @notice Sync Canton shares from bridge attestation
    /// @dev Rate-limited to prevent share price manipulation
    /// @param _cantonShares Total smUSD shares on Canton
    /// @param epoch Sync epoch (must be sequential)
    function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
        require(epoch > lastCantonSyncEpoch, "EPOCH_NOT_SEQUENTIAL");
        
        // Rate limit — minimum 1 hour between syncs
        require(block.timestamp >= lastCantonSyncTime + MIN_SYNC_INTERVAL, "SYNC_TOO_FREQUENT");
        
        // First sync: cap initial shares to max 2x Ethereum shares to prevent inflation attack
        if (cantonTotalShares == 0) {
            uint256 ethShares = totalSupply();
            uint256 maxInitialShares = ethShares > 0 ? ethShares * 2 : _cantonShares;
            require(_cantonShares <= maxInitialShares, "INITIAL_SHARES_TOO_LARGE");
        } else {
            // Magnitude limit — max 5% change per sync to prevent manipulation
            uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
            uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
            require(_cantonShares <= maxIncrease, "SHARE_INCREASE_TOO_LARGE");
            require(_cantonShares >= maxDecrease, "SHARE_DECREASE_TOO_LARGE");
        }

        // FIX C-02: 24h cumulative deviation cap
        // Resets baseline every 24h; within window, total change from baseline ≤ 20%
        // This prevents compounding: even if each sync is ≤5%, cumulative drift is bounded
        if (cantonSharesBaseline == 0 || block.timestamp >= cantonSharesBaselineTime + 24 hours) {
            cantonSharesBaseline = cantonTotalShares > 0 ? cantonTotalShares : _cantonShares;
            cantonSharesBaselineTime = block.timestamp;
        }
        if (cantonSharesBaseline > 0) {
            uint256 maxCumulative = (cantonSharesBaseline * (10000 + MAX_DAILY_CUMULATIVE_CHANGE_BPS)) / 10000;
            uint256 minCumulative = (cantonSharesBaseline * (10000 - MAX_DAILY_CUMULATIVE_CHANGE_BPS)) / 10000;
            require(_cantonShares <= maxCumulative, "DAILY_CUMULATIVE_INCREASE_EXCEEDED");
            require(_cantonShares >= minCumulative, "DAILY_CUMULATIVE_DECREASE_EXCEEDED");
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
    /// @dev Falls back to local totalAssets if treasury not set.
    ///      Treasury.totalValue() returns USDC (6 decimals); scaled by 1e12
    ///      to match mUSD (18 decimals).
    function globalTotalAssets() public view returns (uint256) {
        if (treasury == address(0)) {
            return totalAssets();
        }
        // Treasury.totalValue() returns total USDC backing all mUSD (6 decimals)
        // slither-disable-next-line calls-loop
        try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
            // Convert USDC (6 decimals) to mUSD (18 decimals)
            return usdcValue * 1e12;
        } catch {
            // If Canton shares exist but Treasury is unreachable, share price would be
            // catastrophically deflated (denominator includes Canton shares, numerator doesn't).
            // Revert to prevent exploitable arbitrage during this degraded state.
            if (cantonTotalShares > 0) {
                revert("TREASURY_UNREACHABLE");
            }
            // No Canton shares — safe to use local totalAssets as sole pricing source
            return totalAssets();
        }
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
    /// @dev Delegates to internal _convertToShares to ensure preview functions
    ///      match actual deposit/mint behavior (ERC-4626 compliance).
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    /// @notice Override convertToAssets to use global share price
    /// @dev Delegates to internal _convertToAssets for ERC-4626 compliance.
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    /// @notice Override internal _convertToShares to use global share price
    /// @dev OZ ERC4626 deposit/withdraw/mint/redeem call these internal versions.
    ///      Without this override, operations would use Ethereum-local rate while
    ///      views showed global rate — creating an arbitrage surface.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 shares = globalTotalShares();
        return assets.mulDiv(shares + 10 ** _decimalsOffset(), globalTotalAssets() + 1, rounding);
    }

    /// @notice Override internal _convertToAssets to use global share price
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 totalShares = globalTotalShares();
        return shares.mulDiv(globalTotalAssets() + 1, totalShares + 10 ** _decimalsOffset(), rounding);
    }

    /// @notice Override totalAssets to return globalTotalAssets for ERC-4626 compliance.
    /// @dev    ERC-4626 requires totalAssets() to reflect all managed assets.
    ///         This vault serves both Ethereum and Canton shareholders, so the
    ///         canonical value is globalTotalAssets().
    function totalAssets() public view override returns (uint256) {
        return globalTotalAssets();
    }

    // ============================================================
    //                     EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause all deposits and withdrawals
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause all deposits and withdrawals
    /// @dev Requires DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
