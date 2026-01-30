// SPDX-License-Identifier: MIT
// BLE Protocol - Treasury
// Holds USDC backing for mUSD, supports yield strategy deployment with auto-allocation

pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IStrategy.sol";

/// @title Treasury
/// @notice Custodies USDC backing for mUSD. Auto-deploys to yield strategies on deposit.
/// @dev Only DirectMint and authorized strategies can deposit/withdraw.
///      When USDC arrives (from mint or bridge-in), it's auto-deployed to the default strategy.
contract Treasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");      // DirectMint contract
    bytes32 public constant STRATEGY_ROLE = keccak256("STRATEGY_ROLE");  // Yield strategies
    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");      // Keeper/bot for auto-deploy
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");      // Bridge contract

    IERC20 public immutable usdc;

    // Track how much USDC is deployed to strategies vs held in reserve
    uint256 public deployedToStrategies;

    // Per-strategy deployment tracking
    mapping(address => uint256) public strategyDeployments;

    // Maximum percentage of reserves that can be deployed (basis points, e.g., 8000 = 80%)
    uint256 public maxDeploymentBps;

    // ============================================================
    //              AUTO-DEPLOY CONFIGURATION
    // ============================================================

    /// @notice Default strategy for auto-deployment (must have STRATEGY_ROLE)
    address public defaultStrategy;

    /// @notice Whether auto-deploy on deposit is enabled
    bool public autoDeployEnabled;

    /// @notice Minimum idle USDC before auto-deploy triggers (prevents dust deploys)
    uint256 public autoDeployThreshold;

    /// @notice Reserve buffer in basis points (e.g., 1000 = 10% stays liquid)
    uint256 public reserveBufferBps;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event DeployedToStrategy(address indexed strategy, uint256 amount);
    event WithdrawnFromStrategy(address indexed strategy, uint256 amount);
    event MaxDeploymentUpdated(uint256 oldBps, uint256 newBps);
    event AutoDeployed(address indexed strategy, uint256 amount);
    event AutoDeployConfigUpdated(address defaultStrategy, bool enabled, uint256 threshold, uint256 reserveBps);
    event BridgeDeposit(address indexed from, uint256 amount, bool autoDeploy);

    constructor(address _usdc, uint256 _maxDeploymentBps) {
        require(_usdc != address(0), "INVALID_USDC");
        require(_maxDeploymentBps <= 9000, "MAX_DEPLOY_TOO_HIGH"); // Cap at 90%

        usdc = IERC20(_usdc);
        maxDeploymentBps = _maxDeploymentBps;

        // Default auto-deploy config
        autoDeployEnabled = true;
        autoDeployThreshold = 1000e6;  // Min $1000 USDC to auto-deploy
        reserveBufferBps = 1000;       // Keep 10% liquid

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TREASURY_ADMIN_ROLE, msg.sender);
        _grantRole(KEEPER_ROLE, msg.sender);
    }

    /// @notice Total USDC backing (in treasury + deployed to strategies)
    function totalBacking() external view returns (uint256) {
        return usdc.balanceOf(address(this)) + deployedToStrategies;
    }

    /// @notice USDC available in treasury (not deployed)
    function availableReserves() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Amount deployable after reserving buffer
    function deployableAmount() public view returns (uint256) {
        uint256 total = usdc.balanceOf(address(this)) + deployedToStrategies;
        if (total == 0) return 0;

        uint256 targetReserve = (total * reserveBufferBps) / 10000;
        uint256 currentReserve = usdc.balanceOf(address(this));

        if (currentReserve <= targetReserve) return 0;
        return currentReserve - targetReserve;
    }

    // ============================================================
    //                  MINTER OPERATIONS
    // ============================================================

    /// @notice Deposit USDC into treasury (called by DirectMint on user deposit)
    /// @param from The address to pull USDC from (must have approved Treasury)
    /// @param amount Amount of USDC to deposit
    function deposit(address from, uint256 amount) external onlyRole(MINTER_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        usdc.safeTransferFrom(from, address(this), amount);
        emit Deposited(from, amount);

        // Auto-deploy to default strategy if enabled
        _tryAutoDeploy();
    }

    /// @notice Deposit USDC from bridge (Canton → Ethereum backing)
    /// @param from The address to pull USDC from
    /// @param amount Amount of USDC bridged in
    function depositFromBridge(address from, uint256 amount) external onlyRole(BRIDGE_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        usdc.safeTransferFrom(from, address(this), amount);

        bool deployed = _tryAutoDeploy();
        emit BridgeDeposit(from, amount, deployed);
    }

    /// @notice Withdraw USDC from treasury (called by DirectMint on user redemption)
    /// @param to The address to send USDC to
    /// @param amount Amount of USDC to withdraw
    function withdraw(address to, uint256 amount) external onlyRole(MINTER_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");

        // If not enough in reserve, pull from strategy
        uint256 reserve = availableReserves();
        if (reserve < amount && defaultStrategy != address(0)) {
            uint256 needed = amount - reserve;
            _withdrawFromDefaultStrategy(needed);
        }

        require(availableReserves() >= amount, "INSUFFICIENT_RESERVES");
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ============================================================
    //                  YIELD STRATEGY OPERATIONS
    // ============================================================

    /// @notice Deploy USDC to a yield strategy
    /// @param strategy The strategy contract address (must have STRATEGY_ROLE)
    /// @param amount Amount to deploy
    // FIX H-03: Require strategy to have STRATEGY_ROLE before sending funds
    // FIX M-12: Guard against division by zero when totalAssets is 0
    function deployToStrategy(
        address strategy,
        uint256 amount
    ) external onlyRole(TREASURY_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        require(amount <= availableReserves(), "INSUFFICIENT_RESERVES");
        // FIX H-03: Only deploy to authorized strategy contracts
        require(hasRole(STRATEGY_ROLE, strategy), "STRATEGY_NOT_AUTHORIZED");

        // FIX M-12: Guard against division by zero
        uint256 totalAssets = availableReserves() + deployedToStrategies;
        require(totalAssets > 0, "NO_ASSETS_AVAILABLE");
        uint256 newDeployed = deployedToStrategies + amount;
        require(
            (newDeployed * 10000) / totalAssets <= maxDeploymentBps,
            "EXCEEDS_MAX_DEPLOYMENT"
        );

        deployedToStrategies += amount;
        strategyDeployments[strategy] += amount;

        usdc.safeTransfer(strategy, amount);
        emit DeployedToStrategy(strategy, amount);
    }

    /// @notice Record USDC returned from a strategy
    /// @param amount Amount returned
    function recordStrategyReturn(uint256 amount) external onlyRole(STRATEGY_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");

        uint256 deployed = strategyDeployments[msg.sender];
        uint256 reduction = amount > deployed ? deployed : amount;

        strategyDeployments[msg.sender] -= reduction;
        deployedToStrategies -= reduction;

        // Strategy must transfer USDC back before calling this
        // (pull pattern: strategy approves, treasury pulls)
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit WithdrawnFromStrategy(msg.sender, amount);
    }

    /// @notice Update maximum deployment percentage
    function setMaxDeploymentBps(uint256 _bps) external onlyRole(TREASURY_ADMIN_ROLE) {
        require(_bps <= 9000, "MAX_DEPLOY_TOO_HIGH");
        uint256 old = maxDeploymentBps;
        maxDeploymentBps = _bps;
        emit MaxDeploymentUpdated(old, _bps);
    }

    // ============================================================
    //              AUTO-DEPLOY MECHANISM
    // ============================================================

    /// @notice Configure auto-deploy settings
    /// @param _defaultStrategy Strategy address for auto-deployment (must have STRATEGY_ROLE)
    /// @param _enabled Enable/disable auto-deploy
    /// @param _threshold Minimum idle USDC before auto-deploy triggers
    /// @param _reserveBps Reserve buffer in basis points
    function setAutoDeployConfig(
        address _defaultStrategy,
        bool _enabled,
        uint256 _threshold,
        uint256 _reserveBps
    ) external onlyRole(TREASURY_ADMIN_ROLE) {
        require(_reserveBps <= 5000, "RESERVE_TOO_HIGH"); // Max 50% reserve

        // If setting a strategy, it must be authorized
        if (_defaultStrategy != address(0)) {
            require(hasRole(STRATEGY_ROLE, _defaultStrategy), "STRATEGY_NOT_AUTHORIZED");
        }

        defaultStrategy = _defaultStrategy;
        autoDeployEnabled = _enabled;
        autoDeployThreshold = _threshold;
        reserveBufferBps = _reserveBps;

        emit AutoDeployConfigUpdated(_defaultStrategy, _enabled, _threshold, _reserveBps);
    }

    /// @notice Try auto-deploy to default strategy
    /// @return deployed Whether deployment occurred
    function _tryAutoDeploy() internal returns (bool deployed) {
        if (!autoDeployEnabled) return false;
        if (defaultStrategy == address(0)) return false;

        uint256 deployable = deployableAmount();
        if (deployable < autoDeployThreshold) return false;

        // Deploy to default strategy
        return _deployToDefaultStrategy(deployable);
    }

    /// @notice Deploy to default strategy
    function _deployToDefaultStrategy(uint256 amount) internal returns (bool) {
        if (amount == 0 || defaultStrategy == address(0)) return false;

        // Verify strategy is still authorized
        if (!hasRole(STRATEGY_ROLE, defaultStrategy)) return false;

        // Check max deployment limit
        uint256 totalAssets = availableReserves() + deployedToStrategies;
        if (totalAssets == 0) return false;

        uint256 newDeployed = deployedToStrategies + amount;
        if ((newDeployed * 10000) / totalAssets > maxDeploymentBps) {
            // Reduce amount to stay within limit
            uint256 maxAllowed = (totalAssets * maxDeploymentBps) / 10000;
            if (maxAllowed <= deployedToStrategies) return false;
            amount = maxAllowed - deployedToStrategies;
        }

        if (amount == 0) return false;

        // Approve and deposit to strategy
        usdc.forceApprove(defaultStrategy, amount);

        try IStrategy(defaultStrategy).deposit(amount) returns (uint256 deposited) {
            deployedToStrategies += deposited;
            strategyDeployments[defaultStrategy] += deposited;
            emit AutoDeployed(defaultStrategy, deposited);
            return true;
        } catch {
            usdc.forceApprove(defaultStrategy, 0);
            return false;
        }
    }

    /// @notice Withdraw from default strategy
    function _withdrawFromDefaultStrategy(uint256 amount) internal returns (uint256 withdrawn) {
        if (defaultStrategy == address(0)) return 0;

        uint256 strategyBalance = strategyDeployments[defaultStrategy];
        if (strategyBalance == 0) return 0;

        uint256 toWithdraw = amount > strategyBalance ? strategyBalance : amount;

        try IStrategy(defaultStrategy).withdraw(toWithdraw) returns (uint256 actual) {
            withdrawn = actual;
            uint256 reduction = actual > strategyBalance ? strategyBalance : actual;
            strategyDeployments[defaultStrategy] -= reduction;
            deployedToStrategies -= reduction;
            emit WithdrawnFromStrategy(defaultStrategy, actual);
        } catch {
            withdrawn = 0;
        }
    }

    /// @notice Keeper can trigger auto-deploy when idle funds accumulate
    /// @return deployed Amount deployed
    function keeperTriggerAutoDeploy() external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 deployed) {
        require(autoDeployEnabled, "AUTO_DEPLOY_DISABLED");
        require(defaultStrategy != address(0), "NO_DEFAULT_STRATEGY");

        uint256 deployable = deployableAmount();
        require(deployable >= autoDeployThreshold, "BELOW_THRESHOLD");

        if (_deployToDefaultStrategy(deployable)) {
            return deployable;
        }
        return 0;
    }

    /// @notice Public view: check if auto-deploy would trigger
    function shouldAutoDeploy() external view returns (bool, uint256) {
        if (!autoDeployEnabled) return (false, 0);
        if (defaultStrategy == address(0)) return (false, 0);

        uint256 deployable = deployableAmount();
        return (deployable >= autoDeployThreshold, deployable);
    }
}
