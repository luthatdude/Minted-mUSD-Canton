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

interface ITreasury {
    function deposit(address from, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
    function availableReserves() external view returns (uint256);
}

/// @title DirectMint
/// @notice Allows users to mint mUSD by depositing USDC 1:1 (minus fees)
///         and redeem mUSD for USDC. Treasury holds the backing.
contract DirectMint is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");

    IERC20 public immutable usdc;
    IMUSD public immutable musd;
    ITreasury public immutable treasury;

    // Fees in basis points (100 = 1%)
    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    uint256 public constant MAX_FEE_BPS = 500; // 5% max

    // Accumulated fees (in USDC decimals) - tracked separately
    uint256 public mintFees;    // Fees from minting (held in this contract)
    uint256 public redeemFees;  // Fees from redeeming (held in Treasury)
    address public feeRecipient;

    // Per-transaction limits (in USDC decimals, 6 decimals)
    uint256 public minMintAmount;
    uint256 public maxMintAmount;
    uint256 public minRedeemAmount;
    uint256 public maxRedeemAmount;

    // Events
    event Minted(address indexed user, uint256 usdcIn, uint256 musdOut, uint256 fee);
    event Redeemed(address indexed user, uint256 musdIn, uint256 usdcOut, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event FeesUpdated(uint256 mintFeeBps, uint256 redeemFeeBps);
    event LimitsUpdated(uint256 minMint, uint256 maxMint, uint256 minRedeem, uint256 maxRedeem);

    constructor(
        address _usdc,
        address _musd,
        address _treasury,
        address _feeRecipient
    ) {
        require(_usdc != address(0), "INVALID_USDC");
        require(_musd != address(0), "INVALID_MUSD");
        require(_treasury != address(0), "INVALID_TREASURY");
        require(_feeRecipient != address(0), "INVALID_FEE_RECIPIENT");

        usdc = IERC20(_usdc);
        musd = IMUSD(_musd);
        treasury = ITreasury(_treasury);
        feeRecipient = _feeRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(FEE_MANAGER_ROLE, msg.sender);

        // Default limits
        minMintAmount = 1e6;          // 1 USDC
        maxMintAmount = 1_000_000e6;  // 1M USDC
        minRedeemAmount = 1e6;        // 1 USDC equivalent
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

        // Calculate fee in USDC terms
        uint256 feeUsdc = (usdcAmount * mintFeeBps) / 10000;
        uint256 usdcAfterFee = usdcAmount - feeUsdc;

        // Convert USDC (6 decimals) to mUSD (18 decimals)
        musdOut = usdcAfterFee * 1e12;

        // Check supply cap
        require(musd.totalSupply() + musdOut <= musd.supplyCap(), "EXCEEDS_SUPPLY_CAP");

        // Transfer USDC from user to this contract
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // FIX H-04: Reset approval to 0 first, then set to avoid safeApprove revert
        // safeApprove reverts if current allowance is non-zero (preventing front-running)
        usdc.forceApprove(address(treasury), usdcAfterFee);
        treasury.deposit(address(this), usdcAfterFee);

        // Track mint fees (held in this contract)
        if (feeUsdc > 0) {
            mintFees += feeUsdc;
        }

        // Mint mUSD to user
        musd.mint(msg.sender, musdOut);

        emit Minted(msg.sender, usdcAmount, musdOut, feeUsdc);
    }

    /// @notice Redeem mUSD for USDC
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    /// @return usdcOut Amount of USDC returned (6 decimals)
    function redeem(uint256 musdAmount) external nonReentrant whenNotPaused returns (uint256 usdcOut) {
        require(musdAmount > 0, "INVALID_AMOUNT");

        // Convert mUSD to USDC equivalent
        uint256 usdcEquivalent = musdAmount / 1e12;
        require(usdcEquivalent >= minRedeemAmount, "BELOW_MIN");
        require(usdcEquivalent <= maxRedeemAmount, "ABOVE_MAX");

        // Calculate fee
        uint256 feeUsdc = (usdcEquivalent * redeemFeeBps) / 10000;
        usdcOut = usdcEquivalent - feeUsdc;

        require(usdcOut > 0, "ZERO_OUTPUT");

        // Check treasury has enough
        require(treasury.availableReserves() >= usdcOut, "INSUFFICIENT_RESERVES");

        // Burn user's mUSD (user must have approved this contract)
        musd.burn(msg.sender, musdAmount);

        // Withdraw from treasury to user
        treasury.withdraw(msg.sender, usdcOut);

        // Track redeem fees (these remain in the Treasury, not in this contract)
        if (feeUsdc > 0) {
            redeemFees += feeUsdc;
        }

        emit Redeemed(msg.sender, musdAmount, usdcOut, feeUsdc);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Preview how much mUSD user will receive for USDC deposit
    function previewMint(uint256 usdcAmount) external view returns (uint256 musdOut, uint256 feeUsdc) {
        feeUsdc = (usdcAmount * mintFeeBps) / 10000;
        uint256 usdcAfterFee = usdcAmount - feeUsdc;
        musdOut = usdcAfterFee * 1e12;
    }

    /// @notice Preview how much USDC user will receive for mUSD redemption
    function previewRedeem(uint256 musdAmount) external view returns (uint256 usdcOut, uint256 feeUsdc) {
        uint256 usdcEquivalent = musdAmount / 1e12;
        feeUsdc = (usdcEquivalent * redeemFeeBps) / 10000;
        usdcOut = usdcEquivalent - feeUsdc;
    }

    /// @notice Check how much more mUSD can be minted
    function remainingMintable() external view returns (uint256) {
        uint256 cap = musd.supplyCap();
        uint256 supply = musd.totalSupply();
        return cap > supply ? cap - supply : 0;
    }

    /// @notice Check treasury balance available for redemptions
    function availableForRedemption() external view returns (uint256) {
        return treasury.availableReserves();
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setFees(uint256 _mintFeeBps, uint256 _redeemFeeBps) external onlyRole(FEE_MANAGER_ROLE) {
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

    function setFeeRecipient(address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_recipient != address(0), "INVALID_RECIPIENT");
        address old = feeRecipient;
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(old, _recipient);
    }

    function withdrawFees() external onlyRole(FEE_MANAGER_ROLE) {
        uint256 fees = mintFees;
        require(fees > 0, "NO_FEES");
        mintFees = 0;
        usdc.safeTransfer(feeRecipient, fees);
        emit FeesWithdrawn(feeRecipient, fees);
    }

    /// @notice FIX S-H02: Withdraw accumulated redeem fees from Treasury
    /// Redeem fees stay in Treasury during redeem(); this function extracts them.
    function withdrawRedeemFees() external onlyRole(FEE_MANAGER_ROLE) {
        uint256 fees = redeemFees;
        require(fees > 0, "NO_REDEEM_FEES");
        redeemFees = 0;
        treasury.withdraw(feeRecipient, fees);
        emit FeesWithdrawn(feeRecipient, fees);
    }

    /// @notice View total accumulated fees (mint + redeem) for accounting
    function totalAccumulatedFees() external view returns (uint256) {
        return mintFees + redeemFees;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Emergency token recovery (not USDC)
    function recoverToken(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(usdc), "CANNOT_RECOVER_USDC");
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
