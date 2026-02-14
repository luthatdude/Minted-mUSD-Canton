export const GLOBAL_PAUSE_REGISTRY_ABI = [
  "function isGloballyPaused() view returns (bool)",
  "function lastPausedAt() view returns (uint256)",
  "function lastUnpausedAt() view returns (uint256)",
  "function pauseGlobal()",
  "function unpauseGlobal()",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function GUARDIAN_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "event GlobalPauseStateChanged(bool paused, address indexed caller)",
] as const;
