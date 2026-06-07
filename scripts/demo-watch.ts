import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

// Live, read-only view of the indexer for the demo: polls the partner read API and
// redraws balance + transfer status for the watched address(es) plus indexer/
// decryption health, highlighting rows whose decryption status changed since the
// last tick — so the encrypted/unauthorized → decrypted backfill flip is visible
// in the terminal. Pure API consumer: no SDK, no keys, no chain access.
//
// Usage: pnpm demo:watch [address ...]
//   addresses default to INDEXED_ADDRESSES; API base from API_BASE_URL.

const apiBase = (process.env.API_BASE_URL ?? "http://localhost:42069").replace(/\/+$/, "");
const intervalMs = Number.parseInt(process.env.WATCH_INTERVAL_MS ?? "4000", 10);

const addresses = resolveAddresses();
if (addresses.length === 0) {
  console.error("No addresses to watch. Pass them as arguments or set INDEXED_ADDRESSES.");
  process.exit(1);
}

function resolveAddresses(): readonly Address[] {
  const fromArgs = process.argv.slice(2);
  const fromEnv = (process.env.INDEXED_ADDRESSES ?? "").split(",");
  const candidates = (fromArgs.length > 0 ? fromArgs : fromEnv).map((value) => value.trim()).filter((value) => value.length > 0);
  const valid: Address[] = [];
  for (const candidate of candidates) {
    if (!isAddress(candidate)) {
      console.error(`Ignoring invalid address: ${candidate}`);
      continue;
    }
    valid.push(getAddress(candidate));
  }
  return valid;
}

const amountSchema = z.object({
  status: z.string(),
  value: z.string().nullable(),
});

const transferSchema = z.object({
  id: z.string(),
  direction: z.string().optional(),
  kind: z.string(),
  amount: amountSchema,
});

const transfersResponseSchema = z.object({
  data: z.array(transferSchema),
});

const balanceResponseSchema = z.object({
  balance: z.object({
    status: z.string(), // exact | as_of | unknown
    value: z.string().nullable(), // flat alias = confirmed.value, or null
    confirmed: z.object({ asOfBlock: z.number().nullable() }).nullable(),
    pending: z.object({
      count: z.number(),
      inbound: z.number(),
      outbound: z.number(),
      byStatus: z.record(z.string(), z.number()),
    }),
  }),
});

const healthResponseSchema = z.object({
  status: z.string(),
  indexer: z.object({
    headBlock: z.number().nullable(),
    indexedBlock: z.number().nullable(),
    lagBlocks: z.number().nullable(),
    lagSeconds: z.number().nullable(),
  }),
  decryption: z.object({
    pending: z.number(),
    unauthorized: z.number(),
    failed: z.number(),
    oldestPendingSeconds: z.number().nullable(),
    breakerState: z.string(),
  }),
});

const tokenResponseSchema = z.object({ symbol: z.string() });

const fetchJson = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetch(`${apiBase}${path}`);
  const raw: unknown = await response.json();
  return schema.parse(raw);
};

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const statusColor: Record<string, string> = {
  decrypted: "\x1b[32m",
  encrypted: "\x1b[90m",
  pending: "\x1b[33m",
  unauthorized: "\x1b[35m",
  failed: "\x1b[31m",
};
const healthColor: Record<string, string> = { healthy: "\x1b[32m", degraded: "\x1b[33m", unhealthy: "\x1b[31m" };

const color = (text: string, code: string): string => `${code}${text}${RESET}`;
const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));

// transfer id -> last seen status, to highlight flips between ticks.
const previousStatus = new Map<string, string>();

let symbol = "";

const renderOnce = async (): Promise<void> => {
  if (symbol === "") {
    symbol = (await fetchJson("/v1/token", tokenResponseSchema)).symbol;
  }
  const health = await fetchJson("/v1/health", healthResponseSchema);

  const lines: string[] = [];
  const hc = healthColor[health.status] ?? RESET;
  lines.push(
    `${BOLD}${symbol}${RESET}  health ${color("●", hc)} ${health.status}` +
      `   indexer lag ${fmt(health.indexer.lagBlocks)}blk / ${fmt(health.indexer.lagSeconds)}s` +
      ` (head ${fmt(health.indexer.headBlock)} idx ${fmt(health.indexer.indexedBlock)})`,
  );
  lines.push(
    `${DIM}decryption${RESET}  pending ${String(health.decryption.pending)}` +
      `  unauthorized ${String(health.decryption.unauthorized)}` +
      `  failed ${String(health.decryption.failed)}` +
      `  oldestPending ${fmt(health.decryption.oldestPendingSeconds)}s` +
      `  breaker ${health.decryption.breakerState}`,
  );

  for (const address of addresses) {
    const [balance, transfers] = await Promise.all([
      fetchJson(`/v1/addresses/${address}/balance`, balanceResponseSchema),
      fetchJson(`/v1/addresses/${address}/transfers?limit=15`, transfersResponseSchema),
    ]);

    lines.push("");
    const b = balance.balance;
    const balanceText = b.value === null ? color("unknown", DIM) : `${b.value} ${symbol}`;
    const tags: string[] = [b.status];
    if (b.status === "as_of" && b.confirmed?.asOfBlock != null) {
      tags.push(`as of blk ${String(b.confirmed.asOfBlock)}`);
    }
    if (b.pending.count > 0) {
      let pendingText = `${String(b.pending.count)} pending (${String(b.pending.inbound)} in / ${String(b.pending.outbound)} out)`;
      if ((b.pending.byStatus.unauthorized ?? 0) > 0) {
        pendingText += color(" · needs delegation", "\x1b[35m");
      }
      tags.push(pendingText);
    }
    lines.push(`${BOLD}${address}${RESET}  balance ${balanceText}  [${tags.join(" · ")}]`);

    if (transfers.data.length === 0) {
      lines.push(`  ${DIM}(no transfers yet)${RESET}`);
      continue;
    }

    for (const transfer of transfers.data) {
      const sc = statusColor[transfer.amount.status] ?? RESET;
      const previous = previousStatus.get(transfer.id);
      const flipped = previous !== undefined && previous !== transfer.amount.status;
      const marker = flipped ? color("→", "\x1b[32m") : " ";
      const flipNote = flipped ? color(`  (${previous} → ${transfer.amount.status})`, "\x1b[32m") : "";
      lines.push(
        `  ${marker} ${color(pad(transfer.amount.status, 13), sc)}` +
          ` ${pad(transfer.direction ?? "-", 4)} ${pad(transfer.kind, 10)}` +
          ` ${pad(transfer.amount.value ?? "—", 12)}` +
          ` ${DIM}${transfer.id.slice(0, 18)}…${RESET}${flipNote}`,
      );
      previousStatus.set(transfer.id, transfer.amount.status);
    }
  }

  lines.push("");
  lines.push(`${DIM}${new Date().toISOString()} · polling ${apiBase} every ${String(intervalMs)}ms · Ctrl-C to stop${RESET}`);

  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
};

const fmt = (value: number | null): string => (value === null ? "?" : String(value));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

process.on("SIGINT", () => {
  console.log();
  process.exit(0);
});

for (;;) {
  try {
    await renderOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`\x1b[2J\x1b[H${color(`Cannot reach indexer API at ${apiBase}`, "\x1b[31m")}\n${DIM}${message}${RESET}\n${DIM}Is \`pnpm dev\` running? Retrying…${RESET}\n`);
  }
  await sleep(intervalMs);
}
