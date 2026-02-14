export const StrategyFactoryABI = [
  {
    inputs: [
      { internalType: "address", name: "_treasury", type: "address" },
      { internalType: "address", name: "_admin", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  // ── Errors ──
  { inputs: [], name: "ZeroAddress", type: "error" },
  { inputs: [], name: "ImplementationNotSet", type: "error" },
  { inputs: [], name: "DeployFailed", type: "error" },
  { inputs: [], name: "InitializeFailed", type: "error" },
  { inputs: [], name: "RegistrationFailed", type: "error" },
  { inputs: [{ name: "protocolId", type: "uint256" }], name: "ProtocolAlreadyDeployed", type: "error" },
  { inputs: [], name: "NotValidStrategy", type: "error" },
  // ── Events ──
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "protocolId", type: "uint256" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "implementation", type: "address" },
    ],
    name: "ImplementationRegistered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "protocolId", type: "uint256" },
      { indexed: true, name: "proxy", type: "address" },
      { indexed: false, name: "implementation", type: "address" },
      { indexed: false, name: "targetBps", type: "uint256" },
    ],
    name: "StrategyDeployed",
    type: "event",
  },
  // ── Views ──
  {
    inputs: [],
    name: "treasury",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "protocolId", type: "uint256" }],
    name: "hasImplementation",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "protocolId", type: "uint256" }],
    name: "hasStrategy",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "protocolId", type: "uint256" }],
    name: "getStrategy",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "deployedCount",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getImplementations",
    outputs: [
      { name: "protocolIds", type: "uint256[]" },
      { name: "impls", type: "address[]" },
      { name: "names", type: "string[]" },
      { name: "activeFlags", type: "bool[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getDeployed",
    outputs: [
      {
        components: [
          { name: "protocolId", type: "uint256" },
          { name: "proxy", type: "address" },
          { name: "implementation", type: "address" },
          { name: "deployedAt", type: "uint256" },
          { name: "active", type: "bool" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  // ── Mutators ──
  {
    inputs: [
      { name: "protocolId", type: "uint256" },
      { name: "impl", type: "address" },
      { name: "name", type: "string" },
    ],
    name: "registerImplementation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "protocolId", type: "uint256" }],
    name: "deactivateImplementation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "protocolId", type: "uint256" },
      { name: "initData", type: "bytes" },
      { name: "targetBps", type: "uint256" },
      { name: "minBps", type: "uint256" },
      { name: "maxBps", type: "uint256" },
      { name: "autoAllocate", type: "bool" },
    ],
    name: "deployAndRegister",
    outputs: [{ name: "proxy", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "_treasury", type: "address" }],
    name: "setTreasury",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
