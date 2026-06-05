# Implementation Plan

Build checklist for the confidential indexer. Every task links to the decision
that fixes its behavior (`Dn` → [`DECISIONS.md`](./DECISIONS.md) Decision *n*) or
the API contract (`API §x` → [`API.md`](./API.md)). Check items as they land.

**Cross-cutting constraints** (from `AGENTS.md`, apply to every phase): strict
TypeScript, ESM-first, no `any`/unsafe casts/dropped promises, `unknown` +
validate at boundaries, **string amounts** for base-unit values, explicit **status
unions** for the encrypt/decrypt lifecycle, and `pnpm run check` green after changes.

Suggested order is top-to-bottom; phases 3–5 can interleave once the schema (P1)
exists. A `Decryptor` fake (P3) unblocks all offline tests before any Sepolia work.

---

## Dependencies & versions

Policy: **latest stable** at scaffold time, via caret ranges so `pnpm install` takes
patches. The **only** version pin is `@zama-fhe/sdk` → the `alpha` dist-tag (per the
brief; do **not** move to stable `3.0.1`). Versions below verified against npm and
peer ranges on the scaffold date.

**Runtime**

| Package | Version | Notes |
| --- | --- | --- |
| `ponder` | `^0.16.6` | peers satisfied: hono ≥4.5, viem ≥2, typescript ≥5.0.4 |
| PGlite | via `ponder` database config | embedded local DB: `database.kind="pglite"`, files in `./.ponder/pglite`; Postgres is the documented scale-up path (`D3`) |
| `viem` | `^2.52.2` | Ponder and the Zama SDK both peer on viem ≥2 |
| `hono` | `^4.12.23` | Ponder API-server peer; we mount `/v1` on it |
| `zod` | `^4.4.3` | boundary validation (standalone, no peer constraints) |
| `@zama-fhe/sdk` | `alpha` (`3.1.0-alpha.x`) | **PINNED to alpha**, not stable 3.0.1; engines node ≥22 |

**Dev**

| Package | Version | Notes |
| --- | --- | --- |
| `typescript` | `^5.9.3` | held to the 5.x line by choice — TS 6.0.x is latest stable but unproven with Ponder typegen |
| `eslint` | `^10.4.1` | |
| `typescript-eslint` | `^8.60.1` | supports eslint ^10 and TS `>=4.8.4 <6.1.0` |
| `@types/node` | latest (Node ≥22 LTS) | matches SDK `engines` |

**Deliberately not installed**
- `ethers`, `@tanstack/query-core` — optional Zama SDK peers; unused on the viem + node path.
- `@openzeppelin/confidential-contracts` / `@fhevm/solidity` — would drag in a Solidity toolchain pin. The TS indexer needs only the **event ABIs**, hand-written as viem `const` ABIs from the D7/D6 signatures. The OZ/fhevm Solidity packages belong to the separate forge-fhevm contract project (`D5`), not this `package.json`.

---

## Stores & reorg-safety model — `D2`, `D3`, `D7`

Two stores with distinct owners and reorg semantics. This is the concrete answer
to "how do out-of-band drainer writes stay reorg-safe."

1. **Ponder onchain tables** (`ponder.schema.ts`, written **only** in indexing
   handlers via `context.db`/`db.sql`): the chain facts — `transfers`, `unwraps`,
   `delegations`. Ponder reorg-tracks these and reverts them automatically.
   In-handler **disclosed** cleartext (`AmountDisclosed`/`UnwrapFinalized`) lives
   here too, since it arrives in a handler and is reorg-tracked.
2. **Drainer-owned store** (plain table(s) the background drainer manages — **not**
   Ponder onchain tables): the `decryptions` cache, `drainerState`, and the SDK
   credential store. Verified against Ponder 0.16: the write API (`context.db`,
   `db.sql`) is **handler-scoped**; there is no supported path to write
   reorg-tracked tables from a background task, so the drainer must not.

