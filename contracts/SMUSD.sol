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

contract SMUSD is ERC4626, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

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

    // FIX S-H01: Always set cooldown for receiver to prevent bypass via third-party deposit.
    // A depositor can always set their own cooldown, and depositing on behalf of someone
    // correctly locks the receiver's withdrawal window.
    // FIX: Added nonReentrant and whenNotPaused for security
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }

    // FIX S-H01: Always set cooldown for receiver to prevent bypass via third-party mint.
    // Matches deposit() behavior — any path that increases shares must reset cooldown.
    // FIX: Added nonReentrant and whenNotPaused for security
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
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
        
        // FIX M-3: Cap yield distribution to prevent excessive dilution
        uint256 currentAssets = totalAssets();
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
        
        // Cap interest to 10% of current assets per call (same as yield cap)
        uint256 currentAssets = totalAssets();
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;
        require(amount <= maxInterest, "INTEREST_EXCEEDS_CAP");

        // Transfer mUSD from BorrowModule (which approved us)
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        
        // Track for analytics
        totalInterestReceived += amount;
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

    /// @notice Set the treasury address for global asset calculation
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "ZERO_ADDRESS");
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
        
        // FIX: Magnitude limit - max 5% change per sync to prevent manipulation
        if (cantonTotalShares > 0) {
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
    function globalTotalAssets() public view returns (uint256) {
        if (treasury == address(0)) {
            return totalAssets();
        }
        // Treasury.totalValue() returns total USDC backing all mUSD
        // slither-disable-next-line calls-loop
        (bool success, bytes memory data) = treasury.staticcall(
            abi.encodeWithSignature("totalValue()")
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return totalAssets();
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
    function convertToShares(uint256 assets) public view override returns (uint256) {
        uint256 shares = globalTotalShares();
        if (shares == 0) {
            return assets * (10 ** _decimalsOffset());
        }
        return (assets * shares) / globalTotalAssets();
    }

    /// @notice Override convertToAssets to use global share price
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        uint256 totalShares = globalTotalShares();
        if (totalShares == 0) {
            return shares / (10 ** _decimalsOffset());
        }
        return (shares * globalTotalAssets()) / totalShares;
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
