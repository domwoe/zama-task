# DECISIONS

This document records the choices behind the confidential indexer — what we
composed, what we wrote ourselves, and where the trade-offs sit. It is meant to
be argued with, not skimmed.

> Status: living document. Sections that depend on the finished implementation
> (tests, SDK feedback, reflection) are marked **TODO** and will be filled in as
> the build lands — they are placeholders, not claims.

## Scope recap

A Node/TypeScript service that watches a single ERC-7984 confidential token
contract, decrypts transfer amounts the indexer holder is entitled to read, and
exposes a cleartext read API (balance, transfer history, health). Chain target
is Sepolia (with local `forge-fhevm` as the fast-iteration fallback). We compose
off-the-shelf primitives rather than writing an EVM indexer from scratch.

---

## Decision 1 — Indexer library: **Ponder**

**Choice:** [Ponder](https://ponder.sh/).

**Why.** The brief's constraints, not raw throughput, drove this. We evaluated
Ponder, Envio (HyperIndex), Subsquid/SQD, The Graph subgraphs, and Goldsky
against four requirements that actually bite here:

1. **Async decryption inside the indexing path.** Decrypting an amount is a
   network call to the Zama relayer. The handler must be able to `await`
   arbitrary I/O. Ponder handlers are plain `async` TypeScript, so the SDK drops
   straight in. **The Graph and Goldsky are disqualified on this point alone** —
   AssemblyScript mappings cannot make arbitrary network calls to a decryption
   service.
2. **Own the database, mutate rows out of band.** "Don't drop events we can't
   yet decrypt" and "backfill cleartext when ACL is granted later" both require
   persisting a *pending* state and updating it out of band. Ponder indexes into
   a Postgres/PGlite store whose schema we own, so a background drainer can write
   cleartext back to it. Envio's store is more opinionated (Hasura), which makes
   out-of-band writes the awkward part.
3. **Speed is a non-requirement.** A single token contract on a testnet. Envio's
   headline advantage — HyperSync backfills 15–150× faster — buys us nothing
   here, and the brief explicitly says ops/scale are not being evaluated. That
   removes Envio's main reason to exist for this task and leaves its friction.
4. **Iterate fastest, TS-native, viem-native.** Ponder has a hot-reload dev
   server, end-to-end type safety with no codegen, and uses viem natively — which
   matches the Zama SDK's viem examples and makes pointing at Sepolia or a local
   `forge-fhevm` RPC trivial.

**Runner-up:** Subsquid/SQD. It satisfies (1) and (2) — arbitrary TS in the batch
processor, fully owned DB — but adds boilerplate (TypeORM, separate API layer)
and leans on archive throughput we don't need. It would be the fallback if Ponder
proved unworkable.

**Rejected:**
- **The Graph / Goldsky** — AssemblyScript cannot drive the decryption SDK in a
  mapping; the whole in-handler-decryption model is impossible.
- **Envio (HyperIndex)** — its speed edge is irrelevant for one testnet contract,
  and its managed store fights the out-of-band backfill pattern below.

**Where we'd push back on the brief:** "decrypt all transfer amounts *as events
are indexed*" reads as inline decryption. We deliberately do **not** do that (see
Decision 2). Inline decryption would couple index progress to relayer latency and
authorization, which is the wrong coupling for a service that must never silently
drop events.

---

## Decision 2 — Architecture: decouple indexing from decryption

**Do not decrypt synchronously inside the indexing handler.** Relayer decryption
is slow, rate-limited, and can fail or be unauthorized. Blocking the handler on it
couples index throughput to relayer health and turns an authorization miss into
either a dropped event or a stalled indexer. Instead, three seams:

1. **Indexer handler (fast, never blocks, never drops).** On each relevant event
   (confidential transfer, shield/unshield), write the raw event plus the
   ciphertext handle and `status = 'encrypted'` to the DB synchronously. Indexing
   progress never waits on the relayer.

2. **Decryption drainer.** Polls rows in a non-terminal state, calls the Zama SDK
   to decrypt, and on success writes the cleartext amount and `status =
   'decrypted'`. On an authorization failure it records the row as `unauthorized`
   and leaves it eligible for retry — it is **not** dropped.