Reorg-safety then falls out of two design choices, with **no conditional-write
dance**:

- **`decryptions` is keyed by the content-addressed `amountHandle`.** A ciphertext
  handle's plaintext is immutable, so the cache is **reorg-immune by construction**
  — a reorg can't invalidate a handle→plaintext entry, and a re-included tx reuses
  it. Orphaned entries (handles whose transfer reorged out) are simply not joined,
  and are harmless / GC-able.
- **Balance is a *derived aggregate*, never a mutated counter** — `SUM(signed
  cleartext)` over the address's `transfers` LEFT JOIN cleartext. Because it's a
  pure function of current Ponder rows, Ponder's row reverts make balance correct
  with nothing to undo out of band.

**Verify at implementation:** the in-process DB-access path — the drainer reading
`ponder:schema` tables and owning a side table in the same PGlite instance. If
clean shared single-connection access isn't workable in one process (`D3` PGlite
limit), that is another force toward the `D3` Postgres + separate-worker model,
where the worker has its own connection and a plain `decryptions` table.

---

## Phase 0 — Scaffold & tooling
- [x] Initialize a Ponder project (TypeScript, ESM), Node ≥ 22 — `D1`
- [x] Add deps at the pinned versions (see §Dependencies & versions): `ponder`, `viem`, `hono`, `zod`, `@zama-fhe/sdk@alpha` — `D1`
- [x] Configure Ponder's embedded PGlite DB explicitly: `database: { kind: "pglite", directory: "./.ponder/pglite" }`; gitignore `.ponder/`; add a local reset note/script that removes only that configured directory — `D3`
- [x] Hand-write minimal viem `const` ABIs for the indexed events + the read views we call (`confidentialBalanceOf`, `rate`, `name`/`symbol`/`decimals`, wrapper `underlying`) — **no** `@openzeppelin/confidential-contracts` dep — `D7`, `D6`
- [x] Token metadata for `GET /v1/token`: resolve `name`/`symbol`/`decimals` via the ERC-7984 views and `underlying` via the wrapper, read once at startup (cached) or from env — API §token
- [x] `tsconfig` strict + ESM, `eslint.config.js` (eslint 10 + typescript-eslint 8, TypeScript held to the 5.x line); add `pnpm run check` = `ponder codegen` + `tsc --noEmit` + eslint — `AGENTS.md`
- [x] `.env.example` only: `SEPOLIA_RPC_URL`, `TOKEN_ADDRESS`, `INDEXER_PRIVATE_KEY`, `START_BLOCK`, relayer/chain config; ACL address comes from SDK config — `D5`, `D6`
- [x] README skeleton with fresh-clone-to-running steps — brief
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** `ponder dev` boots against the Sepolia RPC with an empty schema.

## Phase 1 — Schema & data model — `D2`, `D7`, `D8`
**Ponder onchain tables** (chain facts, written only in handlers — see §Stores):
- [x] `transfers`: `id` (`txHash-logIndex`), `txHash`, `blockNumber`, `logIndex`, `timestamp`, `from`, `to`, `kind` (`transfer|shield|unshield|disclosure`), `amountHandle` (bytes32), `unwrapRequestId` (bytes32|null — links unshield rows), `disclosedRaw` (string|null), `disclosedSource` (`disclosed`|null) — chain facts + in-handler disclosed cleartext; **no decryption-state columns** (those live in `decryptions`) — `D7`, API §amount
- [x] `unwraps` keyed by `unwrapRequestId`: `receiver`, `amountHandle`, `status` (`requested|finalized`), `cleartextRaw` (string|null), `requestedBlock`, `finalizedBlock` — two-phase unshield correlation — `D7`
- [x] `delegations`: `delegator`, `delegate`, `contractAddress`, `expiry`, `lastEventBlock` — `D6`

