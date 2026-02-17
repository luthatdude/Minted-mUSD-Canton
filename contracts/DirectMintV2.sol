// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./Errors.sol";

interface IMUSD_V2 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function supplyCap() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface ITreasuryV2 {
    function deposit(address from, uint256 amount) external;
    function withdraw(address to, uint256 amount) external;
    function availableReserves() external view returns (uint256);
    function totalValue() external view returns (uint256);
    function totalValueNet() external view returns (uint256);
}

/// @title DirectMintV2
/// @notice Allows users to mint mUSD by depositing USDC 1:1 (minus fees)
///         and redeem mUSD for USDC. Integrates with TreasuryV2 auto-allocation.
/// @dev When USDC is deposited, TreasuryV2 automatically deploys it to yield
///      strategies. On redemption, TreasuryV2 pulls from reserve or strategies.
contract DirectMintV2 is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    /// @notice TIMELOCK_ROLE for critical parameter changes
    bytes32 public constant TIMELOCK_ROLE = keccak256("TIMELOCK_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE"); // Role for TreasuryReceiver

    IERC20 public immutable usdc;
    IMUSD_V2 public immutable musd;
    ITreasuryV2 public immutable treasury;

    // Fees in basis points (100 = 1%)
    uint256 public mintFeeBps;
    uint256 public redeemFeeBps;
    uint256 public constant MAX_FEE_BPS = 500; // 5% max

    // Separate mint fees (held locally) from redeem fees (held in Treasury)
    uint256 public mintFees;
    uint256 public redeemFees;
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
        if (_usdc == address(0)) revert InvalidUsdc();
        if (_musd == address(0)) revert InvalidMusd();
        if (_treasury == address(0)) revert InvalidTreasury();
        if (_feeRecipient == address(0)) revert InvalidFeeRecipient();

        usdc = IERC20(_usdc);
        musd = IMUSD_V2(_musd);
        treasury = ITreasuryV2(_treasury);
        feeRecipient = _feeRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(FEE_MANAGER_ROLE, msg.sender);

        // Default fees (100 bps = 1%)
        mintFeeBps = 100;

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
    /// @dev USDC goes to TreasuryV2 which auto-allocates to yield strategies
    /// @param usdcAmount Amount of USDC to deposit (6 decimals)
    /// @return musdOut Amount of mUSD minted (18 decimals)
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused returns (uint256 musdOut) {
        if (usdcAmount < minMintAmount) revert BelowMin();
        if (usdcAmount > maxMintAmount) revert AboveMax();

        // Calculate fee in USDC terms
        uint256 feeUsdc = (usdcAmount * mintFeeBps) / 10000;
        uint256 usdcAfterFee = usdcAmount - feeUsdc;

        // Convert USDC (6 decimals) to mUSD (18 decimals)
        musdOut = usdcAfterFee * 1e12;

        // Check supply cap
        if (musd.totalSupply() + musdOut > musd.supplyCap()) revert ExceedsSupplyCap();

        // Transfer USDC from user to this contract
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Send net amount to TreasuryV2 (auto-allocates to strategies)
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
    /// @dev TreasuryV2 pulls from reserve first, then strategies if needed
    /// @param musdAmount Amount of mUSD to redeem (18 decimals)
    /// @return usdcOut Amount of USDC returned (6 decimals)
    function redeem(uint256 musdAmount) external nonReentrant whenNotPaused returns (uint256 usdcOut) {
        if (musdAmount == 0) revert InvalidAmount();

        // Convert mUSD to USDC equivalent
        uint256 usdcEquivalent = musdAmount / 1e12;
        if (usdcEquivalent < minRedeemAmount) revert BelowMin();
        if (usdcEquivalent > maxRedeemAmount) revert AboveMax();

        // Calculate fee - using combined calculation to avoid precision loss
        uint256 feeUsdc = (musdAmount * redeemFeeBps) / (1e12 * 10000);
        // Ensure fee is non-zero when redeemFeeBps > 0 to prevent fee-free small redemptions
        if (redeemFeeBps > 0 && feeUsdc == 0) {
            feeUsdc = 1; // Minimum 1 wei USDC fee
        }
        usdcOut = usdcEquivalent - feeUsdc;

        if (usdcOut == 0) revert ZeroOutput();

        // Burn user's mUSD
        musd.burn(msg.sender, musdAmount);

        // Withdraw from TreasuryV2 (handles reserve + strategy unwinding)
        treasury.withdraw(msg.sender, usdcOut);

        // Track redeem fees (these remain in the Treasury)
        if (feeUsdc > 0) {
            redeemFees += feeUsdc;
        }

        emit Redeemed(msg.sender, musdAmount, usdcOut, feeUsdc);
    }

    // ============================================================
    //              RECEIVER INTEGRATION
    // ============================================================

    /// @notice Mint mUSD for a recipient (called by TreasuryReceiver for cross-chain mints)
    /// @dev Only callable by authorized MINTER_ROLE (grant to TreasuryReceiver)
    /// @param recipient Address to receive mUSD
    /// @param usdcAmount Amount of USDC being deposited (6 decimals)
    /// @return musdOut Amount of mUSD minted (18 decimals)
    function mintFor(address recipient, uint256 usdcAmount) external nonReentrant whenNotPaused onlyRole(MINTER_ROLE) returns (uint256 musdOut) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (usdcAmount < minMintAmount) revert BelowMin();
        if (usdcAmount > maxMintAmount) revert AboveMax();

        // Calculate fee in USDC terms
        uint256 feeUsdc = (usdcAmount * mintFeeBps) / 10000;
        uint256 usdcAfterFee = usdcAmount - feeUsdc;

        // Convert USDC (6 decimals) to mUSD (18 decimals)
        musdOut = usdcAfterFee * 1e12;

        // Check supply cap
        if (musd.totalSupply() + musdOut > musd.supplyCap()) revert ExceedsSupplyCap();

        // Transfer USDC from caller (TreasuryReceiver) to this contract
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Send net amount to TreasuryV2
        usdc.forceApprove(address(treasury), usdcAfterFee);
        treasury.deposit(address(this), usdcAfterFee);

        // Track mint fees
        if (feeUsdc > 0) {
            mintFees += feeUsdc;
        }

        // Mint mUSD to recipient
        musd.mint(recipient, musdOut);

        emit Minted(recipient, usdcAmount, musdOut, feeUsdc);
        return musdOut;
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
    /// @dev Mirrors the fee-floor logic in redeem() so that the preview
    ///      output exactly matches on-chain execution.
    function previewRedeem(uint256 musdAmount) external view returns (uint256 usdcOut, uint256 feeUsdc) {
        uint256 usdcEquivalent = musdAmount / 1e12;
        // Combined calculation to avoid precision loss
        feeUsdc = (musdAmount * redeemFeeBps) / (1e12 * 10000);
        // Apply the same fee floor as redeem()
        if (redeemFeeBps > 0 && feeUsdc == 0) {
            feeUsdc = 1; // Minimum 1 wei USDC fee — matches redeem()
        }
        usdcOut = usdcEquivalent - feeUsdc;
    }

    /// @notice Check how much more mUSD can be minted
    function remainingMintable() external view returns (uint256) {
        uint256 cap = musd.supplyCap();
        uint256 supply = musd.totalSupply();
        return cap > supply ? cap - supply : 0;
    }

    /// @notice Check treasury total value (reserve + strategies)
    function totalTreasuryValue() external view returns (uint256) {
        return treasury.totalValue();
    }

    /// @notice Check treasury balance available for immediate redemptions
    function availableForRedemption() external view returns (uint256) {
        return treasury.availableReserves();
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setFees(uint256 _mintFeeBps, uint256 _redeemFeeBps) external onlyRole(TIMELOCK_ROLE) {
        if (_mintFeeBps > MAX_FEE_BPS) revert MintFeeTooHigh();
        if (_redeemFeeBps > MAX_FEE_BPS) revert RedeemFeeTooHigh();
        mintFeeBps = _mintFeeBps;
        redeemFeeBps = _redeemFeeBps;
        emit FeesUpdated(_mintFeeBps, _redeemFeeBps);
    }

    function setLimits(
        uint256 _minMint,
        uint256 _maxMint,
        uint256 _minRedeem,
        uint256 _maxRedeem
    ) external onlyRole(TIMELOCK_ROLE) {
        if (_minMint > _maxMint) revert InvalidMintLimits();
        if (_minRedeem > _maxRedeem) revert InvalidRedeemLimits();
        minMintAmount = _minMint;
        maxMintAmount = _maxMint;
        minRedeemAmount = _minRedeem;
        maxRedeemAmount = _maxRedeem;
        emit LimitsUpdated(_minMint, _maxMint, _minRedeem, _maxRedeem);
    }

    /// @notice Update fee recipient — requires timelock governance to prevent
    ///         instant fee redirection by a compromised admin.
    function setFeeRecipient(address _recipient) external onlyRole(TIMELOCK_ROLE) {
        if (_recipient == address(0)) revert InvalidRecipient();
        address old = feeRecipient;
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(old, _recipient);
    }

    /// @notice Withdraw accumulated mint fees (held in this contract)
    function withdrawFees() external onlyRole(FEE_MANAGER_ROLE) {
        uint256 fees = mintFees;
        if (fees == 0) revert NoFees();
        mintFees = 0;
        usdc.safeTransfer(feeRecipient, fees);
        emit FeesWithdrawn(feeRecipient, fees);
    }

    /// @notice Withdraw accumulated redeem fees from Treasury.
    /// Redeem fees stay in Treasury during redeem(); this function extracts them.
    function withdrawRedeemFees() external onlyRole(FEE_MANAGER_ROLE) {
        uint256 fees = redeemFees;
        if (fees == 0) revert NoRedeemFees();
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

    /// @notice Unpause requires TIMELOCK_ROLE (48h governance delay) to prevent compromised lower-privilege roles from unpausing
    function unpause() external onlyRole(TIMELOCK_ROLE) {
        _unpause();
    }

    /// @notice Emergency token recovery (not USDC)
    function recoverToken(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(usdc)) revert CannotRecoverUsdc();
        // Block mUSD recovery to prevent extraction of protocol tokens
        if (token == address(musd)) revert CannotRecoverMusd();
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
