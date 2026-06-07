import { getAddress, isAddress, zeroAddress } from "viem";
import { z } from "zod";

export const SEPOLIA_CHAIN_ID = 11155111;
export const DEFAULT_START_BLOCK = "latest";
const zamaSdkLogLevels = ["silent", "error", "warn", "info", "debug"] as const;

export type ZamaSdkLogLevel = (typeof zamaSdkLogLevels)[number];

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
  if (value === undefined || value.length === 0 || value === DEFAULT_START_BLOCK) {
    return DEFAULT_START_BLOCK;
  }

  const block = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`START_BLOCK must be a non-negative integer, "latest", or unset, got: ${value}`);
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
  const privateKey = parsedEnv.INDEXER_PRIVATE_KEY;

  if (privateKey === undefined || privateKey.length === 0) {
    throw new Error("INDEXER_PRIVATE_KEY is required for the real Zama decryptor");
  }

  return privateKey;
};

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.length === 0 ? undefined : value;

const optionalAddressSchema = z
  .preprocess(emptyStringToUndefined, z.string().optional())
  .transform((value) => normalizeAddress(value));

const addressListSchema = z
  .preprocess(emptyStringToUndefined, z.string().optional())
  .transform((value): readonly `0x${string}`[] => {
    if (value === undefined) {
      return [];
    }

    return value
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0)
      .map((address) => normalizeAddress(address));
  });

const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key")
  .transform((value) => value as `0x${string}`);

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex string")
  .transform((value) => value as `0x${string}`);

const envSchema = z.object({
  CHAIN_ID: z
    .preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional())
    .default(SEPOLIA_CHAIN_ID),
  DECRYPT_BATCH_SIZE: z
    .preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional())
    .default(25),
  DECRYPT_CONCURRENCY: z
    .preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional())
    .default(4),
  DECRYPT_POLL_MS: z
    .preprocess(emptyStringToUndefined, z.coerce.number().int().positive().optional())
    .default(5_000),
  DECRYPTOR_MODE: z.preprocess(emptyStringToUndefined, z.enum(["real", "fake"]).optional()).default("real"),
  FAKE_DECRYPTOR_ACCOUNTS: z.preprocess(emptyStringToUndefined, z.string().optional()),
  FAKE_DECRYPTOR_CLEARTEXT: z.preprocess(
    emptyStringToUndefined,
    z.string().regex(/^\d+$/, "must be an unsigned integer string").optional(),
  ),
  FAKE_DECRYPTOR_HANDLE: z.preprocess(emptyStringToUndefined, bytes32Schema.optional()),
  FHEVM_ACL_ADDRESS: optionalAddressSchema,
  INDEXED_ADDRESSES: addressListSchema,
  INDEXER_ADDRESS: optionalAddressSchema,
  INDEXER_PRIVATE_KEY: z.preprocess(emptyStringToUndefined, privateKeySchema.optional()),
  RELAYER_API_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
  SEPOLIA_RPC_URL: z.preprocess(emptyStringToUndefined, z.string().optional()).default("http://127.0.0.1:8545"),
  START_BLOCK: z
    .preprocess(emptyStringToUndefined, z.string().optional())
    .transform((value) => parseStartBlock(value)),
  TOKEN_ADDRESS: optionalAddressSchema,
  ZAMA_SDK_LOG_LEVEL: z
    .preprocess(emptyStringToUndefined, z.enum(zamaSdkLogLevels).optional())
    .default("debug"),
});

const loadEnv = (): z.infer<typeof envSchema> => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
};

const parsedEnv = loadEnv();

export const env = {
  aclAddress: parsedEnv.FHEVM_ACL_ADDRESS,
  chainId: parsedEnv.CHAIN_ID,
  decryptBatchSize: parsedEnv.DECRYPT_BATCH_SIZE,
  decryptConcurrency: parsedEnv.DECRYPT_CONCURRENCY,
  decryptPollMs: parsedEnv.DECRYPT_POLL_MS,
  /** 'fake' uses FakeDecryptor with deterministic test handles; 'real' uses the Zama SDK. */
  decryptorMode: parsedEnv.DECRYPTOR_MODE,
  fakeDecryptorAccounts: parsedEnv.FAKE_DECRYPTOR_ACCOUNTS,
  fakeDecryptorCleartext: parsedEnv.FAKE_DECRYPTOR_CLEARTEXT,
  fakeDecryptorHandle: parsedEnv.FAKE_DECRYPTOR_HANDLE,
  indexedAddresses: parsedEnv.INDEXED_ADDRESSES,
  indexerAddress: parsedEnv.INDEXER_ADDRESS,
  relayerApiKey: parsedEnv.RELAYER_API_KEY,
  rpcUrl: parsedEnv.SEPOLIA_RPC_URL,
  startBlock: parsedEnv.START_BLOCK,
  tokenAddress: parsedEnv.TOKEN_ADDRESS,
  zamaSdkLogLevel: parsedEnv.ZAMA_SDK_LOG_LEVEL,
};
