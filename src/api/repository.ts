import type { Address } from "viem";

import type { BalanceTransferView, DerivedBalance } from "../balance/derive.js";
import type { DecryptionSource, DecryptionStatus, TransferKind } from "../types/lifecycle.js";

export type TransferDirection = "in" | "out" | "self";
export type TransferOrder = "asc" | "desc";

export interface TransferCursor {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export interface ApiDecryptionView {
  readonly cleartextRaw: string | null;
  readonly status: DecryptionStatus;
  readonly source: DecryptionSource | null;
}

export interface ApiTransferView extends BalanceTransferView {
  readonly id: string;
  readonly txHash: `0x${string}`;
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

export interface TransferPageRequest extends TransferListFilters {
  readonly cursor: TransferCursor | null;
  readonly limit: number;
  readonly order: TransferOrder;
}

export interface TransferPage {
  readonly rows: readonly ApiTransferView[];
  readonly cursorExpired: boolean;
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

export interface BalanceCacheView extends DerivedBalance {
  readonly asOfBlock: bigint | null;
  readonly updatedAt: Date;
}

export interface IndexerReadRepository {
  getAsOfBlock(): Promise<bigint | null>;
  getIndexerCheckpoint(): Promise<IndexerCheckpointSnapshot>;
  getTransferById(id: string): Promise<ApiTransferView | null>;
  listAddressTransfers(address: Address): Promise<readonly ApiTransferView[]>;
  listAddressTransferPage(address: Address, request: TransferPageRequest): Promise<TransferPage>;
  listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]>;
  getCachedBalance(address: Address, asOfBlock: bigint | null): Promise<BalanceCacheView | null>;
  writeCachedBalance(address: Address, balance: DerivedBalance, asOfBlock: bigint | null, updatedAt: Date): Promise<void>;
  getDecryptionHealth(now: Date): Promise<DecryptionHealthSnapshot>;
}
