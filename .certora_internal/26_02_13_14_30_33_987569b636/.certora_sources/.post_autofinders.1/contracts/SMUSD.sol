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
import "./Errors.sol";

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

    constructor(IERC20 _musd) ERC4626(_musd) ERC20("Staked mUSD", "smUSD") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // Always set cooldown for receiver to prevent bypass via third-party deposit.
    // A depositor can always set their own cooldown, and depositing on behalf of someone
    // correctly locks the receiver's withdrawal window.
    function deposit(uint256 assets, address receiver) public override logInternal73(receiver)nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.deposit(assets, receiver);
    }modifier logInternal73(address receiver) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00490000, 1037618708553) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00490001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00490005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00496001, receiver) } _; }

    // Always set cooldown for receiver to prevent bypass via third-party mint.
    // Matches deposit() behavior — any path that increases shares must reset cooldown.
    function mint(uint256 shares, address receiver) public override logInternal66(receiver)nonReentrant whenNotPaused returns (uint256) {
        lastDeposit[receiver] = block.timestamp;
        emit CooldownUpdated(receiver, block.timestamp);
        return super.mint(shares, receiver);
    }modifier logInternal66(address receiver) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00420000, 1037618708546) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00420001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00420005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00426001, receiver) } _; }

    function withdraw(uint256 assets, address receiver, address owner) public override logInternal47(owner)nonReentrant whenNotPaused returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.withdraw(assets, receiver, owner);
    }modifier logInternal47(address owner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002f0000, 1037618708527) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002f0001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002f0005, 73) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002f6002, owner) } _; }

    // Override redeem to enforce cooldown
    function redeem(uint256 shares, address receiver, address owner) public override logInternal67(owner)nonReentrant whenNotPaused returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.redeem(shares, receiver, owner);
    }modifier logInternal67(address owner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00430000, 1037618708547) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00430001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00430005, 73) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00436002, owner) } _; }

    // Propagate cooldown on transfer to prevent bypass
    function _update(address from, address to, uint256 value) internal override {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00270000, 1037618708519) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00270001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00270005, 73) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00276002, value) }
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
        if (totalSupply() == 0) revert NoSharesExist();
        if (amount == 0) revert InvalidAmount();
        
        // Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000001,currentAssets)}
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000002,maxYield)}
        if (amount > maxYield) revert YieldExceedsCap();

        // Use safeTransferFrom
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);

        emit YieldDistributed(msg.sender, amount);
    }

    /// @notice Receive interest payments from BorrowModule
    /// @dev Called by BorrowModule to route borrower interest to suppliers
    /// @param amount The amount of mUSD interest to receive
    function receiveInterest(uint256 amount) external onlyRole(INTEREST_ROUTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (globalTotalShares() == 0) revert NoSharesExist();
        
        // Use globalTotalAssets() for the cap, not local totalAssets().
        // The vault serves both Ethereum and Canton shareholders, so the cap
        // should reflect the total asset base.
        uint256 currentAssets = globalTotalAssets();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000003,currentAssets)}
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000004,maxInterest)}
        if (amount > maxInterest) revert InterestExceedsCap();

        // Transfer mUSD from BorrowModule (which approved us)
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        
        // Track for analytics
        totalInterestReceived += amount;
        lastInterestReceiptTime = block.timestamp;

        emit InterestReceived(msg.sender, amount, totalInterestReceived);
    }

    // decimalsOffset provides some protection against donation attacks
    // by making the initial share price calculation more robust
    function _decimalsOffset() internal pure override returns (uint8) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00280000, 1037618708520) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00280001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00280004, 0) }
        return 3;
    }

    // View function to check remaining cooldown time
    function getRemainingCooldown(address account) external view returns (uint256) {
        uint256 cooldownEnd = lastDeposit[account] + WITHDRAW_COOLDOWN;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000005,cooldownEnd)}
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
        if (_treasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000006,oldTreasury)}
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /// @notice Sync Canton shares from bridge attestation
    /// @dev Rate-limited to prevent share price manipulation
    /// @param _cantonShares Total smUSD shares on Canton
    /// @param epoch Sync epoch (must be sequential)
    function syncCantonShares(uint256 _cantonShares, uint256 epoch) external onlyRole(BRIDGE_ROLE) {
        if (epoch <= lastCantonSyncEpoch) revert EpochNotSequential();
        
        // Rate limit — minimum 1 hour between syncs
        if (block.timestamp < lastCantonSyncTime + MIN_SYNC_INTERVAL) revert SyncTooFrequent();
        
        // First sync must use admin-only initialization to prevent manipulation
        // On first sync, cap initial shares to max 2x Ethereum shares to prevent inflation attack
        if (cantonTotalShares == 0) {
            uint256 ethShares = totalSupply();
            uint256 maxInitialShares = ethShares > 0 ? ethShares * 2 : _cantonShares;
            if (_cantonShares > maxInitialShares) revert InitialSharesTooLarge();
        } else {
            // Magnitude limit — max 5% change per sync to prevent manipulation
            uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000008,maxIncrease)}
            uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000009,maxDecrease)}
            if (_cantonShares > maxIncrease) revert ShareIncreaseTooLarge();
            if (_cantonShares < maxDecrease) revert ShareDecreaseTooLarge();
        }
        
        cantonTotalShares = _cantonShares;
        lastCantonSyncEpoch = epoch;
        lastCantonSyncTime = block.timestamp;
        
        emit CantonSharesSynced(_cantonShares, epoch, globalSharePrice());
    }

    /// @notice Get global total shares across both chains
    function globalTotalShares() public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00410000, 1037618708545) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00410001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00410004, 0) }
        return totalSupply() + cantonTotalShares;
    }

    /// @notice Get global total assets from Treasury
    /// @dev Falls back to local totalAssets if treasury not set
    /// @dev Treasury.totalValue() returns USDC (6 decimals) but
    ///      this vault's asset is mUSD (18 decimals). Must scale by 1e12.
    ///      Uses typed interface call for better error propagation and compile-time safety.
    function globalTotalAssets() public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00400000, 1037618708544) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00400001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00400004, 0) }
        if (treasury == address(0)) {
            return totalAssets();
        }
        // Treasury.totalValue() returns total USDC backing all mUSD (6 decimals)
        // slither-disable-next-line calls-loop
        try ITreasury(treasury).totalValue() returns (uint256 usdcValue) {
            // Convert USDC (6 decimals) to mUSD (18 decimals)
            return usdcValue * 1e12;
        } catch {
            // SOL-C-05: Fallback to local assets if Treasury call fails.
            // Cannot emit events in a view function — monitoring should detect
            // divergence between globalTotalAssets() and Treasury.totalValue()
            // off-chain by comparing both values periodically.
            return totalAssets();
        }
    }

    /// @notice Global share price used for both chains
    /// @dev sharePrice = globalTotalAssets / globalTotalShares
    /// @return Share price in asset decimals (6 for USDC)
    function globalSharePrice() public view returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff003f0000, 1037618708543) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff003f0001, 0) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff003f0004, 0) }
        uint256 shares = globalTotalShares();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000007,shares)}
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
    function convertToShares(uint256 assets) public view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002e0000, 1037618708526) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002e0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002e0005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002e6000, assets) }
        return super.convertToShares(assets);
    }

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: previewed asset value must be redeemable from this vault.
    function convertToAssets(uint256 shares) public view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00390000, 1037618708537) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00390001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00390005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00396000, shares) }
        return super.convertToAssets(shares);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    /// @dev Do not use global Treasury TVL for execution-path conversions.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00290000, 1037618708521) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00290001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00290005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00296001, rounding) }
        return super._convertToShares(assets, rounding);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a0000, 1037618708522) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a0005, 9) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff002a6001, rounding) }
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
    function maxWithdraw(address owner) public view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00340000, 1037618708532) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00340001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00340005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00346000, owner) }
        if (paused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxWithdraw(owner);
    }

    /// @notice Maximum shares owner can redeem
    /// @dev Returns 0 when paused or cooldown is active (ERC-4626 compliance)
    function maxRedeem(address owner) public view override returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff004d0000, 1037618708557) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff004d0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff004d0005, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff004d6000, owner) }
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
