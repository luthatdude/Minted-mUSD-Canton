// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 * @title TreasuryReceiver
 * @notice Receives bridged USDC from L2 DepositRouters and forwards to DirectMint
 * @dev Deploy this on Ethereum mainnet to receive cross-chain deposits
 */
contract TreasuryReceiver is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    // ============ Errors ============
    
    error InvalidAddress();
    error InvalidVAA();
    error VAAAlreadyProcessed();
    error UnauthorizedRouter();
    error MintFailed();

    // ============ Constructor ============
    
    constructor(
        address _usdc,
        address _wormhole,
        address _tokenBridge,
        address _directMint,
        address _treasury
    ) Ownable(msg.sender) {
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
    }

    // ============ External Functions ============
    
    /**
     * @notice Complete a cross-chain deposit and mint mUSD
     * @param encodedVAA Wormhole VAA from the source chain
     */
    function receiveAndMint(bytes calldata encodedVAA) external nonReentrant {
        // Parse and verify the VAA
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(encodedVAA);
        if (!valid) revert InvalidVAA();
        
        // Check for replay
        if (processedVAAs[vm.hash]) revert VAAAlreadyProcessed();
        processedVAAs[vm.hash] = true;
        
        // Verify source is authorized
        bytes32 authorizedRouter = authorizedRouters[vm.emitterChainId];
        if (authorizedRouter == bytes32(0) || authorizedRouter != vm.emitterAddress) {
            revert UnauthorizedRouter();
        }
        
        // Complete the token transfer (this receives USDC)
        uint256 balanceBefore = usdc.balanceOf(address(this));
        tokenBridge.completeTransfer(encodedVAA);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;
        
        // Decode the payload to get recipient
        (address recipient) = abi.decode(vm.payload, (address));
        
        // Forward USDC to treasury
        usdc.safeTransfer(treasury, received);
        
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

    // ============ Admin Functions ============
    
    /**
     * @notice Authorize a DepositRouter on a source chain
     * @param chainId Wormhole chain ID
     * @param routerAddress Address of the DepositRouter (as bytes32)
     */
    function authorizeRouter(uint16 chainId, bytes32 routerAddress) external onlyOwner {
        authorizedRouters[chainId] = routerAddress;
        emit RouterAuthorized(chainId, routerAddress);
    }
    
    /**
     * @notice Revoke authorization for a source chain
     * @param chainId Wormhole chain ID
     */
    function revokeRouter(uint16 chainId) external onlyOwner {
        delete authorizedRouters[chainId];
        emit RouterRevoked(chainId);
    }
    
    /**
     * @notice Update DirectMint address
     * @param newDirectMint New DirectMint contract address
     */
    function setDirectMint(address newDirectMint) external onlyOwner {
        if (newDirectMint == address(0)) revert InvalidAddress();
        address old = directMint;
        directMint = newDirectMint;
        emit DirectMintUpdated(old, newDirectMint);
    }
    
    /**
     * @notice Update Treasury address
     * @param newTreasury New Treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
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
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
