import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { BalanceTransferView, DerivedBalance } from "../src/balance/derive.js";
import { createIndexerApi } from "../src/api/app.js";
import { compareTransfer, directionFor, filterAfterCursor } from "../src/api/serialization.js";
import type {
  ApiTransferView,
  BalanceCacheView,
  DecryptionHealthSnapshot,
  IndexerCheckpointSnapshot,
  IndexerReadRepository,
  TransferPage,
  TransferPageRequest,
} from "../src/api/repository.js";
import type { TokenMetadata } from "../src/api/token.js";
import type { DecryptionStatus } from "../src/types/lifecycle.js";

const token: TokenMetadata = {
  chainId: 11155111,
  address: "0x1000000000000000000000000000000000000000",
  name: "Confidential USDT",
  symbol: "cUSDT",
  decimals: 6,
  kind: "erc7984-erc20-wrapper",
  underlying: "0x2000000000000000000000000000000000000000",
};

const alice = "0x3000000000000000000000000000000000000000";
const bob = "0x4000000000000000000000000000000000000000";

interface MemoryRepositoryOptions {
  readonly transfers?: readonly ApiTransferView[];
  readonly checkpoint?: IndexerCheckpointSnapshot;
  readonly decryptionHealth?: DecryptionHealthSnapshot;
  readonly cachedBalance?: BalanceCacheView | null;
}

