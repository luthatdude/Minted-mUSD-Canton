// SPDX-License-Identifier: MIT
// BLE Protocol — ERC-4626 Yield Vault with Unified Cross-Chain Share Price
// Security: Cooldown enforcement, donation attack mitigation, SafeERC20, ReentrancyGuard
// Feature: Unified share price across Ethereum and Canton for equal yield distribution

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

    bytes32 public constant YIELD_MANAGER_ROLE = keccak256("YIELD_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant INTEREST_ROUTER_ROLE = keccak256("INTEREST_ROUTER_ROLE");

    mapping(address => uint256) public lastDeposit;
    uint256 public constant WITHDRAW_COOLDOWN = 24 hours;
    
    // Maximum yield per distribution (10% of total assets) to prevent excessive dilution
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
    // Rate limiting for Canton share sync to prevent manipulation
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

    // Events
    event YieldDistributed(address indexed from, uint256 amount);
    event CooldownUpdated(address indexed account, uint256 timestamp);
    event CantonSharesSynced(uint256 cantonShares, uint256 epoch, uint256 globalSharePrice);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event InterestReceived(address indexed from, uint256 amount, uint256 totalReceived);
    /// @notice FIX SOL-C-05: Emitted when Treasury call fails and globalTotalAssets falls back to local
    event TreasuryFallbackTriggered(uint256 localAssets);

    constructor(IERC20 _musd) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // Always set cooldown for receiver to prevent bypass via third-party deposit.
    // A depositor can always set their own cooldown, and depositing on behalf of someone
    // correctly locks the receiver's withdrawal window.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    // Always set cooldown for receiver to prevent bypass via third-party mint.
    // Matches deposit() behavior — any path that increases shares must reset cooldown.
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.withdraw(assets, receiver, owner);
    }

    // Override redeem to enforce cooldown
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        require(block.timestamp >= lastDeposit[owner] + WITHDRAW_COOLDOWN, "COOLDOWN_ACTIVE");
        return super.redeem(shares, receiver, owner);
    }

    // Propagate cooldown on transfer to prevent bypass
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

    // Use SafeERC20 for token transfers with maximum yield cap to prevent excessive dilution
    function distributeYield(uint256 amount) external onlyRole(YIELD_MANAGER_ROLE) {
        require(totalSupply() > 0, "NO_SHARES_EXIST");
        require(amount > 0, "INVALID_AMOUNT");
        
        // Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxYield, "YIELD_EXCEEDS_CAP");

        // Use safeTransferFrom
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit YieldDistributed(msg.sender, amount);
    }

    /// @notice Receive interest payments from BorrowModule
    /// @dev Called by BorrowModule to route borrower interest to suppliers
    /// @param amount The amount of mUSD interest to receive
    function receiveInterest(uint256 amount) external onlyRole(INTEREST_ROUTER_ROLE) {
        require(amount > 0, "ZERO_AMOUNT");
        require(globalTotalShares() > 0, "NO_SHARES_EXIST");
        
        // Use globalTotalAssets() for the cap, not local totalAssets().
        // The vault serves both Ethereum and Canton shareholders, so the cap
        // should reflect the total asset base.
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

    // decimalsOffset provides some protection against donation attacks
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
        
        // First sync must use admin-only initialization to prevent manipulation
        // On first sync, cap initial shares to max 2x Ethereum shares to prevent inflation attack
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
    /// @dev Falls back to local totalAssets if treasury not set
    /// @dev Treasury.totalValue() returns USDC (6 decimals) but
    ///      this vault's asset is mUSD (18 decimals). Must scale by 1e12.
    ///      Uses typed interface call for better error propagation and compile-time safety.
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
            // FIX SOL-C-05: Emit event so monitoring detects degraded state
            uint256 local = totalAssets();
            emit TreasuryFallbackTriggered(local);
            return local;
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

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: redemptions are paid from local vault liquidity, so preview
    ///      and execution must be based on local totalAssets/totalSupply.
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return super.convertToShares(assets);
    }

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: previewed asset value must be redeemable from this vault.
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return super.convertToAssets(shares);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    /// @dev Do not use global Treasury TVL for execution-path conversions.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToShares(assets, rounding);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToAssets(shares, rounding);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-4626 compliance — maxWithdraw/maxRedeem must return 0
    // when withdraw/redeem would revert (paused or cooldown active).
    // EIP-4626 §maxWithdraw: "MUST return the maximum amount … that would
    // not cause a revert"
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Maximum assets owner can withdraw
    /// @dev Returns 0 when paused or cooldown is active (ERC-4626 compliance)
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxWithdraw(owner);
    }

    /// @notice Maximum shares owner can redeem
    /// @dev Returns 0 when paused or cooldown is active (ERC-4626 compliance)
    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxRedeem(owner);
    }

    // ============================================================
    //                     EMERGENCY CONTROLS
    // ============================================================

    /// @notice Pause all deposits and withdrawals
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause all deposits and withdrawals
    /// @dev Requires DEFAULT_ADMIN_ROLE for separation of duties.
    /// This ensures a compromised PAUSER cannot immediately re-enable operations
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
