import { MemoryStorage, ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia as zamaSepoliaPreset } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

export interface DemoSdkContext {
  readonly accountAddress: Address;
  readonly account: Account;
  readonly sdk: ZamaSDK;
  readonly tokenAddress: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  dispose(): void;
}

export interface MintResult {
  readonly underlying: Address;
  readonly txHash: Hex;
}

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
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
    account,
    sdk,
    tokenAddress,
    publicClient,
    walletClient,
    dispose() {
      sdk.terminate();
    },
  };
};

export const wrapperUnderlyingAbi = [
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const erc20MintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const tokenReadAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

// Mints the wrapper's public underlying ERC-20 to the holder so a fresh clone has
// tokens to shield. The demo underlying is a mock ERC-20 with an unrestricted
// mint(); against a real underlying without one this reverts, which is expected.
export const mintUnderlying = async (
  context: DemoSdkContext,
  amount: bigint,
): Promise<MintResult> => {
  const underlying = await context.publicClient.readContract({
    address: context.tokenAddress,
    abi: wrapperUnderlyingAbi,
    functionName: "underlying",
  });
  const txHash = await context.walletClient.writeContract({
    address: underlying,
    abi: erc20MintAbi,
    functionName: "mint",
    args: [context.accountAddress, amount],
    account: context.account,
    chain: viemSepolia,
  });
  await context.publicClient.waitForTransactionReceipt({ hash: txHash });

  return { underlying, txHash };
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
