# DECISIONS

---

## Decision 1 — Indexer library: **Ponder**

**Why.** A simple, type-safe TS-native library. However, it is still pre-1.0, and I couldn't quickly find much information about who uses it in production. Envio seems to be a more production-ready choice, but also more complex and feature-rich for this task.

**Consequences.** This constrains the choice of API framework (Hono) and database (PostgreSQL/PGLite) since I'd like to minimize dependencies.

---

## Decision 2 — Architecture: decouple indexing from decryption


**Why.** (1) Decryption might not be possible at the time of indexing; (2) Decryption depends on an external service (the relayer hosted by Zama) and might be slow and/or unavailable; (3) We don't want to drop events that can't be decrypted right now; (4) For scalability, it might make sense to have multiple workers handle decryption without impacting API performance.


---

## Decision 3 — Database: **PGlite (embedded), single process**

**Choice:** PGlite, embedded in the Ponder process, with the decryption drainer
running **in the same process** as a background loop.

**Why.** Simplicity. No extra database. No Docker/Docker Compose.

### Robust production architecture

If this graduated to a production multi-contract / high-volume service, the shape
changes along one axis — the process boundary:

- **Postgres (server)** in place of embedded PGlite, so multiple processes share
  the database over real, pooled, multi-connection access.
- **Decryption worker as its own process** (or N workers), reading the same
  `pending` queue. This restores fault isolation (a hung relayer call can't touch
  indexing), independent restart/scaling, and isolated rate-limiting/backpressure
  for the relayer.
- Everything else — the schema, the `pending` → `decrypted`/`unauthorized` state
  machine, the ACL-backfill-via-retry flow — is **unchanged**. Because the
  decoupling lives in the persisted queue (Decision 2), this is a deployment swap
  (`DATABASE_URL` + split the loop into a process), not a redesign. Ponder already
  treats Postgres as its production target, so the migration path is first-class.

## Decision 4 — Read API shape

**Full reference: [`API.md`](./API.md).** This section is the *why*; that file is
the spec.

**Choice.** A small REST API under `/v1` that looks like any other token indexer
(Alchemy/Covalent/Etherscan shapes), with exactly **one** unfamiliar concept: an
amount can be absent because it is still encrypted. Endpoints: `GET /v1/token`,
`/v1/addresses/{address}/balance`, `/v1/addresses/{address}/transfers`,
`/v1/transfers/{id}`, `/v1/health`. I tried to make the balance endpoint consumable by simple wallets (a top-level balance value), while also providing additional data for more sophisticated wallets that want to display more detailed information to the user.


---

## Decision 5 — Environment: **Sepolia + public Relayer** (primary)

**Choice:** Build and demo the indexer against **Sepolia with the public Zama
Relayer**.

**Why.** Initially, I preferred the local model (no network dependencies, faucet, etc.) and looked into `forge-fhevm`, but since the interesting pieces are decryption and backfilling, and there is no proper local equivalent of the relayer service, I chose the Sepolia path. We still have local integration tests using Anvil and a fake decryptor for simpler testing.

---

## Decision 6 — Delegation & backfill model

**Choice:** The indexer holds its own EOA and decrypts **as a delegate**. A token
holder grants the indexer decrypt rights via the ACL's
`delegateForUserDecryption`; the indexer reads their amounts via the SDK's
delegate path (`decryptBalanceAs`), signing the EIP-712 request with **its own
key**. The ACL `DelegatedForUserDecryption` event is the **backfill trigger**.

**Why.** An indexer watching a single contract is almost never a party
to the transfers it sees, so it cannot decrypt as sender/recipient.


**Backfill is event-driven.** The grant emits
`DelegatedForUserDecryption(delegator, delegate, contractAddress, …)` with
`delegator`/`delegate` indexed (`ACL.sol:300`). We add the **ACL contract** to
`ponder.config` with an event filter `delegate == INDEXER_ADDR`; on receipt, we
re-drive that `delegator`'s `unauthorized` rows. A periodic poll remains as a
backstop (see propagation lag below).

**Propagation lag is part of the contract.** The example explicitly retries
`DelegationNotPropagatedError` because "Sepolia ACL propagation can take one or two
minutes." So seeing the delegation event does **not** mean the next decrypt
succeeds. The consequences are baked into the drainer:
- `unauthorized` is **not terminal** — retry with backoff.
- Expect a 1–2 min window where the event is observed but decryption still fails
  authorization.

---

## Decision 7 — Indexed events & amount provenance