3. **ACL backfill — for free.** Because step 2 retries non-terminal rows, a
   later ACL grant needs no special path: previously `unauthorized` rows simply
   succeed on the next pass. Backfill is the normal flow, not a separate feature.

**The decoupling is in the persisted queue, not a process boundary.** What is
*essential* is that the handler hands off to a durable `pending` state and a
drainer reads from it — that is what keeps indexing non-blocking and makes
restarts safe (a crash mid-decrypt loses nothing; the row is still `encrypted`).
Whether the drainer runs **in-process** (a background loop alongside Ponder) or as
a **separate process** is an *operational* choice, decided in Decision 3, not a
correctness one. We pick the in-process drainer for simplicity and document the
separate-process variant as the scale-up. The one rule either way: the drainer
must read from the persisted queue — never fire decryption from inside the handler
(fire-and-forget), or a restart mid-flight silently drops an event, which the
brief forbids.

**Read API surfaces the in-between honestly.** A transfer with no decryption right
yet returns `amount: null` with an explicit status (`encrypted` / `pending` /
`unauthorized`) rather than a fabricated zero or a 404. `/health` reports indexer
lag (head block vs. indexed block) and decryption backlog separately, so a partner
can tell "indexer behind" apart from "decryption behind."

**State machine (per transfer row):**

```
encrypted ──(worker: decrypt ok)──▶ decrypted        (terminal)
    │
    └──(worker: not authorized)──▶ unauthorized ──(ACL granted, retry)──▶ decrypted
```

This is also the component we are **least confident about under partner load**
(see Reflection): the decryption drainer's throughput and retry/backoff behavior
against a rate-limited relayer is the thing most likely to break first.

---

## Decision 3 — Database: **PGlite (embedded), single process**

**Choice:** PGlite, embedded in the Ponder process, with the decryption drainer
running **in the same process** as a background loop. One process, one DB file, no
Docker.

**Why simplicity wins here.** The brief is a single ERC-7984 contract on a testnet
and explicitly says ops/scale are not being evaluated. PGlite is the same Postgres
engine compiled to WASM (full SQL, same Ponder store), so we lose no query power —
we only give up multi-process concurrency, which the simple design doesn't need.
The payoff is a clean fresh-clone-to-running story: `npm install` and go, no
external services to stand up.

**The constraint that shaped this.** PGlite is, per its own docs, *"restricted to
a single user and a single connection"* — the WASM Postgres lives inside one
process, so a separate OS-level worker cannot open the same data directory
concurrently. That is exactly why the decryption drainer runs **in-process** here
(Decision 2): the persisted `pending` queue still provides the decoupling and
restart-safety; only the process boundary is dropped.

**`pglite-socket` — considered and rejected.** PGlite ships a socket server that
multiplexes client connections, so in principle a separate worker *could* connect
to it. But it only relocates the single PGlite backend into a standalone
server process that everything else connects to — a dev-only (no SSL,
single-backend) database with the **same process count as just running Postgres**.
If we ever need a second process to reach the data, real Postgres is strictly
simpler and more robust than a PGlite socket server. So `pglite-socket` buys
nothing for this design; its real use is attaching `psql`/a GUI for debugging.

**Trade-off accepted.** The in-process drainer shares Ponder's event loop and DB
connection, and a drainer bug or a hung relayer call can affect the indexer
process — i.e. **no fault isolation**. For a single-contract toy that is an
acceptable cut; under real load it is the first thing to change (see below).

### Robust production architecture (not built, documented on purpose)

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

The deliberate cut, stated plainly: we trade fault isolation and horizontal
scalability for one-process simplicity, knowing the persisted-queue design lets us
buy them back later without touching application logic.

## Decision 4 — Read API shape

**Full reference: [`API.md`](./API.md).** This section is the *why*; that file is
the spec.

**Choice.** A small REST API under `/v1` that looks like any other token indexer
(Alchemy/Covalent/Etherscan shapes), with exactly **one** unfamiliar concept: an
amount can be absent because it is still encrypted. Endpoints: `GET /v1/token`,
`/v1/addresses/{address}/balance`, `/v1/addresses/{address}/transfers`,
`/v1/transfers/{id}`, `/v1/health`.

