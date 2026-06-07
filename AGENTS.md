# AGENTS.md

## Repository Context

- The target artifact is a small TypeScript Node service that indexes one ERC-7984 confidential token contract, preserves undecryptable events, decrypts when entitled, exposes cleartext read APIs, and includes light tests.
- Do not use production data, real funds, or shared secrets. Use toy values, local/testnet keys, and `.env.example` only.

## Documentation Lookup

- Use the `ctx7` CLI to fetch current documentation whenever the task asks about a library, framework, SDK, API, CLI tool, or cloud service. Except `@zama-fhe`
- First resolve the library with `npx ctx7@latest library <name> "<user's full question>"`; then fetch docs with `npx ctx7@latest docs <libraryId> "<user's full question>"`.
- Pick the best library match by exact name, description relevance, snippet count, source reputation, and benchmark score. Retry with an alternate name or query if results are clearly wrong.
- Do not run more than three Context7 commands per question. Do not include secrets in Context7 queries.

## Constraints

- Install the high-level SDK from the alpha channel: `pnpm add @zama-fhe/sdk@alpha`.
- For Zama SDK docs, use the `zama-ai/sdk` prerelease branch (https://github.com/zama-ai/sdk/tree/prerelease) and examples; stable public docs may lag the alpha package.
- Relevant example is https://github.com/zama-ai/sdk/tree/prerelease/examples/node-viem
- Use `@zama-fhe/sdk`, not the legacy `@zama-fhe/relayer-sdk` except where it appears as a wrapped dependency.

## TypeScript Workflow

- Keep TypeScript strict and ESM-first. Use the existing `tsconfig.json` and `eslint.config.js` instead of weakening checks locally.
- Avoid `any`, unsafe casts, dropped promises, and non-exhaustive switches. Model uncertain external data as `unknown` and validate/narrow at boundaries.
- Use type-only imports for types, string amounts for token/base-unit values, and explicit status unions for encrypted/decrypted lifecycle states.
- After changing TypeScript, config, or generated API shapes, run `pnpm run check` or explain why it could not run.

## Verification

- Add or update tests when implementation behavior changes.
- At minimum, preserve one happy-path test for event-to-cleartext API output and one negative-path test for an undecryptable or not-yet-authorized event.
