// SPDX-License-Identifier: MIT
// BLE Protocol - Collateral Vault
// Accepts ERC-20 collateral deposits (WETH, WBTC, etc.) for overcollateralized borrowing

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CollateralVault
/// @notice Holds collateral deposits for the borrowing system.
///         BorrowModule and LiquidationEngine interact with this vault.
contract CollateralVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BORROW_MODULE_ROLE = keccak256("BORROW_MODULE_ROLE");
    bytes32 public constant LIQUIDATION_ROLE = keccak256("LIQUIDATION_ROLE");
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");

    struct CollateralConfig {
        bool enabled;
        uint256 collateralFactorBps;  // e.g., 7500 = 75% LTV
        uint256 liquidationThresholdBps; // e.g., 8000 = 80% — liquidation triggers here
        uint256 liquidationPenaltyBps;   // e.g., 500 = 5% penalty
    }

    // Supported collateral tokens and their configs
    mapping(address => CollateralConfig) public collateralConfigs;
    address[] public supportedTokens;

    // user => token => deposited amount
    mapping(address => mapping(address => uint256)) public deposits;

    event CollateralAdded(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event CollateralUpdated(address indexed token, uint256 collateralFactorBps, uint256 liquidationThresholdBps);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Seized(address indexed user, address indexed token, uint256 amount, address indexed liquidator);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_ADMIN_ROLE, msg.sender);
    }

    // ============================================================
    //                  COLLATERAL CONFIG
    // ============================================================

    /// @notice Add a new supported collateral token
    function addCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(token != address(0), "INVALID_TOKEN");
        require(!collateralConfigs[token].enabled, "ALREADY_ADDED");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH"); // Max 95%
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");    // Max 20%

        collateralConfigs[token] = CollateralConfig({
            enabled: true,
            collateralFactorBps: collateralFactorBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationPenaltyBps: liquidationPenaltyBps
        });

        supportedTokens.push(token);
        emit CollateralAdded(token, collateralFactorBps, liquidationThresholdBps);
    }

    /// @notice Update collateral parameters
    function updateCollateral(
        address token,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) external onlyRole(VAULT_ADMIN_ROLE) {
        require(collateralConfigs[token].enabled, "NOT_SUPPORTED");
        require(collateralFactorBps > 0 && collateralFactorBps < liquidationThresholdBps, "INVALID_FACTOR");
        require(liquidationThresholdBps <= 9500, "THRESHOLD_TOO_HIGH");
        require(liquidationPenaltyBps <= 2000, "PENALTY_TOO_HIGH");

        collateralConfigs[token].collateralFactorBps = collateralFactorBps;
        collateralConfigs[token].liquidationThresholdBps = liquidationThresholdBps;
        collateralConfigs[token].liquidationPenaltyBps = liquidationPenaltyBps;

        emit CollateralUpdated(token, collateralFactorBps, liquidationThresholdBps);
    }

    // ============================================================
    //                  USER OPERATIONS
    // ============================================================

    /// @notice Deposit collateral
    /// @param token The collateral token address
    /// @param amount Amount to deposit
    function deposit(address token, uint256 amount) external nonReentrant {
        require(collateralConfigs[token].enabled, "TOKEN_NOT_SUPPORTED");
        require(amount > 0, "INVALID_AMOUNT");

        deposits[msg.sender][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraw collateral (BorrowModule checks health factor before allowing)
    /// @param token The collateral token
    /// @param amount Amount to withdraw
    /// @param user The user withdrawing (must be called by BorrowModule after health check)
    function withdraw(
        address token,
        uint256 amount,
        address user
    ) external onlyRole(BORROW_MODULE_ROLE) nonReentrant {
        require(deposits[user][token] >= amount, "INSUFFICIENT_DEPOSIT");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(user, amount);

        emit Withdrawn(user, token, amount);
    }

    /// @notice Seize collateral during liquidation
    /// @param user The borrower being liquidated
    /// @param token The collateral token to seize
    /// @param amount Amount to seize
    /// @param liquidator The liquidator receiving the collateral
    function seize(
        address user,
        address token,
        uint256 amount,
        address liquidator
    ) external onlyRole(LIQUIDATION_ROLE) nonReentrant {
        require(deposits[user][token] >= amount, "INSUFFICIENT_COLLATERAL");

        deposits[user][token] -= amount;
        IERC20(token).safeTransfer(liquidator, amount);

        emit Seized(user, token, amount, liquidator);
    }

    // ============================================================
    //                  VIEW FUNCTIONS
    // ============================================================

    /// @notice Get a user's deposit for a specific token
    function getDeposit(address user, address token) external view returns (uint256) {
        return deposits[user][token];
    }

    /// @notice Get the list of supported collateral tokens
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    /// @notice Get collateral config for a token
    function getConfig(address token) external view returns (
        bool enabled,
        uint256 collateralFactorBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationPenaltyBps
    ) {
        CollateralConfig storage c = collateralConfigs[token];
        return (c.enabled, c.collateralFactorBps, c.liquidationThresholdBps, c.liquidationPenaltyBps);
    }
}
