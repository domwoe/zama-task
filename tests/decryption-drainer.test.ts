import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import { FakeDecryptor } from "../src/decryptor/fake-decryptor.js";
import type { DecryptOutcome } from "../src/decryptor/outcome.js";
import { DecryptionDrainer } from "../src/drainer/drainer.js";
import { InMemoryDrainerStore } from "../src/drainer/in-memory-store.js";
import type { DrainerDelegation, DrainerTransfer } from "../src/drainer/store.js";

const now = new Date("2026-06-05T12:00:00.000Z");
const tokenAddress = "0x1000000000000000000000000000000000000000";
const indexerAddress = "0x2000000000000000000000000000000000000000";
const sender = "0x3000000000000000000000000000000000000000";
const recipient = "0x4000000000000000000000000000000000000000";
const handle = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const transfer = (overrides: Partial<DrainerTransfer> = {}): DrainerTransfer => ({
  id: "0xabc-1",
  blockNumber: 10n,
  logIndex: 1,
  from: sender,
  to: recipient,
  amountHandle: handle,
  disclosedRaw: null,
  ...overrides,
});

const delegation = (delegator: Address): DrainerDelegation => ({
  delegator,
  delegate: indexerAddress,
  contractAddress: tokenAddress,
  expiry: BigInt(Math.floor(now.getTime() / 1_000) + 3_600),
  lastEventBlock: 11n,
});

const createDrainer = (
  store: InMemoryDrainerStore,
  decryptor: FakeDecryptor,
): DecryptionDrainer =>
  new DecryptionDrainer({
    store,
    decryptor,
    indexerAddress,
    tokenAddress,
    relayerMinDelayMs: 0,
    now: () => now,
    random: () => 1,
  });

describe("DecryptionDrainer", () => {
  it("moves a delegated encrypted handle to decrypted", async () => {
    const store = new InMemoryDrainerStore({
      transfers: [transfer()],
      delegations: [delegation(recipient)],
    });
    const decryptor = new FakeDecryptor({
      handles: new Map([
        [
          handle,
          {
            cleartext: 42n,
            allowedAccounts: new Set<Address>([recipient]),
          },
        ],
      ]),
      delegatedAccounts: new Set<Address>([recipient]),
    });

    const result = await createDrainer(store, decryptor).processOnce();

    expect(result).toMatchObject({ processed: 1, decrypted: 1, unauthorized: 0 });
    expect(store.getDecryption(handle)).toMatchObject({
      status: "decrypted",
      cleartextRaw: "42",
      decryptedFor: recipient,
      source: "userDecrypt",
      attempts: 1,
    });
  });

  it("keeps undelegated handles unauthorized, then nudges them after a grant", async () => {
    const store = new InMemoryDrainerStore({
      transfers: [transfer()],
    });
    const decryptor = new FakeDecryptor({
      handles: new Map([
        [
          handle,
          {
            cleartext: 7n,
            allowedAccounts: new Set<Address>([recipient]),
          },
        ],
      ]),
    });
    const drainer = createDrainer(store, decryptor);

    const first = await drainer.processOnce();
    expect(first).toMatchObject({ processed: 1, unauthorized: 1, decrypted: 0 });
    expect(store.getDecryption(handle)).toMatchObject({
      status: "unauthorized",
      cleartextRaw: null,
      lastErrorCode: "NO_ACTIVE_DELEGATION",
    });

    store.addDelegation(delegation(recipient));
    decryptor.grantDelegation(recipient);

    const second = await drainer.processOnce();
    expect(second).toMatchObject({ processed: 1, decrypted: 1, nudged: 1 });
    expect(store.getDecryption(handle)).toMatchObject({
      status: "decrypted",
      cleartextRaw: "7",
      decryptedFor: recipient,
    });
  });

  it("does not call the relayer when no candidate has an active delegation", async () => {
    let relayerCalls = 0;
    const store = new InMemoryDrainerStore({
      transfers: [transfer({ from: zeroAddress })],
    });
    const decryptor = {
      decryptTransferAmountAs(): Promise<DecryptOutcome> {
        relayerCalls += 1;
        return Promise.resolve({
          kind: "failure",
          failure: "unknown",
          errorCode: "UNEXPECTED",
          message: "unexpected relayer call",
        });
      },
      decryptBalanceAs(): Promise<DecryptOutcome> {
        return Promise.resolve({
          kind: "failure",
          failure: "unknown",
          errorCode: "UNUSED",
          message: "unused",
        });
      },
    };
    const drainer = new DecryptionDrainer({
      store,
      decryptor,
      indexerAddress,
      tokenAddress,
      relayerMinDelayMs: 0,
      now: () => now,
    });

    await drainer.processOnce();

    expect(relayerCalls).toBe(0);
    expect(store.getDecryption(handle)).toMatchObject({ status: "unauthorized" });
  });
});
