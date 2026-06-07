import { getAddress, type Address } from "viem";

import type { Decryptor } from "../decryptor/decryptor.js";
import type { DecryptFailure } from "../decryptor/outcome.js";
import type { BalanceTrust, DecryptionSource, DecryptionStatus } from "../types/lifecycle.js";

export type BalanceSource = "derived" | "checkpoint";

export interface BalanceDecryptionView {
  readonly cleartextRaw: string | null;
  readonly status: DecryptionStatus;
  readonly source: DecryptionSource | null;
}

export interface BalanceTransferView {
  readonly id: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
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

/** Exact, zero-anchored balance as of a block. `source` records how it was anchored. */
export interface ConfirmedBalance {
  readonly raw: string;
  readonly value: string;
  readonly asOfBlock: bigint | null;
  readonly source: BalanceSource;
}

/** Affecting transfers we can see but cannot yet value, summarised. */
export interface PendingBalanceSummary {
  readonly count: number;
  readonly inbound: number;
  readonly outbound: number;
  readonly oldestBlock: bigint | null;
  readonly byStatus: Partial<Record<DecryptionStatus, number>>;
}

export interface DerivedBalance {
  readonly status: BalanceTrust;
  readonly confirmed: ConfirmedBalance | null;
  readonly pending: PendingBalanceSummary;
}

export interface DeriveBalanceOptions {
  readonly address: Address;
  readonly transfers: readonly BalanceTransferView[];
  readonly decimals: number;
  /** Indexed head; the as-of block for an `exact` (fully-valued) balance. */
  readonly indexedBlock: bigint | null;
}

export const emptyPending = (): PendingBalanceSummary => ({
  count: 0,
  inbound: 0,
  outbound: 0,
  oldestBlock: null,
  byStatus: {},
});

export const deriveBalance = (options: DeriveBalanceOptions): DerivedBalance => {
  const address = addressKey(options.address);

  // Affecting transfers (net direction != 0), oldest first — the order the prefix walk needs.
  const affecting = options.transfers
    .map((transfer) => ({ transfer, sign: signedDirection(address, transfer) }))
    .filter((entry) => entry.sign !== 0n)
    .sort((a, b) => compareByPosition(a.transfer, b.transfer));

  // `confirmed` = exact sum over the maximal gap-free *valued* prefix.
  let prefixSum = 0n;
  let prefixCount = 0;
  let anchorBlock: bigint | null = null;
  let hitGap = false;

  // `pending` = the un-valued affecting transfers (the things we can't total yet).
  let count = 0;
  let inbound = 0;
  let outbound = 0;
  let oldestBlock: bigint | null = null;
  const byStatus: Partial<Record<DecryptionStatus, number>> = {};

  for (const { transfer, sign } of affecting) {
    const cleartextRaw = transfer.disclosedRaw ?? transfer.decryption?.cleartextRaw ?? null;

    if (cleartextRaw === null) {
      hitGap = true;
      count += 1;
      if (sign > 0n) {
        inbound += 1;
      } else {
        outbound += 1;
      }
      if (oldestBlock === null || transfer.blockNumber < oldestBlock) {
        oldestBlock = transfer.blockNumber;
      }
      const status = transfer.decryption?.status ?? "encrypted";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      continue;
    }

    // Valued transfers only extend the confirmed prefix while it is still gap-free.
    if (!hitGap) {
      prefixSum += sign * BigInt(cleartextRaw);
      anchorBlock = transfer.blockNumber;
      prefixCount += 1;
    }
  }

  const pending: PendingBalanceSummary = { count, inbound, outbound, oldestBlock, byStatus };

  // No zero-anchor: the earliest affecting transfer is un-valued (and there is at
  // least one). We refuse to guess — that is `unknown`, not a fabricated number.
  if (prefixCount === 0 && affecting.length > 0) {
    return { status: "unknown", confirmed: null, pending };
  }

  const isExact = count === 0;
  const raw = prefixSum.toString();

  return {
    status: isExact ? "exact" : "as_of",
    confirmed: {
      raw,
      value: formatBaseUnitValue(raw, options.decimals),
      // Exact ⇒ current to the indexed head; as_of ⇒ the last gap-free valued block.
      asOfBlock: isExact ? options.indexedBlock : anchorBlock,
      source: "derived",
    },
    pending,
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

const compareByPosition = (a: BalanceTransferView, b: BalanceTransferView): number => {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1;
  }

  return a.logIndex - b.logIndex;
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
