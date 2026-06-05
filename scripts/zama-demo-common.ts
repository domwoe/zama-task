import { MemoryStorage, ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia as zamaSepoliaPreset } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

loadDotEnv();

export interface DemoSdkContext {
  readonly accountAddress: Address;
  readonly sdk: ZamaSDK;
  readonly tokenAddress: Address;
  dispose(): void;
}

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
};

export const optionalAddressEnv = (name: string): Address | null => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return null;
  }

  return parseAddress(value, name);
};

export const requireAddressEnv = (name: string): Address => parseAddress(requireEnv(name), name);

export const requirePrivateKeyEnv = (name: string): Hex => {
  const value = requireEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }

  return value as Hex;
};

export const optionalAmountEnv = (name: string): bigint | null => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return null;
  }

  return parseAmount(value, name);
};

export const requireAmountEnv = (name: string): bigint => parseAmount(requireEnv(name), name);

export const createDemoSdk = (privateKeyEnvName: string): DemoSdkContext => {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const tokenAddress = requireAddressEnv("TOKEN_ADDRESS");
  const account = privateKeyToAccount(requirePrivateKeyEnv(privateKeyEnvName));
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({
    chain: viemSepolia,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: viemSepolia,
    transport,
  });
  const zamaSepolia = {
    ...zamaSepoliaPreset,
    network: rpcUrl,
    ...(process.env.RELAYER_API_KEY === undefined || process.env.RELAYER_API_KEY.length === 0
      ? {}
      : {
          auth: {
            __type: "ApiKeyHeader" as const,
            value: process.env.RELAYER_API_KEY,
          },
        }),
  } as const satisfies FheChain;
  const sdk = new ZamaSDK(
    createConfig({
      chains: [zamaSepolia],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: {
        [zamaSepolia.id]: node(),
      },
    }),
  );

  return {
    accountAddress: account.address,
    sdk,
    tokenAddress,
    dispose() {
      sdk.terminate();
    },
  };
};

const parseAddress = (value: string, name: string): Address => {
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }

  return getAddress(value);
};

const parseAmount = (value: string, name: string): bigint => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative base-unit integer string`);
  }

  return BigInt(value);
};

function loadDotEnv(): void {
  if (!existsSync(".env")) {
    return;
  }

  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    process.env[key] ??= stripOptionalQuotes(rawValue);
  }
}

const stripOptionalQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
};
