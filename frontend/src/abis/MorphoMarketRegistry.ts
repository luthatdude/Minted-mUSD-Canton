export const MORPHO_MARKET_REGISTRY_ABI = [
  // Admin
  "function addMarket(bytes32 marketId, string label)",
  "function removeMarket(bytes32 marketId)",
  "function updateLabel(bytes32 marketId, string newLabel)",
  // Views
  "function morpho() view returns (address)",
  "function marketCount() view returns (uint256)",
  "function isWhitelisted(bytes32 marketId) view returns (bool)",
  "function getWhitelistedMarkets() view returns (bytes32[])",
  "function getMarketInfo(bytes32 marketId) view returns (tuple(bytes32 marketId, string label, address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 totalSupplyAssets, uint256 totalBorrowAssets, uint256 utilizationBps, uint256 borrowRateAnnualized, uint256 supplyRateAnnualized))",
  "function getAllMarketInfo() view returns (tuple(bytes32 marketId, string label, address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 totalSupplyAssets, uint256 totalBorrowAssets, uint256 utilizationBps, uint256 borrowRateAnnualized, uint256 supplyRateAnnualized)[])",
  // Events
  "event MarketAdded(bytes32 indexed marketId, string label)",
  "event MarketRemoved(bytes32 indexed marketId)",
  "event MarketLabelUpdated(bytes32 indexed marketId, string newLabel)",
] as const;
