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
cp .env.example .env
```

Fill `.env` with the watched token, fhEVM ACL address, indexer EOA address/private
key, and a Sepolia RPC URL. Do not use production funds, production data, or
shared secrets.

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

## Sepolia Demo

Use toy Sepolia keys only. `TOKEN_ADDRESS` is the ERC-7984 wrapper watched by the
indexer. `DEMO_HOLDER_PRIVATE_KEY` is the holder that shields, transfers, and
grants delegation to `INDEXER_ADDRESS`.

```bash
pnpm run demo:seed
```

Set any of `DEMO_SHIELD_AMOUNT`, `DEMO_TRANSFER_AMOUNT`, and
`DEMO_UNSHIELD_AMOUNT` to a base-unit integer string to run that operation. The
transfer step also requires `DEMO_RECIPIENT_ADDRESS`.

The expected indexer arc is:

```bash
curl "http://localhost:42069/v1/addresses/<holder-address-printed-by-demo-seed>/transfers"
pnpm run demo:delegate
```

After the delegation transaction is mined, the Zama gateway can take 1-2 minutes
to observe the ACL event. The drainer then pulls previously `unauthorized` rows
forward and they should flip to `decrypted`.

```bash
pnpm run demo:revoke
```
