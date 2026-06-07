import { describe, expect, it } from "vitest";

import { shieldDisclosedRaw, type UnderlyingDeposit } from "../src/balance/rate.js";

const wrapper = "0x1000000000000000000000000000000000000000" as const;
const other = "0x3000000000000000000000000000000000000000" as const;

const deposit = (to: `0x${string}`, value: bigint): UnderlyingDeposit => ({ to, value });

describe("shieldDisclosedRaw", () => {
  it("values a single underlying deposit into the wrapper via the rate", () => {
    expect(shieldDisclosedRaw([deposit(wrapper, 12_000_000n)], wrapper, 1n)).toBe("12000000");
  });

  it("applies the wrapper rate when underlying and wrapped units differ", () => {
    // rate = 1000 underlying base units per wrapped base unit.
    expect(shieldDisclosedRaw([deposit(wrapper, 12_000n)], wrapper, 1_000n)).toBe("12");
  });

  it("matches the wrapper case-insensitively", () => {
    expect(shieldDisclosedRaw([deposit(wrapper.toUpperCase() as `0x${string}`, 5n)], wrapper, 1n)).toBe("5");
  });

  it("returns null when no deposit targets the wrapper", () => {
    expect(shieldDisclosedRaw([deposit(other, 9n)], wrapper, 1n)).toBeNull();
  });

  it("returns null for an empty receipt (no underlying deposit found)", () => {
    expect(shieldDisclosedRaw([], wrapper, 1n)).toBeNull();
  });

  it("refuses to guess when multiple deposits into the wrapper are ambiguous", () => {
    expect(
      shieldDisclosedRaw([deposit(wrapper, 4n), deposit(wrapper, 7n)], wrapper, 1n),
    ).toBeNull();
  });

  it("ignores unrelated deposits and values the unique wrapper deposit", () => {
    expect(
      shieldDisclosedRaw([deposit(other, 99n), deposit(wrapper, 8n)], wrapper, 2n),
    ).toBe("4");
  });
});
