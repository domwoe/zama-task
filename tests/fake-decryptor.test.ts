import { describe, expect, it } from "vitest";

import { FakeDecryptor } from "../src/decryptor/fake-decryptor.js";

const handle = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const delegator = "0x00000000000000000000000000000000000000a1";

describe("FakeDecryptor", () => {
  it("retains an unauthorized outcome until delegation is granted", async () => {
    const decryptor = new FakeDecryptor({
      handles: new Map([
        [
          handle,
          {
            cleartext: 42n,
            allowedAccounts: new Set([delegator]),
          },
        ],
      ]),
    });

    await expect(decryptor.decryptTransferAmountAs(handle, delegator)).resolves.toMatchObject({
      kind: "failure",
      failure: "unauthorized",
    });

    decryptor.grantDelegation(delegator);

    await expect(decryptor.decryptTransferAmountAs(handle, delegator)).resolves.toEqual({
      kind: "success",
      cleartextRaw: "42",
    });
  });

  it("models delegation propagation lag before decrypting", async () => {
    const decryptor = new FakeDecryptor({
      delegatedAccounts: new Set([delegator]),
      propagationFailures: new Map([[handle, 1]]),
      handles: new Map([
        [
          handle,
          {
            cleartext: 7n,
            allowedAccounts: new Set([delegator]),
          },
        ],
      ]),
    });

    await expect(decryptor.decryptTransferAmountAs(handle, delegator)).resolves.toMatchObject({
      kind: "failure",
      failure: "propagationLag",
    });

    await expect(decryptor.decryptTransferAmountAs(handle, delegator)).resolves.toEqual({
      kind: "success",
      cleartextRaw: "7",
    });
  });
});
