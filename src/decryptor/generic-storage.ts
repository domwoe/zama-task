import type { GenericStorage } from "@zama-fhe/sdk";

export interface SdkStorageRecordStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const sdkStorageJsonTypeKey = "__zamaConfidentialIndexerJsonType";
const sdkStorageBigintType = "bigint";
const serializedBigintPattern = /^-?(0|[1-9]\d*)$/;

interface SerializedSdkBigint {
  readonly [sdkStorageJsonTypeKey]: typeof sdkStorageBigintType;
  readonly value: string;
}

export const serializeSdkStorageValue = (value: unknown): string => {
  return JSON.stringify(value, sdkStorageJsonReplacer);
};

export const deserializeSdkStorageValue = (value: string): unknown => {
  return JSON.parse(value, sdkStorageJsonReviver) as unknown;
};

const sdkStorageJsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value !== "bigint") {
    return value;
  }

  return {
    [sdkStorageJsonTypeKey]: sdkStorageBigintType,
    value: value.toString(),
  } satisfies SerializedSdkBigint;
};

const sdkStorageJsonReviver = (_key: string, value: unknown): unknown => {
  if (!isRecord(value) || value[sdkStorageJsonTypeKey] !== sdkStorageBigintType) {
    return value;
  }

  const serializedValue = value.value;
  if (typeof serializedValue !== "string" || !serializedBigintPattern.test(serializedValue)) {
    throw new Error("Invalid bigint value in SDK storage JSON");
  }

  return BigInt(serializedValue);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export class PersistentSdkStorage implements GenericStorage {
  readonly #store: SdkStorageRecordStore;

  constructor(store: SdkStorageRecordStore) {
    this.#store = store;
  }

  // The SDK's GenericStorage contract is generic so callers can recover their
  // own stored value type. The backing store remains unknown at the boundary.
  get<T = unknown>(key: string): Promise<T | null> {
    return this.#store.get(key) as Promise<T | null>;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  set<T = unknown>(key: string, value: T): Promise<void> {
    return this.#store.set(key, value);
  }

  delete(key: string): Promise<void> {
    return this.#store.delete(key);
  }
}
