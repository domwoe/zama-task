import type { GenericStorage } from "@zama-fhe/sdk";

export interface SdkStorageRecordStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

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
