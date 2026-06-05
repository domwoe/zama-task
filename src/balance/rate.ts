export const underlyingToWrappedRaw = (underlyingRaw: bigint, rate: bigint): string => {
  if (rate <= 0n) {
    throw new Error(`Wrapper rate must be positive, got ${rate.toString()}`);
  }

  return (underlyingRaw / rate).toString();
};
