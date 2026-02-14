export const PENDLE_STRATEGY_ABI = [
  // View functions
  "function currentMarket() view returns (address)",
  "function currentPT() view returns (address)",
  "function currentSY() view returns (address)",
  "function currentExpiry() view returns (uint256)",
  "function ptBalance() view returns (uint256)",
  "function totalValue() view returns (uint256)",
  "function slippageBps() view returns (uint256)",
  "function ptDiscountRateBps() view returns (uint256)",
  "function rolloverThreshold() view returns (uint256)",
  "function marketCategory() view returns (string)",
  "function active() view returns (bool)",
  "function paused() view returns (bool)",
  "function manualMarketSelection() view returns (bool)",
  "function shouldRollover() view returns (bool)",
  "function timeToExpiry() view returns (uint256)",
  "function isActive() view returns (bool)",
  "function asset() view returns (address)",
  // Multi-pool views
  "function idleBalance() view returns (uint256)",
  "function positionCount() view returns (uint256)",
  "function getPositions() view returns (address[] markets, uint256[] ptBalances, uint256[] expiries, uint256[] usdcValues)",
  // Multi-pool allocation
  "function allocateToMarket(address _market, uint256 usdcAmount)",
  "function deallocateFromMarket(address _market, uint256 usdcAmount)",
  "function deallocateAllFromMarket(address _market)",
  // Manual market selection
  "function setManualMode(bool _manual)",
  "function setMarketManual(address _market)",
  // Strategist controls
  "function setSlippage(uint256 _slippageBps)",
  "function setPtDiscountRate(uint256 _rateBps)",
  "function setRolloverThreshold(uint256 _threshold)",
  "function setActive(bool _active)",
  "function rollToNewMarket()",
  "function triggerRollover()",
  // Guardian
  "function pause()",
  "function emergencyWithdraw(address recipient)",
  // Timelock
  "function unpause()",
  "function setMarketSelector(address _selector)",
] as const;
