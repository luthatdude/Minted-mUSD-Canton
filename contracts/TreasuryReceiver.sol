// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./TimelockGoverned.sol";

/**
 * @title IWormhole
 * @notice Minimal interface for Wormhole core contract
 */
interface IWormhole {
    function parseAndVerifyVM(bytes calldata encodedVM) external view returns (
        IWormhole.VM memory vm,
        bool valid,
        string memory reason
    );
    
    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        bytes signatures;
        bytes32 hash;
    }
}

/**
 * @title ITokenBridge
 * @notice Interface for Wormhole Token Bridge to complete transfers
 */
interface ITokenBridge {
    function completeTransfer(bytes memory encodedVm) external;
    function completeTransferAndUnwrapETH(bytes memory encodedVm) external;
}

/**
 * @title IDirectMint
 * @notice Interface for DirectMint to mint mUSD for users
 */
interface IDirectMint {
    function mintFor(address recipient, uint256 usdcAmount) external returns (uint256 musdMinted);
}

/**
 * @title TreasuryReceiver
 * @notice Receives bridged USDC from L2 DepositRouters and forwards to DirectMint
 * @dev Deploy this on Ethereum mainnet to receive cross-chain deposits
 * @dev Uses AccessControl for role-based access and Pausable for emergency controls
 */
