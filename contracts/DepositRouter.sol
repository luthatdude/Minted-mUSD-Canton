// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IWormholeRelayer.sol";
import "./interfaces/IWormholeTokenBridge.sol";

/**
 * @title DepositRouter
 * @notice Routes USDC deposits from L2 chains to Ethereum Treasury via Wormhole
 * @dev Deploy this on Base, Arbitrum, and other L2s to accept deposits
 * @dev Migrated from Ownable to AccessControl for role separation
 */
contract DepositRouter is AccessControl, ReentrancyGuard, Pausable {
 using SafeERC20 for IERC20;

 // ============ Roles ============
 
 /// @notice Role for pausing the contract (emergency response)
 bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
 
 /// @notice Role for administrative functions (config changes)
 bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");

 // ============ Constants ============
 
 uint16 public constant ETHEREUM_CHAIN_ID = 2; // Wormhole chain ID for Ethereum
 uint256 public constant GAS_LIMIT = 250_000;
 uint256 public constant MIN_DEPOSIT = 1e6; // 1 USDC minimum
 uint256 public constant MAX_DEPOSIT = 1_000_000e6; // 1M USDC maximum

 // ============ State Variables ============
 
 /// @notice USDC token on this chain
 IERC20 public immutable usdc;
 
 /// @notice Wormhole relayer for cross-chain messaging
 IWormholeRelayer public immutable wormholeRelayer;
 
 /// @notice Wormhole token bridge for token transfers
 IWormholeTokenBridge public immutable tokenBridge;
 
 /// @notice Treasury address on Ethereum (receives deposits)
 address public treasuryAddress;
 
 /// @notice DirectMint address on Ethereum (mints mUSD)
 address public directMintAddress;
 
 /// @notice Protocol fee in basis points (e.g., 30 = 0.30%)
 uint256 public feeBps;
 
 /// @notice Accumulated fees available for withdrawal
 uint256 public accumulatedFees;
 
 /// @notice Nonce for Wormhole transfers
 uint32 private _nonce;
 
 /// @notice Mapping of pending deposits by sequence number
 mapping(uint64 => PendingDeposit) public pendingDeposits;

 // ============ Structs ============
 
 struct PendingDeposit {
 address depositor;
 uint256 amount;
 uint256 fee;
 uint256 timestamp;
 bool completed;
 }

 // ============ Events ============
 
 event DepositInitiated(
 address indexed depositor,
 uint256 amount,
 uint256 fee,
 uint64 sequence,
 uint256 timestamp
 );
 
 event DepositCompleted(
 uint64 indexed sequence,
 address indexed depositor,
 uint256 amount
 );
 
 event TreasuryUpdated(address oldTreasury, address newTreasury);
 event DirectMintUpdated(address oldDirectMint, address newDirectMint);
 event FeeUpdated(uint256 oldFee, uint256 newFee);
 event FeesWithdrawn(address indexed to, uint256 amount);

 // ============ Errors ============
 
 error InvalidAddress();
 error InvalidAmount();
 error AmountBelowMinimum();
 error AmountAboveMaximum();
 error InsufficientNativeToken();
 error TransferFailed();
 error FeeTooHigh();

 // ============ Constructor ============
 
 constructor(
 address _usdc,
 address _wormholeRelayer,
 address _tokenBridge,
 address _treasuryAddress,
 address _directMintAddress,
 uint256 _feeBps,
 address _admin
 ) {
 if (_usdc == address(0)) revert InvalidAddress();
 if (_wormholeRelayer == address(0)) revert InvalidAddress();
 if (_tokenBridge == address(0)) revert InvalidAddress();
 if (_treasuryAddress == address(0)) revert InvalidAddress();
 if (_directMintAddress == address(0)) revert InvalidAddress();
 if (_admin == address(0)) revert InvalidAddress();
 if (_feeBps > 500) revert FeeTooHigh(); // Max 5%
 
 usdc = IERC20(_usdc);
 wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
 tokenBridge = IWormholeTokenBridge(_tokenBridge);
 treasuryAddress = _treasuryAddress;
 directMintAddress = _directMintAddress;
 feeBps = _feeBps;
 
 // Set up role hierarchy
 _grantRole(DEFAULT_ADMIN_ROLE, _admin);
 _grantRole(ROUTER_ADMIN_ROLE, _admin);
 _grantRole(PAUSER_ROLE, _admin);
 }

 // ============ External Functions ============
 
 /**
 * @notice Deposit USDC to be bridged to Ethereum Treasury
 * @param amount Amount of USDC to deposit (6 decimals)
 * @return sequence Wormhole sequence number for tracking
 */
 function deposit(uint256 amount) external payable nonReentrant whenNotPaused returns (uint64 sequence) {
 return _deposit(msg.sender, amount);
 }
 
 /**
 * @notice Deposit USDC on behalf of another address
 * @param recipient Address to receive mUSD on Ethereum
 * @param amount Amount of USDC to deposit
 * @return sequence Wormhole sequence number
 */
 function depositFor(address recipient, uint256 amount) external payable nonReentrant whenNotPaused returns (uint64 sequence) {
 if (recipient == address(0)) revert InvalidAddress();
 return _deposit(recipient, amount);
 }
 
 /**
 * @notice Preview the output for a deposit
 * @param amount Input USDC amount
 * @return netAmount Amount after fee
 * @return fee Protocol fee amount
 */
 function previewDeposit(uint256 amount) external view returns (uint256 netAmount, uint256 fee) {
 fee = (amount * feeBps) / 10000;
 netAmount = amount - fee;
 }
 
 /**
 * @notice Get quote for Wormhole delivery cost
 * @return nativeCost Amount of native token needed for bridge
 */
 function quoteBridgeCost() public view returns (uint256 nativeCost) {
 (nativeCost, ) = wormholeRelayer.quoteEVMDeliveryPrice(
 ETHEREUM_CHAIN_ID,
 0, // No native token to send
 GAS_LIMIT
 );
 }
 
 /**
 * @notice Check if a deposit has been completed
 * @param sequence Wormhole sequence number
 * @return completed Whether the deposit is complete
 */
 function isDepositComplete(uint64 sequence) external view returns (bool completed) {
 return pendingDeposits[sequence].completed;
 }
 
 /**
 * @notice Get deposit details
 * @param sequence Wormhole sequence number
 * @return deposit The pending deposit struct
 */
 function getDeposit(uint64 sequence) external view returns (PendingDeposit memory) {
 return pendingDeposits[sequence];
 }

 /**
 * @notice Mark a deposit as completed after cross-chain confirmation
 * @param sequence Wormhole sequence number of the completed deposit
 * @dev The completed flag was never set. This admin function
 * allows marking deposits as completed after TreasuryReceiver processes them.
 */
 function markDepositComplete(uint64 sequence) external onlyRole(ROUTER_ADMIN_ROLE) {
 // Renamed from 'deposit' to avoid shadowing the deposit() function
 PendingDeposit storage pendingDep = pendingDeposits[sequence];
 require(pendingDep.depositor != address(0), "DEPOSIT_NOT_FOUND");
 require(!pendingDep.completed, "ALREADY_COMPLETED");
 pendingDep.completed = true;
 emit DepositCompleted(sequence, pendingDep.depositor, pendingDep.amount);
 }

 /**
 * @notice Mark multiple deposits as completed in a single transaction
 * @param sequences Array of Wormhole sequence numbers
 */
 function markDepositsComplete(uint64[] calldata sequences) external onlyRole(ROUTER_ADMIN_ROLE) {
 for (uint256 i = 0; i < sequences.length; i++) {
 // Renamed from 'deposit' to avoid shadowing the deposit() function
 PendingDeposit storage pendingDep = pendingDeposits[sequences[i]];
 if (pendingDep.depositor != address(0) && !pendingDep.completed) {
 pendingDep.completed = true;
 emit DepositCompleted(sequences[i], pendingDep.depositor, pendingDep.amount);
 }
 }
 }

 // ============ Admin Functions ============
 
 /**
 * @notice Update the treasury address
 * @param newTreasury New treasury address on Ethereum
 */
 function setTreasury(address newTreasury) external onlyRole(ROUTER_ADMIN_ROLE) {
 if (newTreasury == address(0)) revert InvalidAddress();
 address old = treasuryAddress;
 treasuryAddress = newTreasury;
 emit TreasuryUpdated(old, newTreasury);
 }
 
 /**
 * @notice Update the DirectMint address
 * @param newDirectMint New DirectMint address on Ethereum
 */
 function setDirectMint(address newDirectMint) external onlyRole(ROUTER_ADMIN_ROLE) {
 if (newDirectMint == address(0)) revert InvalidAddress();
 address old = directMintAddress;
 directMintAddress = newDirectMint;
 emit DirectMintUpdated(old, newDirectMint);
 }
 
 /**
 * @notice Update the protocol fee
 * @param newFeeBps New fee in basis points
 */
 function setFee(uint256 newFeeBps) external onlyRole(ROUTER_ADMIN_ROLE) {
 if (newFeeBps > 500) revert FeeTooHigh();
 uint256 old = feeBps;
 feeBps = newFeeBps;
 emit FeeUpdated(old, newFeeBps);
 }
 
 /**
 * @notice Withdraw accumulated fees
 * @param to Address to receive fees
 */
 function withdrawFees(address to) external onlyRole(ROUTER_ADMIN_ROLE) {
 if (to == address(0)) revert InvalidAddress();
 uint256 amount = accumulatedFees;
 // Prevent zero-amount withdrawal (wastes gas + emits misleading event)
 require(amount > 0, "NO_FEES");
 accumulatedFees = 0;
 usdc.safeTransfer(to, amount);
 emit FeesWithdrawn(to, amount);
 }
 
 /**
 * @notice Pause deposits (Requires PAUSER_ROLE)
 */
 function pause() external onlyRole(PAUSER_ROLE) {
 _pause();
 }
 
 /**
 * @notice Unpause deposits (Requires DEFAULT_ADMIN_ROLE for separation of duties)
 */
 function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
 _unpause();
 }
 
 /**
 * @notice Emergency withdrawal
 * @param token Token to withdraw (use address(0) for native)
 * @param to Recipient address
 * @param amount Amount to withdraw
 */
 event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount);

 function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
 if (to == address(0)) revert InvalidAddress();
 // Block USDC withdrawal unless contract is paused (true emergency).
 // Prevents admin from draining in-flight user deposits during normal operation.
 if (token == address(usdc)) {
 require(paused(), "USDC_WITHDRAW_ONLY_WHEN_PAUSED");
 // Reset accumulated fees to prevent desync after emergency USDC withdrawal
 accumulatedFees = 0;
 }
 if (token == address(0)) {
 (bool success, ) = to.call{value: amount}("");
 if (!success) revert TransferFailed();
 } else {
 IERC20(token).safeTransfer(to, amount);
 }
 // Emit event for monitoring/audit trail
 emit EmergencyWithdrawal(token, to, amount);
 }

 // ============ Internal Functions ============
 
 function _deposit(address depositor, uint256 amount) internal returns (uint64 sequence) {
 // Validate amount
 if (amount == 0) revert InvalidAmount();
 if (amount < MIN_DEPOSIT) revert AmountBelowMinimum();
 if (amount > MAX_DEPOSIT) revert AmountAboveMaximum();
 
 // Calculate fee
 uint256 fee = (amount * feeBps) / 10000;
 uint256 netAmount = amount - fee;
 
 // Get bridge cost quote
 uint256 bridgeCost = quoteBridgeCost();
 if (msg.value < bridgeCost) revert InsufficientNativeToken();
 
 // Transfer USDC from depositor
 usdc.safeTransferFrom(msg.sender, address(this), amount);
 
 // Accumulate fees
 accumulatedFees += fee;
 
 // Use forceApprove for USDT-safe approval
 usdc.forceApprove(address(tokenBridge), netAmount);
 
 // Increment nonce
 _nonce++;
 
 // Convert treasury address to bytes32 (receiver contract)
 bytes32 treasuryReceiverBytes = bytes32(uint256(uint160(treasuryAddress)));
 
 // Encode the actual depositor as payload so TreasuryReceiver
 // knows who to mint mUSD for. Without this, TreasuryReceiver's
 // abi.decode(vm.payload, (address)) would fail on empty payload.
 bytes memory recipientPayload = abi.encode(depositor);
 
 // Initiate Wormhole token transfer WITH PAYLOAD
 // slither-disable-next-line reentrancy-benign
 sequence = tokenBridge.transferTokensWithPayload{value: bridgeCost}(
 address(usdc),
 netAmount,
 ETHEREUM_CHAIN_ID,
 treasuryReceiverBytes,
 _nonce,
 recipientPayload
 );
 
 // Store pending deposit
 pendingDeposits[sequence] = PendingDeposit({
 depositor: depositor,
 amount: netAmount,
 fee: fee,
 timestamp: block.timestamp,
 completed: false
 });
 
 emit DepositInitiated(depositor, netAmount, fee, sequence, block.timestamp);
 
 // Refund excess native token
 if (msg.value > bridgeCost) {
 (bool success, ) = msg.sender.call{value: msg.value - bridgeCost}("");
 if (!success) revert TransferFailed();
 }
 }
 
 // ============ Receive ============
 
 receive() external payable {}
}
