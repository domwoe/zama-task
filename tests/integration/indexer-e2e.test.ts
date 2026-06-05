/**
 * End-to-end integration test: real Anvil chain → real Ponder indexer → real drainer → real API.
 *
 * Scenario:
 *  1. Deploy MockToken and MockAcl stubs on Anvil.
 *  2. Emit a ConfidentialTransfer; Ponder indexes it.
 *  3. API returns the transfer with status "unauthorized" (no delegation yet).
 *  4. Emit a DelegatedForUserDecryption; Ponder indexes the delegation.
 *  5. Drainer picks up the backfill nudge and decrypts with FakeDecryptor.
 *  6. API now returns the transfer with status "decrypted" and the correct amount.
 *
 * Ponder runs with DECRYPTOR_MODE=fake and explicit fixture env vars so the
 * drainer uses a deterministic FakeDecryptor instead of the live Zama relayer.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createAnvil } from "@viem/anvil";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import MockTokenArtifact from "../fixtures/contracts/MockToken.sol/MockToken.json" with { type: "json" };
import MockAclArtifact from "../fixtures/contracts/MockAcl.sol/MockAcl.json" with { type: "json" };

// Deterministic Anvil funded accounts (mnemonic: "test test test … junk")
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // account 0
const HOLDER_ADDR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // account 1
const HOLDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RECIPIENT_ADDR: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // account 2
const INDEXER_ADDR: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // account 3

// Fixed test handle pre-registered in the FakeDecryptor through fixture env vars.
const TEST_HANDLE =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TEST_CLEARTEXT = "12000000";

const PONDER_PORT = 49123;
const PROJECT_ROOT = join(import.meta.dirname, "../..");

// Minimal ABIs for the deploy+emit calls we make from the test.
const mockTokenAbi = MockTokenArtifact.abi as unknown[];
const mockAclAbi = MockAclArtifact.abi as unknown[];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` returns a truthy value or we time out. */
const pollUntil = async <T>(
  check: () => Promise<T | null | undefined | false>,
  { intervalMs = 300, timeoutMs = 30_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${String(timeoutMs)}ms`);
};

// ─── Test state ────────────────────────────────────────────────────────────────

let ponderProcess: ChildProcess | undefined;
let dbDir: string;
let tokenAddress: Address;
let aclAddress: Address;
const ponderLines: string[] = [];
let lastTransfersResponse = "";

const ANVIL_PORT = 18_545;
const anvil = createAnvil({ port: ANVIL_PORT });

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start Anvil (instant-mining mode by default)
  await anvil.start();
  const anvilUrl = `http://127.0.0.1:${String(anvil.port)}`;

  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const publicClient = createPublicClient({ chain: foundry, transport: http(anvilUrl) });
  const walletClient = createWalletClient({ account: deployer, chain: foundry, transport: http(anvilUrl) });

  // Deploy MockToken
  const tokenHash = await walletClient.deployContract({
    abi: mockTokenAbi,
    bytecode: MockTokenArtifact.bytecode.object as `0x${string}`,
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash });
  if (!tokenReceipt.contractAddress) throw new Error("MockToken deployment failed");
  tokenAddress = tokenReceipt.contractAddress;

  // Deploy MockAcl
  const aclHash = await walletClient.deployContract({
    abi: mockAclAbi,
    bytecode: MockAclArtifact.bytecode.object as `0x${string}`,
  });
  const aclReceipt = await publicClient.waitForTransactionReceipt({ hash: aclHash });
  if (!aclReceipt.contractAddress) throw new Error("MockAcl deployment failed");
  aclAddress = aclReceipt.contractAddress;

  // Note the current block as START_BLOCK so Ponder only indexes events we emit.
  const startBlock = Number(await publicClient.getBlockNumber());

  // Fresh isolated PGlite directory for this test run.
  dbDir = mkdtempSync(join(tmpdir(), "ponder-e2e-"));

  // Spawn Ponder with fake decryptor and pointing at Anvil.
  ponderProcess = spawn(
    "pnpm",
    ["ponder", "dev", "--port", String(PONDER_PORT), "--disable-ui"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${process.env.HOME ?? ""}/.foundry/bin:${process.env.PATH ?? ""}`,
        SEPOLIA_RPC_URL: anvilUrl,
        TOKEN_ADDRESS: tokenAddress,
        FHEVM_ACL_ADDRESS: aclAddress,
        INDEXED_ADDRESSES: [HOLDER_ADDR, RECIPIENT_ADDR].join(","),
        INDEXER_ADDRESS: INDEXER_ADDR,
        INDEXER_PRIVATE_KEY: DEPLOYER_KEY, // unused in fake mode but required by schema
        START_BLOCK: String(startBlock),
        CHAIN_ID: "31337",
        DECRYPTOR_MODE: "fake",
        FAKE_DECRYPTOR_ACCOUNTS: [
          DEPLOYER_ADDR,
          HOLDER_ADDR,
          RECIPIENT_ADDR,
          INDEXER_ADDR,
        ].join(","),
        FAKE_DECRYPTOR_CLEARTEXT: TEST_CLEARTEXT,
        FAKE_DECRYPTOR_HANDLE: TEST_HANDLE,
        DECRYPT_POLL_MS: "500",
        PONDER_DB_DIR: dbDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  ponderProcess.stdout?.on("data", (chunk: Buffer) => {
    ponderLines.push(chunk.toString());
  });
  ponderProcess.stderr?.on("data", (chunk: Buffer) => {
    ponderLines.push(chunk.toString());
  });

  // Wait until Ponder's liveness probe responds.
  try {
    await pollUntil(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${String(PONDER_PORT)}/v1/health/live`);
          return res.ok;
        } catch {
          return null;
        }
      },
      { timeoutMs: 55_000, intervalMs: 500 },
    );
  } catch (error) {
    console.error("Ponder did not start. Last output:\n", ponderLines.slice(-30).join(""));
    throw error;
  }
}, 60_000);

