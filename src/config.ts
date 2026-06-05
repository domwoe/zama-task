import { getAddress, isAddress, zeroAddress } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_START_BLOCK = "latest";

export const normalizeAddress = (
  value: string | undefined,
  fallback: `0x${string}` = zeroAddress,
): `0x${string}` => {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  if (!isAddress(value)) {
    throw new Error(`Invalid address in environment: ${value}`);
  }

  return getAddress(value);
};

export const parseStartBlock = (value: string | undefined): number | "latest" => {
  if (value === undefined || value.length === 0) {
    return DEFAULT_START_BLOCK;
  }

  const block = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`START_BLOCK must be a non-negative integer or unset, got: ${value}`);
  }

  return block;
};

export const env = {
  aclAddress: normalizeAddress(process.env.FHEVM_ACL_ADDRESS),
  indexerAddress: normalizeAddress(process.env.INDEXER_ADDRESS),
  rpcUrl: process.env.SEPOLIA_RPC_URL ?? "http://127.0.0.1:8545",
  startBlock: parseStartBlock(process.env.START_BLOCK),
  tokenAddress: normalizeAddress(process.env.TOKEN_ADDRESS),
};
