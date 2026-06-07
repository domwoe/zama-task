import { describe, expect, it } from "vitest";

import {
  deserializeSdkStorageValue,
  serializeSdkStorageValue,
} from "../src/decryptor/generic-storage.js";

describe("SDK storage JSON", () => {
  it("round-trips nested bigint values", () => {
    const stored = serializeSdkStorageValue({
      keyId: "local-test-key",
      counters: [0n, 1n, 12_345_678_901_234_567_890n],
      metadata: {
        negative: -42n,
        regularString: "123",
      },
    });

    expect(deserializeSdkStorageValue(stored)).toEqual({
      keyId: "local-test-key",
      counters: [0n, 1n, 12_345_678_901_234_567_890n],
      metadata: {
        negative: -42n,
        regularString: "123",
      },
    });
  });

  it("round-trips a top-level bigint value", () => {
    const stored = serializeSdkStorageValue(99n);

    expect(deserializeSdkStorageValue(stored)).toEqual(99n);
  });

  it("rejects malformed tagged bigint payloads", () => {
    const stored = JSON.stringify({
      __zamaConfidentialIndexerJsonType: "bigint",
      value: "not-a-decimal",
    });

    expect(() => deserializeSdkStorageValue(stored)).toThrow("Invalid bigint value");
  });
});
