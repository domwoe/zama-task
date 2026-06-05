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
