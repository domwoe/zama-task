import {
  balanceTrustLevels,
  breakerStates,
  decryptionSources,
  decryptionStatuses,
  type BalanceTrust,
  type BreakerState,
  type DecryptionSource,
  type DecryptionStatus,
} from "../types/lifecycle.js";
import type { BalanceSource } from "../balance/derive.js";

export interface DecryptionRow {
  amountHandle: `0x${string}`;
  cleartextRaw: string | null;
  status: DecryptionStatus;
  decryptedFor: `0x${string}` | null;
  source: DecryptionSource | null;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
}

export interface DrainerStateRow {
  id: "singleton";
  lastSuccessAt: Date | null;
  breakerState: BreakerState;
  breakerOpenedAt: Date | null;
}

export interface SdkCredentialRow {
  key: string;
  value: string;
  updatedAt: Date;
}

export interface BalanceCacheRow {
  address: `0x${string}`;
  status: BalanceTrust;
  raw: string;
  value: string;
  source: BalanceSource;
  pendingTransfers: number;
  asOfBlock: bigint | null;
  transferCount: number;
  maxTransferBlock: bigint | null;
  maxTransferLogIndex: number | null;
  updatedAt: Date;
}

const sqlStringList = (values: readonly string[]): string => {
  return values.map((value) => `'${value}'`).join(", ");
};

export const createDrainerTablesSql = [
  `CREATE TABLE IF NOT EXISTS decryptions (
    amount_handle text PRIMARY KEY,
    cleartext_raw text,
    status text NOT NULL CHECK (status IN (${sqlStringList(decryptionStatuses)})),
    decrypted_for text,
    source text CHECK (source IS NULL OR source IN (${sqlStringList(decryptionSources)})),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error_code text,
    last_error_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS decryptions_work_idx
    ON decryptions (status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS drainer_state (
    id text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
    last_success_at timestamptz,
    breaker_state text NOT NULL CHECK (breaker_state IN (${sqlStringList(breakerStates)})),
    breaker_opened_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS sdk_credentials (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS balances (
    address text PRIMARY KEY,
    status text NOT NULL CHECK (status IN (${sqlStringList(balanceTrustLevels)})),
    raw text NOT NULL,
    value text NOT NULL,
    source text NOT NULL CHECK (source IN ('derived', 'checkpoint')),
    pending_transfers integer NOT NULL,
    as_of_block numeric,
    transfer_count integer NOT NULL,
    max_transfer_block numeric,
    max_transfer_log_index integer,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
] as const;
