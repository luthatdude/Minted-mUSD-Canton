export const PENDLE_MARKET_SELECTOR_ABI = [
  // View functions
  "function getWhitelistedMarkets() view returns (address[])",
  "function whitelistedCount() view returns (uint256)",
  "function isWhitelisted(address market) view returns (bool)",
  "function marketCategory(address market) view returns (string)",
  "function getMarketInfo(address market) view returns (tuple(address market, address sy, address pt, uint256 expiry, uint256 timeToExpiry, uint256 totalPt, uint256 totalSy, uint256 tvlSy, uint256 impliedRate, uint256 impliedAPY, uint256 score))",
  "function getValidMarkets(string category) view returns (tuple(address market, address sy, address pt, uint256 expiry, uint256 timeToExpiry, uint256 totalPt, uint256 totalSy, uint256 tvlSy, uint256 impliedRate, uint256 impliedAPY, uint256 score)[])",
  "function selectBestMarket(string category) view returns (address bestMarket, tuple(address market, address sy, address pt, uint256 expiry, uint256 timeToExpiry, uint256 totalPt, uint256 totalSy, uint256 tvlSy, uint256 impliedRate, uint256 impliedAPY, uint256 score) info)",
  "function minTimeToExpiry() view returns (uint256)",
  "function minTvlUsd() view returns (uint256)",
  "function minApyBps() view returns (uint256)",
  "function tvlWeight() view returns (uint256)",
  "function apyWeight() view returns (uint256)",
  // Admin functions
  "function whitelistMarket(address market, string category)",
  "function removeMarket(address market)",
  "function setParams(uint256 _minTimeToExpiry, uint256 _minTvlUsd, uint256 _minApyBps, uint256 _tvlWeight, uint256 _apyWeight)",
] as const;
