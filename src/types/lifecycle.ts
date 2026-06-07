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

// Trust level of a balance's `confirmed` figure. `confirmed.value` (when present)
// is always an *exact* total as of `confirmed.asOfBlock` — never a lower bound:
//   exact   — confirmed is current (no affecting transfer is still un-valued)
//   as_of   — confirmed is exact but as of an earlier block; newer transfers pending
//   unknown — no zero-anchored exact figure available (confirmed is null)
// Why isn't it current/known is carried separately by `pending.byStatus`, not here.
export const balanceTrustLevels = ["exact", "as_of", "unknown"] as const;
export type BalanceTrust = (typeof balanceTrustLevels)[number];
