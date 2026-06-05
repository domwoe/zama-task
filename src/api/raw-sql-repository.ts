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

import { delegations, transfers } from "ponder:schema";
import type { schema as ponderSchema } from "ponder:internal";

import { emptyPending } from "../balance/derive.js";
import type { BalanceTransferView, DerivedBalance } from "../balance/derive.js";
import { createDrainerTablesSql } from "../db/drainer-schema.js";
import { balanceTrustLevels, breakerStates, decryptionSources, decryptionStatuses, transferKinds } from "../types/lifecycle.js";
import type { DecryptionRow, DrainerStateRow } from "../db/drainer-schema.js";
import type { SdkStorageRecordStore } from "../decryptor/generic-storage.js";
import { compareDrainerTransfer, orderedTransferCandidates } from "../drainer/store.js";
import type {
  ActiveDelegationQuery,
  DecryptionWrite,
  DrainerStore,
  DrainerTransfer,
  DrainerWorkItem,
} from "../drainer/store.js";
import type {
  ApiDecryptionView,
  ApiTransferView,
  BalanceCacheView,
  DecryptionHealthSnapshot,
  IndexerCheckpointSnapshot,
  IndexerReadRepository,
  TransferCursor,
  TransferListFilters,
  TransferPage,
  TransferPageRequest,
} from "./repository.js";

type PonderSchema = typeof ponderSchema;

interface ExecuteResult {
  readonly rows?: readonly unknown[];
}

interface RawSqlExecutor {
  execute<T = unknown>(query: SQL<T>): Promise<ExecuteResult>;
}

export class RawSqlSideTableRepository implements IndexerReadRepository, DrainerStore, SdkStorageRecordStore {
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

