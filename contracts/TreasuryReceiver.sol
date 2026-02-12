// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/ITreasuryV2.sol";
import "./interfaces/IWormhole.sol";
import "./interfaces/ITokenBridge.sol";
import "./interfaces/IDirectMint.sol";
import "./TimelockGoverned.sol";

/**
 * @title TreasuryReceiver
 * @notice Receives bridged USDC from L2 DepositRouters and forwards to DirectMint
 * @dev Deploy this on Ethereum mainnet to receive cross-chain deposits
 * @dev Migrated from Ownable to AccessControl for role-based access
 * @dev Added Pausable for emergency controls
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
 // Events for mUSD minting success/fallback
 event MUSDMinted(address indexed recipient, uint256 usdcAmount, uint256 musdAmount, bytes32 vaaHash);
 event MintFallbackToTreasury(address indexed recipient, uint256 usdcAmount, bytes32 vaaHash);
 /// @notice Event for retry of failed mints
 event FailedMintRetried(address indexed recipient, uint256 amount, uint256 musdMinted);

 // ============ Failed Mint Tracking ============

 struct FailedMint {
 address recipient;
 uint256 amount;
 uint256 timestamp;
 }

 /// @notice Track failed mints for admin retry
 mapping(bytes32 => FailedMint) public failedMints;
 bytes32[] public failedMintIds;
 /// @notice Maximum failed mints before requiring cleanup
 uint256 public constant MAX_FAILED_MINTS = 100;

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
 address _treasury,
 address _timelock
 ) {
 if (_usdc == address(0)) revert InvalidAddress();
 if (_wormhole == address(0)) revert InvalidAddress();
 if (_tokenBridge == address(0)) revert InvalidAddress();
 if (_directMint == address(0)) revert InvalidAddress();
 if (_treasury == address(0)) revert InvalidAddress();
 
 _setTimelock(_timelock);
 usdc = IERC20(_usdc);
 wormhole = IWormhole(_wormhole);
 tokenBridge = ITokenBridge(_tokenBridge);
 directMint = _directMint;
 treasury = _treasury;
 
 // Grant roles
 _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
 _grantRole(BRIDGE_ADMIN_ROLE, msg.sender);
 _grantRole(PAUSER_ROLE, msg.sender);
 }

 // ============ External Functions ============
 
 /**
 * @notice Complete a cross-chain deposit and mint mUSD
 * @param encodedVAA Wormhole VAA from the source chain
 * @dev Added whenNotPaused for emergency controls
 */
 function receiveAndMint(bytes calldata encodedVAA) external nonReentrant whenNotPaused {
 // Parse and verify the VAA
 // Suppress unused 'reason' compiler warning
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
 // Reject zero-amount transfers to prevent wasted failedMintIds slots
 require(received > 0, "ZERO_AMOUNT_RECEIVED");
 
 // Parse Wormhole Token Bridge TransferWithPayload (type 3) format.
 // Layout: payloadID(1) + amount(32) + tokenAddress(32) + tokenChain(2) +
 // to(32) + toChain(2) + fromAddress(32) + userPayload(variable)
 // Total fixed header = 133 bytes. User payload starts at offset 133.
 require(vm.payload.length >= 133 + 32, "INVALID_PAYLOAD_LENGTH");
 require(uint8(vm.payload[0]) == 3, "NOT_TRANSFER_WITH_PAYLOAD");
 
 // Extract user payload (the abi.encode(depositor) from DepositRouter)
 bytes memory userPayload = new bytes(vm.payload.length - 133);
 for (uint256 i = 0; i < userPayload.length; i++) {
 userPayload[i] = vm.payload[133 + i];
 }
 address recipient = abi.decode(userPayload, (address));
 
 // Actually mint mUSD for the recipient via DirectMint
 // Previously forwarded USDC to treasury but never minted mUSD
 usdc.forceApprove(directMint, received);
 try IDirectMint(directMint).mintFor(recipient, received) returns (uint256 musdMinted) {
 // Mark processed only after successful mint
 processedVAAs[vm.hash] = true;
 emit MUSDMinted(recipient, received, musdMinted, vm.hash);
 } catch {
 // If minting fails, forward to treasury as fallback (funds not lost)
 usdc.forceApprove(directMint, 0);
 usdc.safeTransfer(treasury, received);
 // Track failed mint for admin retry
 // Enforce max failed mints to prevent unbounded array growth
 require(failedMintIds.length < MAX_FAILED_MINTS, "TOO_MANY_FAILED_MINTS");
 failedMints[vm.hash] = FailedMint({
 recipient: recipient,
 amount: received,
 timestamp: block.timestamp
 });
 failedMintIds.push(vm.hash);
 // Mark processed after successful fallback transfer
 processedVAAs[vm.hash] = true;
 emit MintFallbackToTreasury(recipient, received, vm.hash);
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

 // ============ Admin Functions ============
 
 /**
 * @notice Authorize a DepositRouter on a source chain
 * @param chainId Wormhole chain ID
 * @param routerAddress Address of the DepositRouter (as bytes32)
 * @dev Changed from onlyOwner to role-based access
 */
 function authorizeRouter(uint16 chainId, bytes32 routerAddress) external onlyRole(BRIDGE_ADMIN_ROLE) {
 // Reject zero-address router to prevent misleading state
 require(routerAddress != bytes32(0), "ZERO_ROUTER_ADDRESS");
 authorizedRouters[chainId] = routerAddress;
 emit RouterAuthorized(chainId, routerAddress);
 }
 
 /**
 * @notice Revoke authorization for a source chain
 * @param chainId Wormhole chain ID
 * @dev Changed from onlyOwner to role-based access
 */
 function revokeRouter(uint16 chainId) external onlyRole(BRIDGE_ADMIN_ROLE) {
 delete authorizedRouters[chainId];
 emit RouterRevoked(chainId);
 }
 
 /**
 * @notice Update DirectMint address
 * @param newDirectMint New DirectMint contract address
 * @dev Changed from onlyOwner to DEFAULT_ADMIN_ROLE
 */
 function setDirectMint(address newDirectMint) external onlyRole(DEFAULT_ADMIN_ROLE) {
 if (newDirectMint == address(0)) revert InvalidAddress();
 address old = directMint;
 directMint = newDirectMint;
 emit DirectMintUpdated(old, newDirectMint);
 }
 
 /**
 * @notice Update Treasury address
 * @param newTreasury New Treasury address
 * @dev Changed from onlyOwner to DEFAULT_ADMIN_ROLE
 */
 function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
 * @dev Changed from onlyOwner to DEFAULT_ADMIN_ROLE
 */
 event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount);

 function emergencyWithdraw(address token, address to, uint256 amount) external onlyTimelock {
 if (to == address(0)) revert InvalidAddress();
 // Block USDC withdrawal unless contract is paused (true emergency).
 // When paused, admin needs full access to recover all tokens.
 require(token != address(usdc) || paused(), "USDC_WITHDRAW_ONLY_WHEN_PAUSED");
 IERC20(token).safeTransfer(to, amount);
 // Emit event for monitoring/audit trail
 emit EmergencyWithdrawal(token, to, amount);
 }

 /// @notice Retry a failed mint by pulling USDC from treasury
 /// @param vaaHash The VAA hash of the failed mint to retry
 // Added nonReentrant to prevent cross-function reentrancy
 function retryFailedMint(bytes32 vaaHash) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
 FailedMint storage fm = failedMints[vaaHash];
 require(fm.amount > 0, "NO_FAILED_MINT");

 address recipient = fm.recipient;
 uint256 amount = fm.amount;

 // Clear before external calls (CEI)
 delete failedMints[vaaHash];

 // Remove from failedMintIds array (swap-and-pop).
 // Without this cleanup, the array grows forever. After 100 cumulative
 // failures (even if all retried), MAX_FAILED_MINTS blocks new fallbacks,
 // permanently bricking bridge inflow.
 for (uint256 i = 0; i < failedMintIds.length; i++) {
 if (failedMintIds[i] == vaaHash) {
 failedMintIds[i] = failedMintIds[failedMintIds.length - 1];
 failedMintIds.pop();
 break;
 }
 }

 // Use treasury.withdraw() instead of safeTransferFrom.
 // safeTransferFrom requires treasury to have approved this contract (it doesn't).
 // withdraw() is the proper TreasuryV2 interface for pulling USDC.
 ITreasuryV2(treasury).withdraw(address(this), amount);
 usdc.forceApprove(directMint, amount);
 uint256 musdMinted = IDirectMint(directMint).mintFor(recipient, amount);

 emit FailedMintRetried(recipient, amount, musdMinted);
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
