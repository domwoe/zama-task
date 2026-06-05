import type { Address } from "viem";

import type { DecryptOutcome } from "./outcome.js";

export interface Decryptor {
  decryptTransferAmountAs(handle: `0x${string}`, delegator: Address): Promise<DecryptOutcome>;
  decryptBalanceAs(holder: Address): Promise<DecryptOutcome>;
}
