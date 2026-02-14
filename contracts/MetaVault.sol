// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IStrategy.sol";
import "./TimelockGoverned.sol";
import "./Errors.sol";

/**
 * @title MetaVault
 * @notice Vault-of-vaults that aggregates multiple strategies with target proportions
 * @dev Inspired by Stability DAO's MetaVault pattern. Manages a portfolio of
 *      IStrategy implementations with automatic rebalancing to target allocations.
 *
 *      KEY FEATURES:
 *      - Multiple strategy support with BPS-based target allocations
 *      - Auto-rebalance to maintain target proportions
 *      - Share-based accounting for accurate value tracking
 *      - Performance fee accrual via high-water mark
 *      - Emergency withdrawal from any/all strategies
 *      - Implements IStrategy so it can be plugged into TreasuryV2
 *        as a composable vault-of-vaults
 */
contract MetaVault is
    IStrategy,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    TimelockGoverned
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    uint256 public constant BPS = 10_000;
    uint256 public constant WAD = 1e18;
    uint256 public constant MAX_VAULTS = 10;
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 5000; // 50%
    uint256 public constant MIN_REBALANCE_THRESHOLD_BPS = 50; // 0.5%

    // ═══════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════

    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// @notice TREASURY_ROLE for IStrategy interface — TreasuryV2 calls deposit/withdraw
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    // ═══════════════════════════════════════════
    // TYPES
    // ═══════════════════════════════════════════

    struct VaultConfig {
        address strategy;     // IStrategy address
        uint256 targetBps;    // Target allocation in BPS
        bool active;          // Whether vault accepts deposits
    }

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    /// @notice The underlying asset (USDC)
    IERC20 public underlyingAsset;

    /// @notice Array of managed vaults/strategies
    VaultConfig[] public vaults;

    /// @notice Total shares outstanding (virtual, for share price tracking)
    uint256 public totalShares;

    /// @notice High-water mark for performance fee calculation
    uint256 public highWaterMark;

    /// @notice Performance fee in basis points
    uint256 public performanceFeeBps;

    /// @notice Accrued performance fees (in USDC)
    uint256 public accruedFees;

    /// @notice Fee recipient address
    address public feeRecipient;

    /// @notice Rebalance threshold — rebalance when drift exceeds this
    uint256 public rebalanceThresholdBps;

    /// @notice Whether to auto-allocate on deposit
    bool public autoAllocateEnabled;

    /// @notice Whether MetaVault is active as an IStrategy for TreasuryV2
    bool public strategyActive;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event VaultAdded(address indexed strategy, uint256 targetBps);
    event VaultRemoved(address indexed strategy);
    event VaultUpdated(address indexed strategy, uint256 newTargetBps, bool active);
    event Deposited(address indexed from, uint256 amount, uint256 sharesIssued);
    event Withdrawn(address indexed to, uint256 amount, uint256 sharesBurned);
    event Rebalanced(uint256 totalValue, uint256 vaultsAdjusted);
    event FeesAccrued(uint256 newFees, uint256 totalAccrued);
    event FeesCollected(address indexed recipient, uint256 amount);
    event EmergencyWithdrawn(address indexed strategy, uint256 amount);

    // ═══════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════

    error TooManyVaults();
    error VaultNotFound();
    error VaultAlreadyExists();
    error AllocationExceedsBPS();
    error InsufficientShares();
    error InvalidFee();
    error InvalidRebalanceThreshold();
    error NoFeesToCollect();

    // ═══════════════════════════════════════════
    // CONSTRUCTOR & INITIALIZER
    // ═══════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _asset,
        address _feeRecipient,
        address _admin,
        address _timelock
    ) external initializer {
        if (_asset == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        _setTimelock(_timelock);

        underlyingAsset = IERC20(_asset);
        feeRecipient = _feeRecipient;
        performanceFeeBps = 2000; // 20% default
        rebalanceThresholdBps = 200; // 2% drift threshold
        autoAllocateEnabled = true;
        strategyActive = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(DEPOSITOR_ROLE, _admin);
        _grantRole(ALLOCATOR_ROLE, _admin);
        _grantRole(STRATEGIST_ROLE, _admin);
        _grantRole(GUARDIAN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
        _grantRole(TREASURY_ROLE, _admin);
    }

    // ═══════════════════════════════════════════
    // VAULT MANAGEMENT
    // ═══════════════════════════════════════════

    function addVault(
        address _strategy,
        uint256 _targetBps
    ) external onlyRole(STRATEGIST_ROLE) {
        if (vaults.length >= MAX_VAULTS) revert TooManyVaults();

        // Check no duplicates
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i].strategy == _strategy) revert VaultAlreadyExists();
        }

        // Validate total allocation doesn't exceed BPS
        uint256 totalTarget = _targetBps;
        for (uint256 i = 0; i < vaults.length; i++) {
            totalTarget += vaults[i].targetBps;
        }
        if (totalTarget > BPS) revert AllocationExceedsBPS();

        vaults.push(VaultConfig({
            strategy: _strategy,
            targetBps: _targetBps,
            active: true
        }));

        // Approve strategy to pull USDC
        underlyingAsset.forceApprove(_strategy, type(uint256).max);

        emit VaultAdded(_strategy, _targetBps);
    }

    function removeVault(address _strategy) external onlyRole(STRATEGIST_ROLE) {
        uint256 len = vaults.length;
        for (uint256 i = 0; i < len; i++) {
            if (vaults[i].strategy == _strategy) {
                // Withdraw everything from the strategy first
                try IStrategy(_strategy).withdrawAll() returns (uint256) {} catch {}

                // Revoke approval
                underlyingAsset.forceApprove(_strategy, 0);

                // Swap with last and pop
                vaults[i] = vaults[len - 1];
                vaults.pop();

                emit VaultRemoved(_strategy);
                return;
            }
        }
        revert VaultNotFound();
    }

    function updateVault(
        address _strategy,
        uint256 _newTargetBps,
        bool _active
    ) external onlyRole(STRATEGIST_ROLE) {
        uint256 totalTarget = 0;
        bool found = false;

        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i].strategy == _strategy) {
                vaults[i].targetBps = _newTargetBps;
                vaults[i].active = _active;
                totalTarget += _newTargetBps;
                found = true;
            } else {
                totalTarget += vaults[i].targetBps;
            }
        }

        if (!found) revert VaultNotFound();
        if (totalTarget > BPS) revert AllocationExceedsBPS();

        emit VaultUpdated(_strategy, _newTargetBps, _active);
    }

    // ═══════════════════════════════════════════
    // IStrategy IMPLEMENTATION (TreasuryV2 interface)
    // ═══════════════════════════════════════════

    /**
     * @notice IStrategy.deposit — Accept USDC from TreasuryV2
     * @param amount Amount of USDC to deposit (6 decimals)
     * @return deposited Actual USDC deposited
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

        _accrueFees();

        uint256 currentValue = totalValue();
        uint256 sharesIssued;
        if (totalShares == 0 || currentValue == 0) {
            sharesIssued = amount;
        } else {
            sharesIssued = (amount * totalShares) / currentValue;
        }

        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
        totalShares += sharesIssued;

        if (autoAllocateEnabled && vaults.length > 0) {
            _autoAllocate(amount);
        }

        highWaterMark = totalValue();
        deposited = amount;

        emit Deposited(msg.sender, amount, sharesIssued);
    }

    /**
     * @notice IStrategy.withdraw — Return USDC to TreasuryV2
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

        _accrueFees();

        // Convert USDC amount to shares
        uint256 currentValue = totalValue();
        if (currentValue == 0) return 0;
        uint256 sharesToBurn = (amount * totalShares) / currentValue;
        if (sharesToBurn > totalShares) sharesToBurn = totalShares;

        uint256 amountRequested = (sharesToBurn * currentValue) / totalShares;

        // Fulfill from reserve, then strategies
        uint256 reserve = underlyingAsset.balanceOf(address(this));
        if (reserve < amountRequested) {
            _withdrawFromStrategies(amountRequested - reserve);
        }

        uint256 available = underlyingAsset.balanceOf(address(this));
        withdrawn = available < amountRequested ? available : amountRequested;

        totalShares -= sharesToBurn;
        underlyingAsset.safeTransfer(msg.sender, withdrawn);

        highWaterMark = totalValue();
        emit Withdrawn(msg.sender, withdrawn, sharesToBurn);
    }

    /**
     * @notice IStrategy.withdrawAll — Withdraw all USDC back to caller
     * @return withdrawn Total USDC withdrawn
     */
    function withdrawAll()
        external
        override
        onlyRole(TREASURY_ROLE)
        nonReentrant
        returns (uint256 withdrawn)
    {
        _accrueFees();

        // Pull from all strategies
        for (uint256 i = 0; i < vaults.length; i++) {
            try IStrategy(vaults[i].strategy).withdrawAll() {} catch {}
        }

        totalShares = 0;
        withdrawn = underlyingAsset.balanceOf(address(this));
        if (withdrawn > 0) {
            underlyingAsset.safeTransfer(msg.sender, withdrawn);
        }

        highWaterMark = 0;
        emit Withdrawn(msg.sender, withdrawn, 0);
    }

    /// @inheritdoc IStrategy
    function asset() external view override returns (address) {
        return address(underlyingAsset);
    }

    /// @inheritdoc IStrategy
    function isActive() external view override returns (bool) {
        return strategyActive && !paused();
    }

    // ═══════════════════════════════════════════
    // SHARE-BASED DEPOSIT & WITHDRAW (internal / keeper)
    // ═══════════════════════════════════════════

    /**
     * @notice Deposit USDC via DEPOSITOR_ROLE (share-based, for keepers)
     * @param amount USDC amount
     * @return sharesIssued Shares minted
     */
    function depositShares(uint256 amount)
        external
        onlyRole(DEPOSITOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesIssued)
    {
        if (amount == 0) revert ZeroAmount();

        _accrueFees();

        uint256 currentValue = totalValue();
        if (totalShares == 0 || currentValue == 0) {
            sharesIssued = amount;
        } else {
            sharesIssued = (amount * totalShares) / currentValue;
        }

        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
        totalShares += sharesIssued;

        if (autoAllocateEnabled && vaults.length > 0) {
            _autoAllocate(amount);
        }

        highWaterMark = totalValue();
        emit Deposited(msg.sender, amount, sharesIssued);
    }

    /**
     * @notice Withdraw USDC via DEPOSITOR_ROLE (share-based, for keepers)
     * @param shares Number of shares to burn
     * @return amountReturned USDC returned
     */
    function withdrawShares(uint256 shares)
        external
        onlyRole(DEPOSITOR_ROLE)
        nonReentrant
        returns (uint256 amountReturned)
    {
        if (shares == 0) revert ZeroAmount();
        if (shares > totalShares) revert InsufficientShares();

        _accrueFees();

        uint256 currentValue = totalValue();
        uint256 amountRequested = (shares * currentValue) / totalShares;

        // Try to fulfill from reserve
        uint256 reserve = underlyingAsset.balanceOf(address(this));
        if (reserve < amountRequested) {
            _withdrawFromStrategies(amountRequested - reserve);
        }

        uint256 available = underlyingAsset.balanceOf(address(this));
        amountReturned = available < amountRequested ? available : amountRequested;

        totalShares -= shares;
        underlyingAsset.safeTransfer(msg.sender, amountReturned);

        highWaterMark = totalValue();

        emit Withdrawn(msg.sender, amountReturned, shares);
    }

    // ═══════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════

    function rebalance() external onlyRole(KEEPER_ROLE) nonReentrant whenNotPaused {
        _accrueFees();

        uint256 total = totalValue();
        if (total == 0) return;

        uint256 adjusted = 0;

        for (uint256 i = 0; i < vaults.length; i++) {
            if (!vaults[i].active) continue;

            uint256 currentVal;
            try IStrategy(vaults[i].strategy).totalValue() returns (uint256 v) {
                currentVal = v;
            } catch {
                continue;
            }

            uint256 targetVal = (total * vaults[i].targetBps) / BPS;
            uint256 currentBps = total > 0 ? (currentVal * BPS) / total : 0;

            // Check if drift exceeds threshold
            uint256 drift = currentBps > vaults[i].targetBps
                ? currentBps - vaults[i].targetBps
                : vaults[i].targetBps - currentBps;

            if (drift < rebalanceThresholdBps) continue;

            if (currentVal > targetVal) {
                // Over-allocated — withdraw excess
                uint256 excess = currentVal - targetVal;
                try IStrategy(vaults[i].strategy).withdraw(excess) {} catch {}
                adjusted++;
            } else if (currentVal < targetVal) {
                // Under-allocated — deposit more
                uint256 deficit = targetVal - currentVal;
                uint256 reserve = underlyingAsset.balanceOf(address(this));
                uint256 toDeposit = deficit < reserve ? deficit : reserve;
                if (toDeposit > 0) {
                    underlyingAsset.forceApprove(vaults[i].strategy, toDeposit);
                    try IStrategy(vaults[i].strategy).deposit(toDeposit) {} catch {}
                    adjusted++;
                }
            }
        }

        highWaterMark = totalValue();
        emit Rebalanced(total, adjusted);
    }

    // ═══════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════

    function totalValue() public view override returns (uint256 total) {
        total = underlyingAsset.balanceOf(address(this));

        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i].active) {
                try IStrategy(vaults[i].strategy).totalValue() returns (uint256 val) {
                    total += val;
                } catch {}
            }
        }
    }

    function sharePrice() public view returns (uint256) {
        if (totalShares == 0) return WAD;
        return (totalValue() * WAD) / totalShares;
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function getAllVaults() external view returns (VaultConfig[] memory) {
        return vaults;
    }

    function getCurrentAllocations() external view returns (
        address[] memory strategies,
        uint256[] memory currentBps,
        uint256[] memory targetBps_
    ) {
        uint256 total = totalValue();
        uint256 len = vaults.length;
        strategies = new address[](len);
        currentBps = new uint256[](len);
        targetBps_ = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            strategies[i] = vaults[i].strategy;
            targetBps_[i] = vaults[i].targetBps;

            if (total > 0 && vaults[i].active) {
                try IStrategy(vaults[i].strategy).totalValue() returns (uint256 val) {
                    currentBps[i] = (val * BPS) / total;
                } catch {}
            }
        }
    }

    // ═══════════════════════════════════════════
    // FEES
    // ═══════════════════════════════════════════

    function _accrueFees() internal {
        uint256 currentValue = totalValue();
        if (currentValue > highWaterMark && highWaterMark > 0) {
            uint256 profit = currentValue - highWaterMark;
            uint256 newFees = (profit * performanceFeeBps) / BPS;
            accruedFees += newFees;
            emit FeesAccrued(newFees, accruedFees);
        }
        highWaterMark = currentValue;
    }

    function collectFees() external onlyRole(STRATEGIST_ROLE) nonReentrant {
        if (accruedFees == 0) revert NoFeesToCollect();

        uint256 reserve = underlyingAsset.balanceOf(address(this));
        uint256 toCollect = accruedFees < reserve ? accruedFees : reserve;
        accruedFees -= toCollect;

        underlyingAsset.safeTransfer(feeRecipient, toCollect);
        emit FeesCollected(feeRecipient, toCollect);
    }

    function setPerformanceFee(uint256 _feeBps) external onlyTimelock {
        if (_feeBps > MAX_PERFORMANCE_FEE_BPS) revert InvalidFee();
        performanceFeeBps = _feeBps;
    }

    function setFeeRecipient(address _recipient) external onlyTimelock {
        if (_recipient == address(0)) revert ZeroAddress();
        feeRecipient = _recipient;
    }

    // ═══════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════

    function setRebalanceThreshold(uint256 _thresholdBps) external onlyRole(STRATEGIST_ROLE) {
        if (_thresholdBps < MIN_REBALANCE_THRESHOLD_BPS || _thresholdBps > 2000) revert InvalidRebalanceThreshold();
        rebalanceThresholdBps = _thresholdBps;
    }

    function setAutoAllocate(bool _enabled) external onlyRole(STRATEGIST_ROLE) {
        autoAllocateEnabled = _enabled;
    }

    function setStrategyActive(bool _active) external onlyRole(STRATEGIST_ROLE) {
        strategyActive = _active;
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyTimelock {
        _unpause();
    }

    // ═══════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════

    function emergencyWithdrawFromVault(address _strategy) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        uint256 withdrawn;
        try IStrategy(_strategy).withdrawAll() returns (uint256 w) {
            withdrawn = w;
        } catch {}
        emit EmergencyWithdrawn(_strategy, withdrawn);
    }

    function emergencyWithdrawAll() external onlyRole(GUARDIAN_ROLE) nonReentrant {
        for (uint256 i = 0; i < vaults.length; i++) {
            try IStrategy(vaults[i].strategy).withdrawAll() {} catch {}
        }
        emit EmergencyWithdrawn(address(0), underlyingAsset.balanceOf(address(this)));
    }

    // ═══════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════

    function _autoAllocate(uint256 amount) internal {
        uint256 totalTarget = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i].active) totalTarget += vaults[i].targetBps;
        }
        if (totalTarget == 0) return;

        uint256 remaining = amount;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (!vaults[i].active || vaults[i].targetBps == 0) continue;

            uint256 allocation = (amount * vaults[i].targetBps) / totalTarget;
            if (allocation > remaining) allocation = remaining;
            if (allocation == 0) continue;

            underlyingAsset.forceApprove(vaults[i].strategy, allocation);
            try IStrategy(vaults[i].strategy).deposit(allocation) {
                remaining -= allocation;
            } catch {}
        }
    }

    function _withdrawFromStrategies(uint256 needed) internal {
        uint256 remaining = needed;
        uint256 reserve = underlyingAsset.balanceOf(address(this));
        uint256 deployedTotal = totalValue() - reserve;
        if (deployedTotal == 0) return;

        for (uint256 i = 0; i < vaults.length && remaining > 0; i++) {
            if (!vaults[i].active) continue;

            uint256 stratVal;
            try IStrategy(vaults[i].strategy).totalValue() returns (uint256 v) {
                stratVal = v;
            } catch {
                continue;
            }

            uint256 proportional = (needed * stratVal) / deployedTotal;
            if (proportional > remaining) proportional = remaining;
            if (proportional == 0) continue;

            try IStrategy(vaults[i].strategy).withdraw(proportional) returns (uint256 w) {
                remaining = remaining > w ? remaining - w : 0;
            } catch {}
        }
    }

    // ═══════════════════════════════════════════
    // STORAGE GAP & UPGRADES
    // ═══════════════════════════════════════════

    uint256[34] private __gap;

    function _authorizeUpgrade(address) internal override onlyTimelock {}
}