class MemoryRepository implements IndexerReadRepository {
  readonly #transfers: readonly ApiTransferView[];
  readonly #checkpoint: IndexerCheckpointSnapshot;
  readonly #decryptionHealth: DecryptionHealthSnapshot;
  #cachedBalance: BalanceCacheView | null;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.#transfers = options.transfers ?? [];
    this.#checkpoint = options.checkpoint ?? {
      indexedBlock: 12n,
      indexedBlockTimestamp: new Date("2026-06-05T11:59:30.000Z"),
    };
    this.#decryptionHealth = options.decryptionHealth ?? {
      pending: 1,
      unauthorized: 0,
      failed: 0,
      oldestPendingSeconds: 30,
      lastSuccessAt: new Date("2026-06-05T12:00:00.000Z"),
      breakerState: "closed",
    };
    this.#cachedBalance = options.cachedBalance ?? null;
  }

  getAsOfBlock(): Promise<bigint | null> {
    return Promise.resolve(this.#checkpoint.indexedBlock);
  }

  getIndexerCheckpoint(): Promise<IndexerCheckpointSnapshot> {
    return Promise.resolve(this.#checkpoint);
  }

  getTransferById(id: string): Promise<ApiTransferView | null> {
    return Promise.resolve(this.#transfers.find((transfer) => transfer.id === id) ?? null);
  }

  listAddressTransfers(address: Address): Promise<readonly ApiTransferView[]> {
    const lower = address.toLowerCase();
    return Promise.resolve(
      this.#transfers.filter(
        (transfer) => transfer.from.toLowerCase() === lower || transfer.to.toLowerCase() === lower,
      ),
    );
  }

  async listAddressTransferPage(address: Address, request: TransferPageRequest): Promise<TransferPage> {
    const rows = (await this.listAddressTransfers(address))
      .filter((transfer) => request.direction === undefined || directionFor(address, transfer) === request.direction)
      .filter((transfer) => request.kind === undefined || transfer.kind === request.kind)
      .filter((transfer) => request.status === undefined || amountStatus(transfer) === request.status)
      .sort(compareTransfer(request.order));

    const cursorExpired =
      request.cursor !== null &&
      !rows.some(
        (transfer) =>
          transfer.blockNumber === request.cursor?.blockNumber &&
          transfer.logIndex === request.cursor.logIndex,
      );
    const afterCursor = request.cursor === null ? rows : filterAfterCursor(rows, request.cursor, request.order);

    return {
      rows: afterCursor.slice(0, request.limit),
      cursorExpired,
    };
  }

  listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]> {
    return this.listAddressTransfers(address);
  }

  getCachedBalance(_address: Address, asOfBlock: bigint | null): Promise<BalanceCacheView | null> {
    if (this.#cachedBalance?.asOfBlock !== asOfBlock) {
      return Promise.resolve(null);
    }

    return Promise.resolve(this.#cachedBalance);
  }

  writeCachedBalance(_address: Address, balance: DerivedBalance, asOfBlock: bigint | null, updatedAt: Date): Promise<void> {
    this.#cachedBalance = {
      ...balance,
      asOfBlock,
      updatedAt,
    };
    return Promise.resolve();
  }

  getDecryptionHealth(): Promise<DecryptionHealthSnapshot> {
    return Promise.resolve(this.#decryptionHealth);
  }
}

const transfer = (overrides: Partial<ApiTransferView>): ApiTransferView => ({
  id: "0xaaa-1",
  txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  blockNumber: 10n,
  logIndex: 1,
  timestamp: 1_780_000_000n,
  from: bob,
  to: alice,
  kind: "transfer",
  amountHandle: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  disclosedRaw: null,
  decryption: {
    cleartextRaw: "10000000",
    status: "decrypted",
    source: "userDecrypt",
  },
  ...overrides,
});

const amountStatus = (transfer: ApiTransferView): DecryptionStatus => {
  if (transfer.disclosedRaw !== null) {
    return "decrypted";
  }

  return transfer.decryption?.status ?? "encrypted";
};

const appWith = (transfers: readonly ApiTransferView[], options: Omit<MemoryRepositoryOptions, "transfers"> = {}) =>
  createIndexerApi({
    repository: new MemoryRepository({ ...options, transfers }),
    getTokenMetadata: () => Promise.resolve(token),
    getHeadBlock: () => Promise.resolve(14n),
    now: () => new Date("2026-06-05T12:00:00.000Z"),
  });

describe("createIndexerApi", () => {
  it("returns token metadata", async () => {
    const response = await appWith([]).request("/v1/token");

    await expect(response.json()).resolves.toEqual(token);
  });

  it("returns an as_of balance: confirmed figure plus a pending summary", async () => {
    const app = appWith([
      transfer({ id: "known-in", from: zeroAddress, to: alice, blockNumber: 10n, logIndex: 0, disclosedRaw: "100000000", decryption: null }),
      transfer({ id: "pending-out", from: alice, to: bob, blockNumber: 11n, logIndex: 0, decryption: null }),
    ]);

    const response = await app.request(`/v1/addresses/${alice}/balance`);
    const body = await response.json() as {
      readonly balance: {
        readonly status: string;
        readonly value: string | null;
        readonly confirmed: { readonly raw: string; readonly value: string; readonly asOfBlock: number; readonly source: string } | null;
        readonly pending: { readonly count: number; readonly outbound: number; readonly oldestBlock: number };
      };
    };

    expect(body.balance).toMatchObject({
      status: "as_of",
      value: "100.0",
      confirmed: { raw: "100000000", value: "100.0", asOfBlock: 10, source: "derived" },
      pending: { count: 1, outbound: 1, oldestBlock: 11 },
    });
  });

  it("returns an unknown balance when the earliest affecting transfer is un-valued", async () => {
    const app = appWith([
      transfer({
        id: "unauthorized-in",
        from: bob,
        to: alice,
        blockNumber: 10n,
        logIndex: 0,
        decryption: { cleartextRaw: null, status: "unauthorized", source: "userDecrypt" },
      }),
    ]);

    const response = await app.request(`/v1/addresses/${alice}/balance`);
    const body = await response.json() as {
      readonly balance: {
        readonly status: string;
        readonly value: string | null;
        readonly confirmed: unknown;
        readonly pending: { readonly count: number; readonly inbound: number; readonly byStatus: Record<string, number> };
      };
    };

    expect(body.balance).toMatchObject({
      status: "unknown",
      value: null,
      confirmed: null,
      pending: { count: 1, inbound: 1, byStatus: { unauthorized: 1 } },
    });
  });

  it("uses the cached balance when it matches the current indexed block", async () => {
    const app = appWith([], {
      cachedBalance: {
        status: "exact",
        confirmed: { raw: "42000000", value: "42.0", asOfBlock: 12n, source: "derived" },
        pending: { count: 0, inbound: 0, outbound: 0, oldestBlock: null, byStatus: {} },
        asOfBlock: 12n,
        updatedAt: new Date("2026-06-05T12:00:00.000Z"),
      },
    });

    const response = await app.request(`/v1/addresses/${alice}/balance`);
    const body = await response.json() as {
      readonly balance: {
        readonly status: string;
        readonly value: string;
        readonly confirmed: { readonly raw: string; readonly source: string } | null;
      };
    };

    expect(body.balance).toMatchObject({
      status: "exact",
      value: "42.0",
      confirmed: { raw: "42000000", source: "derived" },
    });
  });

  it("lists address transfers with amount status and cursor pagination", async () => {
    const app = appWith([
      transfer({ id: "older", blockNumber: 10n, logIndex: 1 }),
      transfer({
        id: "newer",
        blockNumber: 11n,
        logIndex: 1,
        from: alice,
        to: bob,
        decryption: {
          cleartextRaw: null,
          status: "pending",
          source: "userDecrypt",
        },
      }),
    ]);

    const response = await app.request(`/v1/addresses/${alice}/transfers?limit=1`);
    const body = await response.json() as {
      readonly data: readonly [{ readonly id: string; readonly direction: string; readonly amount: { readonly status: string } }];
      readonly page: { readonly hasMore: boolean; readonly nextCursor: string | null };
    };

    expect(body.data[0].id).toBe("newer");
    expect(body.data[0].direction).toBe("out");
    expect(body.data[0].amount.status).toBe("pending");
    expect(body.page.hasMore).toBe(true);
    expect(body.page.nextCursor).not.toBeNull();
  });

  it("returns one transfer by id and 404s unknown ids", async () => {
    const app = appWith([transfer({ id: "known" })]);

    const found = await app.request("/v1/transfers/known");
    await expect(found.json()).resolves.toMatchObject({ id: "known" });

    const missing = await app.request("/v1/transfers/missing");
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(missing.status).toBe(404);
  });

  it("uses the documented error envelope for bad addresses", async () => {
    const response = await appWith([]).request("/v1/addresses/not-an-address/balance");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_ADDRESS",
      },
    });
  });

  it("reports independent indexer and decryption health and returns 503 when unhealthy", async () => {
    const app = createIndexerApi({
      repository: new MemoryRepository({
        decryptionHealth: {
          pending: 10,
          unauthorized: 2,
          failed: 1,
          oldestPendingSeconds: 4_000,
          lastSuccessAt: new Date("2026-06-05T11:00:00.000Z"),
          breakerState: "open",
        },
        checkpoint: {
          indexedBlock: 1_000n,
          indexedBlockTimestamp: new Date("2026-06-05T11:00:00.000Z"),
        },
      }),
      getTokenMetadata: () => Promise.resolve(token),
      getHeadBlock: () => Promise.resolve(2_050n),
      now: () => new Date("2026-06-05T12:00:00.000Z"),
    });

    const response = await app.request("/v1/health");
    const body = await response.json() as {
      readonly status: string;
      readonly indexer: { readonly headBlock: number; readonly indexedBlock: number; readonly lagBlocks: number };
      readonly decryption: { readonly pending: number; readonly breakerState: string };
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.indexer).toMatchObject({
      headBlock: 2050,
      indexedBlock: 1000,
      lagBlocks: 1050,
    });
    expect(body.decryption).toMatchObject({
      pending: 10,
      breakerState: "open",
    });
  });
});
