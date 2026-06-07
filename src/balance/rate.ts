export const underlyingToWrappedRaw = (underlyingRaw: bigint, rate: bigint): string => {
  if (rate <= 0n) {
    throw new Error(`Wrapper rate must be positive, got ${rate.toString()}`);
  }

  return (underlyingRaw / rate).toString();
};

/** An ERC-20 `Transfer` from the same transaction as a shield mint. */
export interface UnderlyingDeposit {
  readonly to: `0x${string}`;
  readonly value: bigint;
}

/**
 * Cleartext wrapped amount of a shield, derived from the underlying ERC-20
 * deposit into the wrapper in the same transaction — option (a), mirroring how
 * `UnwrapFinalized` converts its public `cleartextAmount` via `rate`. A wrap
 * amount is public, so we never need to decrypt it.
 *
 * Only an **unambiguous** single deposit into the wrapper is valued. Zero or
 * multiple deposits (batch wraps, routed deposits) return `null`, and the shield
 * falls back to the delegated decrypt path — we never guess a value.
 */
export const shieldDisclosedRaw = (
  deposits: readonly UnderlyingDeposit[],
  wrapper: `0x${string}`,
  rate: bigint,
): string | null => {
  const intoWrapper = deposits.filter((deposit) => sameAddress(deposit.to, wrapper));
  const [only] = intoWrapper;
  if (only === undefined || intoWrapper.length !== 1) {
    return null;
  }

  return underlyingToWrappedRaw(only.value, rate);
};

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