**Drainer-owned store** (not Ponder tables, written only by the drainer — see §Stores):
- [x] `decryptions` keyed by `amountHandle` (reorg-immune): `cleartextRaw` (string|null), `status` (`encrypted|pending|unauthorized|decrypted|failed`), `decryptedFor` (address|null — which delegator's right unlocked it), `source` (`userDecrypt`), `attempts`, `nextAttemptAt`, `lastErrorCode`, `lastErrorAt` — `D8`
- [x] `drainerState`: `lastSuccessAt`, `breakerState`, `breakerOpenedAt` (for `/health`) — `D8`, API §health
- [x] SDK credential store backing the SDK `GenericStorage` — `D6`

**Derived / external:**
- [ ] Balance is **derived** (a `SUM`, not a stored counter, P5); optionally a `balances` cache row that is **recomputed** on change — `D7`, §Stores
- [ ] Indexer lag for `/health` reads Ponder's own sync status (head vs indexed), not a hand-maintained row — `D2`, API §health
- [x] Shared TS string-literal unions for every status enum — `AGENTS.md`
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** schema compiles and types are exported from `ponder.schema.ts`.

## Phase 2 — Indexing handlers (write-only, never decrypt) — `D7`, `D6`, `D2`
- [x] Register token in `ponder.config` (`TOKEN_ADDRESS`, `START_BLOCK`, merged `IERC7984` + `IERC7984ERC20Wrapper` ABI) — `D7`
- [x] Register ACL contract with event filter `delegate == INDEXER_ADDR` — `D6`
- [x] `ConfidentialTransfer` → upsert `transfers` with chain facts + `amountHandle`; derive `kind` (`from==0`⇒shield, `to==0`⇒unshield-burn, else transfer). **No decryption fields** — those live in the drainer-owned `decryptions` (see §Stores); shield mints go through the decrypt path like any transfer (`D7`) — `D7`, `D2`
- [x] `AmountDisclosed` → set `disclosedRaw`/`disclosedSource='disclosed'` on the transfer row(s) matching the handle (in-handler, reorg-safe) — `D7`
- [x] `UnwrapRequested` → upsert `unwraps` (`status='requested'`, `amountHandle`); set `unwrapRequestId` on the linked unshield transfer — `D7`
- [ ] `UnwrapFinalized` → update `unwraps` by `unwrapRequestId` → `status='finalized'` + `cleartextRaw`; propagate `disclosedRaw` to the linked unshield transfer (apply `rate()` if underlying≠wrapped units) — `D7`
- [x] `OperatorSet` → index as metadata or skip (no amount) — `D7`
- [x] ACL `DelegatedForUserDecryption` → upsert `delegations` only. The backfill nudge lives in the drainer (P4), since it owns `decryptions`; handlers never touch the drainer store — `D6`
- [x] Confirm handlers never call the relayer and never write the drainer store; reorg-safety is structural (§Stores), not a per-write check — `D2`, `D7`
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** events persist as rows with correct `kind`; zero decryption in handlers.

## Phase 3 — Decryptor seam & SDK integration — `D5`, `D6`, `D8`
- [x] Define `Decryptor` interface — both methods **delegated** (the indexer signs; the param is the delegator/holder whose right is used): `decryptTransferAmountAs(handle, delegator)` and `decryptBalanceAs(holder)`, surfacing typed outcomes. Candidate selection (which party to use) is the drainer's job (P4), not the interface's — `D5`, `D6`, `D8`
- [x] Real impl over `@zama-fhe/sdk`: `createConfig` (viem + Sepolia preset + node transport), `GenericStorage` backed by the DB table (not `MemoryStorage`) — `D6`
- [x] Delegated decrypt via the SDK `decryptBalanceAs` / user-decrypt path, indexer signs with its own key — `D6`
- [x] Map `ZamaError` → internal outcome classes via `matchZamaError` (`DelegationNotFound`, `…Expired`, `…NotPropagated`, `RelayerRequestFailed`+`statusCode`, `AclPaused`, keypair, `DecryptionFailed`) — `D8`
- [x] Fake impl: delegation set + `handle → allowedAccounts` predicate; can throw `DelegationNotPropagated` N times to mirror lag — `D6`
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** real and fake both satisfy the interface; fake predicate unit-tested.

## Phase 4 — Decryption drainer — `D2`, `D8`, `D3`
- [ ] In-process background loop started alongside the Ponder/API server — `D3`
- [x] Work query: `transfers` LEFT JOIN `decryptions` (on `amountHandle`) for handles with no terminal `decryptions` row and `nextAttemptAt <= now()`, `ORDER BY blockNumber, logIndex ASC` (oldest-first), `LIMIT batch`; lazily seed an `encrypted` `decryptions` row on first sight — `D8`, §Stores
- [x] **Candidate selection per handle:** candidates = `{to, from} \ {0x0}` filtered to parties with an **active delegation** to the indexer (from `delegations`); try in order **`to` then `from`**; on success record `decryptedFor` + `source='userDecrypt'`. If **no** candidate is delegated → mark `unauthorized` **without a relayer call** — `D6`, `D8`
- [x] Concurrency cap (~4) + simple relayer rate limiter — `D8`
- [x] Classify outcome via `matchZamaError` → set `decryptions.status` + `nextAttemptAt = now + backoff(class, attempts)` (full-jitter exp) — `D8`
- [x] **Backfill nudge (owned here):** detect new/updated `delegations` rows and pull `nextAttemptAt=now()` forward for that delegator's `unauthorized` handles — `D6`, `D8`
- [x] `unauthorized` → slow backstop poll; `failed` → surfaced, slow-retry, non-terminal — `D8`
- [x] Stale-credential outcome → refresh keypair and retry, not a row failure — `D8`, `D6`
- [x] Circuit breaker: pause whole drainer on sustained 429/5xx/`AclPaused`; persist `breakerState`/`lastSuccessAt` in `drainerState` — `D8`, API §health
- [x] Writes **only** the `decryptions` store (keyed by handle); no Ponder-table writes, no conditional-write dance — reorg-immunity is structural (§Stores). Balance needs no update here — it is derived (P5) — `D7`, §Stores
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** against the fake, `encrypted→decrypted`, and `unauthorized→decrypted` after a delegation flip.

## Phase 5 — Balance derivation & checkpoint — `D7`
- [x] Balance is a **derived aggregate** (no mutable counter): `SUM(signed cleartext)` over the address's `transfers` LEFT JOIN cleartext (`disclosedRaw` ?? `decryptions.cleartextRaw`), signed by direction (in/mint `+`, out/burn `−`) — `D7`, §Stores, API §balance
- [x] Set `balance.status='partial'` + `pendingTransfers` when any contributing transfer lacks cleartext — `D7`, API §balance
- [ ] Optional: a `balances` cache row **recomputed** (not incremented) when an address's rows change — idempotent and reorg-safe — `D7`
- [x] Periodic checkpoint: `decryptBalanceAs(holder)` against `confidentialBalanceOf` to reconcile/detect drift and serve the `partial` fallback total — `D7`
- [ ] Handle wrapper `rate()` units when cross-filling shield/unshield cleartext — `D7`
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** balance endpoint returns the correct sum; `partial` shown when history is incomplete.

## Phase 6 — Read API — `D4` / `API.md`
- [x] Mount Hono under `/v1`, JSON, with an error-envelope middleware — API §errors
- [x] `GET /v1/token` — API §token
- [x] `GET /v1/addresses/{address}/balance` — API §balance
- [x] `GET /v1/addresses/{address}/transfers` with keyset cursor + `limit/order/direction/kind/status` filters, including `status=failed` — API §transfers
- [x] `GET /v1/transfers/{id}` (single-row poll for `pending`/`unauthorized`/`failed`) — API §transfers
- [x] Cursor encode/decode (base64 of `blockNumber,logIndex`); emit `CURSOR_EXPIRED` on reorg past anchor — API §transfers
- [x] Amount serialization: `{ status, raw, value, source }` string pair — API §amount
- [x] Boundary validation (address, params) with zod → error codes table; unknown address ⇒ empty/zero, not 404 — API §errors
- [x] `asOfBlock` on every response — API §conventions
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** every endpoint returns spec-shaped JSON; bad input uses the envelope.

## Phase 7 — Health — `D2`/`D7`, API §health
- [x] `GET /v1/health`: **indexer lag** (`headBlock` vs `indexedBlock`) from Ponder's sync status, **and** decryption backlog as independent signals — counts (`pending`/`unauthorized`/`failed`) + `oldestPendingSeconds` from `decryptions`; `lastSuccessAt` + breaker state from `drainerState` — API §health, §Stores
- [x] `status` thresholds `healthy|degraded|unhealthy`; `200` vs `503` (breaker open / unbounded backlog) — API §health, `D8`
- [x] `GET /v1/health/live` trivial liveness probe — API §health
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** health reflects real lag and backlog; returns 503 under the defined unhealthy conditions.

## Phase 8 — Seed & demo scripts — `D6`, `D7`
- [x] Script: holder shields / confidential-transfers on Sepolia (SDK) to generate events — `D6`, `D7`
- [x] Grant delegation to the indexer: `sdk.delegations.delegateDecryption(...)` **or** the `cast` one-liner — `D6`
- [x] Optional revoke script — `D6`
- [x] Document the demo arc in README: transfer → see `unauthorized` → grant → see `decrypted` (note 1–2 min propagation) — brief DX
- [x] Commit the phase with a state-of-the-art, expressive git message.
- **Done when:** end-to-end on Sepolia shows a row flip `pending/unauthorized → decrypted` after the grant.


---

## Definition of done (brief deliverables)
- [ ] Indexer watches one ERC-7984, decrypts entitled amounts, **preserves** undecryptable events, **backfills** on later grant — `D2`/`D6`/`D7`
- [ ] Read API: current balance, transfer history with cleartext where available, health + how-far-behind — `API.md`
- [ ] `DECISIONS.md` complete and defensible — Phase 10
- [ ] Light tests: one happy path + one negative — Phase 9
- [ ] Reflection, SDK feedback, AI assistance — Phase 10

## Open (tracked, non-blocking)
- [ ] Partner-feedback items: zero-amount transfers, `partial` = checkpoint vs lower-bound, moving-tip vs snapshot cursors, cursor TTL — API §"Open questions"


## Notes

- Phase 0 switched the project to `pnpm@10.34.1` (`packageManager`,
  `pnpm-lock.yaml`); `package-lock.json` was removed. Use `pnpm install`,
  `pnpm run dev`, and `pnpm run check`.
- Ponder `0.16.6` does **not** expose the planned `ponder typecheck` command. The
  closest supported Ponder-specific verification is `ponder codegen`, so
  `pnpm run check` now runs `ponder codegen && tsc --noEmit && eslint`.
- `skipLibCheck` is `true` because Ponder/PGlite/Drizzle declaration files do not
  typecheck under this repo's strict flags (`exactOptionalPropertyTypes`, missing
  optional ambient declarations). Application code remains strict; generated
  `ponder-env.d.ts` is excluded from lint.
