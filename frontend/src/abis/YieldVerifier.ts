/** YieldVerifier ABI — on-chain yield verification layer */
export const YieldVerifierABI = [
  // Constructor
  { inputs: [{ name: "_admin", type: "address" }], stateMutability: "nonpayable", type: "constructor" },
  // Constants
  { inputs: [], name: "DEFAULT_TOLERANCE_BPS", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MANAGER_ROLE", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  // Adapter management
  { inputs: [{ name: "protocolId", type: "uint256" }, { name: "adapter", type: "address" }], name: "registerAdapter", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "protocolId", type: "uint256" }], name: "deactivateAdapter", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "protocolId", type: "uint256" }, { name: "toleranceBps", type: "uint256" }], name: "setTolerance", outputs: [], stateMutability: "nonpayable", type: "function" },
  // Views
  { inputs: [], name: "adapterCount", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "protocolId", type: "uint256" }], name: "hasAdapter", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "protocolId", type: "uint256" }], name: "getTolerance", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [], name: "getAdapters",
    outputs: [
      { name: "protocolIds", type: "uint256[]" },
      { name: "infos", type: "tuple[]", components: [
        { name: "adapter", type: "address" },
        { name: "name", type: "string" },
        { name: "active", type: "bool" },
      ]},
    ],
    stateMutability: "view", type: "function",
  },
  // Core: Verify
  {
    inputs: [
      { name: "protocolId", type: "uint256" },
      { name: "venue", type: "address" },
      { name: "extraData", type: "bytes32" },
      { name: "expectedApyBps", type: "uint256" },
    ],
    name: "verify",
    outputs: [
      { name: "result", type: "tuple", components: [
        { name: "passed", type: "bool" },
        { name: "liveSupplyApyBps", type: "uint256" },
        { name: "liveBorrowApyBps", type: "uint256" },
        { name: "liveTvlUsd6", type: "uint256" },
        { name: "liveUtilizationBps", type: "uint256" },
        { name: "liveAvailable", type: "bool" },
        { name: "apyDeviation", type: "int256" },
      ]},
    ],
    stateMutability: "view", type: "function",
  },
  // Core: Quick verify
  {
    inputs: [
      { name: "protocolId", type: "uint256" },
      { name: "venue", type: "address" },
      { name: "extraData", type: "bytes32" },
      { name: "expectedApyBps", type: "uint256" },
    ],
    name: "quickVerify",
    outputs: [{ name: "passed", type: "bool" }],
    stateMutability: "view", type: "function",
  },
  // Core: Batch verify
  {
    inputs: [
      { name: "items", type: "tuple[]", components: [
        { name: "protocolId", type: "uint256" },
        { name: "venue", type: "address" },
        { name: "extraData", type: "bytes32" },
        { name: "expectedApyBps", type: "uint256" },
      ]},
    ],
    name: "batchVerify",
    outputs: [
      { name: "results", type: "tuple[]", components: [
        { name: "passed", type: "bool" },
        { name: "liveSupplyApyBps", type: "uint256" },
        { name: "liveBorrowApyBps", type: "uint256" },
        { name: "liveTvlUsd6", type: "uint256" },
        { name: "liveUtilizationBps", type: "uint256" },
        { name: "liveAvailable", type: "bool" },
        { name: "apyDeviation", type: "int256" },
      ]},
      { name: "passedCount", type: "uint256" },
    ],
    stateMutability: "view", type: "function",
  },
  // Core: Read live data (no comparison)
  {
    inputs: [
      { name: "protocolId", type: "uint256" },
      { name: "venue", type: "address" },
      { name: "extraData", type: "bytes32" },
    ],
    name: "readLive",
    outputs: [
      { name: "success", type: "bool" },
      { name: "supplyApyBps", type: "uint256" },
      { name: "borrowApyBps", type: "uint256" },
      { name: "tvlUsd6", type: "uint256" },
      { name: "utilizationBps", type: "uint256" },
      { name: "available", type: "bool" },
    ],
    stateMutability: "view", type: "function",
  },
] as const;

export default YieldVerifierABI;
