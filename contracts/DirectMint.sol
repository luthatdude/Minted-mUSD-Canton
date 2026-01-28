// SPDX-License-Identifier: MIT
// BLE Protocol - DirectMint
// User-facing mint/redeem: USDC <-> mUSD

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IMUSD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function supplyCap() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

contract DirectMint is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable usdc;
    IMUSD public immutable musd;
    address public treasury;

    // Fees in basis points (100 = 1%)
    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    uint256 public constant MAX_FEE_BPS = 500; // 5% max

    // Accumulated fees
    uint256 public accumulatedFees;

    // Per-transaction limits
    uint256 public minMintAmount;
    uint256 public maxMintAmount;
    uint256 public minRedeemAmount;
    uint256 public maxRedeemAmount;

    // Events
    event Minted(address indexed user, uint256 usdcIn, uint256 musdOut, uint256 fee);
    event Redeemed(address indexed user, uint256 musdIn, uint256 usdcOut, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeesUpdated(uint256 mintFeeBps, uint256 redeemFeeBps);
    event LimitsUpdated(uint256 minMint, uint256 maxMint, uint256 minRedeem, uint256 maxRedeem);

    constructor(
        address _usdc,
        address _musd,
        address _treasury
    ) {
        require(_usdc != address(0), "INVALID_USDC");
        require(_musd != address(0), "INVALID_MUSD");
        require(_treasury != address(0), "INVALID_TREASURY");

        usdc = IERC20(_usdc);
        musd = IMUSD(_musd);
        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(TREASURY_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        // Default limits
        minMintAmount = 1e6;        // 1 USDC
        maxMintAmount = 1_000_000e6; // 1M USDC
        minRedeemAmount = 1e6;
        maxRedeemAmount = 1_000_000e6;
    }

    // ============================================================
    //                    CORE FUNCTIONS
    // ============================================================

    /// @notice Mint mUSD by depositing USDC
    /// @param usdcAmount Amount of USDC to deposit (6 decimals)
    /// @return musdOut Amount of mUSD minted (18 decimals)
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused returns (uint256 musdOut) {
        require(usdcAmount >= minMintAmount, "BELOW_MIN");
        require(usdcAmount <= maxMintAmount, "ABOVE_MAX");

        // Convert USDC (6 decimals) to mUSD (18 decimals)
        uint256 musdAmount = usdcAmount * 1e12;

        // Check supply cap
        require(musd.totalSupply() + musdAmount <= musd.supplyCap(), "EXCEEDS_SUPPLY_CAP");

        // Calculate fee
        uint256 fee = (musdAmount * mintFeeBps) / 10000;
        musdOut = musdAmount - fee;

        // Transfer USDC to treasury
        usdc.safeTransferFrom(msg.sender, treasury, usdcAmount);

        // Mint mUSD to user (minus fee)
        musd.mint(msg.sender, musdOut);

        // Track fees (in mUSD terms, will be collected as USDC)
        if (fee > 0) {
            accumulatedFees += fee / 1e12; // Convert back to USDC decimals
        }

        emit Minted(msg.sender, usdcAmount, musdOut, fee);
    }

    /// @notice Redeem mUSD for USDC
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    /// @return usdcOut Amount of USDC returned (6 decimals)
    function redeem(uint256 musdAmount) external nonReentrant whenNotPaused returns (uint256 usdcOut) {
        // Convert to USDC decimals for limit checks
        uint256 usdcEquivalent = musdAmount / 1e12;
        require(usdcEquivalent >= minRedeemAmount, "BELOW_MIN");
        require(usdcEquivalent <= maxRedeemAmount, "ABOVE_MAX");

        // Calculate fee
        uint256 fee = (musdAmount * redeemFeeBps) / 10000;
        uint256 musdAfterFee = musdAmount - fee;
        usdcOut = musdAfterFee / 1e12;

        require(usdcOut > 0, "ZERO_OUTPUT");

        // Check treasury has enough USDC
        require(usdc.balanceOf(treasury) >= usdcOut, "INSUFFICIENT_TREASURY");

        // Burn user's mUSD
        musd.burn(msg.sender, musdAmount);

        // Transfer USDC from treasury to user
        usdc.safeTransferFrom(treasury, msg.sender, usdcOut);

        // Track fees
        if (fee > 0) {
            accumulatedFees += fee / 1e12;
        }

        emit Redeemed(msg.sender, musdAmount, usdcOut, fee);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Preview how much mUSD user will receive for USDC deposit
    function previewMint(uint256 usdcAmount) external view returns (uint256 musdOut, uint256 fee) {
        uint256 musdAmount = usdcAmount * 1e12;
        fee = (musdAmount * mintFeeBps) / 10000;
        musdOut = musdAmount - fee;
    }

    /// @notice Preview how much USDC user will receive for mUSD redemption
    function previewRedeem(uint256 musdAmount) external view returns (uint256 usdcOut, uint256 fee) {
        fee = (musdAmount * redeemFeeBps) / 10000;
        uint256 musdAfterFee = musdAmount - fee;
        usdcOut = musdAfterFee / 1e12;
    }

    /// @notice Check how much more mUSD can be minted
    function remainingMintable() external view returns (uint256) {
        uint256 cap = musd.supplyCap();
        uint256 supply = musd.totalSupply();
        return cap > supply ? cap - supply : 0;
    }

    /// @notice Check treasury balance
    function treasuryBalance() external view returns (uint256) {
        return usdc.balanceOf(treasury);
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setFees(uint256 _mintFeeBps, uint256 _redeemFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_mintFeeBps <= MAX_FEE_BPS, "MINT_FEE_TOO_HIGH");
        require(_redeemFeeBps <= MAX_FEE_BPS, "REDEEM_FEE_TOO_HIGH");
        mintFeeBps = _mintFeeBps;
        redeemFeeBps = _redeemFeeBps;
        emit FeesUpdated(_mintFeeBps, _redeemFeeBps);
    }

    function setLimits(
        uint256 _minMint,
        uint256 _maxMint,
        uint256 _minRedeem,
        uint256 _maxRedeem
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_minMint <= _maxMint, "INVALID_MINT_LIMITS");
        require(_minRedeem <= _maxRedeem, "INVALID_REDEEM_LIMITS");
        minMintAmount = _minMint;
        maxMintAmount = _maxMint;
        minRedeemAmount = _minRedeem;
        maxRedeemAmount = _maxRedeem;
        emit LimitsUpdated(_minMint, _maxMint, _minRedeem, _maxRedeem);
    }

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "INVALID_TREASURY");
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    function withdrawFees(address to) external onlyRole(TREASURY_ROLE) {
        uint256 fees = accumulatedFees;
        require(fees > 0, "NO_FEES");
        accumulatedFees = 0;
        usdc.safeTransferFrom(treasury, to, fees);
        emit FeesWithdrawn(to, fees);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