- Dependency audit: `@hono/node-server`, `esbuild`, `vite`, and `ws` findings were
  addressed with pnpm overrides. Ponder currently pins vulnerable `kysely@0.26.3`
  and `drizzle-orm@0.41.0`; overriding Kysely/Drizzle to patched versions cleared
  audit but broke Ponder/Drizzle type compatibility, so those overrides were
  backed out. Avoid untrusted dynamic SQL identifiers / JSON-path APIs and revisit
  when Ponder ships patched transitive dependencies.
- `pnpm install` still warns that Ponder's `abitype@0.10.3` peers on zod 3 while
  this project and `@zama-fhe/sdk@alpha` use zod 4. `pnpm run check` is green with
  zod 4, so the warning is recorded rather than downgrading against the SDK path.
- `ponder dev` was not run against Sepolia in Phase 0 because the workspace has no
  real `.env` values (`SEPOLIA_RPC_URL`, token, ACL, indexer address). The scaffold
  is validated with `ponder codegen`, TypeScript, and ESLint; boot verification is
  still pending once toy Sepolia values are provided.
- Phase 1 has schema foundations committed: Ponder owns only reorg-tracked chain
  fact tables, while drainer-owned state is represented by separate SQL DDL/types.
  Balance derivation and health lag are intentionally still runtime work in P5/P7.
