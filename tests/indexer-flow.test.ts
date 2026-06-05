import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import type { BalanceTransferView } from "../src/balance/derive.js";
import { FakeDecryptor } from "../src/decryptor/fake-decryptor.js";
import { DecryptionDrainer } from "../src/drainer/drainer.js";
import { InMemoryDrainerStore } from "../src/drainer/in-memory-store.js";
import type { DrainerDelegation, DrainerTransfer } from "../src/drainer/store.js";
import { createIndexerApi } from "../src/api/app.js";
import type {
  ApiTransferView,
  DecryptionHealthSnapshot,
  IndexerCheckpointSnapshot,
  IndexerReadRepository,
} from "../src/api/repository.js";
import type { TokenMetadata } from "../src/api/token.js";

const now = new Date("2026-06-05T12:00:00.000Z");
const tokenAddress = "0x1000000000000000000000000000000000000000";
const indexerAddress = "0x2000000000000000000000000000000000000000";
const holder = "0x3000000000000000000000000000000000000000";
const recipient = "0x4000000000000000000000000000000000000000";
const handle = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const token: TokenMetadata = {
  chainId: 11155111,
  address: tokenAddress,
  name: "Confidential USDT",
  symbol: "cUSDT",
  decimals: 6,
  kind: "erc7984-erc20-wrapper",
  underlying: "0x5000000000000000000000000000000000000000",
};

class FlowRepository implements IndexerReadRepository {
  readonly #store: InMemoryDrainerStore;
  readonly #transfers: readonly DrainerTransfer[];

  constructor(store: InMemoryDrainerStore, transfers: readonly DrainerTransfer[]) {
    this.#store = store;
    this.#transfers = transfers;
  }

  getAsOfBlock(): Promise<bigint | null> {
    return Promise.resolve(10n);
  }

  getIndexerCheckpoint(): Promise<IndexerCheckpointSnapshot> {
    return Promise.resolve({
      indexedBlock: 10n,
      indexedBlockTimestamp: now,
    });
  }

  getTransferById(id: string): Promise<ApiTransferView | null> {
    const transfer = this.#transfers.find((row) => row.id === id);
    return Promise.resolve(transfer === undefined ? null : this.#toApiTransfer(transfer));
  }

  listAddressTransfers(address: Address): Promise<readonly ApiTransferView[]> {
    const lower = address.toLowerCase();
    return Promise.resolve(
      this.#transfers
        .filter((transfer) => transfer.from.toLowerCase() === lower || transfer.to.toLowerCase() === lower)
        .map((transfer) => this.#toApiTransfer(transfer)),
    );
  }

  listBalanceTransfers(address: Address): Promise<readonly BalanceTransferView[]> {
    return this.listAddressTransfers(address);
  }

  getDecryptionHealth(): Promise<DecryptionHealthSnapshot> {
    return Promise.resolve({
      pending: 0,
      unauthorized: 0,
      failed: 0,
      oldestPendingSeconds: null,
      lastSuccessAt: now,
      breakerState: "closed",
    });
  }

  #toApiTransfer(transfer: DrainerTransfer): ApiTransferView {
    const decryption = this.#store.getDecryption(transfer.amountHandle);

    return {
      ...transfer,
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      timestamp: BigInt(Math.floor(now.getTime() / 1_000)),
      kind: transfer.from === zeroAddress ? "shield" : transfer.to === zeroAddress ? "unshield" : "transfer",
      decryption:
        decryption === undefined
          ? null
          : {
              cleartextRaw: decryption.cleartextRaw,
              status: decryption.status,
              source: decryption.source,
            },
    };
  }
}

const transfer = (): DrainerTransfer => ({
  id: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1",
  blockNumber: 10n,
  logIndex: 1,
  from: holder,
  to: recipient,
  amountHandle: handle,
  disclosedRaw: null,
});

const delegation = (): DrainerDelegation => ({
  delegator: recipient,
  delegate: indexerAddress,
  contractAddress: tokenAddress,
  expiry: BigInt(Math.floor(now.getTime() / 1_000) + 3_600),
  lastEventBlock: 10n,
});

const createApp = (repository: IndexerReadRepository) =>
  createIndexerApi({
    repository,
    getTokenMetadata: () => Promise.resolve(token),
    getHeadBlock: () => Promise.resolve(10n),
    now: () => now,
  });

describe("fake indexer flow", () => {
  it("shows decrypted cleartext after the fake drainer processes a delegated transfer", async () => {
    const row = transfer();
    const store = new InMemoryDrainerStore({
      transfers: [row],
      delegations: [delegation()],
    });
    const decryptor = new FakeDecryptor({
      handles: new Map([
        [
          handle,
          {
            cleartext: 12_000_000n,
            allowedAccounts: new Set<Address>([recipient]),
          },
        ],
      ]),
      delegatedAccounts: new Set<Address>([recipient]),
    });
    const drainer = new DecryptionDrainer({
      store,
      decryptor,
      indexerAddress,
      tokenAddress,
      relayerMinDelayMs: 0,
      now: () => now,
    });

    await drainer.processOnce();

    const response = await createApp(new FlowRepository(store, [row])).request(`/v1/addresses/${recipient}/transfers`);
    const body = await response.json() as {
      readonly data: readonly [{ readonly amount: { readonly status: string; readonly raw: string; readonly value: string } }];
    };

    expect(body.data[0].amount).toEqual({
      status: "decrypted",
      raw: "12000000",
      value: "12.0",
      source: "userDecrypt",
    });
  });

  it("retains unauthorized events in the API instead of dropping them", async () => {
    const row = transfer();
    const store = new InMemoryDrainerStore({
      transfers: [row],
    });
    const decryptor = new FakeDecryptor({
      handles: new Map([
        [
          handle,
          {
            cleartext: 12_000_000n,
            allowedAccounts: new Set<Address>([recipient]),
          },
        ],
      ]),
    });
    const drainer = new DecryptionDrainer({
      store,
      decryptor,
      indexerAddress,
      tokenAddress,
      relayerMinDelayMs: 0,
      now: () => now,
    });

    await drainer.processOnce();

    const response = await createApp(new FlowRepository(store, [row])).request(`/v1/addresses/${recipient}/transfers`);
    const body = await response.json() as {
      readonly data: readonly [{ readonly id: string; readonly amount: { readonly status: string; readonly raw: null } }];
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: row.id,
      amount: {
        status: "unauthorized",
        raw: null,
      },
    });
  });
});