**Shaping choices and their grounding:**
- **ERC-20-native fields**, modeled on what wallet devs already consume (Alchemy
  `getAssetTransfers`: `hash/from/to/value/category/uniqueId` + opaque page token).
- **Amounts are a string pair, never a JSON number** — `raw` (base-unit string) +
  `value` (human-readable). Our amounts are `uint64`; number division loses
  precision. Helius documents this raw+display split as current best practice.
- **The amount object carries `status`** (`decrypted | encrypted | pending |
  unauthorized`) — the D2 state machine surfaced verbatim. Undecryptable ⇒ `null`
  value + reason, never `0`, never 404. This is the brief's "must not be silently
  dropped" made observable, and the one FHE concession in an otherwise familiar API.
- **`balance.status` (`complete | partial | unavailable`) + `source` + `kind` +
  `amount.source`** expose the D7 running-sum/checkpoint model and provenance.
- **Keyset (cursor) pagination**, newest-first, over `(blockNumber, logIndex)` —
  stable under inserts, reorg-aware (`CURSOR_EXPIRED` on reorg past the anchor).
- **`/health` reports indexer lag and decryption backlog as independent signals**
  (D2/D7), so a partner can tell "chain-behind" from "decryption-behind."
- **Unknown address ⇒ empty/zero, not 404**; 404 is reserved for unknown
  routes/ids.
- **Hono, mounted in-process on Ponder's API server** (not a standalone Fastify).
  Ponder is Hono-native (peer-deps `hono`) and serves custom routes on the *same*
  server with typed, reorg-aware store access — matching D3's single process. A
  standalone framework (Fastify, etc.) only earns its keep at the D3 scale-up, when
  the API splits into its own process reading Postgres; even then `zod` already
  covers boundary validation, so Fastify's schema/serialization edge isn't
  decisive. So Hono here is "use the server Ponder already runs," not an
  independent framework pick.

