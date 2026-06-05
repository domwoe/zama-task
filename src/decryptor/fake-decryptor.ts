import type { Address } from "viem";

import type { Decryptor } from "./decryptor.js";
import { success, type DecryptOutcome } from "./outcome.js";

type Handle = `0x${string}`;

interface FakeHandleRule {
  readonly cleartext: bigint;
  readonly allowedAccounts: ReadonlySet<Address>;
}

export interface FakeDecryptorOptions {
  handles: ReadonlyMap<Handle, FakeHandleRule>;
  delegatedAccounts?: ReadonlySet<Address>;
  propagationFailures?: ReadonlyMap<Handle, number>;
  balances?: ReadonlyMap<Address, bigint>;
}

export class FakeDecryptor implements Decryptor {
  readonly #handles: ReadonlyMap<Handle, FakeHandleRule>;
  readonly #delegatedAccounts: Set<Address>;
  readonly #remainingPropagationFailures: Map<Handle, number>;
  readonly #balances: ReadonlyMap<Address, bigint>;

  constructor(options: FakeDecryptorOptions) {
    this.#handles = options.handles;
    this.#delegatedAccounts = new Set(options.delegatedAccounts);
    this.#remainingPropagationFailures = new Map(options.propagationFailures);
    this.#balances = options.balances ?? new Map<Address, bigint>();
  }

  grantDelegation(account: Address): void {
    this.#delegatedAccounts.add(account);
  }

  revokeDelegation(account: Address): void {
    this.#delegatedAccounts.delete(account);
  }

  decryptTransferAmountAs(handle: Handle, delegator: Address): Promise<DecryptOutcome> {
    const rule = this.#handles.get(handle);
    if (rule === undefined) {
      return Promise.resolve({
        kind: "failure",
        failure: "decryptionFailed",
        errorCode: "DECRYPTION_FAILED",
        message: `Unknown encrypted handle ${handle}`,
      });
    }

    const remainingLagFailures = this.#remainingPropagationFailures.get(handle) ?? 0;
    if (remainingLagFailures > 0) {
      this.#remainingPropagationFailures.set(handle, remainingLagFailures - 1);
      return Promise.resolve({
        kind: "failure",
        failure: "propagationLag",
        errorCode: "DELEGATION_NOT_PROPAGATED",
        message: "Delegation has not propagated yet",
      });
    }

    if (!this.#delegatedAccounts.has(delegator) || !rule.allowedAccounts.has(delegator)) {
      return Promise.resolve({
        kind: "failure",
        failure: "unauthorized",
        errorCode: "DELEGATION_NOT_FOUND",
        message: "No active delegation for handle",
      });
    }

    return Promise.resolve(success(rule.cleartext));
  }

  decryptBalanceAs(holder: Address): Promise<DecryptOutcome> {
    if (!this.#delegatedAccounts.has(holder)) {
      return Promise.resolve({
        kind: "failure",
        failure: "unauthorized",
        errorCode: "DELEGATION_NOT_FOUND",
        message: "No active delegation for balance",
      });
    }

    return Promise.resolve(success(this.#balances.get(holder) ?? 0n));
  }
}
