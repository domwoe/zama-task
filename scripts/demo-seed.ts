import {
  createDemoSdk,
  optionalAmountEnv,
  requireAddressEnv,
} from "./zama-demo-common.ts";

const context = createDemoSdk("DEMO_HOLDER_PRIVATE_KEY");

try {
  const token = context.sdk.createWrappedToken(context.tokenAddress);
  const recipient = requireAddressEnv("DEMO_RECIPIENT_ADDRESS");
  const shieldAmount = optionalAmountEnv("DEMO_SHIELD_AMOUNT");
  const transferAmount = optionalAmountEnv("DEMO_TRANSFER_AMOUNT");
  const unshieldAmount = optionalAmountEnv("DEMO_UNSHIELD_AMOUNT");

  console.log(`holder=${context.accountAddress}`);
  console.log(`token=${context.tokenAddress}`);

  if (shieldAmount !== null) {
    console.log(`shield raw=${shieldAmount.toString()}`);
    const result = await token.shield(shieldAmount, {
      onApprovalSubmitted: (hash) => {
        console.log(`approvalSubmitted=${hash}`);
      },
      onShieldSubmitted: (hash) => {
        console.log(`shieldSubmitted=${hash}`);
      },
    });
    console.log(`shieldReceipt=${result.txHash}`);
  }

  if (transferAmount !== null) {
    console.log(`confidentialTransfer to=${recipient} raw=${transferAmount.toString()}`);
    const result = await token.confidentialTransfer(recipient, transferAmount, {
      onEncryptComplete: () => {
        console.log("transferEncryptionComplete=true");
      },
      onTransferSubmitted: (hash) => {
        console.log(`transferSubmitted=${hash}`);
      },
    });
    console.log(`transferReceipt=${result.txHash}`);
  }

  if (unshieldAmount !== null) {
    console.log(`unshield raw=${unshieldAmount.toString()}`);
    const result = await token.unshield(unshieldAmount, {
      onUnwrapSubmitted: (hash) => {
        console.log(`unwrapSubmitted=${hash}`);
      },
      onFinalizing: () => {
        console.log("unwrapFinalizing=true");
      },
      onFinalizeSubmitted: (hash) => {
        console.log(`finalizeSubmitted=${hash}`);
      },
    });
    console.log(`unshieldReceipt=${result.txHash}`);
  }
} finally {
  context.dispose();
}
