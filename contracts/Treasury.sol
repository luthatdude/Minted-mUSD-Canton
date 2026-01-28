// SPDX-License-Identifier: MIT
// BLE Protocol - Treasury
// Holds USDC backing for mUSD, supports yield strategy deployment

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Treasury
/// @notice Custodies USDC backing for mUSD. Supports deploying reserves to yield strategies.
/// @dev Only DirectMint and authorized strategies can deposit/withdraw.
contract Treasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");      // DirectMint contract
    bytes32 public constant STRATEGY_ROLE = keccak256("STRATEGY_ROLE");  // Yield strategies
    bytes32 public constant TREASURY_ADMIN_ROLE = keccak256("TREASURY_ADMIN_ROLE");

    IERC20 public immutable usdc;

    // Track how much USDC is deployed to strategies vs held in reserve
    uint256 public deployedToStrategies;

    // Per-strategy deployment tracking
    mapping(address => uint256) public strategyDeployments;

    // Maximum percentage of reserves that can be deployed (basis points, e.g., 8000 = 80%)
    uint256 public maxDeploymentBps;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event DeployedToStrategy(address indexed strategy, uint256 amount);
    event WithdrawnFromStrategy(address indexed strategy, uint256 amount);
    event MaxDeploymentUpdated(uint256 oldBps, uint256 newBps);

    constructor(address _usdc, uint256 _maxDeploymentBps) {
        require(_usdc != address(0), "INVALID_USDC");
        require(_maxDeploymentBps <= 9000, "MAX_DEPLOY_TOO_HIGH"); // Cap at 90%

        usdc = IERC20(_usdc);
        maxDeploymentBps = _maxDeploymentBps;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TREASURY_ADMIN_ROLE, msg.sender);
    }

    /// @notice Total USDC backing (in treasury + deployed to strategies)
    function totalBacking() external view returns (uint256) {
        return usdc.balanceOf(address(this)) + deployedToStrategies;
    }

    /// @notice USDC available in treasury (not deployed)
    function availableReserves() public view returns (uint256) {
        return usdc.balanceOf(address(this));
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
    }

    /// @notice Withdraw USDC from treasury (called by DirectMint on user redemption)
    /// @param to The address to send USDC to
    /// @param amount Amount of USDC to withdraw
    function withdraw(address to, uint256 amount) external onlyRole(MINTER_ROLE) nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        require(amount <= availableReserves(), "INSUFFICIENT_RESERVES");
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
}
