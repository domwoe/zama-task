import { zeroAddress, type Address } from "viem";

import type { DecryptionRow, DrainerStateRow } from "../db/drainer-schema.js";
import type { DecryptionSource, DecryptionStatus } from "../types/lifecycle.js";

export interface DrainerTransfer {
  readonly id: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly from: Address;
  readonly to: Address;
  readonly amountHandle: `0x${string}`;
  readonly disclosedRaw: string | null;
}

export interface DrainerDelegation {
  readonly delegator: Address;
  readonly delegate: Address;
  readonly contractAddress: Address;
  readonly expiry: bigint;
  readonly lastEventBlock: bigint;
}

export interface DrainerWorkItem {
  readonly transfer: DrainerTransfer;
  readonly decryption: DecryptionRow | null;
}

export interface DecryptionWrite {
  readonly amountHandle: `0x${string}`;
  readonly cleartextRaw: string | null;
  readonly status: DecryptionStatus;
  readonly decryptedFor: Address | null;
  readonly source: DecryptionSource | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: Date | null;
}

export interface ActiveDelegationQuery {
  readonly delegators: readonly Address[];
  readonly delegate: Address;
  readonly contractAddress: Address;
  readonly at: Date;
}

export interface NudgeQuery {
  readonly delegate: Address;
  readonly contractAddress: Address;
  readonly at: Date;
  /** A `failed` row is only re-armed while its attempt count is below this cap. */
  readonly failedMaxAttempts: number;
}

export interface DrainerStore {
  listDueTransfers(now: Date, limit: number): Promise<readonly DrainerWorkItem[]>;
  seedEncryptedDecryption(amountHandle: `0x${string}`, now: Date): Promise<DecryptionRow>;
  writeDecryption(row: DecryptionWrite): Promise<void>;
  listActiveDelegators(query: ActiveDelegationQuery): Promise<readonly Address[]>;
  nudgeRetryableForActiveDelegations(query: NudgeQuery): Promise<number>;
  getDrainerState(): Promise<DrainerStateRow>;
  writeDrainerState(row: DrainerStateRow): Promise<void>;
}

/** Total order over a transfer's on-chain position: block number, then log index. */
export const compareDrainerTransfer = (left: DrainerTransfer, right: DrainerTransfer): number => {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  return left.logIndex - right.logIndex;
};

/** Delegation candidates for a transfer, in `[to, from]` priority order, excluding the zero address. */
export const orderedTransferCandidates = (transfer: DrainerTransfer): readonly Address[] => {
  const candidates: Address[] = [];
  for (const candidate of [transfer.to, transfer.from]) {
    if (candidate === zeroAddress || candidates.includes(candidate)) {
      continue;
    }

    candidates.push(candidate);
  }

  return candidates;
};
