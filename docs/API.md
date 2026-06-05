# Read API

The partner-facing HTTP API. A wallet integrator should be able to read it and
feel like they're using any other token indexer (Alchemy / Covalent / Etherscan
shapes), with exactly **one** unfamiliar concept: an amount can be *absent because
it is still encrypted*. That single addition is surfaced honestly and never faked.

> Design rationale and trade-offs live in `DECISIONS.md` (Decision 4). This file
> is the reference; the decisions doc is the argument.

## Design principles (and where they come from)

- **ERC-20-shaped, wallet-native fields.** Modeled on what wallet devs already
  consume: Alchemy `getAssetTransfers` (`hash, from, to, value, category, uniqueId`
  + opaque `pageKey`), Helius Wallet API (human-readable **and** raw amounts),
  Covalent/Etherscan (per-page limits, `decimals`).
- **Amounts are always a string pair, never a JSON number.** `raw` (base-unit
  integer string) + `value` (human-readable string). Our amounts are `uint64`;
  JSON-number division by `10^decimals` loses precision. Display from `value`,
  reconcile from `raw`. (Helius states this explicitly as current best practice.)
- **Honest in-between state.** Every amount carries a `status`; an undecryptable
  amount returns `null` value with a reason, never `0` and never a 404. This is the
  one FHE-specific concession and is the whole point of the service.
- **Keyset (cursor) pagination, newest-first.** Opaque cursor over
  `(blockNumber, logIndex)` — stable under inserts, reorg-aware, no offset drift.
- **Freshness is explicit.** Every response carries `asOfBlock` so a wallet knows
  how current the data is.

## Conventions

| Aspect | Choice |
| --- | --- |
| Base path | `/v1` |
| Server | Hono, mounted **in-process** on Ponder's API server (Ponder is Hono-native). A standalone framework (Fastify, etc.) is deferred to the D3 scale-up, when the API becomes its own process. See `DECISIONS.md` D4. |
| Token | Single token, fixed by server config — **not** in the path. `chainId` + token echoed in responses. |
| Content type | `application/json; charset=utf-8` |
| Timestamps | ISO 8601 UTC (`2026-06-05T12:00:00Z`), alongside `blockNumber` |
| Addresses | lowercase hex; input is case-insensitive, validated EIP-55 or raw |
| Amounts | `{ status, raw, value, source }` object (see below) |
| Pagination | `?limit=&cursor=`; response `page: { nextCursor, hasMore }`; `limit` default 50, max 100 |
| Ordering | `order=desc` default (newest first) |
| Freshness | `asOfBlock` on every response |
| Auth | Out of scope for the toy (no shared secrets per the brief). Seam: an `Authorization`/API-key header at the edge. |

### The amount object (the confidential core)

```jsonc
{
  "status": "decrypted",   // decrypted | encrypted | pending | unauthorized | failed
  "raw": "10000000",       // base-unit string; null unless status=decrypted
  "value": "10.0",         // human-readable string; null unless status=decrypted
  "source": "userDecrypt"  // userDecrypt | public | disclosed
}
```

`status` is the Decision 2 state machine surfaced verbatim:

| status | meaning | raw/value | terminal? |
| --- | --- | --- | --- |
| `decrypted` | cleartext available | present | yes |
| `encrypted` | not yet attempted / awaiting rights | null | no |
| `pending` | decrypt in flight or propagation lag | null | no |
| `unauthorized` | tried, no delegation yet | null | **no** (retryable — backfill flips it) |
| `failed` | decrypt failed or returned a malformed result; surfaced while retrying slowly | null | **no** (slow retry) |

`source` is the Decision 7 provenance: `userDecrypt` (delegated decryption),
`public` (shield amount known from chain), `disclosed` (`AmountDisclosed` /
`UnwrapFinalized` cleartext).

## Endpoints

### `GET /v1/token`
Token metadata so the wallet can render symbol/decimals.
```json
{
  "chainId": 11155111,
  "address": "0x…",
  "name": "Confidential USDT",
  "symbol": "cUSDT",
  "decimals": 6,
  "kind": "erc7984-erc20-wrapper",
  "underlying": "0xa7dA08…"
}
```

### `GET /v1/addresses/{address}/balance`
Current cleartext balance for an address.
```json
{
  "address": "0x…",
  "balance": {
    "status": "complete",     // complete | partial | unavailable
    "raw": "40000000",
    "value": "40.0",
    "source": "derived",      // derived (running sum) | checkpoint (on-chain handle)
    "pendingTransfers": 0      // undecrypted transfers affecting this address; >0 ⇒ partial
  },
  "asOfBlock": 1234567,
  "asOfTime": "2026-06-05T12:00:00Z"
}
```
`balance.status` makes the Decision 7 honesty rule observable: if any transfer
affecting the address is still undecrypted, the balance is `partial` (and `value`
is the best-known total or the on-chain checkpoint), never a confident wrong number.

### `GET /v1/addresses/{address}/transfers`
Transfer history with cleartext amounts where available.

Query params: `limit`, `cursor`, `order` (`asc|desc`), `direction` (`in|out|self`),
`kind` (`transfer|shield|unshield|disclosure`), `status` (`decrypted|encrypted|pending|unauthorized|failed`).

