import { db, publicClients } from "ponder:api";

import { confidentialTokenWithWrapperAbi } from "../abi/confidential-token.js";
import { env, SEPOLIA_CHAIN_ID } from "../config.js";
import { RawSqlSideTableRepository } from "./raw-sql-repository.js";
import { createIndexerApi } from "./app.js";
import type { TokenMetadata } from "./token.js";

const repository = new RawSqlSideTableRepository(db);

let tokenMetadataPromise: Promise<TokenMetadata> | undefined;

const loadTokenMetadata = async (): Promise<TokenMetadata> => {
  const [name, symbol, decimals, underlying] = await Promise.all([
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "name",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "symbol",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "decimals",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "underlying",
    }),
  ]);

  return {
    chainId: SEPOLIA_CHAIN_ID,
    address: env.tokenAddress,
    name,
    symbol,
    decimals,
    kind: "erc7984-erc20-wrapper",
    underlying,
  };
};

const getTokenMetadata = (): Promise<TokenMetadata> => {
  tokenMetadataPromise ??= loadTokenMetadata();
  return tokenMetadataPromise;
};

await repository.initSideTables();

export default createIndexerApi({
  repository,
  getTokenMetadata,
  getHeadBlock: () => publicClients.sepolia.getBlockNumber(),
});