contract TreasuryReceiver is AccessControl, ReentrancyGuard, Pausable, TimelockGoverned {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    bytes32 public constant BRIDGE_ADMIN_ROLE = keccak256("BRIDGE_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============ State Variables ============
    
    /// @notice USDC token on Ethereum
    IERC20 public immutable usdc;
    
    /// @notice Wormhole core contract
    IWormhole public immutable wormhole;
    
    /// @notice Wormhole token bridge
    ITokenBridge public immutable tokenBridge;
    
    /// @notice DirectMint contract for minting mUSD
    address public directMint;
    
    /// @notice Treasury address for reserve deposits
    address public treasury;
    
    /// @notice Mapping of processed VAAs (to prevent replay)
    mapping(bytes32 => bool) public processedVAAs;

    struct PendingMint {
        address recipient;
        uint256 usdcAmount;
        bool claimed;
    }

    /// @notice Pending mints keyed by VAA hash when DirectMint fails.
    mapping(bytes32 => PendingMint) public pendingMints;

    /// @notice Aggregate pending USDC amount per recipient.
    mapping(address => uint256) public pendingCredits;
    
    /// @notice Authorized source chains and their DepositRouter addresses
    mapping(uint16 => bytes32) public authorizedRouters;
    
    /// @notice Wormhole chain IDs
    uint16 public constant BASE_CHAIN_ID = 30;
    uint16 public constant ARBITRUM_CHAIN_ID = 23;
    uint16 public constant SOLANA_CHAIN_ID = 1;

    // ============ Events ============
    
    event DepositReceived(
        uint16 sourceChain,
        bytes32 sourceRouter,
        address indexed recipient,
        uint256 amount,
        bytes32 vaaHash
    );
    
    event RouterAuthorized(uint16 chainId, bytes32 routerAddress);
    event RouterRevoked(uint16 chainId);
    event DirectMintUpdated(address oldDirectMint, address newDirectMint);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event MUSDMinted(address indexed recipient, uint256 usdcAmount, uint256 musdAmount, bytes32 vaaHash);
    event MintFallbackToTreasury(address indexed recipient, uint256 usdcAmount, bytes32 vaaHash);
    event MintQueued(address indexed recipient, uint256 usdcAmount, bytes32 vaaHash);
    event PendingMintClaimed(address indexed recipient, uint256 usdcAmount, uint256 musdAmount, bytes32 vaaHash);

    // ============ Errors ============
    
    error InvalidAddress();
    error InvalidVAA();
    error VAAAlreadyProcessed();
    error UnauthorizedRouter();
    error MintFailed();
    error NoPendingMint();
    error PendingMintAlreadyClaimed();
    error UnauthorizedClaim();

    // ============ Constructor ============
    
    constructor(
        address _usdc,
        address _wormhole,
        address _tokenBridge,
        address _directMint,
        address _treasury,
        address _timelock
    ) {
        if (_usdc == address(0)) revert InvalidAddress();
        if (_wormhole == address(0)) revert InvalidAddress();
        if (_tokenBridge == address(0)) revert InvalidAddress();
        if (_directMint == address(0)) revert InvalidAddress();
        if (_treasury == address(0)) revert InvalidAddress();
        
        usdc = IERC20(_usdc);
        wormhole = IWormhole(_wormhole);
        tokenBridge = ITokenBridge(_tokenBridge);
        directMint = _directMint;
        treasury = _treasury;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BRIDGE_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        // S-H-01: Initialize timelock for admin setters
        _setTimelock(_timelock);
    }

    // ============ External Functions ============
    
    /**
     * @notice Complete a cross-chain deposit and mint mUSD
     * @param encodedVAA Wormhole VAA from the source chain
     * @dev Paused during emergencies
     */
    function receiveAndMint(bytes calldata encodedVAA) external nonReentrant whenNotPaused {
        // Parse and verify the VAA
        (IWormhole.VM memory vm, bool valid, ) = wormhole.parseAndVerifyVM(encodedVAA);
        if (!valid) revert InvalidVAA();
        
        // Check for replay
        if (processedVAAs[vm.hash]) revert VAAAlreadyProcessed();
        // Don't mark processed yet — wait until mint/fallback succeeds
        
        // Verify source is authorized
        bytes32 authorizedRouter = authorizedRouters[vm.emitterChainId];
        if (authorizedRouter == bytes32(0) || authorizedRouter != vm.emitterAddress) {
            revert UnauthorizedRouter();
        }
        
        // Complete the token transfer (this receives USDC)
        uint256 balanceBefore = usdc.balanceOf(address(this));
        tokenBridge.completeTransfer(encodedVAA);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;
        
        // Parse Wormhole Token Bridge TransferWithPayload (type 3) format.
        // Layout: payloadID(1) + amount(32) + tokenAddress(32) + tokenChain(2) +
        //         to(32) + toChain(2) + fromAddress(32) + userPayload(variable)
        // Total fixed header = 133 bytes. User payload starts at offset 133.
        require(vm.payload.length >= 133 + 32, "INVALID_PAYLOAD_LENGTH");
        require(uint8(vm.payload[0]) == 3, "NOT_TRANSFER_WITH_PAYLOAD");
        
        // Extract user payload (the abi.encode(depositor) from DepositRouter)
        bytes memory userPayload = new bytes(vm.payload.length - 133);
        for (uint256 i = 0; i < userPayload.length; i++) {
            userPayload[i] = vm.payload[133 + i];
        }
        address recipient = abi.decode(userPayload, (address));
        
        // Mint mUSD for the recipient via DirectMint
        usdc.forceApprove(directMint, received);
        try IDirectMint(directMint).mintFor(recipient, received) returns (uint256 musdMinted) {
            // Mark processed only after successful mint
            processedVAAs[vm.hash] = true;
            emit MUSDMinted(recipient, received, musdMinted, vm.hash);
        } catch {
            // Queue the mint for deterministic retry instead of forwarding to treasury.
            // This preserves user attribution and avoids orphaned cross-chain credits.
            usdc.forceApprove(directMint, 0);
            processedVAAs[vm.hash] = true;
            pendingMints[vm.hash] = PendingMint({
                recipient: recipient,
                usdcAmount: received,
                claimed: false
            });
            pendingCredits[recipient] += received;
            emit MintQueued(recipient, received, vm.hash);
        }
        
        emit DepositReceived(
            vm.emitterChainId,
            vm.emitterAddress,
            recipient,
            received,
            vm.hash
        );
    }
    
    /**
     * @notice Check if a VAA has been processed
     * @param vaaHash Hash of the VAA
     * @return processed Whether it's been processed
     */
    function isVAAProcessed(bytes32 vaaHash) external view returns (bool processed) {
        return processedVAAs[vaaHash];
    }

    /**
     * @notice Retry minting for a previously queued VAA.
     * @dev Callable by the intended recipient or admin.
     */
    function claimPendingMint(bytes32 vaaHash) external nonReentrant whenNotPaused returns (uint256 musdMinted) {
        PendingMint storage pending = pendingMints[vaaHash];
        if (pending.recipient == address(0)) revert NoPendingMint();
        if (pending.claimed) revert PendingMintAlreadyClaimed();
        if (msg.sender != pending.recipient && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedClaim();
        }

        uint256 amount = pending.usdcAmount;
        usdc.forceApprove(directMint, amount);

        try IDirectMint(directMint).mintFor(pending.recipient, amount) returns (uint256 minted) {
            pending.claimed = true;
            pendingCredits[pending.recipient] -= amount;
            emit PendingMintClaimed(pending.recipient, amount, minted, vaaHash);
            emit MUSDMinted(pending.recipient, amount, minted, vaaHash);
            return minted;
        } catch {
            usdc.forceApprove(directMint, 0);
            revert MintFailed();
        }
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Authorize a DepositRouter on a source chain
     * @param chainId Wormhole chain ID
     * @param routerAddress Address of the DepositRouter (as bytes32)
     * @dev Requires BRIDGE_ADMIN_ROLE
     */
    function authorizeRouter(uint16 chainId, bytes32 routerAddress) external onlyRole(BRIDGE_ADMIN_ROLE) {
        authorizedRouters[chainId] = routerAddress;
        emit RouterAuthorized(chainId, routerAddress);
    }
    
    /**
     * @notice Revoke authorization for a source chain
     * @param chainId Wormhole chain ID
     * @dev Requires BRIDGE_ADMIN_ROLE
     */
    function revokeRouter(uint16 chainId) external onlyRole(BRIDGE_ADMIN_ROLE) {
        delete authorizedRouters[chainId];
        emit RouterRevoked(chainId);
    }
    
    /**
     * @notice Update DirectMint address
     * @param newDirectMint New DirectMint contract address
     * @dev S-H-01: Changed to onlyTimelock — requires scheduling through MintedTimelockController
     */
    function setDirectMint(address newDirectMint) external onlyTimelock {
        if (newDirectMint == address(0)) revert InvalidAddress();
        address old = directMint;
        directMint = newDirectMint;
        emit DirectMintUpdated(old, newDirectMint);
    }
    
    /**
     * @notice Update Treasury address
     * @param newTreasury New Treasury address
     * @dev S-H-01: Changed to onlyTimelock — requires scheduling through MintedTimelockController
     */
    function setTreasury(address newTreasury) external onlyTimelock {
        if (newTreasury == address(0)) revert InvalidAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }
    
    /**
     * @notice Emergency withdrawal
     * @param token Token to withdraw
     * @param to Recipient
     * @param amount Amount to withdraw
     * @dev Requires DEFAULT_ADMIN_ROLE
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ============ Emergency Controls ============
    
    /// @notice Pause all receiving and minting
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause operations
    /// @dev Requires DEFAULT_ADMIN_ROLE for separation of duties
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
