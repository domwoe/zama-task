import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { BalanceTransferView } from "../src/balance/derive.js";
import { createIndexerApi } from "../src/api/app.js";
import type {
  ApiTransferView,
  DecryptionHealthSnapshot,
  IndexerReadRepository,
} from "../src/api/repository.js";
import type { TokenMetadata } from "../src/api/token.js";

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

class MemoryRepository implements IndexerReadRepository {
  readonly #transfers: readonly ApiTransferView[];

  constructor(transfers: readonly ApiTransferView[]) {
    this.#transfers = transfers;
  }

  getAsOfBlock(): Promise<bigint | null> {
    return Promise.resolve(12n);
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

  listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]> {
    return this.listAddressTransfers(address);
  }

  getDecryptionHealth(): Promise<DecryptionHealthSnapshot> {
    return Promise.resolve({
      pending: 1,
      unauthorized: 0,
      failed: 0,
      oldestPendingSeconds: 30,
      lastSuccessAt: new Date("2026-06-05T12:00:00.000Z"),
      breakerState: "closed",
    });
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

const appWith = (transfers: readonly ApiTransferView[]) =>
  createIndexerApi({
    repository: new MemoryRepository(transfers),
    getTokenMetadata: () => Promise.resolve(token),
    now: () => new Date("2026-06-05T12:00:00.000Z"),
  });

describe("createIndexerApi", () => {
  it("returns token metadata", async () => {
    const response = await appWith([]).request("/v1/token");

    await expect(response.json()).resolves.toEqual(token);
  });

  it("returns a derived partial balance for unknown cleartext", async () => {
    const app = appWith([
      transfer({
        id: "known-in",
        from: zeroAddress,
        to: alice,
        disclosedRaw: "100000000",
        decryption: null,
      }),
      transfer({
        id: "unknown-out",
        from: alice,
        to: bob,
        decryption: null,
      }),
    ]);

    const response = await app.request(`/v1/addresses/${alice}/balance`);
    const body = await response.json() as {
      readonly balance: {
        readonly status: string;
        readonly raw: string;
        readonly pendingTransfers: number;
      };
    };

    expect(body.balance).toMatchObject({
      status: "partial",
      raw: "100000000",
      pendingTransfers: 1,
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
});
