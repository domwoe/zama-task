export const confidentialTokenAbi = [
  {
    type: "event",
    name: "ConfidentialTransfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "bytes32", internalType: "euint64", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AmountDisclosed",
    inputs: [
      { name: "encryptedAmount", type: "bytes32", internalType: "euint64", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OperatorSet",
    inputs: [
      { name: "holder", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "until", type: "uint48", indexed: false },
    ],
  },
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes32", internalType: "euint64" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const confidentialWrapperAbi = [
  {
    type: "event",
    name: "UnwrapRequested",
    inputs: [
      { name: "receiver", type: "address", indexed: true },
      { name: "unwrapRequestId", type: "bytes32", indexed: true },
      { name: "amount", type: "bytes32", internalType: "euint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "UnwrapFinalized",
    inputs: [
      { name: "receiver", type: "address", indexed: true },
      { name: "unwrapRequestId", type: "bytes32", indexed: true },
      { name: "encryptedAmount", type: "bytes32", internalType: "euint64", indexed: false },
      { name: "cleartextAmount", type: "uint64", indexed: false },
    ],
  },
  {
    type: "function",
    name: "rate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const confidentialTokenWithWrapperAbi = [
  ...confidentialTokenAbi,
  ...confidentialWrapperAbi,
] as const;

export const aclAbi = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    inputs: [
      { name: "delegator", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "contractAddress", type: "address", indexed: true },
      { name: "expiry", type: "uint64", indexed: false },
      { name: "delegationCounter", type: "uint64", indexed: false },
    ],
  },
] as const;