**Choice.** The token is an **ERC-7984 ERC-20 wrapper**, so we index both the base
`IERC7984` and the `IERC7984ERC20Wrapper` events:

| Event | Carries |
| --- | --- |
| `ConfidentialTransfer(from, to, euint64 indexed amount)` | encrypted handle |
| `AmountDisclosed(euint64 indexed encryptedAmount, uint64 amount)` | handle + cleartext |
| `UnwrapRequested(receiver, unwrapRequestId, euint64 amount)` | handle |
| `UnwrapFinalized(receiver, unwrapRequestId, euint64 encryptedAmount, uint64 cleartextAmount)` | handle + cleartext |
| `ACL.DelegatedForUserDecryption(delegator, delegate, contractAddress, …)` | backfill trigger (D6) |

**Amount provenance — three sources, only one needs the relayer:**

1. **Cleartext in the event** (`source='disclosed'`, skips the queue):
   `AmountDisclosed.amount` and `UnwrapFinalized.cleartextAmount` (the latter also
   values the unshield-burn, joined on `unwrapRequestId`).
2. **Public shield mints** (`source='disclosed'`): a shield has no wrap event, but the
   underlying ERC-20 emits `Transfer(_, wrapper, amount)` in the same tx. If exactly
   one such deposit exists, we convert it via `rate()` and store it (`shieldDisclosedRaw`
   in `src/balance/rate.ts`); ambiguous cases (0 or >1 deposits) fall back to (3). This
   avoids forcing a delegation to value an amount that was never secret.
3. **Delegated `userDecrypt`** (the `pending` queue, D2/D8): plain
   `ConfidentialTransfer.amount` and any shield that fell back from (2). A delegation
   from either transfer party covers the handle (ERC-7984 `FHE.allow`s both, D6).

We never call `publicDecrypt`.

**Balance is derived locally** from the stored cleartext deltas (a `SUM`, no relayer in
the read path): a **confirmed** exact figure over the gap-free valued prefix, plus a
**pending** summary, at trust level `exact | as_of | unknown` (D4). An unvalued early
transfer is `unknown` / `value: null`, never a guess. Trade-off: it needs complete,
decrypted history, so a fresh holder waits for backfill before a balance shows. A
`confidentialBalanceOf` **checkpoint** to anchor late-indexed holders is designed but
not built.

**We allow addresses/accounts to be specified in the config, but index all by default.** Configuration is scenario-dependent; adding addresses at runtime is omitted because it would require reindexing.

**We allow setting a START_BLOCK for indexing**, because we don't want to index the entire Sepolia chain for this demo. In a real scenario, it is important to catch all relevant blocks/events.

---

## Decision 8 — Drainer retry & rate-limit policy

**Choice.** Classify each decrypt outcome by the SDK's typed error (via
`matchZamaError`, never message parsing) and let the class set retry semantics — a
single backoff would be wrong:

| Outcome | SDK error | Reaction | Row state |
| --- | --- | --- | --- |
| Success | — | write cleartext | `decrypted` (terminal) |
| No delegation / expired | `DelegationNotFound` / `DelegationExpired` | wait for ACL grant; slow backstop | `unauthorized` |
| Not propagated | `DelegationNotPropagated` | ~30s backoff, cap ~10 min | `pending` |
| Rate limited (429) | `RelayerRequestFailed` | throttle whole drainer; circuit-break | `pending` |
| Server / network (≥500) | `RelayerRequestFailed` | exponential backoff + jitter | `pending` |
| ACL paused | `AclPaused` | pause drainer until cleared | `pending` |
| Stale credential | `KeypairExpired` / `InvalidKeypair` | refresh keypair, retry now | `pending` |
| Decrypt failed | `DecryptionFailed` | surface + slow retry | `failed` |

**One scheduler.** Every non-terminal row carries `next_attempt_at`; the drainer is a
single `WHERE status <> 'decrypted' AND next_attempt_at <= now() ORDER BY block_number,
log_index LIMIT :batch`. The ACL grant event (D6) just pulls `next_attempt_at` forward,
so backfill needs no separate machinery. Rows are processed **oldest-first** so the
running-sum balance (D7) settles in chain order.

**`failed` is not terminal** — surfaced on `/health`, kept on a long, slow retry, never
dead-lettered (preserves "never silently drop").

**Rate-limiting is global**: a 429 means the next will too, so a concurrency cap + a
circuit breaker live at the drainer level (self-protection + good citizenship for the
shared relayer). Retries are idempotent (decrypt is read-only on-chain), and the
decryption cache is keyed by the content-addressed handle, so reorgs need no undo (D7).
This drives `/health`: `degraded` on soft backlog, `unhealthy` (503) when the breaker is open.

