import { zeroAddress, type Address } from "viem";

import type { Decryptor } from "../decryptor/decryptor.js";
import type { DecryptFailure, DecryptFailureKind, DecryptOutcome } from "../decryptor/outcome.js";
import type { DecryptionRow, DrainerStateRow } from "../db/drainer-schema.js";
import type { BreakerState, DecryptionStatus } from "../types/lifecycle.js";
import type { DrainerStore, DrainerTransfer, DrainerWorkItem } from "./store.js";

interface CredentialRefreshingDecryptor extends Decryptor {
  refreshCredentials(): Promise<void>;
}

export interface DecryptionDrainerOptions {
  readonly store: DrainerStore;
  readonly decryptor: Decryptor;
  readonly indexerAddress: Address;
  readonly tokenAddress: Address;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly relayerMinDelayMs?: number;
  readonly breakerFailureThreshold?: number;
  readonly breakerCooldownMs?: number;
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RetryPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly propagationBaseMs: number;
  readonly propagationMaxMs: number;
  readonly unauthorizedBackstopMs: number;
  readonly failedBackstopMs: number;
  readonly staleCredentialRetryMs: number;
}

export interface DecryptionDrainerRunResult {
  readonly processed: number;
  readonly decrypted: number;
  readonly unauthorized: number;
  readonly failed: number;
  readonly pending: number;
  readonly nudged: number;
  readonly breakerState: BreakerState;
}

export interface RunningDecryptionDrainer {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

const defaultRetryPolicy: RetryPolicy = {
  baseMs: 1_000,
  maxMs: 60_000,
  propagationBaseMs: 30_000,
  propagationMaxMs: 600_000,
  unauthorizedBackstopMs: 600_000,
  failedBackstopMs: 3_600_000,
  staleCredentialRetryMs: 0,
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const mergeRetryPolicy = (override: Partial<RetryPolicy> | undefined): RetryPolicy => ({
  ...defaultRetryPolicy,
  ...override,
});

export class DecryptionDrainer {
  readonly #store: DrainerStore;
  readonly #decryptor: Decryptor;
  readonly #indexerAddress: Address;
  readonly #tokenAddress: Address;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #relayerMinDelayMs: number;
  readonly #breakerFailureThreshold: number;
  readonly #breakerCooldownMs: number;
  readonly #retryPolicy: RetryPolicy;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #relayerGate: Promise<void> = Promise.resolve();
  #lastRelayerCallAt = 0;
  #consecutiveGlobalFailures = 0;

  constructor(options: DecryptionDrainerOptions) {
    this.#store = options.store;
    this.#decryptor = options.decryptor;
    this.#indexerAddress = options.indexerAddress;
    this.#tokenAddress = options.tokenAddress;
    this.#batchSize = options.batchSize ?? 100;
    this.#concurrency = options.concurrency ?? 4;
    this.#relayerMinDelayMs = options.relayerMinDelayMs ?? 250;
    this.#breakerFailureThreshold = options.breakerFailureThreshold ?? 5;
    this.#breakerCooldownMs = options.breakerCooldownMs ?? 60_000;
    this.#retryPolicy = mergeRetryPolicy(options.retryPolicy);
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async processOnce(): Promise<DecryptionDrainerRunResult> {
    const now = this.#now();
    const state = await this.#store.getDrainerState();
    if (state.breakerState === "open" && !this.#isBreakerReadyForProbe(state, now)) {
      return emptyRunResult(0, "open");
    }

    if (state.breakerState === "open") {
      await this.#writeBreakerState("halfOpen", now);
    }

    const nudged = await this.#store.nudgeUnauthorizedForActiveDelegations({
      delegate: this.#indexerAddress,
      contractAddress: this.#tokenAddress,
      at: now,
    });
    const work = await this.#store.listDueTransfers(now, this.#batchSize);
    const results = await mapLimited(work, this.#concurrency, (item) => this.#processWorkItem(item, now));

    return results.reduce<DecryptionDrainerRunResult>(
      (accumulator, result) => ({
        processed: accumulator.processed + 1,
        decrypted: accumulator.decrypted + (result.status === "decrypted" ? 1 : 0),
        unauthorized: accumulator.unauthorized + (result.status === "unauthorized" ? 1 : 0),
        failed: accumulator.failed + (result.status === "failed" ? 1 : 0),
        pending: accumulator.pending + (result.status === "pending" || result.status === "encrypted" ? 1 : 0),
        nudged,
        breakerState: result.breakerState,
      }),
      emptyRunResult(nudged, state.breakerState),
    );
  }

  async #processWorkItem(item: DrainerWorkItem, now: Date): Promise<{
    readonly status: DecryptionStatus;
    readonly breakerState: BreakerState;
  }> {
    const current =
      item.decryption ?? (await this.#store.seedEncryptedDecryption(item.transfer.amountHandle, now));
    const attempts = current.attempts + 1;
    const candidates = await this.#activeCandidates(item.transfer, now);

    if (candidates.length === 0) {
      await this.#writeFailure(current, {
        attempts,
        status: "unauthorized",
        nextAttemptAt: new Date(now.getTime() + this.#retryPolicy.unauthorizedBackstopMs),
        errorCode: "NO_ACTIVE_DELEGATION",
        lastErrorAt: now,
      });
      return { status: "unauthorized", breakerState: (await this.#store.getDrainerState()).breakerState };
    }

    let lastFailure: DecryptFailure | undefined;
    for (const candidate of candidates) {
      const outcome = await this.#decryptWithRateLimit(item.transfer.amountHandle, candidate);
      if (outcome.kind === "success") {
        await this.#store.writeDecryption({
          ...current,
          status: "decrypted",
          cleartextRaw: outcome.cleartextRaw,
          decryptedFor: candidate,
          source: "userDecrypt",
          attempts,
          nextAttemptAt: now,
          lastErrorCode: null,
          lastErrorAt: null,
        });
        this.#consecutiveGlobalFailures = 0;
        await this.#store.writeDrainerState({
          id: "singleton",
          lastSuccessAt: now,
          breakerState: "closed",
          breakerOpenedAt: null,
        });
        return { status: "decrypted", breakerState: "closed" };
      }

      lastFailure = outcome;
      if (outcome.failure !== "unauthorized") {
        break;
      }
    }

