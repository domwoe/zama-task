import { getAddress, type Address } from "viem";

import type { Decryptor } from "../decryptor/decryptor.js";
import type { DecryptFailure } from "../decryptor/outcome.js";
import type { BalanceStatus, DecryptionSource, DecryptionStatus } from "../types/lifecycle.js";

export type BalanceSource = "derived" | "checkpoint";

export interface BalanceDecryptionView {
  readonly cleartextRaw: string | null;
  readonly status: DecryptionStatus;
  readonly source: DecryptionSource | null;
}

export interface BalanceTransferView {
  readonly id: string;
  readonly from: Address;
  readonly to: Address;
  readonly disclosedRaw: string | null;
  readonly decryption: BalanceDecryptionView | null;
}

export interface BalanceCheckpoint {
  readonly cleartextRaw: string;
}

export interface BalanceCheckpointFailure {
  readonly failure: DecryptFailure;
}

export type BalanceCheckpointOutcome = BalanceCheckpoint | BalanceCheckpointFailure;

export interface DerivedBalance {
  readonly status: BalanceStatus;
  readonly raw: string;
  readonly value: string;
  readonly source: BalanceSource;
  readonly pendingTransfers: number;
}

export interface DeriveBalanceOptions {
  readonly address: Address;
  readonly transfers: readonly BalanceTransferView[];
  readonly decimals: number;
  readonly checkpoint?: BalanceCheckpoint | null;
}

export const deriveBalance = (options: DeriveBalanceOptions): DerivedBalance => {
  const address = addressKey(options.address);
  let knownRaw = 0n;
  let pendingTransfers = 0;

  for (const transfer of options.transfers) {
    const deltaSign = signedDirection(address, transfer);
    if (deltaSign === 0n) {
      continue;
    }

    const cleartextRaw = transfer.disclosedRaw ?? transfer.decryption?.cleartextRaw ?? null;
    if (cleartextRaw === null) {
      pendingTransfers += 1;
      continue;
    }

    knownRaw += deltaSign * BigInt(cleartextRaw);
  }

  const isPartial = pendingTransfers > 0;
  const raw = isPartial && options.checkpoint !== undefined && options.checkpoint !== null
    ? options.checkpoint.cleartextRaw
    : knownRaw.toString();
  const source: BalanceSource = isPartial && options.checkpoint !== undefined && options.checkpoint !== null
    ? "checkpoint"
    : "derived";

  return {
    status: isPartial ? "partial" : "complete",
    raw,
    value: formatBaseUnitValue(raw, options.decimals),
    source,
    pendingTransfers,
  };
};

export const decryptBalanceCheckpoint = async (
  decryptor: Decryptor,
  holder: Address,
): Promise<BalanceCheckpointOutcome> => {
  const outcome = await decryptor.decryptBalanceAs(holder);
  if (outcome.kind === "success") {
    return { cleartextRaw: outcome.cleartextRaw };
  }

  return { failure: outcome };
};

export const formatBaseUnitValue = (raw: string, decimals: number): string => {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Token decimals must be a non-negative integer, got ${decimals.toString()}`);
  }

  if (decimals === 0) {
    return raw;
  }

  const amount = BigInt(raw);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${sign}${whole.toString()}.${fraction.length === 0 ? "0" : fraction}`;
};

const signedDirection = (address: string, transfer: BalanceTransferView): -1n | 0n | 1n => {
  const from = addressKey(transfer.from);
  const to = addressKey(transfer.to);

  if (from === address && to === address) {
    return 0n;
  }

  if (to === address) {
    return 1n;
  }

  if (from === address) {
    return -1n;
  }

  return 0n;
};

const addressKey = (address: Address): string => getAddress(address).toLowerCase();
