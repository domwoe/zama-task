# DECISIONS

---

## Decision 1 — Indexer library: **Ponder**

**Why.** A simple, type-safe TS-native library. However, it is still pre-1.0, and I couldn't quickly find much information about who uses it in production. Envio seems to be a more production-ready choice, but also more complex and feature-rich for this task.

**Consequences.** This constrains the choice of API framework (Hono) and database (PostgreSQL/PGLite) since I'd like to minimize dependencies.

This turned out to be a bad decision which cost me quite some time and codex could only fix by patching the sdk. The way that the zama sdk looks up worker threads is not compatible with the Vite SSR enviromnent that poncho uses. See also SDK Feedback.

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
   in `src/balance/rate.ts`); ambiguous cases (0 or >1 deposits) fall back to (3). This avoids forcing a delegation to value an amount that was never secret.
3. **Delegated `userDecrypt`** (the `pending` queue, D2/D8): plain
   `ConfidentialTransfer.amount` and any shield that fell back from (2). A delegation
   from either transfer party covers the handle (ERC-7984 `FHE.allow`s both, D6).


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

The part I trust least under partner load is the decryption drainer. It is correct
enough for a single demo token, but it is still a single in-process loop sharing
the Ponder process, PGlite, and the Zama relayer budget. A burst of delegation
events for holders with long histories would create many retryable decrypt jobs,
and the first thing to break would be latency: API reads would still work, but
rows would sit in `pending`/`unauthorized` longer and `/health` would degrade.

I would prove this with a replay test before changing architecture: seed 10k-100k
encrypted transfers across many holders, emit delegation events in a burst, and
measure time-to-first-decrypted, time-to-drain, relayer error rate, breaker state,
and API p95 latency. If those numbers move badly, the next step is not a redesign:
move the same queue to server Postgres and run one or more dedicated drainer
processes.


### What I've cut / what still needs to be done

1. Balance checkpointing. The API currently derives balances from indexed,
   valued transfers. That is honest for fresh holders and complete histories, but
   late `START_BLOCK` holders need an encrypted `confidentialBalanceOf` checkpoint
   to anchor the absolute balance and detect missed history.

2. Batch decryption. The drainer decrypts one handle at a time. That is simple,
   but inefficient when a new delegation unlocks a long history for one holder.
   The SDK supports batch-style flows, and that would be my first performance
   improvement.

3. Revocation. I currently don't track revocations.

## SDK feedback

- P0: Make the Node worker lookup bundler/runtime-safe. `@zama-fhe/sdk/node`
  currently uses `import.meta.resolve` to locate its worker. In Ponder's Vite SSR
  runtime that became `__vite_ssr_import_meta__.resolve`, which does not exist.
  Concrete change: resolve the worker relative to the SDK module URL, or expose a
  supported `workerUrl`/`createWorker` option. This unblocks indexers and backend
  frameworks that run code through Vite/Vite Node.

- P1: Provide a durable server-side `GenericStorage` adapter, or a documented
  recipe. Server integrations need to persist keypairs/permits across restarts and
  possibly across drainer processes. SQL/Redis/file adapters, ideally with guidance
  on encrypting sensitive entries, would remove a common footgun.

- P2: Expose relayer backpressure as first-class data. Today I infer rate limiting
  from `RelayerRequestFailedError.statusCode === 429`, and I do not get
  `Retry-After`. A `retryAfter` or `retryable` field would let partner services
  back off politely instead of guessing.

- P3: Make worker timeouts configurable and easier to diagnose. I hit
  `EncryptionFailedError` caused by `Request ENCRYPT timed out after 30000ms`
  while recording the demo (probably too many stuff open on my machine).

## AI assistance

I used Claude and Codex for research, shaping, implementation, debugging, and test
selection. The useful parts were fast codebase navigation, proposing API shapes,
and catching TypeScript/test fallout quickly.

The tools were also confidently wrong in a few places. The most important example:
they initially suggested fabricated or stale ERC-7984/Zama event signatures. I had
to stop and verify the actual interfaces before wiring Ponder filters and fixtures.
They also pushed toward a bigger Postgres/Docker/separate-worker architecture early
on; I kept the shipped version smaller because the task rewards a runnable
single-token service more than production operations.
