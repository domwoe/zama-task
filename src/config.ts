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

export const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }

  return parsed;
};

export const requireIndexerPrivateKey = (): `0x${string}` => {
  const privateKey = process.env.INDEXER_PRIVATE_KEY;

  if (privateKey === undefined || privateKey.length === 0) {
    throw new Error("INDEXER_PRIVATE_KEY is required for the real Zama decryptor");
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("INDEXER_PRIVATE_KEY must be a 32-byte hex private key");
  }

  return privateKey as `0x${string}`;
};

export const env = {
  aclAddress: normalizeAddress(process.env.FHEVM_ACL_ADDRESS),
  decryptBatchSize: parsePositiveInteger(process.env.DECRYPT_BATCH_SIZE, 25, "DECRYPT_BATCH_SIZE"),
  decryptConcurrency: parsePositiveInteger(process.env.DECRYPT_CONCURRENCY, 4, "DECRYPT_CONCURRENCY"),
  decryptPollMs: parsePositiveInteger(process.env.DECRYPT_POLL_MS, 5_000, "DECRYPT_POLL_MS"),
  indexerAddress: normalizeAddress(process.env.INDEXER_ADDRESS),
  relayerApiKey: process.env.RELAYER_API_KEY,
  rpcUrl: process.env.SEPOLIA_RPC_URL ?? "http://127.0.0.1:8545",
  startBlock: parseStartBlock(process.env.START_BLOCK),
  tokenAddress: normalizeAddress(process.env.TOKEN_ADDRESS),
};
