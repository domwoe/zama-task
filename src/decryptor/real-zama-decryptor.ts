import { ZamaSDK, type FheChain, type GenericLogger, type ZamaSDKEvent } from "@zama-fhe/sdk";
import { sepolia } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

import { env, requireIndexerPrivateKey, type ZamaSdkLogLevel } from "../config.js";
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
  logLevel?: ZamaSdkLogLevel;
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
    const logLevel = options.logLevel ?? "silent";
    const logger = createZamaSdkLogger(logLevel);
    const onEvent = createZamaSdkEventLogger(logLevel);
    writeZamaSdkLog(logLevel, "info", "real decryptor initialized", {
      chainId: zamaSepolia.id,
      relayerApiKeyConfigured: options.relayerApiKey !== undefined && options.relayerApiKey.length > 0,
      tokenAddress: options.tokenAddress,
    });

    this.#tokenAddress = options.tokenAddress;
    this.#sdk = new ZamaSDK(
      createConfig({
        chains: [zamaSepolia],
        publicClient,
        walletClient,
        storage: new PersistentSdkStorage(options.storage),
        ...(onEvent === undefined ? {} : { onEvent }),
        relayers: {
          [zamaSepolia.id]: node(logger === undefined ? undefined : { logger }),
        },
      }),
    );
  }

  async decryptTransferAmountAs(
    handle: `0x${string}`,
    delegator: Address,
  ): Promise<DecryptOutcome> {
    writeZamaSdkLog(env.zamaSdkLogLevel, "info", "delegated transfer decrypt start", {
      delegator,
      encryptedValue: handle,
      tokenAddress: this.#tokenAddress,
    });

    try {
      const values = await this.#sdk.decryption.delegatedDecrypt(
        [{ encryptedValue: handle, contractAddress: this.#tokenAddress }],
        delegator,
      );
      const value: unknown = values[handle];

      if (value === undefined) {
        writeZamaSdkLog(env.zamaSdkLogLevel, "warn", "delegated transfer decrypt returned no value", {
          delegator,
          encryptedValue: handle,
        });
        return {
          kind: "failure",
          failure: "decryptionFailed",
          errorCode: "DECRYPTION_FAILED",
          message: `Delegated decryption returned no value for ${handle}`,
        };
      }

      if (typeof value !== "bigint") {
        writeZamaSdkLog(env.zamaSdkLogLevel, "warn", "delegated transfer decrypt returned non-bigint", {
          delegator,
          encryptedValue: handle,
          valueType: typeof value,
        });
        return {
          kind: "failure",
          failure: "decryptionFailed",
          errorCode: "DECRYPTION_FAILED",
          message: `Delegated decryption returned a non-bigint value for ${handle}`,
        };
      }

      writeZamaSdkLog(env.zamaSdkLogLevel, "info", "delegated transfer decrypt success", {
        delegator,
        encryptedValue: handle,
      });
      return success(value);
    } catch (error) {
      const failure = matchDecryptFailure(error);
      writeZamaSdkLog(env.zamaSdkLogLevel, "warn", "delegated transfer decrypt failed", {
        delegator,
        encryptedValue: handle,
        error: summarizeError(error),
        failure: failure.failure,
        errorCode: failure.errorCode,
      });
      return failure;
    }
  }

  async decryptBalanceAs(holder: Address): Promise<DecryptOutcome> {
    writeZamaSdkLog(env.zamaSdkLogLevel, "info", "delegated balance decrypt start", {
      holder,
      tokenAddress: this.#tokenAddress,
    });

    try {
      const result = success(
        await this.#sdk.createToken(this.#tokenAddress).decryptBalanceAs({
          delegatorAddress: holder,
        }),
      );
      writeZamaSdkLog(env.zamaSdkLogLevel, "info", "delegated balance decrypt success", {
        holder,
      });
      return result;
    } catch (error) {
      const failure = matchDecryptFailure(error);
      writeZamaSdkLog(env.zamaSdkLogLevel, "warn", "delegated balance decrypt failed", {
        holder,
        error: summarizeError(error),
        failure: failure.failure,
        errorCode: failure.errorCode,
      });
      return failure;
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
    logLevel: env.zamaSdkLogLevel,
    ...(env.relayerApiKey === undefined || env.relayerApiKey.length === 0
      ? {}
      : { relayerApiKey: env.relayerApiKey }),
  });
};

