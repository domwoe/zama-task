import { db, publicClients } from "ponder:api";
import { getAddress, isAddress, type Address } from "viem";

import { confidentialTokenWithWrapperAbi } from "../abi/confidential-token.js";
import { env } from "../config.js";
import type { Decryptor } from "../decryptor/decryptor.js";
import { FakeDecryptor } from "../decryptor/fake-decryptor.js";
import { createRealZamaDecryptor } from "../decryptor/real-zama-decryptor.js";
import { DecryptionDrainer, startDecryptionDrainer } from "../drainer/drainer.js";
import { RawSqlSideTableRepository } from "./raw-sql-repository.js";
import { createIndexerApi } from "./app.js";
import type { TokenMetadata } from "./token.js";

const LOCAL_ANVIL_CHAIN_ID = 31_337;

const repository = new RawSqlSideTableRepository(db);

const decryptor = createDecryptor();

function createDecryptor(): Decryptor {
  if (env.decryptorMode === "real") {
    return createRealZamaDecryptor(repository);
  }

  if (env.chainId !== LOCAL_ANVIL_CHAIN_ID) {
    throw new Error("DECRYPTOR_MODE=fake is only supported for local Anvil chain 31337");
  }

  const handle = env.fakeDecryptorHandle;
  const cleartext = env.fakeDecryptorCleartext;
  const accounts = parseFakeDecryptorAccounts(env.fakeDecryptorAccounts);
  if (handle === undefined || cleartext === undefined || accounts.size === 0) {
    throw new Error(
      "DECRYPTOR_MODE=fake requires FAKE_DECRYPTOR_HANDLE, FAKE_DECRYPTOR_CLEARTEXT, and FAKE_DECRYPTOR_ACCOUNTS",
    );
  }

  return new FakeDecryptor({
    handles: new Map([
      [
        handle,
        {
          cleartext: BigInt(cleartext),
          allowedAccounts: accounts,
        },
      ],
    ]),
    delegatedAccounts: accounts,
  });
}

function parseFakeDecryptorAccounts(value: string | undefined): ReadonlySet<Address> {
  if (value === undefined) {
    return new Set<Address>();
  }

  const accounts = value
    .split(",")
    .map((account) => account.trim())
    .filter((account) => account.length > 0)
    .map((account) => {
      if (!isAddress(account)) {
        throw new Error(`Invalid FAKE_DECRYPTOR_ACCOUNTS address: ${account}`);
      }

      return getAddress(account);
    });

  return new Set(accounts);
}

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
  onError(error: unknown) {
    console.error("Decryption drainer iteration failed", error);
  },
  onResult(result) {
    if (env.zamaSdkLogLevel === "debug") {
      console.log("[zama-drainer:debug] iteration", result);
    }
  },
});
runningDrainer.done.catch((error: unknown) => {
  console.error("Decryption drainer stopped", error);
});

const stopDrainer = (): void => {
  runningDrainer.stop().catch((error: unknown) => {
    console.error("Failed to stop decryption drainer", error);
  });
  if (isDisposableDecryptor(decryptor)) {
    decryptor[Symbol.dispose]();
  }
};

function isDisposableDecryptor(value: Decryptor): value is Decryptor & { [Symbol.dispose]: () => void } {
  return Symbol.dispose in value && typeof value[Symbol.dispose] === "function";
}

process.once("SIGINT", stopDrainer);
process.once("SIGTERM", stopDrainer);

export default createIndexerApi({
  repository,
  getTokenMetadata,
  getHeadBlock: () => publicClients.sepolia.getBlockNumber(),
});