    const failure = lastFailure ?? {
      kind: "failure",
      failure: "unknown",
      errorCode: "UNKNOWN",
      message: "No decrypt outcome was returned",
    };
    const classified = await this.#classifyFailure(failure, attempts, now);
    await this.#writeFailure(current, classified);
    return {
      status: classified.status,
      breakerState: (await this.#store.getDrainerState()).breakerState,
    };
  }

  async #activeCandidates(transfer: DrainerTransfer, now: Date): Promise<readonly Address[]> {
    const candidates = orderedTransferCandidates(transfer);
    return this.#store.listActiveDelegators({
      delegators: candidates,
      delegate: this.#indexerAddress,
      contractAddress: this.#tokenAddress,
      at: now,
    });
  }

  async #decryptWithRateLimit(handle: `0x${string}`, candidate: Address): Promise<DecryptOutcome> {
    await this.#waitForRelayerSlot();
    return this.#decryptor.decryptTransferAmountAs(handle, candidate);
  }

  async #waitForRelayerSlot(): Promise<void> {
    this.#relayerGate = this.#relayerGate.then(async () => {
      const elapsedMs = Date.now() - this.#lastRelayerCallAt;
      const waitMs = Math.max(0, this.#relayerMinDelayMs - elapsedMs);
      if (waitMs > 0) {
        await this.#sleep(waitMs);
      }
      this.#lastRelayerCallAt = Date.now();
    });
    return this.#relayerGate;
  }

  async #classifyFailure(
    failure: DecryptFailure,
    attempts: number,
    now: Date,
  ): Promise<{
    readonly attempts: number;
    readonly status: Exclude<DecryptionStatus, "decrypted" | "encrypted">;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly lastErrorAt: Date;
  }> {
    if (failure.failure === "staleCredentials") {
      await this.#refreshCredentials();
    }

    if (isGlobalFailure(failure.failure)) {
      await this.#recordGlobalFailure(now);
    }

    const status = statusForFailure(failure.failure);
    const nextAttemptAt = new Date(now.getTime() + this.#delayFor(failure.failure, attempts));

    return {
      attempts,
      status,
      nextAttemptAt,
      errorCode: failure.errorCode,
      lastErrorAt: now,
    };
  }

  async #writeFailure(
    current: DecryptionRow,
    failure: {
      readonly attempts: number;
      readonly status: Exclude<DecryptionStatus, "decrypted">;
      readonly nextAttemptAt: Date;
      readonly errorCode: string;
      readonly lastErrorAt: Date;
    },
  ): Promise<void> {
    await this.#store.writeDecryption({
      ...current,
      cleartextRaw: null,
      status: failure.status,
      decryptedFor: null,
      source: null,
      attempts: failure.attempts,
      nextAttemptAt: failure.nextAttemptAt,
      lastErrorCode: failure.errorCode,
      lastErrorAt: failure.lastErrorAt,
    });
  }

  async #recordGlobalFailure(now: Date): Promise<void> {
    this.#consecutiveGlobalFailures += 1;
    if (this.#consecutiveGlobalFailures < this.#breakerFailureThreshold) {
      return;
    }

    await this.#writeBreakerState("open", now);
  }

  async #writeBreakerState(breakerState: BreakerState, now: Date): Promise<void> {
    const current = await this.#store.getDrainerState();
    await this.#store.writeDrainerState({
      id: "singleton",
      lastSuccessAt: current.lastSuccessAt,
      breakerState,
      breakerOpenedAt: breakerState === "open" ? now : null,
    });
  }

  #isBreakerReadyForProbe(state: DrainerStateRow, now: Date): boolean {
    return (
      state.breakerOpenedAt !== null &&
      now.getTime() - state.breakerOpenedAt.getTime() >= this.#breakerCooldownMs
    );
  }

  #delayFor(failure: DecryptFailureKind, attempts: number): number {
    switch (failure) {
      case "unauthorized":
        return this.#retryPolicy.unauthorizedBackstopMs;
      case "propagationLag":
        return jitteredExpBackoff(
          this.#retryPolicy.propagationBaseMs,
          this.#retryPolicy.propagationMaxMs,
          attempts,
          this.#random,
        );
      case "relayerRateLimited":
      case "relayerUnavailable":
      case "aclPaused":
        return jitteredExpBackoff(this.#retryPolicy.baseMs, this.#retryPolicy.maxMs, attempts, this.#random);
      case "staleCredentials":
        return this.#retryPolicy.staleCredentialRetryMs;
      case "decryptionFailed":
      case "unknown":
        return this.#retryPolicy.failedBackstopMs;
    }
  }

  async #refreshCredentials(): Promise<void> {
    if (isCredentialRefreshingDecryptor(this.#decryptor)) {
      await this.#decryptor.refreshCredentials();
    }
  }
}

