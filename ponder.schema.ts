import { onchainTable } from "ponder";

import type { DisclosedSource, TransferKind, UnwrapStatus } from "./src/types/lifecycle.js";

export const transfers = onchainTable("transfers", (p) => ({
  id: p.text().primaryKey(),
  txHash: p.hex().notNull(),
  blockNumber: p.bigint().notNull(),
  logIndex: p.integer().notNull(),
  timestamp: p.bigint().notNull(),
  from: p.hex().notNull(),
  to: p.hex().notNull(),
  kind: p.text().notNull().$type<TransferKind>(),
  amountHandle: p.hex().notNull(),
  unwrapRequestId: p.hex(),
  disclosedRaw: p.text(),
  disclosedSource: p.text().$type<DisclosedSource>(),
}));

export const unwraps = onchainTable("unwraps", (p) => ({
  unwrapRequestId: p.hex().primaryKey(),
  receiver: p.hex().notNull(),
  amountHandle: p.hex().notNull(),
  status: p.text().notNull().$type<UnwrapStatus>(),
  cleartextRaw: p.text(),
  requestedBlock: p.bigint().notNull(),
  finalizedBlock: p.bigint(),
}));

export const delegations = onchainTable("delegations", (p) => ({
  id: p.text().primaryKey(),
  delegator: p.hex().notNull(),
  delegate: p.hex().notNull(),
  contractAddress: p.hex().notNull(),
  expiry: p.bigint().notNull(),
  lastEventBlock: p.bigint().notNull(),
}));