  async getIndexerCheckpoint(): Promise<IndexerCheckpointSnapshot> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT latest_checkpoint
        FROM _ponder_checkpoint
        LIMIT 1
      `),
    );
    const parsed = checkpointRowSchema.safeParse(row);
    if (!parsed.success) {
      return {
        indexedBlock: await this.getAsOfBlock(),
        indexedBlockTimestamp: null,
      };
    }

    const checkpoint = decodePonderCheckpoint(parsed.data.latest_checkpoint);
    return {
      indexedBlock: checkpoint.blockNumber,
      indexedBlockTimestamp: new Date(Number(checkpoint.blockTimestamp) * 1_000),
    };
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
    const normalized = lowerAddress(address);
    const rows = await this.#db
      .select()
      .from(transfers)
      .where(or(eq(transfers.from, normalized), eq(transfers.to, normalized)))
      .orderBy(desc(transfers.blockNumber), desc(transfers.logIndex));
    const decryptions = await this.#fetchDecryptions(rows.map((row) => row.amountHandle));

    return rows.map((row) => toApiTransfer(row, decryptions.get(row.amountHandle) ?? null));
  }

  async listAddressTransferPage(address: Address, request: TransferPageRequest): Promise<TransferPage> {
    const normalized = lowerAddress(address);
    const conditions = transferFilterConditions(normalized, request);
    const cursorExpired =
      request.cursor !== null && !(await this.#hasTransferAtCursor(conditions, request.cursor));
    if (cursorExpired) {
      return { rows: [], cursorExpired };
    }

    const cursorCondition = request.cursor === null ? undefined : transferCursorCondition(request.cursor, request.order);
    const rows = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT
          t.id,
          t.tx_hash,
          t.block_number,
          t.log_index,
          t.timestamp,
          t."from",
          t."to",
          t.kind,
          t.amount_handle,
          t.disclosed_raw,
          d.cleartext_raw AS decryption_cleartext_raw,
          d.status AS decryption_status,
          d.source AS decryption_source
        FROM transfers t
        LEFT JOIN decryptions d ON d.amount_handle = t.amount_handle
        WHERE ${andSql([...conditions, ...(cursorCondition === undefined ? [] : [cursorCondition])])}
        ORDER BY
          ${sql.raw(request.order === "asc" ? "t.block_number ASC, t.log_index ASC" : "t.block_number DESC, t.log_index DESC")}
        LIMIT ${request.limit}
      `),
    );

    return {
      rows: rows.map(toApiTransferPageRow),
      cursorExpired: false,
    };
  }

  async listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]> {
    return this.listAddressTransfers(address);
  }

  async getCachedBalance(address: Address, asOfBlock: bigint | null): Promise<BalanceCacheView | null> {
    const normalized = lowerAddress(address);
    const fingerprint = await this.#balanceFingerprint(normalized);
    const [row] = await rowsFromExecute(
      asOfBlock === null
        ? this.#db.execute(sql`
            SELECT
              address,
              status,
              raw,
              value,
              source,
              pending_transfers,
              as_of_block,
              transfer_count,
              max_transfer_block,
              max_transfer_log_index,
              updated_at
            FROM balances
            WHERE address = ${normalized} AND as_of_block IS NULL
            LIMIT 1
          `)
        : this.#db.execute(sql`
            SELECT
              address,
              status,
              raw,
              value,
              source,
              pending_transfers,
              as_of_block,
              transfer_count,
              max_transfer_block,
              max_transfer_log_index,
              updated_at
            FROM balances
            WHERE address = ${normalized} AND as_of_block = ${asOfBlock.toString()}
            LIMIT 1
          `),
    );

    if (row === undefined) {
      return null;
    }

    const parsed = balanceCacheSchema.parse(row);
    if (!fingerprintsEqual(fingerprint, {
      transferCount: Number(parsed.transfer_count),
      maxTransferBlock: parseBigintOrNull(parsed.max_transfer_block),
      maxTransferLogIndex: parseNumberOrNull(parsed.max_transfer_log_index),
    })) {
      return null;
    }

    // Only `exact` balances are cached, so confirmed is always present and pending empty.
    const anchor = parseBigintOrNull(parsed.as_of_block);
    return {
      status: "exact",
      confirmed: { raw: parsed.raw, value: parsed.value, asOfBlock: anchor, source: parsed.source },
      pending: emptyPending(),
      asOfBlock: anchor,
      updatedAt: parseRequiredDate(parsed.updated_at),
    };
  }

  async writeCachedBalance(
    address: Address,
    balance: DerivedBalance,
    asOfBlock: bigint | null,
    updatedAt: Date,
  ): Promise<void> {
    // We only cache exact balances (confirmed present, no pending).
    if (balance.confirmed === null) {
      return;
    }
    const fingerprint = await this.#balanceFingerprint(address);
    await this.#db.execute(sql`
      INSERT INTO balances (
        address,
        status,
        raw,
        value,
        source,
        pending_transfers,
        as_of_block,
        transfer_count,
        max_transfer_block,
        max_transfer_log_index,
        updated_at
      )
      VALUES (
        ${lowerAddress(address)},
        ${balance.status},
        ${balance.confirmed.raw},
        ${balance.confirmed.value},
        ${balance.confirmed.source},
        ${balance.pending.count},
        ${asOfBlock === null ? null : asOfBlock.toString()},
        ${fingerprint.transferCount},
        ${fingerprint.maxTransferBlock === null ? null : fingerprint.maxTransferBlock.toString()},
        ${fingerprint.maxTransferLogIndex},
        ${updatedAt.toISOString()}
      )
      ON CONFLICT (address) DO UPDATE SET
        status = EXCLUDED.status,
        raw = EXCLUDED.raw,
        value = EXCLUDED.value,
        source = EXCLUDED.source,
        pending_transfers = EXCLUDED.pending_transfers,
        as_of_block = EXCLUDED.as_of_block,
        transfer_count = EXCLUDED.transfer_count,
        max_transfer_block = EXCLUDED.max_transfer_block,
        max_transfer_log_index = EXCLUDED.max_transfer_log_index,
        updated_at = EXCLUDED.updated_at
    `);
  }

  async listDueTransfers(now: Date, limit: number): Promise<readonly DrainerWorkItem[]> {
    const rows = await rowsFromExecute(
      this.#db.execute(sql`
        WITH oldest_transfer_per_handle AS (
          SELECT DISTINCT ON (amount_handle)
            id,
            block_number,
            log_index,
            "from",
            "to",
            amount_handle,
            disclosed_raw
          FROM transfers
          WHERE disclosed_raw IS NULL
          ORDER BY amount_handle, block_number ASC, log_index ASC
        )
        SELECT
          t.id,
          t.block_number,
          t.log_index,
          t."from",
          t."to",
          t.amount_handle,
          t.disclosed_raw,
          d.cleartext_raw AS decryption_cleartext_raw,
          d.status AS decryption_status,
          d.decrypted_for AS decryption_decrypted_for,
          d.source AS decryption_source,
          d.attempts AS decryption_attempts,
          d.next_attempt_at AS decryption_next_attempt_at,
          d.last_error_code AS decryption_last_error_code,
          d.last_error_at AS decryption_last_error_at
        FROM oldest_transfer_per_handle t
        LEFT JOIN decryptions d ON d.amount_handle = t.amount_handle
        WHERE
          (d.amount_handle IS NULL OR d.status <> 'decrypted')
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${now.toISOString()})
        ORDER BY t.block_number ASC, t.log_index ASC
        LIMIT ${limit}
      `),
    );

    return rows.map(toDrainerWorkItemRow);
  }

  async seedEncryptedDecryption(amountHandle: `0x${string}`, now: Date): Promise<DecryptionRow> {
    await this.#db.execute(sql`
      INSERT INTO decryptions (
        amount_handle,
        cleartext_raw,
        status,
        decrypted_for,
        source,
        attempts,
        next_attempt_at,
        last_error_code,
        last_error_at
      )
      VALUES (${amountHandle}, NULL, 'encrypted', NULL, NULL, 0, ${now.toISOString()}, NULL, NULL)
      ON CONFLICT (amount_handle) DO NOTHING
    `);

    const row = await this.#fetchDecryptionRow(amountHandle);
    if (row === null) {
      throw new Error(`Failed to seed decryption row for ${amountHandle}`);
    }

    return row;
  }

  async writeDecryption(row: DecryptionWrite): Promise<void> {
    await this.#db.execute(sql`
      INSERT INTO decryptions (
        amount_handle,
        cleartext_raw,
        status,
        decrypted_for,
        source,
        attempts,
        next_attempt_at,
        last_error_code,
        last_error_at
      )
      VALUES (
        ${row.amountHandle},
        ${row.cleartextRaw},
        ${row.status},
        ${row.decryptedFor},
        ${row.source},
        ${row.attempts},
        ${row.nextAttemptAt.toISOString()},
        ${row.lastErrorCode},
        ${row.lastErrorAt?.toISOString() ?? null}
      )
      ON CONFLICT (amount_handle) DO UPDATE SET
        cleartext_raw = EXCLUDED.cleartext_raw,
        status = EXCLUDED.status,
        decrypted_for = EXCLUDED.decrypted_for,
        source = EXCLUDED.source,
        attempts = EXCLUDED.attempts,
        next_attempt_at = EXCLUDED.next_attempt_at,
        last_error_code = EXCLUDED.last_error_code,
        last_error_at = EXCLUDED.last_error_at
    `);
  }

  async listActiveDelegators(query: ActiveDelegationQuery): Promise<readonly Address[]> {
    if (query.delegators.length === 0) {
      return [];
    }

    const rows = await this.#db
      .select()
      .from(delegations)
      .where(
        or(
          ...query.delegators.map((delegator) => eq(delegations.delegator, lowerAddress(delegator))),
        ),
      );
    const atSeconds = BigInt(Math.floor(query.at.getTime() / 1_000));
    const delegate = addressKey(query.delegate);
    const contractAddress = addressKey(query.contractAddress);

    return query.delegators.filter((delegator) =>
      rows.some(
        (row) =>
          addressKey(row.delegator) === addressKey(delegator) &&
          addressKey(row.delegate) === delegate &&
          addressKey(row.contractAddress) === contractAddress &&
          row.expiry > atSeconds,
      ),
    );
  }

  async nudgeUnauthorizedForActiveDelegations(query: Omit<ActiveDelegationQuery, "delegators">): Promise<number> {
    const rows = await this.#fetchDecryptionRowsByStatus("unauthorized");
    let nudged = 0;

    for (const row of rows) {
      if (row.nextAttemptAt <= query.at) {
        continue;
      }

      const transfer = await this.#oldestTransferForHandle(row.amountHandle);
      if (transfer === null) {
        continue;
      }

      const candidates = orderedTransferCandidates(transfer);
      const active = await this.listActiveDelegators({ ...query, delegators: candidates });
      if (active.length === 0) {
        continue;
      }

      await this.writeDecryption({
        ...row,
        nextAttemptAt: query.at,
      });
      nudged += 1;
    }

    return nudged;
  }

  async getDrainerState(): Promise<DrainerStateRow> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT last_success_at, breaker_state, breaker_opened_at
        FROM drainer_state
        WHERE id = 'singleton'
        LIMIT 1
      `),
    );
    const parsed = drainerStateFullSchema.parse(row ?? {});

    return {
      id: "singleton",
      lastSuccessAt: parseDateOrNull(parsed.last_success_at),
      breakerState: parsed.breaker_state,
      breakerOpenedAt: parseDateOrNull(parsed.breaker_opened_at),
    };
  }

  async writeDrainerState(row: DrainerStateRow): Promise<void> {
    await this.#db.execute(sql`
      INSERT INTO drainer_state (id, last_success_at, breaker_state, breaker_opened_at)
      VALUES (
        'singleton',
        ${row.lastSuccessAt?.toISOString() ?? null},
        ${row.breakerState},
        ${row.breakerOpenedAt?.toISOString() ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        last_success_at = EXCLUDED.last_success_at,
        breaker_state = EXCLUDED.breaker_state,
        breaker_opened_at = EXCLUDED.breaker_opened_at
    `);
  }

  async get(key: string): Promise<unknown> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT value
        FROM sdk_credentials
        WHERE key = ${key}
        LIMIT 1
      `),
    );
    const parsed = sdkCredentialSchema.safeParse(row);
    if (!parsed.success) {
      return null;
    }

    return JSON.parse(parsed.data.value) as unknown;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#db.execute(sql`
      INSERT INTO sdk_credentials (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, ${new Date().toISOString()})
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
    `);
  }

  async delete(key: string): Promise<void> {
    await this.#db.execute(sql`
      DELETE FROM sdk_credentials
      WHERE key = ${key}
    `);
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

  async #fetchDecryptionRow(handle: `0x${string}`): Promise<DecryptionRow | null> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT
          amount_handle,
          cleartext_raw,
          status,
          decrypted_for,
          source,
          attempts,
          next_attempt_at,
          last_error_code,
          last_error_at
        FROM decryptions
        WHERE amount_handle = ${handle}
        LIMIT 1
      `),
    );

    return row === undefined ? null : toDecryptionRow(row);
  }

  async #fetchDecryptionRowsByStatus(status: DecryptionRow["status"]): Promise<readonly DecryptionRow[]> {
    const rows = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT
          amount_handle,
          cleartext_raw,
          status,
          decrypted_for,
          source,
          attempts,
          next_attempt_at,
          last_error_code,
          last_error_at
        FROM decryptions
        WHERE status = ${status}
      `),
    );

    return rows.map(toDecryptionRow);
  }

  async #oldestTransferForHandle(amountHandle: `0x${string}`): Promise<DrainerTransfer | null> {
    const rows = await this.#db.select().from(transfers).where(eq(transfers.amountHandle, amountHandle));
    const [oldest] = rows.map(toDrainerTransfer).sort(compareDrainerTransfer);
    return oldest ?? null;
  }

  async #balanceFingerprint(address: Address): Promise<BalanceFingerprint> {
    const normalized = lowerAddress(address);
    const rows = await this.#db
      .select({
        blockNumber: transfers.blockNumber,
        logIndex: transfers.logIndex,
      })
      .from(transfers)
      .where(or(eq(transfers.from, normalized), eq(transfers.to, normalized)));
    const [latest] = [...rows].sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber > right.blockNumber ? -1 : 1;
      }

      return right.logIndex - left.logIndex;
    });

    return {
      transferCount: rows.length,
      maxTransferBlock: latest?.blockNumber ?? null,
      maxTransferLogIndex: latest?.logIndex ?? null,
    };
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

  async #hasTransferAtCursor(conditions: readonly SQL[], cursor: TransferCursor): Promise<boolean> {
    const [row] = await rowsFromExecute(
      this.#db.execute(sql`
        SELECT 1 AS found
        FROM transfers t
        LEFT JOIN decryptions d ON d.amount_handle = t.amount_handle
        WHERE ${andSql([
          ...conditions,
          sql`t.block_number = ${cursor.blockNumber.toString()}`,
          sql`t.log_index = ${cursor.logIndex}`,
        ])}
        LIMIT 1
      `),
    );

    return row !== undefined;
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

const toApiTransferPageRow = (row: unknown): ApiTransferView => {
  const parsed = transferPageRowSchema.parse(row);
  return {
    id: parsed.id,
    txHash: parsed.tx_hash,
    blockNumber: parseRequiredBigint(parsed.block_number),
    logIndex: parsed.log_index,
    timestamp: parseRequiredBigint(parsed.timestamp),
    from: getAddress(parsed.from),
    to: getAddress(parsed.to),
    kind: parsed.kind,
    amountHandle: parsed.amount_handle,
    disclosedRaw: parsed.disclosed_raw,
    decryption:
      parsed.decryption_status === null
        ? null
        : {
            cleartextRaw: parsed.decryption_cleartext_raw,
            status: parsed.decryption_status,
            source: parsed.decryption_source,
          },
  };
};

const toDrainerTransfer = (row: {
  readonly id: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly amountHandle: `0x${string}`;
  readonly disclosedRaw: string | null;
}): DrainerTransfer => ({
  id: row.id,
  blockNumber: row.blockNumber,
  logIndex: row.logIndex,
  from: getAddress(row.from),
  to: getAddress(row.to),
  amountHandle: row.amountHandle,
  disclosedRaw: row.disclosedRaw,
});

const toDrainerWorkItemRow = (row: unknown): DrainerWorkItem => {
  const parsed = drainerWorkItemRowSchema.parse(row);
  const transfer = toDrainerTransfer({
    id: parsed.id,
    blockNumber: parseRequiredBigint(parsed.block_number),
    logIndex: parsed.log_index,
    from: parsed.from,
    to: parsed.to,
    amountHandle: parsed.amount_handle,
    disclosedRaw: parsed.disclosed_raw,
  });

  return {
    transfer,
    decryption:
      parsed.decryption_status === null
        ? null
        : {
            amountHandle: parsed.amount_handle,
            cleartextRaw: parsed.decryption_cleartext_raw,
            status: parsed.decryption_status,
            decryptedFor: parsed.decryption_decrypted_for,
            source: parsed.decryption_source,
            attempts: Number(parsed.decryption_attempts),
            nextAttemptAt: parseRequiredDate(parsed.decryption_next_attempt_at),
            lastErrorCode: parsed.decryption_last_error_code,
            lastErrorAt: parseDateOrNull(parsed.decryption_last_error_at),
          },
  };
};

const toDecryptionRow = (row: unknown): DecryptionRow => {
  const parsed = decryptionRowSchema.parse(row);
  return {
    amountHandle: parsed.amount_handle,
    cleartextRaw: parsed.cleartext_raw,
    status: parsed.status,
    decryptedFor: parsed.decrypted_for,
    source: parsed.source,
    attempts: Number(parsed.attempts),
    nextAttemptAt: parseRequiredDate(parsed.next_attempt_at),
    lastErrorCode: parsed.last_error_code,
    lastErrorAt: parseDateOrNull(parsed.last_error_at),
  };
};

const decryptionSchema = z.object({
  amount_handle: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as `0x${string}`),
  cleartext_raw: z.string().nullable(),
  status: z.enum(decryptionStatuses),
  source: z.enum(decryptionSources).nullable(),
});

const transferPageRowSchema = z.object({
  id: z.string(),
  tx_hash: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as `0x${string}`),
  block_number: z.unknown(),
  log_index: z.number(),
  timestamp: z.unknown(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  kind: z.enum(transferKinds),
  amount_handle: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as `0x${string}`),
  disclosed_raw: z.string().nullable(),
  decryption_cleartext_raw: z.string().nullable(),
  decryption_status: z.enum(decryptionStatuses).nullable(),
  decryption_source: z.enum(decryptionSources).nullable(),
});

const transferFilterConditions = (
  address: Address,
  filters: TransferListFilters,
): readonly SQL[] => {
  const addressConditions: readonly SQL[] =
    filters.direction === "in"
      ? [sql`t."to" = ${address}`, sql`t."from" <> ${address}`]
      : filters.direction === "out"
        ? [sql`t."from" = ${address}`, sql`t."to" <> ${address}`]
        : filters.direction === "self"
          ? [sql`t."from" = ${address}`, sql`t."to" = ${address}`]
          : [sql`(t."from" = ${address} OR t."to" = ${address})`];
  const kindConditions = filters.kind === undefined ? [] : [sql`t.kind = ${filters.kind}`];
  const statusConditions = filters.status === undefined ? [] : [transferStatusCondition(filters.status)];

  return [...addressConditions, ...kindConditions, ...statusConditions];
};

const transferStatusCondition = (status: DecryptionRow["status"]): SQL => {
  if (status === "decrypted") {
    return sql`(t.disclosed_raw IS NOT NULL OR d.status = 'decrypted')`;
  }

  return sql`t.disclosed_raw IS NULL AND COALESCE(d.status, 'encrypted') = ${status}`;
};

const transferCursorCondition = (cursor: TransferCursor, order: TransferPageRequest["order"]): SQL => {
  if (order === "asc") {
    return sql`(t.block_number > ${cursor.blockNumber.toString()} OR (t.block_number = ${cursor.blockNumber.toString()} AND t.log_index > ${cursor.logIndex}))`;
  }

  return sql`(t.block_number < ${cursor.blockNumber.toString()} OR (t.block_number = ${cursor.blockNumber.toString()} AND t.log_index < ${cursor.logIndex}))`;
};

const andSql = (conditions: readonly SQL[]): SQL => {
  const [first, ...rest] = conditions;
  if (first === undefined) {
    return sql`TRUE`;
  }

  return rest.reduce((joined, condition) => sql`${joined} AND ${condition}`, first);
};

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

const drainerStateFullSchema = drainerStateSchema.extend({
  breaker_opened_at: z.unknown().optional(),
});

const decryptionRowSchema = decryptionSchema.extend({
  decrypted_for: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value)).nullable(),
  attempts: z.union([z.string(), z.number(), z.bigint()]).default(0),
  next_attempt_at: z.unknown(),
  last_error_code: z.string().nullable(),
  last_error_at: z.unknown().optional(),
});

const drainerWorkItemRowSchema = z.object({
  id: z.string(),
  block_number: z.unknown(),
  log_index: z.number(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value)),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value)),
  amount_handle: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as `0x${string}`),
  disclosed_raw: z.string().nullable(),
  decryption_cleartext_raw: z.string().nullable(),
  decryption_status: z.enum(decryptionStatuses).nullable(),
  decryption_decrypted_for: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value)).nullable(),
  decryption_source: z.enum(decryptionSources).nullable(),
  decryption_attempts: z.union([z.string(), z.number(), z.bigint()]).nullable(),
  decryption_next_attempt_at: z.unknown().nullable(),
  decryption_last_error_code: z.string().nullable(),
  decryption_last_error_at: z.unknown().nullable(),
});

const balanceCacheSchema = z.object({
  // Only `exact` balances are cached (writeCachedBalance is gated on confirmed != null).
  status: z.enum(balanceTrustLevels),
  raw: z.string(),
  value: z.string(),
  source: z.enum(["derived", "checkpoint"]),
  pending_transfers: z.union([z.string(), z.number(), z.bigint()]),
  as_of_block: z.unknown().optional(),
  transfer_count: z.union([z.string(), z.number(), z.bigint()]),
  max_transfer_block: z.unknown().optional(),
  max_transfer_log_index: z.unknown().optional(),
  updated_at: z.unknown(),
});

const sdkCredentialSchema = z.object({
  value: z.string(),
});

const checkpointRowSchema = z.object({
  latest_checkpoint: z.string().length(75),
});

const decodePonderCheckpoint = (
  checkpoint: string,
): {
  readonly blockTimestamp: bigint;
  readonly blockNumber: bigint;
} => {
  const blockTimestamp = BigInt(checkpoint.slice(0, 10));
  const blockNumber = BigInt(checkpoint.slice(26, 42));

  return {
    blockTimestamp,
    blockNumber,
  };
};

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

const parseRequiredDate = (value: unknown): Date => {
  const parsed = parseDateOrNull(value);
  if (parsed === null) {
    throw new Error("Expected a valid timestamp");
  }

  return parsed;
};

const parseBigintOrNull = (value: unknown): bigint | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string") {
    return BigInt(value);
  }

  return null;
};

const parseRequiredBigint = (value: unknown): bigint => {
  const parsed = parseBigintOrNull(value);
  if (parsed === null) {
    throw new Error("Expected a valid bigint");
  }

  return parsed;
};

const parseNumberOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
};

const addressKey = (address: Address): string => getAddress(address).toLowerCase();

const lowerAddress = (address: Address): Address => addressKey(address) as Address;

interface BalanceFingerprint {
  readonly transferCount: number;
  readonly maxTransferBlock: bigint | null;
  readonly maxTransferLogIndex: number | null;
}

const fingerprintsEqual = (left: BalanceFingerprint, right: BalanceFingerprint): boolean => {
  return (
    left.transferCount === right.transferCount &&
    left.maxTransferBlock === right.maxTransferBlock &&
    left.maxTransferLogIndex === right.maxTransferLogIndex
  );
};