---

## Reflection

The drainer implementation is very noisy; that is, we currently scan all unauthorized records regularly (every 5 seconds) to see whether a delegation has arrived and the decryption process can start. If we run the indexer in the default mode, where all accounts are indexed but we only have a delegation for a tiny fraction of them, we stress the in-memory database quite a lot with superfluous work. An event-driven approach based on delegation events would be cleaner and much more efficient (I have not properly discussed this with Claude).


### What I've cut / what still needs to be done

Besides the fix described above:

1. Use the encrypted balance endpoint to allow a user to see their balance, even if not all transfers are indexed/decrypted yet. Also use this to uncover discrepancies if there is any chance that we missed an event and therefore derived an incorrect balance.

2. Leverage batch decryption. We currently call the relayer for every encrypted handle individually. This is particularly inefficient when we get a new delegation for an existing long transfer history.

## SDK feedback

- P1: A durable server-side `GenericStorage` implementation (e.g. a Node file, SQL, or Redis adapter). It probably should also be encrypted, since it contains sensitive data. This is particularly important if we want to scale with multiple drainers/decryption workers.

- P2: Rate-limiting has no dedicated error class (we infer 429 from
`RelayerRequestFailedError.statusCode`), and that error doesn't expose `Retry-After`,
so we can't honor server backpressure — a `retryAfter`/`retryable` field would fix both.

Issues I've encountered:

1. got this while trying to record the screencast. Maybe too little memory?

[EncryptionFailedError]: Encryption failed
    at zt.encrypt (file:///Users/domwoe/Dev/projects/zama-task/node_modules/.pnpm/@zama-fhe+sdk@3.1.0-alpha.4_ethers@6.16.0_viem@2.52.2_typescript@5.9.3_zod@4.4.3_/node_modules/@zama-fhe/sdk/dist/esm/index.js:1:17029)
    at async tn.confidentialTransfer (file:///Users/domwoe/Dev/projects/zama-task/node_modules/.pnpm/@zama-fhe+sdk@3.1.0-alpha.4_ethers@6.16.0_viem@2.52.2_typescript@5.9.3_zod@4.4.3_/node_modules/@zama-fhe/sdk/dist/esm/token-Cwqua22I.js:1:10734)
    at async file:///Users/domwoe/Dev/projects/zama-task/scripts/demo-seed.ts:43:20 {
  code: 'ENCRYPTION_FAILED',
  [cause]: Error: Request ENCRYPT timed out after 30000ms
      at Timeout._onTimeout (file:///Users/domwoe/Dev/projects/zama-task/node_modules/.pnpm/@zama-fhe+sdk@3.1.0-alpha.4_ethers@6.16.0_viem@2.52.2_typescript@5.9.3_zod@4.4.3_/node_modules/@zama-fhe/sdk/dist/esm/worker.base-client-pErLQy-p.js:1:10443)
      at listOnTimeout (node:internal/timers:605:17)
      at process.processTimers (node:internal/timers:541:7)
}

2. The SDK worker lookup did not work when @zama-fhe/sdk/node was loaded through Ponder's Vite SSR runtime:

› 18:08:24.895 INFO  Indexed block chain=sepolia number=11009643 event_count=0 (6ms)
  [zama-sdk:info] delegated transfer decrypt start {
    delegator: '0x38976c3179ABC5a95D41dbe8Ca6d44ae716d84F1',
    encryptedValue: '0xebeac6180f4afa12fe1104a57662db502bc845fe9eff0000000000aa36a70500',
    tokenAddress: '0x4E7B06D78965594eB5EF5414c357ca21E1554491'
  }
  [zama-sdk:warn] delegated transfer decrypt failed {
    delegator: '0x38976c3179ABC5a95D41dbe8Ca6d44ae716d84F1',
    encryptedValue: '0xebeac6180f4afa12fe1104a57662db502bc845fe9eff0000000000aa36a70500',
    error: {
      name: 'TypeError',
      message: '__vite_ssr_import_meta__.resolve is not a function'
    },
    failure: 'unknown',
    errorCode: 'UNKNOWN'
  }

## AI assistance

I used Claude and Codex for research, interactive planning, implementation, and testing. There were quite a few situations where I had to nudge/steer:

- Simplifying the architecture (not going with the full PostgreSQL, Docker, Decryption Worker setup)
- Correcting fabricated contract/event signatures and fetching the OpenZeppelin ERC-7984 interface.
- Defining the shape of the balance endpoint was a longer back-and-forth discussion.
