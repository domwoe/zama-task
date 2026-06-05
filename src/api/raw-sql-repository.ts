import {
  desc,
  eq,
  max,
  or,
  sql,
  type ReadonlyDrizzle,
} from "ponder";
import type { SQL } from "drizzle-orm";
import { getAddress, type Address } from "viem";
import { z } from "zod";

import { transfers } from "ponder:schema";
import type { schema as ponderSchema } from "ponder:internal";

import type { BalanceTransferView } from "../balance/derive.js";
import { createDrainerTablesSql } from "../db/drainer-schema.js";
import { breakerStates, decryptionSources, decryptionStatuses } from "../types/lifecycle.js";
import type {
  ApiDecryptionView,
  ApiTransferView,
  DecryptionHealthSnapshot,
  IndexerReadRepository,
} from "./repository.js";

type PonderSchema = typeof ponderSchema;

interface ExecuteResult {
  readonly rows?: readonly unknown[];
}

interface RawSqlExecutor {
  execute<T = unknown>(query: SQL<T>): Promise<ExecuteResult>;
}

export class RawSqlSideTableRepository implements IndexerReadRepository {
  readonly #db: ReadonlyDrizzle<PonderSchema> & RawSqlExecutor;

  constructor(db: ReadonlyDrizzle<PonderSchema> & RawSqlExecutor) {
    this.#db = db;
  }

  async initSideTables(): Promise<void> {
    for (const statement of createDrainerTablesSql) {
      await this.#db.execute(sql.raw(statement));
    }
  }

  async getAsOfBlock(): Promise<bigint | null> {
    const [row] = await this.#db.select({ blockNumber: max(transfers.blockNumber) }).from(transfers);
    return row?.blockNumber ?? null;
  }

  async getTransferById(id: string): Promise<ApiTransferView | null> {
    const [row] = await this.#db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
    if (row === undefined) {
      return null;
    }

    const decryptions = await this.#fetchDecryptions([row.amountHandle]);
    return toApiTransfer(row, decryptions.get(row.amountHandle) ?? null);
  }

  async listAddressTransfers(address: Address): Promise<readonly ApiTransferView[]> {
    const normalized = getAddress(address);
    const rows = await this.#db
      .select()
      .from(transfers)
      .where(or(eq(transfers.from, normalized), eq(transfers.to, normalized)))
      .orderBy(desc(transfers.blockNumber), desc(transfers.logIndex));
    const decryptions = await this.#fetchDecryptions(rows.map((row) => row.amountHandle));

    return rows.map((row) => toApiTransfer(row, decryptions.get(row.amountHandle) ?? null));
  }

  async listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]> {
    return this.listAddressTransfers(address);
  }

  async getDecryptionHealth(now: Date): Promise<DecryptionHealthSnapshot> {
    const [countsRow] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending' OR status = 'encrypted') AS pending,
          COUNT(*) FILTER (WHERE status = 'unauthorized') AS unauthorized,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed,
          MIN(next_attempt_at) FILTER (WHERE status <> 'decrypted') AS oldest_pending_at
        FROM decryptions
      `),
    );
    const counts = decryptionCountsSchema.parse(countsRow ?? {});

    const [stateRow] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT last_success_at, breaker_state
        FROM drainer_state
        WHERE id = 'singleton'
        LIMIT 1
      `),
    );
    const state = drainerStateSchema.parse(stateRow ?? {});
    const oldestPendingAt = parseDateOrNull(counts.oldest_pending_at);

    return {
      pending: Number(counts.pending),
      unauthorized: Number(counts.unauthorized),
      failed: Number(counts.failed),
      oldestPendingSeconds:
        oldestPendingAt === null ? null : Math.max(0, Math.floor((now.getTime() - oldestPendingAt.getTime()) / 1_000)),
      lastSuccessAt: parseDateOrNull(state.last_success_at),
      breakerState: state.breaker_state,
    };
  }

  async #fetchDecryptions(handles: readonly `0x${string}`[]): Promise<ReadonlyMap<`0x${string}`, ApiDecryptionView>> {
    const uniqueHandles = [...new Set(handles)];
    if (uniqueHandles.length === 0) {
      return new Map();
    }

    const rows = await Promise.all(uniqueHandles.map((handle) => this.#fetchDecryption(handle)));
    return new Map(rows.flatMap((row) => (row === null ? [] : [[row.amountHandle, row]])));
  }

  async #fetchDecryption(handle: `0x${string}`): Promise<(ApiDecryptionView & { amountHandle: `0x${string}` }) | null> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT amount_handle, cleartext_raw, status, source
        FROM decryptions
        WHERE amount_handle = ${handle}
        LIMIT 1
      `),
    );

    if (row === undefined) {
      return null;
    }

    const parsed = decryptionSchema.parse(row);
    return {
      amountHandle: parsed.amount_handle,
      cleartextRaw: parsed.cleartext_raw,
      status: parsed.status,
      source: parsed.source,
    };
  }
}

const rowsFromExecute = async (resultPromise: Promise<ExecuteResult>): Promise<readonly unknown[]> => {
  const result = await resultPromise;
  return result.rows ?? [];
};

const toApiTransfer = (
  row: {
    readonly id: string;
    readonly txHash: `0x${string}`;
    readonly blockNumber: bigint;
    readonly logIndex: number;
    readonly timestamp: bigint;
    readonly from: Address;
    readonly to: Address;
    readonly kind: ApiTransferView["kind"];
    readonly amountHandle: `0x${string}`;
    readonly disclosedRaw: string | null;
  },
  decryption: ApiDecryptionView | null,
): ApiTransferView => ({
  id: row.id,
  txHash: row.txHash,
  blockNumber: row.blockNumber,
  logIndex: row.logIndex,
  timestamp: row.timestamp,
  from: row.from,
  to: row.to,
  kind: row.kind,
  amountHandle: row.amountHandle,
  disclosedRaw: row.disclosedRaw,
  decryption,
});

const decryptionSchema = z.object({
  amount_handle: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as `0x${string}`),
  cleartext_raw: z.string().nullable(),
  status: z.enum(decryptionStatuses),
  source: z.enum(decryptionSources).nullable(),
});

const decryptionCountsSchema = z.object({
  pending: z.union([z.string(), z.number(), z.bigint()]).default(0),
  unauthorized: z.union([z.string(), z.number(), z.bigint()]).default(0),
  failed: z.union([z.string(), z.number(), z.bigint()]).default(0),
  oldest_pending_at: z.unknown().optional(),
});

const drainerStateSchema = z.object({
  last_success_at: z.unknown().optional(),
  breaker_state: z.enum(breakerStates).default("closed"),
});

const parseDateOrNull = (value: unknown): Date | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
};
