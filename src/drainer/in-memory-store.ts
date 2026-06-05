import { getAddress, type Address } from "viem";

import type { DecryptionRow, DrainerStateRow } from "../db/drainer-schema.js";
import type { DecryptionStatus } from "../types/lifecycle.js";
import type {
  ActiveDelegationQuery,
  DecryptionWrite,
  DrainerDelegation,
  DrainerStore,
  DrainerTransfer,
  DrainerWorkItem,
} from "./store.js";

interface InMemoryDrainerStoreOptions {
  readonly transfers?: readonly DrainerTransfer[];
  readonly delegations?: readonly DrainerDelegation[];
  readonly decryptions?: readonly DecryptionRow[];
  readonly state?: DrainerStateRow;
}

const addressKey = (address: Address): string => getAddress(address).toLowerCase();

const rowForWrite = (row: DecryptionWrite): DecryptionRow => ({
  amountHandle: row.amountHandle,
  cleartextRaw: row.cleartextRaw,
  status: row.status,
  decryptedFor: row.decryptedFor,
  source: row.source,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  lastErrorCode: row.lastErrorCode,
  lastErrorAt: row.lastErrorAt,
});

const defaultState = (): DrainerStateRow => ({
  id: "singleton",
  lastSuccessAt: null,
  breakerState: "closed",
  breakerOpenedAt: null,
});

export class InMemoryDrainerStore implements DrainerStore {
  readonly #transfers = new Map<string, DrainerTransfer>();
  readonly #decryptions = new Map<`0x${string}`, DecryptionRow>();
  readonly #delegations: DrainerDelegation[] = [];
  #state: DrainerStateRow;

  constructor(options: InMemoryDrainerStoreOptions = {}) {
    for (const transfer of options.transfers ?? []) {
      this.#transfers.set(transfer.id, transfer);
    }

    for (const decryption of options.decryptions ?? []) {
      this.#decryptions.set(decryption.amountHandle, decryption);
    }

    this.#delegations.push(...(options.delegations ?? []));
    this.#state = options.state ?? defaultState();
  }

  addTransfer(transfer: DrainerTransfer): void {
    this.#transfers.set(transfer.id, transfer);
  }

  addDelegation(delegation: DrainerDelegation): void {
    const existingIndex = this.#delegations.findIndex(
      (existing) =>
        addressKey(existing.delegator) === addressKey(delegation.delegator) &&
        addressKey(existing.delegate) === addressKey(delegation.delegate) &&
        addressKey(existing.contractAddress) === addressKey(delegation.contractAddress),
    );

    if (existingIndex === -1) {
      this.#delegations.push(delegation);
      return;
    }

    this.#delegations[existingIndex] = delegation;
  }

  getDecryption(amountHandle: `0x${string}`): DecryptionRow | undefined {
    return this.#decryptions.get(amountHandle);
  }

  listDueTransfers(now: Date, limit: number): Promise<readonly DrainerWorkItem[]> {
    const oldestByHandle = new Map<`0x${string}`, DrainerTransfer>();

    for (const transfer of this.#transfers.values()) {
      if (transfer.disclosedRaw !== null) {
        continue;
      }

      const current = oldestByHandle.get(transfer.amountHandle);
      if (
        current === undefined ||
        transfer.blockNumber < current.blockNumber ||
        (transfer.blockNumber === current.blockNumber && transfer.logIndex < current.logIndex)
      ) {
        oldestByHandle.set(transfer.amountHandle, transfer);
      }
    }

    const due = [...oldestByHandle.values()]
      .map((transfer) => ({
        transfer,
        decryption: this.#decryptions.get(transfer.amountHandle) ?? null,
      }))
      .filter((item) => item.decryption?.status !== "decrypted")
      .filter((item) => item.decryption === null || item.decryption.nextAttemptAt <= now)
      .sort((left, right) => compareTransferOrder(left.transfer, right.transfer))
      .slice(0, limit);

    return Promise.resolve(due);
  }

  seedEncryptedDecryption(amountHandle: `0x${string}`, now: Date): Promise<DecryptionRow> {
    const existing = this.#decryptions.get(amountHandle);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    const row: DecryptionRow = {
      amountHandle,
      cleartextRaw: null,
      status: "encrypted",
      decryptedFor: null,
      source: null,
      attempts: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
    };
    this.#decryptions.set(amountHandle, row);
    return Promise.resolve(row);
  }

  writeDecryption(row: DecryptionWrite): Promise<void> {
    this.#decryptions.set(row.amountHandle, rowForWrite(row));
    return Promise.resolve();
  }

  listActiveDelegators(query: ActiveDelegationQuery): Promise<readonly Address[]> {
    const active = query.delegators.filter((delegator) =>
      this.#isActiveDelegation(delegator, query.delegate, query.contractAddress, query.at),
    );
    return Promise.resolve(active);
  }

  nudgeUnauthorizedForActiveDelegations(query: Omit<ActiveDelegationQuery, "delegators">): Promise<number> {
    let nudged = 0;

    for (const row of this.#decryptions.values()) {
      if (row.status !== "unauthorized" || row.nextAttemptAt <= query.at) {
        continue;
      }

      const transfer = this.#oldestTransferForHandle(row.amountHandle);
      if (transfer === undefined) {
        continue;
      }

      const candidates = orderedTransferCandidates(transfer);
      const hasActiveCandidate = candidates.some((candidate) =>
        this.#isActiveDelegation(candidate, query.delegate, query.contractAddress, query.at),
      );

      if (!hasActiveCandidate) {
        continue;
      }

      this.#decryptions.set(row.amountHandle, {
        ...row,
        nextAttemptAt: query.at,
      });
      nudged += 1;
    }

    return Promise.resolve(nudged);
  }

  getDrainerState(): Promise<DrainerStateRow> {
    return Promise.resolve(this.#state);
  }

  writeDrainerState(row: DrainerStateRow): Promise<void> {
    this.#state = row;
    return Promise.resolve();
  }

  #oldestTransferForHandle(amountHandle: `0x${string}`): DrainerTransfer | undefined {
    return [...this.#transfers.values()]
      .filter((transfer) => transfer.amountHandle === amountHandle)
      .sort(compareTransferOrder)[0];
  }

  #isActiveDelegation(delegator: Address, delegate: Address, contractAddress: Address, at: Date): boolean {
    const atSeconds = BigInt(Math.floor(at.getTime() / 1_000));

    return this.#delegations.some(
      (delegation) =>
        addressKey(delegation.delegator) === addressKey(delegator) &&
        addressKey(delegation.delegate) === addressKey(delegate) &&
        addressKey(delegation.contractAddress) === addressKey(contractAddress) &&
        delegation.expiry > atSeconds,
    );
  }
}

const compareTransferOrder = (left: DrainerTransfer, right: DrainerTransfer): number => {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  return left.logIndex - right.logIndex;
};

const orderedTransferCandidates = (transfer: DrainerTransfer): readonly Address[] => {
  const candidates = [transfer.to, transfer.from].filter(
    (address, index, all): address is Address =>
      address !== "0x0000000000000000000000000000000000000000" && all.indexOf(address) === index,
  );
  return candidates;
};

export const decryptionRow = (
  amountHandle: `0x${string}`,
  status: DecryptionStatus,
  now: Date,
): DecryptionRow => ({
  amountHandle,
  cleartextRaw: null,
  status,
  decryptedFor: null,
  source: null,
  attempts: 0,
  nextAttemptAt: now,
  lastErrorCode: null,
  lastErrorAt: null,
});
