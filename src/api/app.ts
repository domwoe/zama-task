import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

import { deriveBalance, type DerivedBalance } from "../balance/derive.js";
import { SEPOLIA_CHAIN_ID } from "../config.js";
import { decryptionStatuses, transferKinds, type DecryptionStatus, type TransferKind } from "../types/lifecycle.js";
import type { TokenMetadata } from "./token.js";
import type { IndexerReadRepository, TransferDirection, TransferOrder } from "./repository.js";
import {
  decodeCursor,
  encodeCursor,
  isDecryptionStatus,
  isTransferDirection,
  isTransferKind,
  isTransferOrder,
  serializeTransfer,
} from "./serialization.js";

interface IndexerApiDependencies {
  readonly repository: IndexerReadRepository;
  readonly getTokenMetadata: () => Promise<TokenMetadata>;
  readonly getHeadBlock?: () => Promise<bigint | null>;
  readonly now?: () => Date;
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

interface ParsedTransferQuery {
  readonly resultType: "ok";
  readonly limit: number;
  readonly order: TransferOrder;
  readonly cursor: string | null;
  readonly direction?: TransferDirection;
  readonly kind?: TransferKind;
  readonly status?: DecryptionStatus;
}

interface ParsedTransferQueryError {
  readonly resultType: "error";
  readonly status: 400 | 413;
  readonly code: string;
  readonly message: string;
}

const defaultLimit = 50;
const maxLimit = 100;
const degradedLagBlocks = 20;
const unhealthyLagBlocks = 1_000;
const degradedOldestPendingSeconds = 300;
const unhealthyOldestPendingSeconds = 3_600;
const openApiYaml = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
const addressParamSchema = z.string().refine(isAddress);
const transferQuerySchema = z.object({
  cursor: z.string().optional(),
  direction: z.enum(["in", "out", "self"]).optional(),
  kind: z.enum(transferKinds).optional(),
  limit: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  status: z.enum(decryptionStatuses).optional(),
});

export const createIndexerApi = (dependencies: IndexerApiDependencies): Hono => {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date());

  app.notFound((context) => errorJson(context, 404, "NOT_FOUND", "Route not found"));

  app.onError((error, context) => {
    return errorJson(context, 500, "INTERNAL", error.message);
  });

  app.get("/v1/health/live", (context) => {
    return context.json({ status: "live" });
  });

  app.get("/v1/openapi.yaml", (context) => {
    return context.text(openApiYaml, 200, { "Content-Type": "application/yaml; charset=utf-8" });
  });

  app.get("/v1/token", async (context) => {
    return context.json(await dependencies.getTokenMetadata());
  });

  app.get("/v1/addresses/:address/balance", async (context) => {
    const address = parseAddress(context.req.param("address"));
    if (address === null) {
      return errorJson(context, 400, "INVALID_ADDRESS", "Address must be a valid EVM address");
    }

    const token = await dependencies.getTokenMetadata();
    const asOfBlock = await dependencies.repository.getAsOfBlock();
    const cached = await dependencies.repository.getCachedBalance(address, asOfBlock);
    if (cached !== null) {
      return context.json({
        address,
        balance: serializeBalance(cached),
        asOfBlock: serializeBlock(asOfBlock),
        asOfTime: now().toISOString(),
      });
    }

    const transfers = await dependencies.repository.listBalanceTransfers(address);
    const balance = deriveBalance({
      address,
      transfers,
      decimals: token.decimals,
      indexedBlock: asOfBlock,
    });
    if (balance.status === "exact") {
      await dependencies.repository.writeCachedBalance(address, balance, asOfBlock, now());
    }

    return context.json({
      address,
      balance: serializeBalance(balance),
      asOfBlock: serializeBlock(asOfBlock),
      asOfTime: now().toISOString(),
    });
  });