export const startDecryptionDrainer = (
  drainer: DecryptionDrainer,
  options: {
    readonly intervalMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): RunningDecryptionDrainer => {
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = options.intervalMs ?? 5_000;
  const state = { stopped: false };

  const done = (async () => {
    while (!state.stopped) {
      await drainer.processOnce();
      await sleep(intervalMs);
    }
  })();

  return {
    done,
    async stop() {
      state.stopped = true;
      await done;
    },
  };
};

const orderedTransferCandidates = (transfer: DrainerTransfer): readonly Address[] => {
  const candidates: Address[] = [];

  for (const candidate of [transfer.to, transfer.from]) {
    if (candidate === zeroAddress || candidates.includes(candidate)) {
      continue;
    }

    candidates.push(candidate);
  }

  return candidates;
};

const statusForFailure = (
  failure: DecryptFailureKind,
): Exclude<DecryptionStatus, "decrypted" | "encrypted"> => {
  switch (failure) {
    case "unauthorized":
      return "unauthorized";
    case "decryptionFailed":
    case "unknown":
      return "failed";
    case "propagationLag":
    case "relayerRateLimited":
    case "relayerUnavailable":
    case "aclPaused":
    case "staleCredentials":
      return "pending";
  }
};

const isGlobalFailure = (failure: DecryptFailureKind): boolean => {
  switch (failure) {
    case "relayerRateLimited":
    case "relayerUnavailable":
    case "aclPaused":
      return true;
    case "unauthorized":
    case "propagationLag":
    case "staleCredentials":
    case "decryptionFailed":
    case "unknown":
      return false;
  }
};

const jitteredExpBackoff = (
  baseMs: number,
  maxMs: number,
  attempts: number,
  random: () => number,
): number => {
  const exponent = Math.max(0, attempts - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
};

const isCredentialRefreshingDecryptor = (
  decryptor: Decryptor,
): decryptor is CredentialRefreshingDecryptor => {
  return "refreshCredentials" in decryptor && typeof decryptor.refreshCredentials === "function";
};

const mapLimited = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  worker: (item: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results: Output[] = [];
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const itemIndex = nextIndex;
      nextIndex += 1;
      const item = items[itemIndex];
      if (item !== undefined) {
        results[itemIndex] = await worker(item);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
};

const emptyRunResult = (nudged: number, breakerState: BreakerState): DecryptionDrainerRunResult => ({
  processed: 0,
  decrypted: 0,
  unauthorized: 0,
  failed: 0,
  pending: 0,
  nudged,
  breakerState,
});
