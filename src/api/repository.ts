import type { Address } from "viem";

import type { BalanceTransferView } from "../balance/derive.js";
import type { DecryptionSource, DecryptionStatus, TransferKind } from "../types/lifecycle.js";

export type TransferDirection = "in" | "out" | "self";
export type TransferOrder = "asc" | "desc";

export interface ApiDecryptionView {
  readonly cleartextRaw: string | null;
  readonly status: DecryptionStatus;
  readonly source: DecryptionSource | null;
}

export interface ApiTransferView extends BalanceTransferView {
  readonly id: string;
  readonly txHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly timestamp: bigint;
  readonly from: Address;
  readonly to: Address;
  readonly kind: TransferKind;
  readonly amountHandle: `0x${string}`;
  readonly disclosedRaw: string | null;
  readonly decryption: ApiDecryptionView | null;
}

export interface TransferListFilters {
  readonly direction?: TransferDirection;
  readonly kind?: TransferKind;
  readonly status?: DecryptionStatus;
}

export interface DecryptionHealthSnapshot {
  readonly pending: number;
  readonly unauthorized: number;
  readonly failed: number;
  readonly oldestPendingSeconds: number | null;
  readonly lastSuccessAt: Date | null;
  readonly breakerState: "closed" | "open" | "halfOpen";
}

export interface IndexerCheckpointSnapshot {
  readonly indexedBlock: bigint | null;
  readonly indexedBlockTimestamp: Date | null;
}

export interface IndexerReadRepository {
  getAsOfBlock(): Promise<bigint | null>;
  getIndexerCheckpoint(): Promise<IndexerCheckpointSnapshot>;
  getTransferById(id: string): Promise<ApiTransferView | null>;
  listAddressTransfers(address: Address): Promise<readonly ApiTransferView[]>;
  listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]>;
  getDecryptionHealth(now: Date): Promise<DecryptionHealthSnapshot>;
}
