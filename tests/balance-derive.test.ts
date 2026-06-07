import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";

import { FakeDecryptor } from "../src/decryptor/fake-decryptor.js";
import { underlyingToWrappedRaw } from "../src/balance/rate.js";
import {
  decryptBalanceCheckpoint,
  deriveBalance,
  formatBaseUnitValue,
  type BalanceTransferView,
} from "../src/balance/derive.js";
import type { DecryptionStatus } from "../src/types/lifecycle.js";

const alice = "0x5000000000000000000000000000000000000000";
const bob = "0x6000000000000000000000000000000000000000";

const transfer = (
  id: string,
  from: Address,
  to: Address,
  cleartextRaw: string | null,
  block: number,
  pendingStatus: DecryptionStatus = "encrypted",
): BalanceTransferView => ({
  id,
  blockNumber: BigInt(block),
  logIndex: 0,
  from,
  to,
  disclosedRaw: cleartextRaw,
  decryption:
    cleartextRaw !== null
      ? { cleartextRaw, status: "decrypted", source: "userDecrypt" }
      : pendingStatus === "encrypted"
        ? null
        : { cleartextRaw: null, status: pendingStatus, source: "userDecrypt" },
});

describe("deriveBalance", () => {
  it("is exact when the whole history is valued (signed sum, no mutable counter)", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 0,
      indexedBlock: 4n,
      transfers: [
        transfer("mint", zeroAddress, alice, "100", 1),
        transfer("out", alice, bob, "30", 2),
        transfer("in", bob, alice, "10", 3),
        transfer("burn", alice, zeroAddress, "5", 4),
      ],
    });

    expect(balance).toEqual({
      status: "exact",
      confirmed: { raw: "75", value: "75", asOfBlock: 4n, source: "derived" },
      pending: { count: 0, inbound: 0, outbound: 0, oldestBlock: null, byStatus: {} },
    });
  });

  it("is exact 0 for an address with no transfers", () => {
    const balance = deriveBalance({ address: alice, decimals: 0, indexedBlock: 9n, transfers: [] });

    expect(balance).toEqual({
      status: "exact",
      confirmed: { raw: "0", value: "0", asOfBlock: 9n, source: "derived" },
      pending: { count: 0, inbound: 0, outbound: 0, oldestBlock: null, byStatus: {} },
    });
  });

  it("is as_of (exact, earlier block) when a newer transfer is still pending", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 0,
      indexedBlock: 2n,
      transfers: [
        transfer("mint", zeroAddress, alice, "100", 1),
        transfer("pending-out", alice, bob, null, 2),
      ],
    });

    expect(balance).toEqual({
      status: "as_of",
      confirmed: { raw: "100", value: "100", asOfBlock: 1n, source: "derived" },
      pending: { count: 1, inbound: 0, outbound: 1, oldestBlock: 2n, byStatus: { encrypted: 1 } },
    });
  });

  it("is unknown (no anchor) when the earliest affecting transfer is un-valued", () => {
    const balance = deriveBalance({
      address: alice,
      decimals: 0,
      indexedBlock: 2n,
      transfers: [
        transfer("unauthorized-in", bob, alice, null, 1, "unauthorized"),
        transfer("later-mint", zeroAddress, alice, "100", 2),
      ],
    });

    expect(balance).toEqual({
      status: "unknown",
      confirmed: null,
      pending: { count: 1, inbound: 1, outbound: 0, oldestBlock: 1n, byStatus: { unauthorized: 1 } },
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

  it("converts unwrap public amounts from underlying units to wrapped units", () => {
    expect(underlyingToWrappedRaw(1_000n, 10n)).toBe("100");
    expect(() => underlyingToWrappedRaw(1_000n, 0n)).toThrow("Wrapper rate must be positive");
  });
});
