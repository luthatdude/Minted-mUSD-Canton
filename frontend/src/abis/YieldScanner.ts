// Auto-generated ABI for YieldScanner.sol
export const YIELD_SCANNER_ABI = [
  // ─── Constructor ───
  // constructor(address _admin, address _usdc)

  // ─── Admin: Configure Protocols ───
  {
    inputs: [{ name: "_pool", type: "address" }],
    name: "configureAaveV3",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_comet", type: "address" }],
    name: "configureCompoundV3",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_pool", type: "address" }],
    name: "configureSpark",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_vault", type: "address" }],
    name: "configureSkySUSDS",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_vault", type: "address" }],
    name: "configureEthenaSUSDe",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "_blue", type: "address" },
      { name: "_registry", type: "address" },
    ],
    name: "configureMorpho",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_selector", type: "address" }],
    name: "configurePendle",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_vault", type: "address" }],
    name: "configureYearnV3",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "_pool", type: "address" },
      { name: "_gauge", type: "address" },
    ],
    name: "configureCurve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ─── Admin: Manual Entries ───
  {
    inputs: [
      { name: "_protocol", type: "uint8" },
      { name: "_label", type: "string" },
      { name: "_target", type: "address" },
      { name: "_marketId", type: "bytes32" },
    ],
    name: "addEntry",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "index", type: "uint256" },
      { name: "enabled", type: "bool" },
    ],
    name: "toggleEntry",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // ─── Core: Scan & Suggest ───
  {
    inputs: [],
    name: "scanAll",
    outputs: [
      {
        name: "opportunities",
        type: "tuple[]",
        components: [
          { name: "protocol", type: "uint8" },
          { name: "risk", type: "uint8" },
          { name: "label", type: "string" },
          { name: "venue", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "supplyApyBps", type: "uint256" },
          { name: "borrowApyBps", type: "uint256" },
          { name: "tvlUsd6", type: "uint256" },
          { name: "utilizationBps", type: "uint256" },
          { name: "extraData", type: "uint256" },
          { name: "available", type: "bool" },
        ],
      },
      { name: "count", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "maxSuggestions", type: "uint256" }],
    name: "getSuggestions",
    outputs: [
      {
        name: "suggestions",
        type: "tuple[]",
        components: [
          { name: "rank", type: "uint8" },
          { name: "protocol", type: "uint8" },
          { name: "label", type: "string" },
          { name: "venue", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "supplyApyBps", type: "uint256" },
          { name: "risk", type: "uint8" },
          { name: "reason", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "perTranche", type: "uint256" }],
    name: "getTranches",
    outputs: [
      {
        name: "senior",
        type: "tuple[]",
        components: [
          { name: "rank", type: "uint8" },
          { name: "tranche", type: "uint8" },
          { name: "protocol", type: "uint8" },
          { name: "label", type: "string" },
          { name: "venue", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "supplyApyBps", type: "uint256" },
          { name: "borrowApyBps", type: "uint256" },
          { name: "tvlUsd6", type: "uint256" },
          { name: "utilizationBps", type: "uint256" },
          { name: "risk", type: "uint8" },
          { name: "compositeScore", type: "uint256" },
          { name: "reason", type: "string" },
        ],
      },
      {
        name: "mezzanine",
        type: "tuple[]",
        components: [
          { name: "rank", type: "uint8" },
          { name: "tranche", type: "uint8" },
          { name: "protocol", type: "uint8" },
          { name: "label", type: "string" },
          { name: "venue", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "supplyApyBps", type: "uint256" },
          { name: "borrowApyBps", type: "uint256" },
          { name: "tvlUsd6", type: "uint256" },
          { name: "utilizationBps", type: "uint256" },
          { name: "risk", type: "uint8" },
          { name: "compositeScore", type: "uint256" },
          { name: "reason", type: "string" },
        ],
      },
      {
        name: "junior",
        type: "tuple[]",
        components: [
          { name: "rank", type: "uint8" },
          { name: "tranche", type: "uint8" },
          { name: "protocol", type: "uint8" },
          { name: "label", type: "string" },
          { name: "venue", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "supplyApyBps", type: "uint256" },
          { name: "borrowApyBps", type: "uint256" },
          { name: "tvlUsd6", type: "uint256" },
          { name: "utilizationBps", type: "uint256" },
          { name: "risk", type: "uint8" },
          { name: "compositeScore", type: "uint256" },
          { name: "reason", type: "string" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },

  // ─── Views ───
  {
    inputs: [],
    name: "entryCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAllEntries",
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "protocol", type: "uint8" },
          { name: "label", type: "string" },
          { name: "target", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getProtocolConfig",
    outputs: [
      { name: "_aave", type: "address" },
      { name: "_compound", type: "address" },
      { name: "_spark", type: "address" },
      { name: "_sUsds", type: "address" },
      { name: "_sUsde", type: "address" },
      { name: "_morpho", type: "address" },
      { name: "_morphoReg", type: "address" },
      { name: "_pendle", type: "address" },
      { name: "_yearn", type: "address" },
      { name: "_curve", type: "address" },
      { name: "_curveGauge", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },

  // ─── State Getters ───
  { inputs: [], name: "usdc", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "aaveV3Pool", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "compoundComet", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "sparkPool", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "sUsdsVault", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "sUsdeVault", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "morphoBlue", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "morphoRegistry", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "pendleSelector", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "yearnVault", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "curvePool", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "curveGauge", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },

  // ─── AccessControl ───
  { inputs: [], name: "MANAGER_ROLE", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "DEFAULT_ADMIN_ROLE", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "grantRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "revokeRole",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    name: "hasRole",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },

  // ─── Events ───
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "protocol", type: "uint8" },
      { indexed: false, name: "target", type: "address" },
    ],
    name: "ProtocolConfigured",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "index", type: "uint256" },
      { indexed: false, name: "protocol", type: "uint8" },
      { indexed: false, name: "label", type: "string" },
      { indexed: false, name: "target", type: "address" },
    ],
    name: "EntryAdded",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "index", type: "uint256" },
      { indexed: false, name: "enabled", type: "bool" },
    ],
    name: "EntryToggled",
    type: "event",
  },
] as const;