```json
{
  "data": [
    {
      "id": "0xabc…-3",
      "txHash": "0xabc…",
      "blockNumber": 1234567,
      "logIndex": 3,
      "timestamp": "2026-06-05T12:00:00Z",
      "from": "0x…",
      "to": "0x…",
      "direction": "in",
      "kind": "transfer",
      "amount": { "status": "decrypted", "raw": "10000000", "value": "10.0", "source": "userDecrypt" }
    },
    {
      "id": "0xdef…-1",
      "txHash": "0xdef…",
      "blockNumber": 1234560,
      "logIndex": 1,
      "timestamp": "2026-06-05T11:58:00Z",
      "from": "0x…",
      "to": "0x…",
      "direction": "out",
      "kind": "transfer",
      "amount": { "status": "pending", "raw": null, "value": null, "source": "userDecrypt" }
    }
  ],
  "page": { "nextCursor": "eyJiIjoxMjM0NTYwLCJsIjoxfQ", "hasMore": true },
  "asOfBlock": 1234567
}
```
- `id` = `uniqueId` = `txHash-logIndex`.
- `direction` is relative to `{address}`; omitted on any non-address-scoped listing.
- `kind` and `amount.source` come from Decision 7's provenance table.
- Cursor is opaque base64 of `(blockNumber, logIndex)`; a reorg past the cursor
  anchor returns `CURSOR_EXPIRED` so the client restarts rather than silently
  skipping or duplicating.

### `GET /v1/transfers/{id}`
A single transfer — lets a wallet that saw `status: pending`/`unauthorized`/`failed` poll one
row until backfill or slow retry flips it to `decrypted`, instead of re-listing. Returns the
transfer object above (404 if the id is unknown).

### `GET /v1/health`
Health and how-far-behind — two **independent** signals (Decision 2 / 7).
```json
{
  "status": "healthy",          // healthy | degraded | unhealthy
  "chainId": 11155111,
  "token": "0x…",
  "indexer":    { "headBlock": 1234600, "indexedBlock": 1234567, "lagBlocks": 33, "lagSeconds": 396 },
  "decryption": { "pending": 12, "unauthorized": 4, "failed": 1, "oldestPendingSeconds": 90, "lastSuccessAt": "2026-06-05T12:00:00Z" }
}
```
- **Indexer lag** (head vs indexed) is reported separately from **decryption
  backlog** so a partner can distinguish "chain-behind" from "decryption-behind."
  `failed` counts rows that are visible in transfer APIs and still on a slow retry.
- HTTP `200` for `healthy`/`degraded`, `503` for `unhealthy` (lag over threshold or
  drainer stalled).
- `GET /v1/health/live` is a trivial liveness probe (process up); this endpoint is
  readiness.

## Error taxonomy

One envelope everywhere:
```json
{ "error": { "code": "INVALID_ADDRESS", "message": "…", "details": {} } }
```

| HTTP | code | when |
| --- | --- | --- |
| 400 | `INVALID_ADDRESS` / `INVALID_PARAM` | bad address / bad query value |
| 400 | `INVALID_CURSOR` | malformed cursor |
| 409 | `CURSOR_EXPIRED` | cursor anchor reorged away → restart pagination |
| 413 | `LIMIT_TOO_LARGE` | `limit > 100` |
| 429 | `RATE_LIMITED` | + `Retry-After` header |
| 503 | `INDEXER_NOT_READY` | still backfilling / lag over threshold |
| 404 | `NOT_FOUND` | unknown route or transfer id |
| 500 | `INTERNAL` | unexpected |

**An unknown address is not a 404** — it returns an empty transfer list / zero
balance. Every address is a valid query target; only unknown routes and transfer
ids are 404.

## Open questions for the partner (feedback wanted)

These are genuine product choices we should not make unilaterally — they affect
wallet UX and we'd rather surface them than guess:

1. **Show or hide zero-amount (failed) transfers?** Overspend attempts emit
   `ConfidentialTransfer(from, to, 0)` (Decision 7). Default proposal: **include**
   them with `kind: "transfer"` and `value: "0"` so history matches the chain, but
   provide `?includeZero=false` to hide. Does the wallet want them in the feed?
2. **`partial` balance — checkpoint or lower bound?** When some transfers are
   undecrypted, should `balance.value` be the **on-chain checkpoint total**
   (accurate total, but you can't see the matching line items) or the
   **decrypted-so-far lower bound** (matches the visible history, but understates)?
   We lean checkpoint-total + `pendingTransfers > 0`, but this is a UX call.
3. **Pagination over a moving tip.** Default is keyset newest-first; a long-lived
   cursor near the head will see new rows arrive. Acceptable, or does the partner
   want a snapshot/`asOfBlock`-pinned cursor?
4. **Cursor TTL.** Alchemy expires `pageKey` after 10 min. Our keyset cursor has no
   server state, so it need not expire — but it *can* be invalidated by a reorg
   (`CURSOR_EXPIRED`). Confirm the partner is fine with stateless, non-expiring
   cursors.
5. **Shield visibility before delegation?** A shield/wrap mint carries an
   *encrypted* handle and has **no** dedicated public event, so by default it shows
   `encrypted`/`unauthorized` until the holder delegates and it backfills (Decision
   7) — even though the wrap amount is technically public on-chain. We *could*
   correlate the public amount (tx-input / underlying ERC-20 transfer + `rate()`)
   to show shields immediately, at the cost of brittle correlation and
   display-only values that can round-drift from the minted handle. Worth it, or is
   delegated-decrypt-then-backfill acceptable for the on-ramp?

## Mapping to decisions

| API element | Decision |
| --- | --- |
| `amount.status` enum, `/transfers/{id}` polling | D2 (state machine), D6 (backfill) |
| `balance.source` / `partial`, `kind`, `amount.source` | D7 (provenance, running-sum + checkpoint) |
| `/health` lag vs backlog split | D2, D7 |
| Sepolia-only delegated decryption affecting `pending`/`unauthorized` | D5, D6 |