  app.get("/v1/addresses/:address/transfers", async (context) => {
    const address = parseAddress(context.req.param("address"));
    if (address === null) {
      return errorJson(context, 400, "INVALID_ADDRESS", "Address must be a valid EVM address");
    }

    const query = parseTransferQuery(context.req.query());
    if (query.resultType === "error") {
      return errorJson(context, query.status, query.code, query.message);
    }

    const token = await dependencies.getTokenMetadata();
    const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
    if (query.cursor !== null && cursor === null) {
      return errorJson(context, 400, "INVALID_CURSOR", "Cursor is malformed");
    }

    const page = await dependencies.repository.listAddressTransferPage(address, {
      cursor,
      limit: query.limit + 1,
      order: query.order,
      ...(query.direction === undefined ? {} : { direction: query.direction }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    if (page.cursorExpired) {
      return errorJson(context, 409, "CURSOR_EXPIRED", "Cursor anchor is no longer available");
    }

    const dataRows = page.rows.slice(0, query.limit);
    const lastRow = dataRows.at(-1);
    const hasMore = page.rows.length > query.limit;

    return context.json({
      data: dataRows.map((transfer) => serializeTransfer(transfer, { decimals: token.decimals, address })),
      page: {
        nextCursor:
          hasMore && lastRow !== undefined
            ? encodeCursor({ blockNumber: lastRow.blockNumber, logIndex: lastRow.logIndex })
            : null,
        hasMore,
      },
      asOfBlock: serializeBlock(await dependencies.repository.getAsOfBlock()),
    });
  });

  app.get("/v1/transfers/:id", async (context) => {
    const transfer = await dependencies.repository.getTransferById(context.req.param("id"));
    if (transfer === null) {
      return errorJson(context, 404, "NOT_FOUND", "Transfer not found");
    }

    const token = await dependencies.getTokenMetadata();
    return context.json({
      ...serializeTransfer(transfer, { decimals: token.decimals }),
      asOfBlock: serializeBlock(await dependencies.repository.getAsOfBlock()),
    });
  });

  app.get("/v1/health", async (context) => {
    const token = await dependencies.getTokenMetadata();
    const [checkpoint, headBlock, asOfBlock] = await Promise.all([
      dependencies.repository.getIndexerCheckpoint(),
      dependencies.getHeadBlock?.() ?? Promise.resolve(null),
      dependencies.repository.getAsOfBlock(),
    ]);
    const decryption = await dependencies.repository.getDecryptionHealth(now());
    const indexedBlock = checkpoint.indexedBlock ?? asOfBlock;
    const lagBlocks = headBlock === null || indexedBlock === null ? null : headBlock - indexedBlock;
    const lagSeconds =
      checkpoint.indexedBlockTimestamp === null
        ? null
        : Math.max(0, Math.floor((now().getTime() - checkpoint.indexedBlockTimestamp.getTime()) / 1_000));
    const status = healthStatus({ lagBlocks, decryption });

    return context.json(
      {
        status,
        chainId: SEPOLIA_CHAIN_ID,
        token: token.address,
        indexer: {
          headBlock: serializeBlock(headBlock),
          indexedBlock: serializeBlock(indexedBlock),
          lagBlocks: serializeBigintNumber(lagBlocks),
          lagSeconds,
        },
        decryption,
      },
      status === "unhealthy" ? 503 : 200,
    );
  });

  return app;
};

const parseAddress = (value: string): Address | null => {
  const parsed = addressParamSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return getAddress(parsed.data);
};

const parseTransferQuery = (
  query: Record<string, string | undefined>,
): ParsedTransferQuery | ParsedTransferQueryError => {
  const parsed = transferQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "query parameters are invalid" };
  }

  const limit = parsed.data.limit === undefined ? defaultLimit : Number.parseInt(parsed.data.limit, 10);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "limit must be a positive integer" };
  }

  if (limit > maxLimit) {
    return { resultType: "error", status: 413, code: "LIMIT_TOO_LARGE", message: `limit must be <= ${maxLimit.toString()}` };
  }

  const order = parsed.data.order ?? "desc";
  if (!isTransferOrder(order)) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "order must be asc or desc" };
  }

  if (parsed.data.direction !== undefined && !isTransferDirection(parsed.data.direction)) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "direction must be in, out, or self" };
  }

  if (parsed.data.kind !== undefined && !isTransferKind(parsed.data.kind)) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "kind is invalid" };
  }

  if (parsed.data.status !== undefined && !isDecryptionStatus(parsed.data.status)) {
    return { resultType: "error", status: 400, code: "INVALID_PARAM", message: "status is invalid" };
  }

  return {
    resultType: "ok",
    limit,
    order,
    cursor: parsed.data.cursor ?? null,
    ...(parsed.data.direction === undefined ? {} : { direction: parsed.data.direction }),
    ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
    ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
  };
};

const serializeBalance = (balance: DerivedBalance) => ({
  status: balance.status,
  confirmed:
    balance.confirmed === null
      ? null
      : {
          raw: balance.confirmed.raw,
          value: balance.confirmed.value,
          asOfBlock: serializeBlock(balance.confirmed.asOfBlock),
          source: balance.confirmed.source,
        },
  pending: {
    count: balance.pending.count,
    inbound: balance.pending.inbound,
    outbound: balance.pending.outbound,
    oldestBlock: serializeBlock(balance.pending.oldestBlock),
    byStatus: balance.pending.byStatus,
  },
  // Flat alias for simple consumers: the exact value, or null when unknown.
  value: balance.confirmed?.value ?? null,
});

const serializeBlock = (block: bigint | null): number | null => {
  if (block === null) {
    return null;
  }

  const value = Number(block);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Block number is outside the JSON safe integer range: ${block.toString()}`);
  }

  return value;
};

const serializeBigintNumber = (value: bigint | null): number | null => {
  if (value === null) {
    return null;
  }

  const serialized = Number(value);
  if (!Number.isSafeInteger(serialized)) {
    throw new Error(`Value is outside the JSON safe integer range: ${value.toString()}`);
  }

  return serialized;
};

const healthStatus = (input: {
  readonly lagBlocks: bigint | null;
  readonly decryption: Awaited<ReturnType<IndexerReadRepository["getDecryptionHealth"]>>;
}): "healthy" | "degraded" | "unhealthy" => {
  if (
    input.decryption.breakerState === "open" ||
    (input.lagBlocks !== null && input.lagBlocks > BigInt(unhealthyLagBlocks)) ||
    (input.decryption.oldestPendingSeconds !== null &&
      input.decryption.oldestPendingSeconds > unhealthyOldestPendingSeconds)
  ) {
    return "unhealthy";
  }

  if (
    input.decryption.breakerState === "halfOpen" ||
    input.decryption.failed > 0 ||
    (input.lagBlocks !== null && input.lagBlocks > BigInt(degradedLagBlocks)) ||
    (input.decryption.oldestPendingSeconds !== null &&
      input.decryption.oldestPendingSeconds > degradedOldestPendingSeconds)
  ) {
    return "degraded";
  }

  return "healthy";
};

const errorJson = (
  context: Parameters<Parameters<Hono["notFound"]>[0]>[0],
  status: 400 | 404 | 409 | 413 | 500,
  code: string,
  message: string,
) => {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      details: {},
    },
  };

  return context.json(body, status);
};
