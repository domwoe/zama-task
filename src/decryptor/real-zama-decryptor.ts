import { ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

import { env, requireIndexerPrivateKey } from "../config.js";
import type { Decryptor } from "./decryptor.js";
import type { SdkStorageRecordStore } from "./generic-storage.js";
import { PersistentSdkStorage } from "./generic-storage.js";
import { matchDecryptFailure, success, type DecryptOutcome } from "./outcome.js";

export interface RealZamaDecryptorOptions {
  tokenAddress: Address;
  rpcUrl: string;
  indexerPrivateKey: `0x${string}`;
  storage: SdkStorageRecordStore;
  relayerApiKey?: string;
}

export class RealZamaDecryptor implements Decryptor, Disposable {
  readonly #sdk: ZamaSDK;
  readonly #tokenAddress: Address;

  constructor(options: RealZamaDecryptorOptions) {
    const transport = http(options.rpcUrl);
    const account = privateKeyToAccount(options.indexerPrivateKey);
    const publicClient = createPublicClient({ chain: viemSepolia, transport });
    const walletClient = createWalletClient({ account, chain: viemSepolia, transport });
    const zamaSepolia = {
      ...sepolia,
      network: options.rpcUrl,
      ...(options.relayerApiKey === undefined || options.relayerApiKey.length === 0
        ? {}
        : { auth: { __type: "ApiKeyHeader" as const, value: options.relayerApiKey } }),
    } as const satisfies FheChain;

    this.#tokenAddress = options.tokenAddress;
    this.#sdk = new ZamaSDK(
      createConfig({
        chains: [zamaSepolia],
        publicClient,
        walletClient,
        storage: new PersistentSdkStorage(options.storage),
        relayers: {
          [zamaSepolia.id]: node(),
        },
      }),
    );
  }

  async decryptTransferAmountAs(
    handle: `0x${string}`,
    delegator: Address,
  ): Promise<DecryptOutcome> {
    try {
      const values = await this.#sdk.decryption.delegatedDecrypt(
        [{ encryptedValue: handle, contractAddress: this.#tokenAddress }],
        delegator,
      );
      const value: unknown = values[handle];

      if (value === undefined) {
        return {
          kind: "failure",
          failure: "decryptionFailed",
          errorCode: "DECRYPTION_FAILED",
          message: `Delegated decryption returned no value for ${handle}`,
        };
      }

      if (typeof value !== "bigint") {
        return {
          kind: "failure",
          failure: "decryptionFailed",
          errorCode: "DECRYPTION_FAILED",
          message: `Delegated decryption returned a non-bigint value for ${handle}`,
        };
      }

      return success(value);
    } catch (error) {
      return matchDecryptFailure(error);
    }
  }

  async decryptBalanceAs(holder: Address): Promise<DecryptOutcome> {
    try {
      return success(
        await this.#sdk.createToken(this.#tokenAddress).decryptBalanceAs({
          delegatorAddress: holder,
        }),
      );
    } catch (error) {
      return matchDecryptFailure(error);
    }
  }

  [Symbol.dispose](): void {
    this.#sdk.terminate();
  }
}

export const createRealZamaDecryptor = (storage: SdkStorageRecordStore): RealZamaDecryptor => {
  return new RealZamaDecryptor({
    tokenAddress: env.tokenAddress,
    rpcUrl: env.rpcUrl,
    indexerPrivateKey: requireIndexerPrivateKey(),
    storage,
    ...(env.relayerApiKey === undefined || env.relayerApiKey.length === 0
      ? {}
      : { relayerApiKey: env.relayerApiKey }),
  });
};
