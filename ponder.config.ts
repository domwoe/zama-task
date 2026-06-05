import { createConfig } from "ponder";

import { aclAbi, confidentialTokenWithWrapperAbi } from "./src/abi/confidential-token.js";
import { env } from "./src/config.js";

type ConfidentialTokenFilter = (
  | { event: "ConfidentialTransfer"; args: { from?: readonly `0x${string}`[]; to?: readonly `0x${string}`[] } }
  | { event: "UnwrapRequested"; args: { receiver: readonly `0x${string}`[] } }
  | { event: "UnwrapFinalized"; args: { receiver: readonly `0x${string}`[] } }
  | { event: "AmountDisclosed"; args: { encryptedAmount: null } }
)[];

const confidentialTokenFilter =
  env.indexedAddresses.length === 0
    ? undefined
    : ([
        { event: "ConfidentialTransfer" as const, args: { from: env.indexedAddresses } },
        { event: "ConfidentialTransfer" as const, args: { to: env.indexedAddresses } },
        { event: "UnwrapRequested" as const, args: { receiver: env.indexedAddresses } },
        { event: "UnwrapFinalized" as const, args: { receiver: env.indexedAddresses } },
        { event: "AmountDisclosed" as const, args: { encryptedAmount: null } },
      ] satisfies ConfidentialTokenFilter);

// Only `delegator` and `delegate` are indexed on DelegatedForUserDecryption, so the
// filter can only constrain those; `contractAddress` is non-indexed and is checked in
// the indexing handler instead (src/index.ts).
const aclFilterArgs =
  env.indexedAddresses.length === 0
    ? { delegate: env.indexerAddress }
    : { delegator: env.indexedAddresses, delegate: env.indexerAddress };

export default createConfig({
  database: {
    kind: "pglite",
    directory: process.env.PONDER_DB_DIR ?? "./.ponder/pglite",
  },
  chains: {
    sepolia: {
      id: env.chainId,
      rpc: env.rpcUrl,
    },
  },
  contracts: {
    ConfidentialToken: {
      chain: "sepolia",
      abi: confidentialTokenWithWrapperAbi,
      address: env.tokenAddress,
      startBlock: env.startBlock,
      ...(confidentialTokenFilter === undefined ? {} : { filter: confidentialTokenFilter }),
    },
    FhevmAcl: {
      chain: "sepolia",
      abi: aclAbi,
      address: env.aclAddress,
      startBlock: env.startBlock,
      filter: {
        event: "DelegatedForUserDecryption",
        args: aclFilterArgs,
      },
    },
  },
});
