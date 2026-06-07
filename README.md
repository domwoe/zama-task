# Zama Confidential Indexer

Small TypeScript Node service for indexing one ERC-7984 confidential token,
retaining encrypted events, decrypting amounts when the indexer has delegated
rights, and exposing cleartext-style wallet APIs.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- Sepolia RPC URL
- Toy/testnet keys only

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Then fill `.env.local`. Ponder loads `.env.local` (not `.env`), and the demo scripts
read the same file, so this is the single source of configuration. The table below
describes each value; the [Sepolia Demo](#sepolia-demo) section provides ready-to-use
contract addresses for the public Zama demo token, so in practice you only need to
generate keys and fund a holder.

| Variable | What it is |
| --- | --- |
| `SEPOLIA_RPC_URL` | Sepolia JSON-RPC endpoint. A keyless public node works: `https://ethereum-sepolia-rpc.publicnode.com` (swap in your own if it rate-limits). |
| `TOKEN_ADDRESS` | The watched **ERC-7984 confidential wrapper** — not the underlying ERC-20. |
| `FHEVM_ACL_ADDRESS` | Canonical fhEVM ACL on the target chain. |
| `INDEXED_ADDRESSES` | Comma-separated holders to scope the indexer to (also the `demo:watch` default). Omit to index every address on the token. |
| `INDEXER_ADDRESS` / `INDEXER_PRIVATE_KEY` | The indexer's own EOA. It decrypts as a delegate off-chain, so it needs **no ETH**; the address must derive from the key. |
| `DEMO_HOLDER_PRIVATE_KEY` | Holder that shields, transfers, and delegates. **Needs Sepolia ETH for gas.** |
| `DEMO_RECIPIENT_ADDRESS` | Recipient of the demo transfer. |
| `DEMO_MINT_AMOUNT` / `DEMO_SHIELD_AMOUNT` / `DEMO_TRANSFER_AMOUNT` / `DEMO_UNSHIELD_AMOUNT` | Base-unit integer amounts; blank skips that step. Mint/shield are in underlying units, transfer in wrapped units. |
| `START_BLOCK` | Block number to index from, or `latest` to start at the chain head. |
| `API_BASE_URL` | Where `demo:watch` reads the API (default `http://localhost:42069`). |
| `ZAMA_SDK_LOG_LEVEL` | SDK worker/cache/event logging level: `silent`, `error`, `warn`, `info`, or `debug` (default `debug`). |

Do not use production funds, production data, or shared secrets — toy testnet keys
only.

## Local Database

Ponder uses embedded PGlite at `./.ponder/pglite`.

```bash
pnpm run reset:local-db
```

The reset script removes only that configured PGlite directory.

## Development

```bash
pnpm run dev
pnpm run check
```

The API is mounted under `/v1`; the scaffolded liveness endpoint is:

```bash
curl http://localhost:42069/v1/health/live
```

The API contract is in [`docs/openapi.yaml`](docs/openapi.yaml) and is also served
by a running indexer:

```bash
curl http://localhost:42069/v1/openapi.yaml
```

## Tests

```bash
pnpm run test
pnpm run test:integration
```

The required happy path is covered by
[`tests/indexer-flow.test.ts`](tests/indexer-flow.test.ts#L173): an indexed transfer
with delegated decrypt rights is drained and returned by the API with a cleartext
amount. The required negative path is in
[`tests/indexer-flow.test.ts`](tests/indexer-flow.test.ts#L263): an undelegated
transfer is retained in the API as `unauthorized` with `raw: null`, not dropped.

`pnpm run test:integration` runs the Anvil/Ponder flow, checking the same
[`unauthorized` before delegation](tests/integration/indexer-e2e.test.ts#L196) and
[`decrypted` after delegation](tests/integration/indexer-e2e.test.ts#L262) lifecycle
end to end with the fake decryptor.

## Sepolia Demo

End-to-end on Sepolia against the public Zama relayer. The arc: a holder shields
tokens and transfers them; the indexer records the transfers as `encrypted` (it has
no decryption rights yet); the holder delegates decryption to the indexer; the
drainer backfills and the amounts flip to `decrypted`.

### Demo token (public, ready to use)

These public Zama demo contracts on Sepolia are already prefilled in `.env.example` (copied into your `.env.local`) — listed here for reference:

| Variable | Value |
| --- | --- |
| `TOKEN_ADDRESS` | `0x4E7B06D78965594eB5EF5414c357ca21E1554491` (cUSDT mock wrapper) |
| `FHEVM_ACL_ADDRESS` | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` |
| `SEPOLIA_RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` |

The wrapper wraps the mintable USDT mock `0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0`
(resolved via the Zama on-chain registry). Because that underlying has an
unrestricted `mint()`, `DEMO_MINT_AMOUNT` lets a fresh clone create its own tokens
to shield — no faucet for the token itself.

### Generate keys and fund the holder

Generate a throwaway keypair (run twice — once for the indexer, once for the holder):

```bash
node --input-type=module -e "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k=generatePrivateKey(); console.log(k, privateKeyToAccount(k).address)"
```

Put one in `INDEXER_ADDRESS` / `INDEXER_PRIVATE_KEY` and the other in
`DEMO_HOLDER_PRIVATE_KEY`, set `DEMO_RECIPIENT_ADDRESS` (any third address), and list
the holder and recipient in `INDEXED_ADDRESSES`. Then **fund the holder** with a
little Sepolia ETH (~0.02 covers the whole arc) from a faucet such as
<https://sepolia-faucet.pk910.de>. The indexer and recipient need no ETH.

### Validate

```bash
pnpm run demo:doctor
```

A read-only preflight (no transactions): it checks `.env.local` is complete and
well-formed, the RPC is reachable on the expected chain, `TOKEN_ADDRESS` / its
`underlying()` / `FHEVM_ACL_ADDRESS` have contract code, the underlying `mint()` is
callable, `INDEXER_PRIVATE_KEY` derives `INDEXER_ADDRESS`, and the holder is funded.
It exits non-zero on any failure.

### Run

Use three terminals:

```bash
# 1 — indexer + read API (http://localhost:42069)
pnpm run dev

# 2 — live view: balance, transfer status, and indexer/decryption health, redrawn
#     each tick; rows whose decryption status changes are highlighted
pnpm run demo:watch

# 3 — generate activity, then delegate
pnpm run demo:seed       # mint underlying -> shield -> transfer
pnpm run demo:delegate   # holder grants the indexer decryption rights
```

`demo:seed` runs whichever of `DEMO_MINT_AMOUNT`, `DEMO_SHIELD_AMOUNT`,
`DEMO_TRANSFER_AMOUNT`, and `DEMO_UNSHIELD_AMOUNT` are set (blank skips that step).
Run it after `pnpm dev` is up so the events land at the chain head being indexed.

After `demo:delegate` is mined, the Zama gateway can take 1–2 minutes to observe the
ACL event; the drainer then re-drives the holder's `unauthorized` rows and they flip
to `decrypted` — visible live in terminal 2. You can also read it directly:

```bash
curl "http://localhost:42069/v1/addresses/<holder>/transfers"
curl "http://localhost:42069/v1/addresses/<holder>/balance"
```

Revoke the delegation again with:

```bash
pnpm run demo:revoke
```
