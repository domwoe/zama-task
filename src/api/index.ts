import { Hono } from "hono";
import { publicClients } from "ponder:api";

import { confidentialTokenWithWrapperAbi } from "../abi/confidential-token.js";
import { env, SEPOLIA_CHAIN_ID } from "../config.js";

interface TokenMetadata {
  chainId: typeof SEPOLIA_CHAIN_ID;
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  kind: "erc7984-erc20-wrapper";
  underlying: `0x${string}`;
}

const app = new Hono();
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

app.get("/v1/health/live", (context) => {
  return context.json({ status: "live" });
});

app.get("/v1/token", async (context) => {
  return context.json(await getTokenMetadata());
});

export default app;
