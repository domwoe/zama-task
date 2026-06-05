import { db, publicClients } from "ponder:api";

import { confidentialTokenWithWrapperAbi } from "../abi/confidential-token.js";
import { env } from "../config.js";
import { FakeDecryptor } from "../decryptor/fake-decryptor.js";
import { createRealZamaDecryptor } from "../decryptor/real-zama-decryptor.js";
import { DecryptionDrainer, startDecryptionDrainer } from "../drainer/drainer.js";
import { RawSqlSideTableRepository } from "./raw-sql-repository.js";
import { createIndexerApi } from "./app.js";
import type { TokenMetadata } from "./token.js";

// Fixed handle and cleartext used by integration tests (DECRYPTOR_MODE=fake).
// Any bytes32 value emitted by MockToken.emitTransfer will be recognised here.
export const TEST_HANDLE =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
export const TEST_CLEARTEXT = 12_000_000n;

const repository = new RawSqlSideTableRepository(db);

const decryptor =
  env.decryptorMode === "fake"
    ? new FakeDecryptor({
        handles: new Map([
          [
            TEST_HANDLE,
            {
              cleartext: TEST_CLEARTEXT,
              // All Anvil-funded test accounts are pre-authorised as delegators.
              allowedAccounts: new Set([
                "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
                "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
              ]),
            },
          ],
        ]),
        // delegatedAccounts mirrors allowedAccounts — the drainer already checks the
        // on-chain delegation state via listActiveDelegators before calling decrypt,
        // but FakeDecryptor requires the set to be non-empty to return success.
        delegatedAccounts: new Set([
          "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
          "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        ]),
      })
    : createRealZamaDecryptor(repository);

let tokenMetadataPromise: Promise<TokenMetadata> | undefined;

const loadTokenMetadata = async (): Promise<TokenMetadata> => {
  const [name, symbol, decimals, underlying] = await Promise.all([
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "name",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "symbol",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "decimals",
    }),
    publicClients.sepolia.readContract({
      address: env.tokenAddress,
      abi: confidentialTokenWithWrapperAbi,
      functionName: "underlying",
    }),
  ]);

  return {
    chainId: env.chainId,
    address: env.tokenAddress,
    name,
    symbol,
    decimals,
    kind: "erc7984-erc20-wrapper",
    underlying,
  };
};

const getTokenMetadata = (): Promise<TokenMetadata> => {
  tokenMetadataPromise ??= loadTokenMetadata();
  return tokenMetadataPromise;
};

await repository.initSideTables();

const drainer = new DecryptionDrainer({
  store: repository,
  decryptor,
  indexerAddress: env.indexerAddress,
  tokenAddress: env.tokenAddress,
  batchSize: env.decryptBatchSize,
  concurrency: env.decryptConcurrency,
});
const runningDrainer = startDecryptionDrainer(drainer, {
  intervalMs: env.decryptPollMs,
});
runningDrainer.done.catch((error: unknown) => {
  console.error("Decryption drainer stopped", error);
});

const stopDrainer = (): void => {
  runningDrainer.stop().catch((error: unknown) => {
    console.error("Failed to stop decryption drainer", error);
  });
};

process.once("SIGINT", stopDrainer);
process.once("SIGTERM", stopDrainer);

export default createIndexerApi({
  repository,
  getTokenMetadata,
  getHeadBlock: () => publicClients.sepolia.getBlockNumber(),
  decryptor,
});
