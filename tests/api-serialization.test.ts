import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  serializeAmount,
} from "../src/api/serialization.js";
import type { ApiTransferView } from "../src/api/repository.js";

const transfer = (overrides: Partial<ApiTransferView> = {}): ApiTransferView => ({
  id: "0xaaa-1",
  txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  blockNumber: 10n,
  logIndex: 1,
  timestamp: 1_780_000_000n,
  from: "0x1000000000000000000000000000000000000000",
  to: "0x2000000000000000000000000000000000000000",
  kind: "transfer",
  amountHandle: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  disclosedRaw: null,
  decryption: null,
  ...overrides,
});

describe("API serialization", () => {
  it("round-trips keyset cursors", () => {
    const cursor = encodeCursor({ blockNumber: 1234567n, logIndex: 3 });

    expect(decodeCursor(cursor)).toEqual({
      blockNumber: 1234567n,
      logIndex: 3,
    });
  });

  it("serializes disclosed cleartext as a decrypted amount", () => {
    expect(serializeAmount(transfer({ disclosedRaw: "40000000" }), 6)).toEqual({
      status: "decrypted",
      raw: "40000000",
      value: "40.0",
      source: "disclosed",
    });
  });

  it("serializes undecrypted rows with their retryable status", () => {
    expect(
      serializeAmount(
        transfer({
          decryption: {
            cleartextRaw: null,
            status: "failed",
            source: "userDecrypt",
          },
        }),
        6,
      ),
    ).toEqual({
      status: "failed",
      raw: null,
      value: null,
      source: "userDecrypt",
    });
  });
});