- Phase 2's `UnwrapFinalized` handler upserts `unwraps` instead of assuming the
  `UnwrapRequested` row exists, so indexing from a mid-stream `START_BLOCK` still
  preserves finalized cleartext.
- TODO: `UnwrapFinalized.cleartextAmount` is currently stored as emitted. The
  `rate()` conversion for underlying-vs-wrapped units is still open and should be
  handled before considering the unshield propagation bullet complete.
- Phase 3 SDK lookup: Context7 only resolved the legacy `/zama-ai/relayer-sdk`, so
  SDK integration was based on the proper `zama-ai/sdk` `prerelease` branch
  (`examples/node-viem/WALKTHROUGH.md`) plus the installed
  `@zama-fhe/sdk@3.1.0-alpha.4` type declarations.
- Phase 3 added `vitest` and `pnpm test`; `pnpm run check` now includes the fake
  decryptor predicate tests.
- Phase 3's SDK storage is a persistent `GenericStorage` adapter over the
  `sdk_credentials` store shape. The concrete in-process PGlite connection wiring
  is still part of the P4 drainer/runtime integration.
- Phase 4 added the drainer core behind a `DrainerStore` contract, plus an
  in-memory implementation for offline tests. The core covers oldest-first work
  selection, delegated candidate ordering (`to` then `from`), no-relayer-call
  unauthorized classification, full-jitter retries, stale-credential refresh
  hooks, a simple relayer gate, circuit-breaker state, and the ACL backfill nudge.
