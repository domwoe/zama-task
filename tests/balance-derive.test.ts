import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import { FakeDecryptor } from "../src/decryptor/fake-decryptor.js";
import {
  decryptBalanceCheckpoint,
  deriveBalance,
  formatBaseUnitValue,
  type BalanceTransferView,
} from "../src/balance/derive.js";

const alice = "0x5000000000000000000000000000000000000000";
const bob = "0x6000000000000000000000000000000000000000";

const transfer = (
  id: string,
  from: Address,
  to: Address,
  cleartextRaw: string | null,
): BalanceTransferView => ({
  id,
  from,
  to,
  disclosedRaw: cleartextRaw,
  decryption:
    cleartextRaw === null
      ? null
      : {
          cleartextRaw,
          status: "decrypted",
          source: "userDecrypt",
        },
});

describe("deriveBalance", () => {
  it("sums signed cleartext deltas without mutating a counter", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 0,
      transfers: [
        transfer("mint", zeroAddress, alice, "100"),
        transfer("out", alice, bob, "30"),
        transfer("in", bob, alice, "10"),
        transfer("burn", alice, zeroAddress, "5"),
      ],
    });

    expect(balance).toEqual({
      status: "complete",
      raw: "75",
      value: "75",
      source: "derived",
      pendingTransfers: 0,
    });
  });

  it("returns a partial derived balance when an affecting transfer lacks cleartext", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 0,
      transfers: [
        transfer("mint", zeroAddress, alice, "100"),
        transfer("unknown-out", alice, bob, null),
      ],
    });

    expect(balance).toEqual({
      status: "partial",
      raw: "100",
      value: "100",
      source: "derived",
      pendingTransfers: 1,
    });
  });

  it("uses a checkpoint raw total for partial balances when available", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 6,
      checkpoint: { cleartextRaw: "70000000" },
      transfers: [
        transfer("mint", zeroAddress, alice, "100000000"),
        transfer("unknown-out", alice, bob, null),
      ],
    });

    expect(balance).toEqual({
      status: "partial",
      raw: "70000000",
      value: "70.0",
      source: "checkpoint",
      pendingTransfers: 1,
    });
  });

  it("formats base-unit raw strings with token decimals", () => {
    expect(formatBaseUnitValue("40000000", 6)).toBe("40.0");
    expect(formatBaseUnitValue("12345678", 6)).toBe("12.345678");
    expect(formatBaseUnitValue("-500000", 6)).toBe("-0.5");
  });

  it("decrypts checkpoint balances through the decryptor seam", async () => {
    const decryptor = new FakeDecryptor({
      handles: new Map(),
      balances: new Map<Address, bigint>([[alice, 123n]]),
      delegatedAccounts: new Set<Address>([alice]),
    });

    await expect(decryptBalanceCheckpoint(decryptor, alice)).resolves.toEqual({
      cleartextRaw: "123",
    });
  });
});