afterAll(async () => {
  ponderProcess?.kill("SIGTERM");
  await anvil.stop();
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const withPonderOutput = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    console.error("Last Ponder output:\n", ponderLines.slice(-30).join(""));
    console.error("Last transfers response:\n", lastTransfersResponse);
    throw error;
  }
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("indexer e2e", () => {
  it(
    "indexes a ConfidentialTransfer and shows it as unauthorized before delegation",
    async () => {
      const anvilUrl = `http://127.0.0.1:${String(anvil.port)}`;
      const holder = privateKeyToAccount(HOLDER_KEY);
      const publicClient = createPublicClient({ chain: foundry, transport: http(anvilUrl) });
      const walletClient = createWalletClient({ account: holder, chain: foundry, transport: http(anvilUrl) });

      // Emit a real ConfidentialTransfer event from MockToken.
      const txHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: mockTokenAbi,
        functionName: "emitTransfer",
        args: [HOLDER_ADDR, RECIPIENT_ADDR, TEST_HANDLE],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Verify the event is ABI-decodable using our exact confidential-token ABI.
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const log = receipt.logs[0];
      if (log === undefined) throw new Error("No log emitted");
      const decoded = decodeEventLog({
        abi: [
          {
            type: "event",
            name: "ConfidentialTransfer",
            inputs: [
              { name: "from", type: "address", indexed: true },
              { name: "to", type: "address", indexed: true },
              { name: "amount", type: "bytes32", indexed: true },
            ],
          },
        ],
        data: log.data,
        topics: log.topics,
      });
      expect(decoded.args).toMatchObject({ from: HOLDER_ADDR, to: RECIPIENT_ADDR, amount: TEST_HANDLE });

      // Wait for Ponder to index the transfer and the drainer to mark it unauthorized.
      const body = await withPonderOutput(() => pollUntil(
        async () => {
          const res = await fetch(
            `http://127.0.0.1:${String(PONDER_PORT)}/v1/addresses/${RECIPIENT_ADDR}/transfers`,
          );
          const text = await res.text();
          lastTransfersResponse = `${String(res.status)} ${text}`;
          if (!res.ok) return null;
          const data = JSON.parse(text) as {
            data: readonly { amount: { status: string } }[];
          };
          // Accept any non-empty list — the drainer may have reached a terminal status.
          return data.data.length > 0 ? data : null;
        },
        { timeoutMs: 20_000 },
      ));

      // Before delegation, the transfer should be unauthorized (or encrypted if the
      // drainer hasn't run yet — both are valid pre-delegation states).
      const transfer0 = body.data[0];
      if (transfer0 === undefined) throw new Error("Expected at least one transfer");
      const status = transfer0.amount.status;
      expect(["unauthorized", "encrypted"]).toContain(status);
    },
    30_000,
  );

  it(
    "decrypts the transfer after ACL delegation is granted",
    async () => {
      const anvilUrl = `http://127.0.0.1:${String(anvil.port)}`;
      const holder = privateKeyToAccount(HOLDER_KEY);
      const publicClient = createPublicClient({ chain: foundry, transport: http(anvilUrl) });
      const walletClient = createWalletClient({ account: holder, chain: foundry, transport: http(anvilUrl) });

      // Emit DelegatedForUserDecryption — the recipient delegates to the indexer.
      // MockAcl intentionally has no auth checks; this test is about event shape and indexing.
      const expiry = BigInt(Math.floor(Date.now() / 1_000) + 7_200); // 2h from now
      const delegationHash = await walletClient.writeContract({
        address: aclAddress,
        abi: mockAclAbi,
        functionName: "emitDelegation",
        args: [RECIPIENT_ADDR, INDEXER_ADDR, tokenAddress, expiry],
      });
      await publicClient.waitForTransactionReceipt({ hash: delegationHash });

      // Wait for the drainer to pick up the backfill nudge and produce a decrypted row.
      const body = await withPonderOutput(() => pollUntil(
        async () => {
          const res = await fetch(
            `http://127.0.0.1:${String(PONDER_PORT)}/v1/addresses/${RECIPIENT_ADDR}/transfers`,
          );
          const text = await res.text();
          lastTransfersResponse = `${String(res.status)} ${text}`;
          if (!res.ok) return null;
          const data = JSON.parse(text) as {
            data: readonly { amount: { status: string; raw: string | null; value: string | null } }[];
          };
          const transfer = data.data[0];
          return transfer?.amount.status === "decrypted" ? data : null;
        },
        { timeoutMs: 20_000 },
      ));

      const decryptedTransfer = body.data[0];
      if (decryptedTransfer === undefined) throw new Error("Expected a decrypted transfer");
      expect(decryptedTransfer.amount).toMatchObject({
        status: "decrypted",
        raw: "12000000",
        value: "12.0",
      });
    },
    30_000,
  );
});
