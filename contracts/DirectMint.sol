// SPDX-License-Identifier: MIT
// BLE Protocol - DirectMint
// User deposits USDC, receives mUSD 1:1. Redeems mUSD for USDC 1:1.

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMUSDMintBurn {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

interface ITreasury {
    function deposit(address from, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
}

/// @title DirectMint
/// @notice 1:1 USDC ↔ mUSD mint/redeem module
/// @dev User deposits USDC into Treasury, receives mUSD. Redeems mUSD, gets USDC back.
///      USDC uses 6 decimals, mUSD uses 18 decimals — this contract handles the scaling.
contract DirectMint is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable usdc;
    IMUSDMintBurn public immutable musd;
    ITreasury public immutable treasury;

    bool public paused;

    // Daily mint/redeem limits per user (in USDC 6-decimal units)
    uint256 public dailyLimitPerUser;
    mapping(address => uint256) public dailyMinted;    // user => amount minted today
    mapping(address => uint256) public dailyRedeemed;  // user => amount redeemed today
    mapping(address => uint256) public lastMintDay;    // user => day number of last mint
    mapping(address => uint256) public lastRedeemDay;  // user => day number of last redeem

    // USDC has 6 decimals, mUSD has 18 decimals
    uint256 private constant SCALING_FACTOR = 1e12; // 10^(18-6)

    event Minted(address indexed user, uint256 usdcAmount, uint256 musdAmount);
    event Redeemed(address indexed user, uint256 musdAmount, uint256 usdcAmount);
    event DailyLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event PauseToggled(bool paused);

    constructor(
        address _usdc,
        address _musd,
        address _treasury,
        uint256 _dailyLimitPerUser
    ) {
        require(_usdc != address(0), "INVALID_USDC");
        require(_musd != address(0), "INVALID_MUSD");
        require(_treasury != address(0), "INVALID_TREASURY");

        usdc = IERC20(_usdc);
        musd = IMUSDMintBurn(_musd);
        treasury = ITreasury(_treasury);
        dailyLimitPerUser = _dailyLimitPerUser;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    /// @notice Deposit USDC and receive mUSD at 1:1 ratio
    /// @param usdcAmount Amount of USDC to deposit (6 decimals)
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused {
        require(usdcAmount > 0, "INVALID_AMOUNT");

        // Check daily limit
        _checkAndUpdateDailyMint(msg.sender, usdcAmount);

        // Scale USDC (6 dec) to mUSD (18 dec)
        uint256 musdAmount = usdcAmount * SCALING_FACTOR;

        // User approves this contract for USDC, we forward to Treasury
        // First transfer USDC from user to this contract, then deposit to Treasury
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.safeIncreaseAllowance(address(treasury), usdcAmount);
        treasury.deposit(address(this), usdcAmount);

        // Mint mUSD to user
        musd.mint(msg.sender, musdAmount);

        emit Minted(msg.sender, usdcAmount, musdAmount);
    }

    /// @notice Redeem mUSD for USDC at 1:1 ratio
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    function redeem(uint256 musdAmount) external nonReentrant whenNotPaused {
        require(musdAmount > 0, "INVALID_AMOUNT");
        require(musdAmount % SCALING_FACTOR == 0, "AMOUNT_NOT_ALIGNED");

        // Scale mUSD (18 dec) back to USDC (6 dec)
        uint256 usdcAmount = musdAmount / SCALING_FACTOR;

        // Check daily limit
        _checkAndUpdateDailyRedeem(msg.sender, usdcAmount);

        // Burn mUSD from user (user must have approved DirectMint as spender)
        musd.burn(msg.sender, musdAmount);

        // Withdraw USDC from Treasury to user
        treasury.withdraw(msg.sender, usdcAmount);

        emit Redeemed(msg.sender, musdAmount, usdcAmount);
    }

    // ============================================================
    //                  DAILY LIMIT LOGIC
    // ============================================================

    function _currentDay() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _checkAndUpdateDailyMint(address user, uint256 amount) internal {
        if (dailyLimitPerUser == 0) return; // 0 = no limit

        uint256 today = _currentDay();
        if (lastMintDay[user] != today) {
            dailyMinted[user] = 0;
            lastMintDay[user] = today;
        }

        dailyMinted[user] += amount;
        require(dailyMinted[user] <= dailyLimitPerUser, "DAILY_MINT_LIMIT_EXCEEDED");
    }

    function _checkAndUpdateDailyRedeem(address user, uint256 amount) internal {
        if (dailyLimitPerUser == 0) return;

        uint256 today = _currentDay();
        if (lastRedeemDay[user] != today) {
            dailyRedeemed[user] = 0;
            lastRedeemDay[user] = today;
        }

        dailyRedeemed[user] += amount;
        require(dailyRedeemed[user] <= dailyLimitPerUser, "DAILY_REDEEM_LIMIT_EXCEEDED");
    }

    // ============================================================
    //                  ADMIN
    // ============================================================

    function setDailyLimit(uint256 _limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 old = dailyLimitPerUser;
        dailyLimitPerUser = _limit;
        emit DailyLimitUpdated(old, _limit);
    }

    function togglePause() external onlyRole(PAUSER_ROLE) {
        paused = !paused;
        emit PauseToggled(paused);
    }
}
