import { Hono } from "hono";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

import { deriveBalance, type BalanceCheckpoint } from "../balance/derive.js";
import { SEPOLIA_CHAIN_ID } from "../config.js";
import type { Decryptor } from "../decryptor/decryptor.js";
import { decryptionStatuses, transferKinds, type DecryptionStatus, type TransferKind } from "../types/lifecycle.js";
import type { TokenMetadata } from "./token.js";
import type { IndexerReadRepository, TransferDirection, TransferOrder } from "./repository.js";
import {
  compareTransfer,
  decodeCursor,
  encodeCursor,
  filterAfterCursor,
  directionFor,
  isDecryptionStatus,
  isTransferDirection,
  isTransferKind,
  isTransferOrder,
  serializeTransfer,
} from "./serialization.js";

interface IndexerApiDependencies {
  readonly repository: IndexerReadRepository;
  readonly getTokenMetadata: () => Promise<TokenMetadata>;
  readonly decryptor?: Decryptor;
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

  app.get("/v1/token", async (context) => {
    return context.json(await dependencies.getTokenMetadata());
  });

  app.get("/v1/addresses/:address/balance", async (context) => {
    const address = parseAddress(context.req.param("address"));
    if (address === null) {
      return errorJson(context, 400, "INVALID_ADDRESS", "Address must be a valid EVM address");
    }

    const token = await dependencies.getTokenMetadata();
    const transfers = await dependencies.repository.listBalanceTransfers(address);
    const checkpoint = await loadCheckpoint(dependencies.decryptor, address);
    const balance = deriveBalance({
      address,
      transfers,
      decimals: token.decimals,
      checkpoint,
    });

    return context.json({
      address,
      balance,
      asOfBlock: serializeBlock(await dependencies.repository.getAsOfBlock()),
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
    const allTransfers = await dependencies.repository.listAddressTransfers(address);
    const sorted = allTransfers
      .filter((transfer) => query.direction === undefined || directionFor(address, transfer) === query.direction)
      .filter((transfer) => query.kind === undefined || transfer.kind === query.kind)
      .filter((transfer) => query.status === undefined || amountStatus(transfer) === query.status)
      .sort(compareTransfer(query.order));

    const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
    if (query.cursor !== null && cursor === null) {
      return errorJson(context, 400, "INVALID_CURSOR", "Cursor is malformed");
    }

    const afterCursor = cursor === null ? sorted : filterAfterCursor(sorted, cursor, query.order);
    if (cursor !== null && !sorted.some((transfer) => transfer.blockNumber === cursor.blockNumber && transfer.logIndex === cursor.logIndex)) {
      return errorJson(context, 409, "CURSOR_EXPIRED", "Cursor anchor is no longer available");
    }

    const pageRows = afterCursor.slice(0, query.limit + 1);
    const dataRows = pageRows.slice(0, query.limit);
    const lastRow = dataRows.at(-1);
    const hasMore = pageRows.length > query.limit;

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
    const decryption = await dependencies.repository.getDecryptionHealth(now());
    const status = decryption.breakerState === "open" ? "unhealthy" : "healthy";

    return context.json(
      {
        status,
        chainId: SEPOLIA_CHAIN_ID,
        token: token.address,
        indexer: {
          headBlock: null,
          indexedBlock: serializeBlock(await dependencies.repository.getAsOfBlock()),
          lagBlocks: null,
          lagSeconds: null,
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

const loadCheckpoint = async (
  decryptor: Decryptor | undefined,
  address: Address,
): Promise<BalanceCheckpoint | null> => {
  if (decryptor === undefined) {
    return null;
  }

  const outcome = await decryptor.decryptBalanceAs(address);
  return outcome.kind === "success" ? { cleartextRaw: outcome.cleartextRaw } : null;
};

const amountStatus = (transfer: Parameters<typeof serializeTransfer>[0]): DecryptionStatus => {
  if (transfer.disclosedRaw !== null) {
    return "decrypted";
  }

  return transfer.decryption?.status ?? "encrypted";
};

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
