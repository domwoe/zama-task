import {
  breakerStates,
  decryptionSources,
  decryptionStatuses,
  type BreakerState,
  type DecryptionSource,
  type DecryptionStatus,
} from "../types/lifecycle.js";

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
] as const;
