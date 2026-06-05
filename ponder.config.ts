import { createConfig } from "ponder";

import { aclAbi, confidentialTokenWithWrapperAbi } from "./src/abi/confidential-token.js";
import { env, SEPOLIA_CHAIN_ID } from "./src/config.js";

export default createConfig({
  database: {
    kind: "pglite",
    directory: "./.ponder/pglite",
  },
  chains: {
    sepolia: {
      id: SEPOLIA_CHAIN_ID,
      rpc: env.rpcUrl,
    },
  },
  contracts: {
    ConfidentialToken: {
      chain: "sepolia",
      abi: confidentialTokenWithWrapperAbi,
      address: env.tokenAddress,
      startBlock: env.startBlock,
    },
    FhevmAcl: {
      chain: "sepolia",
      abi: aclAbi,
      address: env.aclAddress,
      startBlock: env.startBlock,
      filter: {
        event: "DelegatedForUserDecryption",
        args: { delegate: env.indexerAddress, contractAddress: env.tokenAddress },
      },
    },
  },
});
