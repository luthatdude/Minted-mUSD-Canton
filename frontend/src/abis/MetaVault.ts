export const META_VAULT_ABI = [
  // ── IStrategy interface ──
  "function deposit(uint256 amount) returns (uint256 deposited)",
  "function withdraw(uint256 amount) returns (uint256 withdrawn)",
  "function withdrawAll() returns (uint256 withdrawn)",
  "function totalValue() view returns (uint256)",
  "function asset() view returns (address)",
  "function isActive() view returns (bool)",

  // ── View functions ──
  "function sharePrice() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function highWaterMark() view returns (uint256)",
  "function performanceFeeBps() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function rebalanceThresholdBps() view returns (uint256)",
  "function autoAllocateEnabled() view returns (bool)",
  "function strategyActive() view returns (bool)",
  "function vaultCount() view returns (uint256)",
  "function getAllVaults() view returns (tuple(address strategy, uint256 targetBps, bool active)[])",
  "function getCurrentAllocations() view returns (address[] strategies, uint256[] currentBps, uint256[] targetBps)",
  "function vaults(uint256 index) view returns (address strategy, uint256 targetBps, bool active)",

  // ── Vault management ──
  "function addVault(address strategy, uint256 targetBps)",
  "function removeVault(address strategy)",
  "function updateVault(address strategy, uint256 newTargetBps, bool active)",

  // ── Share-based deposit/withdraw ──
  "function depositShares(uint256 amount) returns (uint256 sharesIssued)",
  "function withdrawShares(uint256 shares) returns (uint256 amountReturned)",

  // ── Keeper / Admin ──
  "function rebalance()",
  "function collectFees()",
  "function setPerformanceFee(uint256 feeBps)",
  "function setFeeRecipient(address recipient)",
  "function setRebalanceThreshold(uint256 thresholdBps)",
  "function setAutoAllocate(bool enabled)",
  "function setStrategyActive(bool active)",

  // ── Emergency ──
  "function emergencyWithdrawFromVault(address strategy)",
  "function emergencyWithdrawAll()",
  "function pause()",
  "function unpause()",

  // ── Roles ──
  "function DEPOSITOR_ROLE() view returns (bytes32)",
  "function ALLOCATOR_ROLE() view returns (bytes32)",
  "function STRATEGIST_ROLE() view returns (bytes32)",
  "function GUARDIAN_ROLE() view returns (bytes32)",
  "function KEEPER_ROLE() view returns (bytes32)",
  "function TREASURY_ROLE() view returns (bytes32)",

  // ── Events ──
  "event VaultAdded(address indexed strategy, uint256 targetBps)",
  "event VaultRemoved(address indexed strategy)",
  "event VaultUpdated(address indexed strategy, uint256 newTargetBps, bool active)",
  "event Deposited(address indexed from, uint256 amount, uint256 sharesIssued)",
  "event Withdrawn(address indexed to, uint256 amount, uint256 sharesBurned)",
  "event Rebalanced(uint256 totalValue, uint256 vaultsAdjusted)",
  "event FeesAccrued(uint256 newFees, uint256 totalAccrued)",
  "event FeesCollected(address indexed recipient, uint256 amount)",
  "event EmergencyWithdrawn(address indexed strategy, uint256 amount)",
] as const;
