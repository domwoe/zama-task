export const transferKinds = ["transfer", "shield", "unshield", "disclosure"] as const;
export type TransferKind = (typeof transferKinds)[number];

export const unwrapStatuses = ["requested", "finalized"] as const;
export type UnwrapStatus = (typeof unwrapStatuses)[number];

export const disclosedSources = ["disclosed"] as const;
export type DisclosedSource = (typeof disclosedSources)[number];

export const decryptionStatuses = [
  "encrypted",
  "pending",
  "unauthorized",
  "decrypted",
  "failed",
] as const;
export type DecryptionStatus = (typeof decryptionStatuses)[number];

export const decryptionSources = ["userDecrypt"] as const;
export type DecryptionSource = (typeof decryptionSources)[number];

export const breakerStates = ["closed", "open", "halfOpen"] as const;
export type BreakerState = (typeof breakerStates)[number];

export const balanceStatuses = ["complete", "partial", "unavailable"] as const;
export type BalanceStatus = (typeof balanceStatuses)[number];