- Ponder's `ponder:api` `db` export is `ReadonlyDrizzle` (no typed
  `insert`/`update`/`delete`), so the API-server startup/SQL adapter for the
  drainer-owned side tables remains unchecked until we wire an explicit raw-SQL
  adapter or move to the D3 Postgres worker path.
- Phase 5 added a pure balance derivation module: it sums signed cleartext deltas,
  treats self-transfers as zero net, marks incomplete history as `partial`, formats
  raw base units with token decimals, and can use `decryptBalanceAs(holder)` as a
  checkpoint raw total while preserving the partial status. The actual `/balance`
  route still lands in P6, and wrapper `rate()` conversion remains open with the
  Phase 2 unshield TODO.
- Phase 6 chose the raw-SQL side-table adapter: Ponder-owned `transfers` are read
  with typed Drizzle queries, while drainer-owned `decryptions`/`drainer_state`
  are accessed through explicit raw SQL and zod-parsed at the boundary. The Hono
  app is now built through an injectable factory so route behavior is testable
  without a live Ponder DB.
- Phase 7 health derives indexed block/time by decoding Ponder's
  `_ponder_checkpoint.latest_checkpoint`, reads the current Sepolia head through
  Ponder's public client, and keeps decryption backlog/breaker state as a separate
  signal from the raw-SQL side tables. Breaker-open or very stale backlog returns
  `503`; softer lag/backlog/failure signals return `degraded` with HTTP `200`.
- Phase 8 demo scripts were based on the proper `zama-ai/sdk` `prerelease`
  `examples/node-viem/WALKTHROUGH.md` and alpha package types. The installed SDK
  exposes wrapper operations through `sdk.createWrappedToken(...)`, while
  delegation lives under `sdk.delegations`. Scripts are typechecked but not run
  against Sepolia here because the workspace has no real toy key/RPC/token values.
