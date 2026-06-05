export interface TokenMetadata {
  readonly chainId: number;
  readonly address: `0x${string}`;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly kind: "erc7984-erc20-wrapper";
  readonly underlying: `0x${string}`;
}