**Surfaced for partner feedback (not decided unilaterally — see `API.md` §"Open
questions"):** (1) show vs. hide zero-amount *failed* transfers; (2) whether a
`partial` balance returns the on-chain **checkpoint total** or a **decrypted-so-far
lower bound**; (3) snapshot-pinned vs. moving-tip cursors; (4) stateless
non-expiring cursors (vs. Alchemy's 10-min `pageKey` TTL); (5) shield visibility
before delegation — public-wrap correlation vs. decrypt-then-backfill (D7). These
are wallet-UX calls we want the partner to weigh in on.

---

## Decision 5 — Environment: **Sepolia + public Relayer** (primary), `forge-fhevm` scoped to contract tests

**Choice:** Build and demo the indexer against **Sepolia with the public Zama
Relayer**. Use `zama-ai/forge-fhevm` only for Solidity contract-level checks and
encrypted-input fixtures — **not** as the service's decryption backend. Put
decryption behind a small `Decryptor` interface so offline tests don't depend on
a networked relayer (real impl → SDK/Sepolia; fake impl → in-memory).

**Why — decided by reading the forge-fhevm source, not the README.** The brief
offers Sepolia *or* a local `forge-fhevm` stack. `forge-fhevm` is a Foundry
*testing library*: it deploys the real fhEVM host contracts inside the Forge VM
and resolves decryption synchronously via cheatcodes against a local plaintext DB
with mock KMS keys. Inspecting it surfaces three layers that matter here:

1. **On-chain ACL/delegation *state* — faithfully modeled.** The ACL is the real
   production contract: `delegateForUserDecryption` (`ACL.sol:261`),
   `revokeDelegationForUserDecryption` (`ACL.sol:315`),
   `isHandleDelegatedForUserDecryption` (`ACL.sol:442`), and a
   `DelegatedForUserDecryption` event carrying a `delegationCounter` explicitly
   "to allow off-chain clients to track changes" (`ACL.sol:113-119`). Anything our
   indexer does by *watching* delegation events or *querying* the ACL is modeled
   correctly.

2. **Decryption *authorization* in the test helper — delegation is NOT honored.**
   The `userDecrypt` helper (the relayer stand-in) authorizes by **direct ACL
   allow only** (`FhevmTest.sol:317-333`): it requires `persistAllowed(handle,
   user)` and `persistAllowed(handle, contractAddress)` and **never calls
   `isHandleDelegatedForUserDecryption`** (grep of `src/` confirms that function is
   referenced only in its own definition and the isolated delegation unit test).
   So a delegate holding *only* a delegation — which is the indexer's exact
   situation — is rejected locally, even though the real Sepolia relayer/KMS would
   grant it. The delegation tests and the decrypt path never cross.

3. **No relayer for a Node process.** Decryption lives in `forge test` cheatcodes;
   there is no HTTP endpoint our long-running Node indexer + `@zama-fhe/sdk` can
   call.

**Consequence.** The most interesting and most load-sensitive part of the brief —
"partners may grant decrypt rights later… backfill cleartext when that happens" —
is the **delegated-decryption** path, and that is *precisely* what `forge-fhevm`
cannot drive end-to-end. Only the real Sepolia relayer honors delegation-based
`userDecrypt`. Choosing the local stack would mean the indexer's headline feature
is never actually exercised.

**Trade-off accepted.** Sepolia is slower (~12s blocks, faucet ETH) and the public
relayer is shared/rate-limited and occasionally flaky — but that rate-limiting *is*
the real-world failure mode the Reflection calls out as "least confident under
load," so testing against it is a feature, not a cost. The `Decryptor` seam keeps
the happy-path test fast and offline; the real relayer is used for the end-to-end
demo and manual verification.

---

## Decision 6 — Delegation & backfill model

**Choice:** The indexer holds its own EOA and decrypts **as a delegate**. A token
holder grants the indexer decrypt rights via the ACL's
`delegateForUserDecryption`; the indexer reads their amounts via the SDK's
delegate path (`decryptBalanceAs`), signing the EIP-712 request with **its own
key**. The ACL `DelegatedForUserDecryption` event is the **backfill trigger**.

**Why this shape.** An indexer watching a single contract is almost never a party
to the transfers it sees, so it cannot decrypt as sender/recipient. Delegation is
the mechanism the brief points at ("or via an ACL delegation… partners may grant
decrypt rights later"). The SDK's `node-viem` example Section 4 is exactly this
scenario — "a backend service (Account B) decrypts confidential balances on behalf
of users (Account A) without holding their private key" — so we follow it as the
reference integration.

**Authorization predicate (from ACL source, `ACL.sol:442`).** For the indexer to
`userDecrypt` a handle `H`, all three must hold:
1. the holder (delegator) is allowed on `H` — true by construction (ERC-7984
   grants transfer participants ACL access to their amount/balance handles);
2. the token contract is allowed on `H` — typically true (contract allows itself);
3. the holder has an active, unexpired delegation **to the indexer, scoped to the
   token contract** (`delegateForUserDecryption(delegate, contractAddress,
   expiry)`).

Delegation is keyed per `(delegator, delegate, contractAddress)`, so **one grant
per holder** unlocks all of that holder's handles on the watched token.

**Granting (how we simulate the partner).** Two equivalent ways to set the
delegation, used for seeding/demo on Sepolia:
- SDK `sdk.delegations.delegateDecryption({ contractAddress, delegateAddress,
  expirationDate? })` (preferred — same on-chain call plus pre-flight checks), or
- raw on-chain via `cast` (fallback + inspection):
  ```bash
  cast send "$ACL_ADDR" \
    "delegateForUserDecryption(address,address,uint64)" \
    "$INDEXER_ADDR" "$TOKEN_ADDR" "$EXPIRY" \
    --private-key "$HOLDER_KEY" --rpc-url "$SEPOLIA_RPC"
  ```
  Constraints enforced on-chain (`ACL.sol:278-289`): `delegate != holder`,
  `contractAddress != holder`, `delegate != contractAddress`, `expiry > now`, no
  delegate+revoke in the same block. `$ACL_ADDR` is the canonical fhEVM host
  address from the SDK config, not something we deploy.

**Backfill is event-driven (closes the open "trigger" question).** The grant emits
`DelegatedForUserDecryption(delegator, delegate, contractAddress, …)` with
`delegator`/`delegate` indexed (`ACL.sol:300`). We add the **ACL contract** to
`ponder.config` with an event filter `delegate == INDEXER_ADDR`; on receipt we
re-drive that `delegator`'s `unauthorized` rows. A periodic poll remains as a
backstop (see propagation lag below).

**Propagation lag is part of the contract.** The example explicitly retries
`DelegationNotPropagatedError` because "Sepolia ACL propagation can take one or two
minutes." So seeing the delegation event does **not** mean the next decrypt
succeeds. Consequences baked into the drainer:
- `unauthorized` is **not terminal** — retry with backoff;
- expect a 1–2 min window where the event is observed but decryption still fails
  authorization;
- this is the concrete mechanism behind D2's "least confident under load" note.

**Resolved — the delegation API is address-based, not ECDH-keyed** (read from
`@zama-fhe/sdk` source, `delegation-service.ts` / `namespaces/delegations.ts`).
`delegateDecryption({ contractAddress, delegateAddress, expirationDate? })`
normalizes addresses with `getAddress()` and calls the on-chain
`ACL.delegateForUserDecryption(delegate, contractAddress, expiry)` — a 1:1 wrapper
with pre-flight checks, **no ECDH/keypair handshake**. So the raw `cast` call above
and the SDK helper are exactly equivalent for granting. Details:
- The **delegator is the connected signer** (`requireAlignedWalletAccount`); in the
  seed/demo the *holder's* key signs the grant and the indexer is `delegateAddress`
  — exactly what `cast --private-key $HOLDER_KEY` does.
- `expirationDate` is a JS `Date`, optional, **default permanent** (`uint64.max`),
  must be ≥ 1 h in the future (`DelegationExpirationTooSoonError`).
- The ECDH/encryption **keypair lives in the *decryption* request, not the
  delegation**: `decryptBalanceAs` signs a user-decrypt request carrying the
  indexer's FHE public key, and the relayer re-encrypts ciphertext to it.
  **Implication:** the drainer must **persist the indexer's FHE keypair** via the
  SDK's `GenericStorage` backed by our DB — not the example's `MemoryStorage`,
  which loses credentials on restart. Surface: `delegateDecryption`,
  `decryptBalanceAs`, `revokeDelegation`, `isActive`, `getExpiry`; the delegate
  signs the request, and `DelegationNotPropagatedError` is typed (D8).

**Offline test model.** The `Decryptor` fake encodes the same three-condition
predicate: a delegation set + a `handle → allowedAccounts` map, where
`decryptAs(handle, delegate)` returns cleartext only when the predicate holds and
otherwise throws `Unauthorized` (or `DelegationNotPropagated` for the first N
calls, to mirror the lag). The happy-path-with-backfill test: index a transfer →
`unauthorized` → flip delegation on → drainer retries → `decrypted` with the
correct cleartext. Deterministic, no Sepolia.

---

## Decision 7 — Indexed events & amount provenance

The watched token is an **ERC-7984 ERC-20 wrapper** (the SDK example's cUSDT
pattern), so we index events from both the base `IERC7984` and the
`IERC7984ERC20Wrapper` interfaces. Signatures below are taken verbatim from
OpenZeppelin `@openzeppelin/confidential-contracts` (`IERC7984.sol`,
`IERC7984ERC20Wrapper.sol`), which is the canonical source — the SDK consumes it,
it does not redefine it.

**Events we index:**

| Event | Interface | Amount field |
| --- | --- | --- |
| `ConfidentialTransfer(address indexed from, address indexed to, euint64 indexed amount)` | base | `amount` = encrypted `euint64` **handle** (indexed topic) |
| `AmountDisclosed(euint64 indexed encryptedAmount, uint64 amount)` | base | handle **+ cleartext** `uint64` |
| `UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, euint64 amount)` | wrapper | encrypted `euint64` handle |
| `UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, euint64 encryptedAmount, uint64 cleartextAmount)` | wrapper | handle **+ cleartext** `uint64` |
| `OperatorSet(address indexed holder, address indexed operator, uint48 until)` | base | none (permissions only) |

**Amount provenance.** The decryption pipeline is needed for confidential transfer
amounts — **including shield mints** — and live balances; amounts the contract
*discloses on-chain* arrive as cleartext in the event and skip it:

- **Decrypt-required (delegated `userDecrypt`):**
  - `ConfidentialTransfer.amount` — the per-transfer encrypted handle (plain
    transfers **and** shield mints; see below). We decrypt these regardless, since
    the brief requires cleartext transfer **history**.
  - **Current balance** — see "Balance strategy" below.
- **Cleartext emitted by the event (no decryption by us):**
  - `UnwrapFinalized.cleartextAmount` and `AmountDisclosed.amount` — the contract
    performs the on-chain **public** decryption (KMS) and the cleartext is *in the
    log*. Written `decrypted`/`source='disclosed'` on index, skipping the queue.

**Shield/wrap mints go through the standard decrypt path** (not treated as "public"
here — correcting an earlier over-claim). A shield emits
`ConfidentialTransfer(0x0, to, handle)` with an *encrypted* handle and **no
dedicated wrap event** carrying the amount. The wrap amount *is* public on-chain
(the `wrap(to, uint256 amount)` call input / the underlying ERC-20 transfer), but
recovering it needs active correlation (tx-input decode or matching the underlying
`Transfer`) — brittle under routers/AA/multicall, and in *underlying* units that
need `rate()` to reach wrapped units, with rounding that can drift from the minted
handle (and so from the balance sum). For any holder the indexer serves — one who
delegated (D6) — the mint handle decrypts via the *same* delegated path as their
other transfers, in **authoritative wrapped units**, zero correlation. So shield
mints are treated uniformly: `encrypted` → drainer → `decrypted`/`source=
'userDecrypt'`. Public-wrap correlation is a **deferred enhancement** whose only
gain is visibility *before* a holder delegates; see the partner-feedback question
in `API.md`.

**Consequence — we never call `publicDecrypt` ourselves.** The only decryption the
indexer performs is delegated `userDecrypt`, for confidential transfer amounts
(plain and shield-mint) and live balances. Only the **disclosed** amounts
(`AmountDisclosed`, `UnwrapFinalized`) arrive as cleartext in the event and skip
the `pending` queue; plain transfers and shield mints flow through it.

**Handle extraction.** For `ConfidentialTransfer`, `event.args.amount` *is* the
`euint64` handle (a 32-byte topic) — fed straight to the decrypt path, no extra
lookup. Because `from`/`to` are indexed and ERC-7984 grants both transfer parties
ACL access to the amount handle, a delegation from either party (scoped to the
token contract, D6) covers that handle.

**Balance strategy — derive locally, checkpoint against the handle.** Since we
decrypt every transfer amount anyway (for history), balance is a **derived
aggregate over the stored cleartext deltas** (a `SUM`, not an independently-mutated
counter — see `plan.md` §Stores & reorg-safety) — reads are pure DB lookups with
**no per-request relayer roundtrip**. The live `confidentialBalanceOf(addr)` handle is
**not** decrypted on every read; it is used as an authoritative checkpoint:
- periodically, to reconcile the running sum and detect drift;
- as a **fallback total** when local history is known-incomplete (any
  `encrypted`/`unauthorized` transfer in the address's set, or indexing started
  mid-history) — one decrypt of the balance handle yields a correct total even
  when individual deltas are missing.

So we pay the relayer at most **once per balance-changing event** (plus rare
reconciliation), not once per API read. If an address has undecryptable transfers,
its derived balance is **partial** and surfaced as such (D2 honesty rule) or
replaced by the checkpoint value — never reported as a confident wrong number.

**Verified (was the load-bearing item): the event carries the actually-applied
amount.** Read directly from OpenZeppelin `ERC7984.sol` `_update` (v master):
`transferred = FHE.select(success, amount, 0)` where `success = fromBalance >=
amount` (`ERC7984.sol:300,306`); the recipient is credited exactly `transferred`
(`:313`) and the event emits `transferred` (`:322`). So the `ConfidentialTransfer`
amount is the value applied to both balances — **summing decrypted deltas is
sound**, and the balance-handle decrypt is a *pure optional checkpoint*, not
mandatory. Three refinements from the same trace:
- **All-or-nothing, not partial clamp.** An overspend transfers `0`, so failed
  sends emit `ConfidentialTransfer(from, to, <handle → 0>)`. History will contain
  zero-amount transfers (a D4 display choice); harmless to the sum.
- **Mint/burn are `ConfidentialTransfer` events** (`_update` handles
  `from/to == address(0)`, `:287-322`): shield → `ConfidentialTransfer(0, to,
  transferred)`, unshield-burn → `ConfidentialTransfer(from, 0, transferred)`. This
  also resolves the shield-event-shape question below. The running sum includes
  mints (inbound-from-0) and burns (outbound-to-0).
- **`transferAndCall` nets via two events** — observers see `sent` and `refund`
  individually (`:256-258`), each emitting its own `transferred`; summing nets
  correctly with no special case.

`FHE.allow(transferred, from/to)` (`:319-320`) confirms both parties (and a delegate
of either) can decrypt the amount handle — validates the D6 delegation model.

**Residual caveats for the sum (unrelated to clamping):** it still requires
**complete + decrypted history**. **Reorg-safety is structural** (resolved in
`plan.md` §Stores): balance is a derived aggregate over Ponder's reorg-tracked
`transfers`, and the decryption cache is keyed by the content-addressed
`amountHandle` (a handle's plaintext is immutable), so reverts need no out-of-band
undo. One wrapper nuance: mint/burn deltas are in *wrapped*
units, while the public `wrap` `uint256` and `UnwrapFinalized.cleartextAmount` may
be in *underlying* units — cross-filling those from cleartext needs the `rate()`
conversion; decrypting the `transferred` handle yields wrapped units directly.

**Confirmed against the implementation** (`ERC7984.sol` `_update`): a **shield/wrap**
emits `ConfidentialTransfer(address(0), to, transferred)` and an **unshield-burn**
emits `ConfidentialTransfer(from, address(0), transferred)`; the event amount is the
**actually-transferred** value, not the requested one. See the balance-strategy
verification above for the full trace.

---

## Decision 8 — Drainer retry & rate-limit policy

**The decision is outcome classification, not a single backoff number.** The
drainer's failures have different causes that demand different reactions; a uniform
backoff would be wrong. We classify each decrypt outcome by the SDK's typed error
and let the class set the retry semantics.

**Verified SDK error surface (read from `@zama-fhe/sdk` source).** Every SDK error
extends `ZamaError` with a machine-readable `code: ZamaErrorCode` and `instanceof`
subclasses, plus a `matchZamaError(err, handlers)` matcher (`errors/base.ts`). The
distinctions our policy needs are all present as distinct types:

| Outcome | SDK error (code) | Class | Reaction | Row state |
| --- | --- | --- | --- | --- |
| Success | — | — | write cleartext | `decrypted` (terminal) |
| No delegation | `DelegationNotFoundError` (`DELEGATION_NOT_FOUND`) | state-driven | wait for ACL grant event; slow backstop | `unauthorized` |
| Delegation expired | `DelegationExpiredError` (`DELEGATION_EXPIRED`) | state-driven | needs re-grant; same handling | `unauthorized` |
| Not propagated | `DelegationNotPropagatedError` (`DELEGATION_NOT_PROPAGATED`) | transient, slow | ~30s backoff, cap ~10 min | `pending` |
| Rate limited | `RelayerRequestFailedError`, `statusCode === 429` | transient, **global** | throttle whole drainer; circuit-break | `pending` |
| Server/network | `RelayerRequestFailedError`, `statusCode >= 500` / network | transient | exp backoff + jitter → slow-park | `pending` |
| ACL paused | `AclPausedError` (`ACL_PAUSED`) | global | pause drainer until cleared | `pending` |
| Stale credential | `KeypairExpiredError` / `InvalidKeypairError` | recoverable | **refresh keypair**, retry now (not a row failure) | `pending` |
| Decrypt failed / malformed | `DecryptionFailedError` (`DECRYPTION_FAILED`) | likely permanent | surface + **slow-retry** (below) | `failed` |

Classification keys off `instanceof` / `error.code` via `matchZamaError`, never
message parsing.

**Ordering: oldest-first.** Non-terminal rows are processed `ORDER BY block_number,
log_index ASC`. This favors backfill completeness and lets the running-sum balance
(D7) settle in chain order. (Newest-first would light up recent transfers sooner for
the wallet; we prioritize correctness of the derived balance.)

**`failed` is not terminal.** A remote KMS/relayer "permanent" error is hard to be
sure of, so `failed` rows are surfaced (API + `/health`) but kept on a **long
slow-retry** (e.g. hourly), not dead-lettered. Only a structurally malformed handle
is a candidate for true termination. This preserves the "never silently drop"
invariant even for errors we can't classify with confidence.

**Unified scheduler — one `next_attempt_at` column.** Every non-terminal row carries
`next_attempt_at`; classification sets it. The drainer is one query:

```sql
WHERE status <> 'decrypted' AND next_attempt_at <= now()
ORDER BY block_number ASC, log_index ASC
LIMIT :batch
```

`failed` rows participate with a far-future `next_attempt_at`. The ACL grant event
(D6) simply pulls the time forward — `next_attempt_at = now()` for the delegator's
rows — giving immediate retry on grant with no separate machinery. New columns:
`attempts`, `next_attempt_at`, `last_error_code`, `last_error_at`.

**Rate-limiting is global, not per-row.** A 429 on one decrypt means the next will
429 too, so backoff lives at the drainer level: a concurrency cap + token bucket on
relayer calls, and a circuit breaker that pauses the whole drainer on sustained
429/5xx/`AclPaused`. Both self-protection and good-citizenship toward a shared
public relayer.

**Defaults (env-tunable):** full-jitter exponential, base 1s ×2 cap 60s; ~8 fast
attempts → slow-park 15 min; propagation retry ~30s up to ~10 min; `unauthorized`
backstop poll ~10 min; concurrency ~4; breaker opens after N consecutive global
failures, cooldown 30–60s, half-open probe. Decrypt is **read-only on-chain**, so
retries are idempotent (no double-spend risk); the only safety rule is that the
cleartext write is conditional on the row still existing (reorg may have reverted
it, D7).

**Drives `/health`:** `degraded` when oldest-pending age / backlog crosses a soft
bound; `unhealthy` (503) when the breaker is open or the backlog is unbounded.

**SDK feedback (confirmed gaps, not blockers):** the typed taxonomy is strong, but
(a) rate-limiting has no dedicated class — we infer it from
`RelayerRequestFailedError.statusCode === 429`; and (b) that error exposes
`statusCode` but **not** the relayer's `Retry-After` header, so we cannot honor a
server-suggested backoff and fall back to our own. A `retryAfter`/`retryable` field
on `RelayerRequestFailedError` would let clients respect server backpressure
directly. (Carried to the SDK feedback section.)

**Scope.** Build now: the unified `next_attempt_at` loop, full-jitter backoff, the
classification above via `matchZamaError`, a small concurrency cap, and a basic
"N recent failures → sleep" breaker. The token-bucket limiter, real half-open
breaker, separate worker process, and metrics export are the documented production
hardening (D3 scale-up).

---

## Tests

**TODO.**
- Happy path: an event in → correct cleartext out of the API.
- One negative test (to be chosen and justified) — likely the
  not-yet-authorized path, asserting the event is retained as `encrypted`/
  `unauthorized` and never dropped.

## Reflection

**TODO** (to be written against the finished build):
- Least-confident component under load and how we'd prove it breaks — current
  candidate: the decryption worker vs. a rate-limited relayer (Decision 2).
- What we cut, and the first thing we'd do with another four hours.

## SDK feedback

**TODO** — 2–3 concrete improvements to `@zama-fhe/sdk@alpha`, each with (a) the
change, (b) the partner-integration scenario it unblocks, (c) priority order.

## AI assistance

**TODO** — how AI tooling was used, and one place it was subtly wrong and had to
be corrected.
