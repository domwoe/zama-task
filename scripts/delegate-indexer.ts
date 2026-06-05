import { createDemoSdk, requireAddressEnv } from "./zama-demo-common.ts";

const context = createDemoSdk("DEMO_HOLDER_PRIVATE_KEY");

try {
  const delegateAddress = requireAddressEnv("INDEXER_ADDRESS");

  console.log(`delegator=${context.accountAddress}`);
  console.log(`delegate=${delegateAddress}`);
  console.log(`token=${context.tokenAddress}`);

  const result = await context.sdk.delegations.delegateDecryption({
    contractAddress: context.tokenAddress,
    delegateAddress,
  });
  console.log(`delegationReceipt=${result.txHash}`);

  const isDelegated = await context.sdk.delegations.isActive({
    contractAddress: context.tokenAddress,
    delegatorAddress: context.accountAddress,
    delegateAddress,
  });
  console.log(`isDelegated=${isDelegated.toString()}`);
} finally {
  context.dispose();
}
