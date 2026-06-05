import { getAddress, type Address } from "viem";

import { formatBaseUnitValue } from "../balance/derive.js";
import { decryptionStatuses, transferKinds, type DecryptionStatus, type TransferKind } from "../types/lifecycle.js";
import type { ApiTransferView, TransferDirection, TransferOrder } from "./repository.js";

export type AmountSource = "userDecrypt" | "public" | "disclosed";

export interface ApiAmount {
  readonly status: DecryptionStatus;
  readonly raw: string | null;
  readonly value: string | null;
  readonly source: AmountSource;
}

export interface SerializedTransfer {
  readonly id: string;
  readonly txHash: `0x${string}`;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly timestamp: string;
  readonly from: Address;
  readonly to: Address;
  readonly direction?: TransferDirection;
  readonly kind: TransferKind;
  readonly amount: ApiAmount;
}

export interface CursorValue {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export const serializeAmount = (transfer: ApiTransferView, decimals: number): ApiAmount => {
  const disclosedRaw = transfer.disclosedRaw;
  if (disclosedRaw !== null) {
    return decryptedAmount(disclosedRaw, decimals, "disclosed");
  }

  if (
    transfer.decryption !== null &&
    transfer.decryption.status === "decrypted" &&
    transfer.decryption.cleartextRaw !== null
  ) {
    return decryptedAmount(transfer.decryption.cleartextRaw, decimals, transfer.decryption.source ?? "userDecrypt");
  }

  return {
    status: transfer.decryption?.status ?? "encrypted",
    raw: null,
    value: null,
    source: transfer.decryption?.source ?? "userDecrypt",
  };
};

export const serializeTransfer = (
  transfer: ApiTransferView,
  options: {
    readonly decimals: number;
    readonly address?: Address;
  },
): SerializedTransfer => ({
  id: transfer.id,
  txHash: transfer.txHash,
  blockNumber: safeBlockNumber(transfer.blockNumber),
  logIndex: transfer.logIndex,
  timestamp: new Date(Number(transfer.timestamp) * 1_000).toISOString(),
  from: transfer.from,
  to: transfer.to,
  ...(options.address === undefined ? {} : { direction: directionFor(options.address, transfer) }),
  kind: transfer.kind,
  amount: serializeAmount(transfer, options.decimals),
});

export const directionFor = (address: Address, transfer: Pick<ApiTransferView, "from" | "to">): TransferDirection => {
  const key = addressKey(address);
  const from = addressKey(transfer.from);
  const to = addressKey(transfer.to);

  if (from === key && to === key) {
    return "self";
  }

  if (to === key) {
    return "in";
  }

  return "out";
};

export const compareTransfer = (order: TransferOrder) => (left: ApiTransferView, right: ApiTransferView): number => {
  const ordered = comparePosition(left, right);
  return order === "asc" ? ordered : -ordered;
};

export const encodeCursor = (value: CursorValue): string => {
  const json = JSON.stringify({ b: value.blockNumber.toString(), l: value.logIndex });
  return Buffer.from(json, "utf8").toString("base64url");
};

export const decodeCursor = (cursor: string): CursorValue | null => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "b" in value &&
      "l" in value &&
      typeof value.b === "string" &&
      typeof value.l === "number" &&
      Number.isInteger(value.l)
    ) {
      return {
        blockNumber: BigInt(value.b),
        logIndex: value.l,
      };
    }
  } catch {
    return null;
  }

  return null;
};

export const isTransferKind = (value: string): value is TransferKind => {
  return transferKinds.includes(value as TransferKind);
};

export const isDecryptionStatus = (value: string): value is DecryptionStatus => {
  return decryptionStatuses.includes(value as DecryptionStatus);
};

export const isTransferOrder = (value: string): value is TransferOrder => {
  return value === "asc" || value === "desc";
};

export const isTransferDirection = (value: string): value is TransferDirection => {
  return value === "in" || value === "out" || value === "self";
};

export const filterAfterCursor = (
  transfers: readonly ApiTransferView[],
  cursor: CursorValue,
  order: TransferOrder,
): readonly ApiTransferView[] => {
  return transfers.filter((transfer) => {
    const comparison = comparePosition(transfer, cursor);
    return order === "asc" ? comparison > 0 : comparison < 0;
  });
};

const decryptedAmount = (raw: string, decimals: number, source: AmountSource): ApiAmount => ({
  status: "decrypted",
  raw,
  value: formatBaseUnitValue(raw, decimals),
  source,
});

const comparePosition = (
  left: Pick<ApiTransferView, "blockNumber" | "logIndex">,
  right: Pick<ApiTransferView, "blockNumber" | "logIndex">,
): number => {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  return left.logIndex - right.logIndex;
};

const addressKey = (address: Address): string => getAddress(address).toLowerCase();

const safeBlockNumber = (blockNumber: bigint): number => {
  const value = Number(blockNumber);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Block number is outside the JSON safe integer range: ${blockNumber.toString()}`);
  }

  return value;
};
