import { eq } from "ponder";
import { ponder } from "ponder:registry";
import { delegations, transfers, unwraps } from "ponder:schema";
import { getAddress, zeroAddress } from "viem";

import { confidentialTokenWithWrapperAbi } from "./abi/confidential-token.js";
import { underlyingToWrappedRaw } from "./balance/rate.js";
import { env } from "./config.js";
import type { TransferKind } from "./types/lifecycle.js";

const transferId = (txHash: `0x${string}`, logIndex: number): string => {
  return `${txHash}-${logIndex.toString()}`;
};

const delegationId = (
  delegator: `0x${string}`,
  delegate: `0x${string}`,
  contractAddress: `0x${string}`,
): string => {
  return `${delegator}:${delegate}:${contractAddress}`;
};

const transferKind = (from: `0x${string}`, to: `0x${string}`): TransferKind => {
  if (from === zeroAddress) {
    return "shield";
  }

  if (to === zeroAddress) {
    return "unshield";
  }

  return "transfer";
};

const sameAddress = (left: `0x${string}`, right: `0x${string}`): boolean => {
  return getAddress(left) === getAddress(right);
};

ponder.on("ConfidentialToken:ConfidentialTransfer", async ({ event, context }) => {
  const id = transferId(event.transaction.hash, event.log.logIndex);

  await context.db
    .insert(transfers)
    .values({
      id,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      from: event.args.from,
      to: event.args.to,
      kind: transferKind(event.args.from, event.args.to),
      amountHandle: event.args.amount,
    })
    .onConflictDoUpdate({
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      from: event.args.from,
      to: event.args.to,
      kind: transferKind(event.args.from, event.args.to),
      amountHandle: event.args.amount,
    });
});

ponder.on("ConfidentialToken:AmountDisclosed", async ({ event, context }) => {
  await context.db.sql
    .update(transfers)
    .set({
      disclosedRaw: event.args.amount.toString(),
      disclosedSource: "disclosed",
    })
    .where(eq(transfers.amountHandle, event.args.encryptedAmount));
});

ponder.on("ConfidentialToken:UnwrapRequested", async ({ event, context }) => {
  await context.db
    .insert(unwraps)
    .values({
      unwrapRequestId: event.args.unwrapRequestId,
      receiver: event.args.receiver,
      amountHandle: event.args.amount,
      status: "requested",
      requestedBlock: event.block.number,
    })
    .onConflictDoUpdate({
      receiver: event.args.receiver,
      amountHandle: event.args.amount,
      status: "requested",
      requestedBlock: event.block.number,
    });

  await context.db.sql
    .update(transfers)
    .set({ unwrapRequestId: event.args.unwrapRequestId })
    .where(eq(transfers.amountHandle, event.args.amount));
});

ponder.on("ConfidentialToken:UnwrapFinalized", async ({ event, context }) => {
  const rate = await context.client.readContract({
    address: env.tokenAddress,
    abi: confidentialTokenWithWrapperAbi,
    functionName: "rate",
    blockNumber: event.block.number,
  });
  const wrappedCleartextRaw = underlyingToWrappedRaw(event.args.cleartextAmount, rate);

  await context.db
    .insert(unwraps)
    .values({
      unwrapRequestId: event.args.unwrapRequestId,
      receiver: event.args.receiver,
      amountHandle: event.args.encryptedAmount,
      status: "finalized",
      cleartextRaw: wrappedCleartextRaw,
      requestedBlock: event.block.number,
      finalizedBlock: event.block.number,
    })
    .onConflictDoUpdate({
      receiver: event.args.receiver,
      amountHandle: event.args.encryptedAmount,
      status: "finalized",
      cleartextRaw: wrappedCleartextRaw,
      finalizedBlock: event.block.number,
    });

  await context.db.sql
    .update(transfers)
    .set({
      amountHandle: event.args.encryptedAmount,
      disclosedRaw: wrappedCleartextRaw,
      disclosedSource: "disclosed",
    })
    .where(eq(transfers.unwrapRequestId, event.args.unwrapRequestId));
});

ponder.on("FhevmAcl:DelegatedForUserDecryption", async ({ event, context }) => {
  // contractAddress is non-indexed, so the log filter can't scope it — only keep
  // delegations granted for the token this indexer watches.
  if (!sameAddress(event.args.contractAddress, env.tokenAddress)) {
    return;
  }

  const id = delegationId(event.args.delegator, event.args.delegate, event.args.contractAddress);
  const expiry = event.args.newExpirationDate;

  await context.db
    .insert(delegations)
    .values({
      id,
      delegator: event.args.delegator,
      delegate: event.args.delegate,
      contractAddress: event.args.contractAddress,
      expiry,
      lastEventBlock: event.block.number,
    })
    .onConflictDoUpdate({
      delegator: event.args.delegator,
      delegate: event.args.delegate,
      contractAddress: event.args.contractAddress,
      expiry,
      lastEventBlock: event.block.number,
    });
});
