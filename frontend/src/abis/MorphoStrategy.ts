export const MORPHO_STRATEGY_ABI = [
  // IStrategy
  "function deposit(uint256 amount) returns (uint256 deposited)",
  "function withdraw(uint256 amount) returns (uint256 withdrawn)",
  "function withdrawAll() returns (uint256 withdrawn)",
  "function totalValue() view returns (uint256)",
  "function asset() view returns (address)",
  "function isActive() view returns (bool)",
  // State
  "function morpho() view returns (address)",
  "function marketId() view returns (bytes32)",
  "function targetLtvBps() view returns (uint256)",
  "function safetyBufferBps() view returns (uint256)",
  "function targetLoops() view returns (uint256)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function totalPrincipal() view returns (uint256)",
  "function maxBorrowRateForProfit() view returns (uint256)",
  "function minSupplyRateRequired() view returns (uint256)",
  // Views
  "function getHealthFactor() view returns (uint256 healthFactor)",
  "function getCurrentLeverage() view returns (uint256 leverageX100)",
  "function getPosition() view returns (uint256 collateral, uint256 borrowed, uint256 principal, uint256 netValue)",
  "function checkProfitability() view returns (bool isProfitable, uint256 currentBorrowRate, uint256 maxAllowedRate)",
  // Strategist
  "function setParameters(uint256 _targetLtvBps, uint256 _targetLoops)",
  "function setSafetyBuffer(uint256 _safetyBufferBps)",
  "function setProfitabilityParams(uint256 _maxBorrowRate, uint256 _minSupplyRate)",
  "function setActive(bool _active)",
  // Guardian
  "function emergencyDeleverage()",
  "function pause()",
  // Timelock
  "function unpause()",
  "function recoverToken(address token, uint256 amount)",
] as const;
