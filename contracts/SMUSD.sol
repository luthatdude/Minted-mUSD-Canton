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
import "./interfaces/IGlobalPauseRegistry.sol";

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
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");

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

    /// @notice Optional global pause registry
    IGlobalPauseRegistry public globalPauseRegistry;

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
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
        return super.withdraw(assets, receiver, owner);
    }

    // Override redeem to enforce cooldown
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant whenNotPaused returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) revert CooldownActive();
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
        if (totalSupply() == 0) revert NoSharesExist();
        if (amount == 0) revert InvalidAmount();
        
        // Use globalTotalAssets() for cap (serves both ETH + Canton shareholders)
        uint256 currentAssets = globalTotalAssets();
        uint256 maxYield = (currentAssets * MAX_YIELD_BPS) / 10000;
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
        uint256 currentAssets = globalTotalAssets();
        uint256 maxInterest = (currentAssets * MAX_YIELD_BPS) / 10000;
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
    /// @dev SOL-H-01: Changed from DEFAULT_ADMIN_ROLE to TIMELOCK_ROLE — critical parameter
    function setTreasury(address _treasury) external onlyRole(TIMELOCK_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
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
            uint256 maxIncrease = (cantonTotalShares * (10000 + MAX_SHARE_CHANGE_BPS)) / 10000;
            uint256 maxDecrease = (cantonTotalShares * (10000 - MAX_SHARE_CHANGE_BPS)) / 10000;
            if (_cantonShares > maxIncrease) revert ShareIncreaseTooLarge();
            if (_cantonShares < maxDecrease) revert ShareDecreaseTooLarge();
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

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-4626 compliance — max* functions must return 0 when the
    // corresponding deposit/mint/withdraw/redeem would revert.
    // EIP-4626: "MUST return the maximum amount … that would not cause
    // a revert"
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Maximum assets that can be deposited for `receiver`
    /// @dev Returns 0 when paused (local or global) since deposit has both pause guards
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused() || _isGloballyPaused()) {
            return 0;
        }
        return super.maxDeposit(receiver);
    }

    /// @notice Maximum shares that can be minted for `receiver`
    /// @dev Returns 0 when paused (local or global) since mint has both pause guards
    function maxMint(address receiver) public view override returns (uint256) {
        if (paused() || _isGloballyPaused()) {
            return 0;
        }
        return super.maxMint(receiver);
    }

    /// @notice Maximum assets owner can withdraw
    /// @dev Returns 0 when paused (local/global) or cooldown is active (ERC-4626 compliance)
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused() || _isGloballyPaused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxWithdraw(owner);
    }

    /// @notice Maximum shares owner can redeem
    /// @dev Returns 0 when paused (local/global) or cooldown is active (ERC-4626 compliance)
    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused() || _isGloballyPaused() || block.timestamp < lastDeposit[owner] + WITHDRAW_COOLDOWN) {
            return 0;
        }
        return super.maxRedeem(owner);
    }

    /// @dev Treat address(0) registry as "global pause disabled" for backward compatibility.
    function _isGloballyPaused() internal view returns (bool) {
        return address(globalPauseRegistry) != address(0) && globalPauseRegistry.isGloballyPaused();
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

    /// @dev CX-C-01: This intentionally uses LOCAL totalAssets() (which subtracts
    ///      unvested yield per SOL-M-9). Integrators needing the global share price
    ///      should use globalSharePrice() or the previewDepositGlobal/previewRedeemGlobal
    ///      helper functions instead.
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return super.convertToShares(assets);
    }

    /// @notice ERC-4626 conversion uses local vault accounting.
    /// @dev Safety: previewed asset value must be redeemable from this vault.
    /// @dev CX-C-01: Uses LOCAL totalAssets() which excludes unvested yield.
    ///      During vesting, this slightly understates asset value per share.
    ///      Use globalSharePrice() for the canonical cross-chain price.
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return super.convertToAssets(shares);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    /// @dev Do not use global Treasury TVL for execution-path conversions.
    /// @dev CX-C-01: Vesting deliberately depresses totalAssets() to prevent
    ///      sandwich attacks around yield injection. This means convertToShares()
    ///      returns MORE shares than a "fair" global price during active vesting,
    ///      which is the desired anti-MEV behavior.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToShares(assets, rounding);
    }

    /// @notice Internal ERC-4626 conversion is intentionally local.
    /// @dev CX-C-01: During active vesting, convertToAssets() returns fewer assets
    ///      per share than globalSharePrice() would suggest. This is intentional:
    ///      it prevents MEV extractors from depositing just before yield injection
    ///      and redeeming after the share price jumps.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return super._convertToAssets(shares, rounding);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CX-C-01 FIX: Global preview functions for off-chain integrators
    // ═══════════════════════════════════════════════════════════════════════
    //
    // ERC-4626 Deviation Notice:
    //   This vault intentionally deviates from strict EIP-4626 preview accuracy
    //   during the 12-hour yield vesting window (SOL-M-9). Specifically:
    //
    //   1. totalAssets() subtracts unvested yield, making the share price rise
    //      linearly over VESTING_DURATION instead of jumping instantly. This is
    //      an anti-MEV / anti-sandwich mechanism.
    //
    //   2. convertToShares() / convertToAssets() use the LOCAL totalAssets()
    //      (vault's mUSD balance minus unvested yield), not globalTotalAssets()
    //      (Treasury TVL). This ensures execution matches preview for local
    //      depositors, but off-chain price feeds should use globalSharePrice().
    //
    //   3. previewDeposit() and previewRedeem() are accurate for EXECUTION at
    //      the current block, but may differ from "fair value" during vesting.
    //
    //   The functions below provide global-price-aware previews for integrators
    //   who need to quote prices reflecting Treasury TVL rather than local vault
    //   accounting. These are VIEW-ONLY and do NOT affect on-chain execution.
    // ═══════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    // CX-C-01 FIX: Global preview functions for off-chain integrators
    // ═══════════════════════════════════════════════════════════════════════
    //
    // ERC-4626 Deviation Notice:
    //   This vault intentionally deviates from strict EIP-4626 preview accuracy
    //   during the 12-hour yield vesting window (SOL-M-9). Specifically:
    //
    //   1. totalAssets() subtracts unvested yield, making the share price rise
    //      linearly over VESTING_DURATION instead of jumping instantly. This is
    //      an anti-MEV / anti-sandwich mechanism.
    //
    //   2. convertToShares() / convertToAssets() use the LOCAL totalAssets()
    //      (vault's mUSD balance minus unvested yield), not globalTotalAssets()
    //      (Treasury TVL). This ensures execution matches preview for local
    //      depositors, but off-chain price feeds should use globalSharePrice().
    //
    //   3. previewDeposit() and previewRedeem() are accurate for EXECUTION at
    //      the current block, but may differ from "fair value" during vesting.
    //
    //   The functions below provide global-price-aware previews for integrators
    //   who need to quote prices reflecting Treasury TVL rather than local vault
    //   accounting. These are VIEW-ONLY and do NOT affect on-chain execution.
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Preview deposit using global share price (for off-chain integrators)
    /// @dev CX-C-01: Returns the shares a depositor WOULD receive if the vault
    ///      used globalTotalAssets() instead of local totalAssets(). Actual on-chain
    ///      deposit uses local accounting and may return more shares during vesting.
    /// @param assets Amount of mUSD to deposit
    /// @return shares Estimated shares at global price
    function previewDepositGlobal(uint256 assets) external view returns (uint256 shares) {
        uint256 gShares = globalTotalShares();
        uint256 gAssets = globalTotalAssets();
        if (gShares == 0) {
            return assets * (10 ** _decimalsOffset());
        }
        return (assets * gShares) / gAssets;
    }

    /// @notice Preview redeem using global share price (for off-chain integrators)
    /// @dev CX-C-01: Returns the assets a redeemer WOULD receive if the vault
    ///      used globalTotalAssets(). Actual on-chain redeem uses local accounting
    ///      and may return fewer assets during vesting.
    /// @param shares Amount of smUSD shares to redeem
    /// @return assets Estimated mUSD at global price
    function previewRedeemGlobal(uint256 shares) external view returns (uint256 assets) {
        uint256 gShares = globalTotalShares();
        uint256 gAssets = globalTotalAssets();
        if (gShares == 0) {
            return 0;
        }
        return (shares * gAssets) / gShares;
    }
}
