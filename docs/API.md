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
  "source": "userDecrypt"  // userDecrypt | disclosed
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

`source` is the Decision 7 provenance: `userDecrypt` (delegated decryption) or
`disclosed` (cleartext available from public-chain data, including
`AmountDisclosed`, `UnwrapFinalized`, and unambiguous shield deposits).

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
Current cleartext balance for an address. Because every cleartext is relayer-decrypted
and therefore lagging, a single "current balance" scalar is impossible to give
honestly. Instead the balance is **a confirmed exact figure as of a block, plus the
set of transfers we can see but cannot yet value**.
```jsonc
{
  "address": "0x…",
  "balance": {
    "status": "as_of",                 // exact | as_of | unknown
    "confirmed": {                      // exact, zero-anchored total — or null
      "raw": "40000000",
      "value": "40.0",
      "asOfBlock": 1234560,            // anchor: last gap-free valued block (exact ⇒ indexed head)
      "source": "derived"             // derived | checkpoint (checkpoint reserved for the D2 seal)
    },
    "pending": {                        // affecting transfers we can't yet value
      "count": 1, "inbound": 0, "outbound": 1,
      "oldestBlock": 1234561,
      "byStatus": { "unauthorized": 1 } // why we can't value them
    },
    "value": "40.0"                     // flat alias = confirmed.value, or null
  },
  "asOfBlock": 1234567,
  "asOfTime": "2026-06-05T12:00:00Z"
}
```

`status` is a **trust level for `confirmed`** — and *only* that; the reason a balance
isn't current/known lives in `pending.byStatus`, never folded into `status`:

| status | meaning | `confirmed` |
| --- | --- | --- |
| `exact` | confirmed is the current balance (no affecting transfer is still un-valued) | present, `asOfBlock` = indexed head |
| `as_of` | confirmed is **exact but as of `asOfBlock`**; newer transfers are pending | present |
| `unknown` | no zero-anchored exact figure (the earliest affecting transfer is un-valued, no checkpoint) | **`null`** |

Key properties:
- **`confirmed.value` is never a lower bound.** It is the exact net of the maximal
  *gap-free valued prefix* of history — we stop summing at the first un-valued
  transfer, so a hidden amount can never silently shrink it. This is the per-amount
  "`null`, never `0`" rule applied to balances.
- **`pending` describes what we can't value yet** — `count`, the `inbound`/`outbound`
  split (direction is known from the indexed `from`/`to` even without the amount),
  `oldestBlock`, and `byStatus` (`unauthorized` ⇒ a delegation is needed; `pending`/
  `encrypted` ⇒ the drainer is catching up; `failed` ⇒ wedged, still retrying).
- **`unknown` ≠ empty.** An address with no transfers is `exact` with `value: "0.0"`
  (provably zero); `unknown` (`value: null`) means "active, but we can't anchor a
  number" — the pre-delegation state. These are deliberately distinguishable.
- **Zero-anchor caveat.** A `source: "derived"` figure assumes the address held zero
  before the earliest *indexed* transfer — true when indexing from the token's deploy,
  or for addresses whose first activity we observed (e.g. a freshly-funded holder). For
  a pre-existing holder on a late `START_BLOCK`, the derived prefix is a *delta*, not a
  balance; supplying the absolute anchor is exactly the job of the **checkpoint seal**
  (`source: "checkpoint"`), a documented follow-up (DECISIONS D7). Until then such
  addresses are reported `unknown` rather than with a wrong number.

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