type PrintableZamaSdkLogLevel = Exclude<ZamaSdkLogLevel, "silent">;

const logPriority = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
} as const satisfies Record<ZamaSdkLogLevel, number>;

const createZamaSdkLogger = (level: ZamaSdkLogLevel): GenericLogger | undefined => {
  if (level === "silent") {
    return undefined;
  }

  return {
    debug: (message, data) => {
      writeZamaSdkLog(level, "debug", message, data);
    },
    error: (message, data) => {
      writeZamaSdkLog(level, "error", message, data);
    },
    info: (message, data) => {
      writeZamaSdkLog(level, "info", message, data);
    },
    warn: (message, data) => {
      writeZamaSdkLog(level, "warn", message, data);
    },
  };
};

const createZamaSdkEventLogger = (
  level: ZamaSdkLogLevel,
): ((event: ZamaSDKEvent) => void) | undefined => {
  if (!shouldLog(level, "info")) {
    return undefined;
  }

  return (event) => {
    writeZamaSdkLog(level, "info", `event ${event.type}`, summarizeZamaSdkEvent(event));
  };
};

const shouldLog = (configuredLevel: ZamaSdkLogLevel, messageLevel: PrintableZamaSdkLogLevel): boolean => {
  return logPriority[configuredLevel] >= logPriority[messageLevel];
};

const writeZamaSdkLog = (
  configuredLevel: ZamaSdkLogLevel,
  messageLevel: PrintableZamaSdkLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void => {
  if (!shouldLog(configuredLevel, messageLevel)) {
    return;
  }

  const prefix = `[zama-sdk:${messageLevel}] ${message}`;
  switch (messageLevel) {
    case "debug":
      console.log(prefix, data ?? {});
      return;
    case "info":
      console.log(prefix, data ?? {});
      return;
    case "warn":
      console.warn(prefix, data ?? {});
      return;
    case "error":
      console.error(prefix, data ?? {});
      return;
  }
};

const safeEventKeys = [
  "durationMs",
  "operation",
  "operationId",
  "shieldPath",
  "step",
  "timestamp",
  "tokenAddress",
  "txHash",
] as const;

const summarizeZamaSdkEvent = (event: ZamaSDKEvent): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    type: event.type,
  };
  const eventRecord: Record<string, unknown> = isRecord(event) ? event : {};

  for (const key of safeEventKeys) {
    const value = eventRecord[key];
    if (value !== undefined) {
      summary[key] = value;
    }
  }

  const encryptedValues = eventRecord.encryptedValues;
  if (Array.isArray(encryptedValues)) {
    summary.encryptedValueCount = encryptedValues.length;
  }

  const result = eventRecord.result;
  if (isRecord(result)) {
    summary.resultCount = Object.keys(result).length;
  }

  const error = eventRecord.error;
  if (error !== undefined) {
    summary.error = summarizeError(error);
  }

  return summary;
};

const summarizeError = (error: unknown): Record<string, unknown> | string => {
  if (error instanceof Error) {
    const summary: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if ("code" in error && typeof error.code === "string") {
      summary.code = error.code;
    }
    return summary;
  }

  if (isRecord(error)) {
    const summary: Record<string, unknown> = {};
    for (const key of ["name", "code", "message"] as const) {
      const value = error[key];
      if (typeof value === "string") {
        summary[key] = value;
      }
    }
    return Object.keys(summary).length > 0 ? summary : "[object]";
  }

  return String(error);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};
