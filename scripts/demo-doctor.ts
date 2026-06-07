import { createPublicClient, formatEther, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia } from "viem/chains";

import { erc20MintAbi, tokenReadAbi, wrapperUnderlyingAbi } from "./zama-demo-common.ts";

// Preflight for the Sepolia demo: validates .env, RPC connectivity, that the
// configured contracts exist, that the indexer key matches its address, and that
// the holder is funded — so a fresh clone fails fast with a clear reason instead
// of midway through demo:seed. Read-only: it never sends a transaction.

type Level = "ok" | "warn" | "fail";

interface Check {
  readonly level: Level;
  readonly label: string;
  readonly detail: string;
}

const SEPOLIA_CHAIN_ID = 11155111;
const MIN_HOLDER_ETH = 0.005;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const checks: Check[] = [];
const record = (level: Level, label: string, detail = ""): void => {
  checks.push({ level, label, detail });
};

const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

const requireAddress = (name: string): Address | null => {
  const value = readEnv(name);
  if (value === undefined) {
    record("fail", name, "missing");
    return null;
  }
  if (!isAddress(value)) {
    record("fail", name, `not a valid address: ${value}`);
    return null;
  }
  record("ok", name, getAddress(value));
  return getAddress(value);
};

const requirePrivateKey = (name: string): Hex | null => {
  const value = readEnv(name);
  if (value === undefined) {
    record("fail", name, "missing");
    return null;
  }
  if (!PRIVATE_KEY_RE.test(value)) {
    record("fail", name, "must be a 32-byte hex private key");
    return null;
  }
  record("ok", name, "set");
  return value as Hex;
};

const codeAt = async (
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  label: string,
): Promise<boolean> => {
  try {
    const code = await client.getCode({ address });
    if (code === undefined || code === "0x") {
      record("fail", label, `no contract code at ${address}`);
      return false;
    }
    return true;
  } catch (error) {
    record("fail", label, describeError(error));
    return false;
  }
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);

// --- Static env checks -------------------------------------------------------

const rpcUrl = readEnv("SEPOLIA_RPC_URL");
if (rpcUrl === undefined) {
  record("fail", "SEPOLIA_RPC_URL", "missing");
} else {
  record("ok", "SEPOLIA_RPC_URL", rpcUrl);
}

const tokenAddress = requireAddress("TOKEN_ADDRESS");
const aclAddress = requireAddress("FHEVM_ACL_ADDRESS");
const indexerAddress = requireAddress("INDEXER_ADDRESS");
const indexerKey = requirePrivateKey("INDEXER_PRIVATE_KEY");
const holderKey = requirePrivateKey("DEMO_HOLDER_PRIVATE_KEY");

if (readEnv("INDEXED_ADDRESSES") === undefined) {
  record("warn", "INDEXED_ADDRESSES", "unset — indexer will track every address on the token");
}

const recipient = readEnv("DEMO_RECIPIENT_ADDRESS");
if (recipient !== undefined && !isAddress(recipient)) {
  record("fail", "DEMO_RECIPIENT_ADDRESS", `not a valid address: ${recipient}`);
}

// Indexer key must derive the configured indexer address.
if (indexerKey !== null) {
  const derivedIndexer = privateKeyToAccount(indexerKey).address;
  if (indexerAddress !== null && derivedIndexer !== indexerAddress) {
    record(
      "fail",
      "INDEXER_PRIVATE_KEY / INDEXER_ADDRESS",
      `key derives ${derivedIndexer} but INDEXER_ADDRESS is ${indexerAddress}`,
    );
  } else if (indexerAddress !== null) {
    record("ok", "INDEXER_PRIVATE_KEY / INDEXER_ADDRESS", `match (${derivedIndexer})`);
  }
}

const holderAddress = holderKey === null ? null : privateKeyToAccount(holderKey).address;
if (holderAddress !== null) {
  record("ok", "holder (from DEMO_HOLDER_PRIVATE_KEY)", holderAddress);
}

// --- Network checks ----------------------------------------------------------

let underlying: Address | null = null;

if (rpcUrl !== undefined) {
  const client = createPublicClient({ chain: viemSepolia, transport: http(rpcUrl) });

  try {
    const chainId = await client.getChainId();
    const expected = Number.parseInt(readEnv("CHAIN_ID") ?? String(SEPOLIA_CHAIN_ID), 10);
    if (chainId === expected) {
      record("ok", "RPC chainId", String(chainId));
    } else {
      record("fail", "RPC chainId", `RPC reports ${String(chainId)}, expected ${String(expected)}`);
    }
  } catch (error) {
    record("fail", "RPC connectivity", describeError(error));
  }

  if (tokenAddress !== null && (await codeAt(client, tokenAddress, "TOKEN_ADDRESS code"))) {
    try {
      const [name, symbol, decimals] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: "name" }),
        client.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: "symbol" }),
        client.readContract({ address: tokenAddress, abi: tokenReadAbi, functionName: "decimals" }),
      ]);
      record("ok", "token metadata", `${name} (${symbol}), decimals=${String(decimals)}`);
      underlying = await client.readContract({
        address: tokenAddress,
        abi: wrapperUnderlyingAbi,
        functionName: "underlying",
      });
      record("ok", "underlying()", underlying);
    } catch (error) {
      record("fail", "token reads", describeError(error));
    }
  }

  if (underlying !== null) {
    await codeAt(client, underlying, "underlying code");
    if (holderAddress !== null) {
      try {
        await client.simulateContract({
          address: underlying,
          abi: erc20MintAbi,
          functionName: "mint",
          args: [holderAddress, 1n],
          account: holderAddress,
        });
        record("ok", "underlying mint()", "callable — demo:seed DEMO_MINT_AMOUNT will work");
      } catch (error) {
        record("warn", "underlying mint()", `not callable (${describeError(error)}); fund the holder manually`);
      }
    }
  }

  if (aclAddress !== null) {
    await codeAt(client, aclAddress, "FHEVM_ACL_ADDRESS code");
  }

  const fundingTargets: readonly (readonly [string, Address])[] = [
    ...(holderAddress === null ? [] : ([["holder", holderAddress]] as const)),
    ...(recipient !== undefined && isAddress(recipient)
      ? ([["recipient", getAddress(recipient)]] as const)
      : []),
  ];
  for (const [label, address] of fundingTargets) {
    try {
      const balance = await client.getBalance({ address });
      const eth = Number(formatEther(balance));
      if (eth >= MIN_HOLDER_ETH) {
        record("ok", `${label} ETH`, `${eth.toString()} ETH`);
      } else {
        record("warn", `${label} ETH`, `${eth.toString()} ETH — below ${MIN_HOLDER_ETH.toString()}, may not cover gas`);
      }
    } catch (error) {
      record("warn", `${label} ETH`, describeError(error));
    }
  }
}

// --- Report ------------------------------------------------------------------

const symbol: Record<Level, string> = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };
console.log("\nDemo preflight\n");
for (const check of checks) {
  console.log(`  ${symbol[check.level]} ${check.label}${check.detail === "" ? "" : `: ${check.detail}`}`);
}

const fails = checks.filter((check) => check.level === "fail").length;
const warns = checks.filter((check) => check.level === "warn").length;
console.log(`\n${fails === 0 ? "Ready" : `${String(fails)} problem(s)`}${warns === 0 ? "" : `, ${String(warns)} warning(s)`}.\n`);
if (fails > 0) {
  process.exitCode = 1;
}
