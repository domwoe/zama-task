import {
  AclPausedError,
  DecryptionFailedError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationNotPropagatedError,
  InvalidKeypairError,
  KeypairExpiredError,
  RelayerRequestFailedError,
  matchZamaError,
} from "@zama-fhe/sdk";

export interface DecryptSuccess {
  readonly kind: "success";
  readonly cleartextRaw: string;
}

export type DecryptFailureKind =
  | "unauthorized"
  | "propagationLag"
  | "relayerRateLimited"
  | "relayerUnavailable"
  | "aclPaused"
  | "staleCredentials"
  | "decryptionFailed"
  | "unknown";

export interface DecryptFailure {
  readonly kind: "failure";
  readonly failure: DecryptFailureKind;
  readonly errorCode: string;
  readonly message: string;
  readonly statusCode?: number;
}

export type DecryptOutcome = DecryptSuccess | DecryptFailure;

const failure = (
  failureKind: DecryptFailureKind,
  error: Error,
  statusCode?: number,
): DecryptFailure => ({
  kind: "failure",
  failure: failureKind,
  errorCode: "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN",
  message: error.message,
  ...(statusCode === undefined ? {} : { statusCode }),
});

export const success = (value: bigint): DecryptSuccess => ({
  kind: "success",
  cleartextRaw: value.toString(),
});

export const matchDecryptFailure = (error: unknown): DecryptFailure => {
  return (
    matchZamaError(error, {
      DELEGATION_NOT_FOUND: (matched) =>
        failure("unauthorized", matched instanceof DelegationNotFoundError ? matched : matched),
      DELEGATION_EXPIRED: (matched) =>
        failure("unauthorized", matched instanceof DelegationExpiredError ? matched : matched),
      DELEGATION_NOT_PROPAGATED: (matched) =>
        failure(
          "propagationLag",
          matched instanceof DelegationNotPropagatedError ? matched : matched,
        ),
      RELAYER_REQUEST_FAILED: (matched) => {
        if (matched instanceof RelayerRequestFailedError && matched.statusCode === 429) {
          return failure("relayerRateLimited", matched, matched.statusCode);
        }

        if (matched instanceof RelayerRequestFailedError) {
          return failure("relayerUnavailable", matched, matched.statusCode);
        }

        return failure("relayerUnavailable", matched);
      },
      ACL_PAUSED: (matched) => failure("aclPaused", matched instanceof AclPausedError ? matched : matched),
      KEYPAIR_EXPIRED: (matched) =>
        failure("staleCredentials", matched instanceof KeypairExpiredError ? matched : matched),
      INVALID_KEYPAIR: (matched) =>
        failure("staleCredentials", matched instanceof InvalidKeypairError ? matched : matched),
      DECRYPTION_FAILED: (matched) =>
        failure("decryptionFailed", matched instanceof DecryptionFailedError ? matched : matched),
      _: (unknownError) => {
        if (unknownError instanceof Error) {
          return failure("unknown", unknownError);
        }

        return {
          kind: "failure",
          failure: "unknown",
          errorCode: "UNKNOWN",
          message: String(unknownError),
        };
      },
    }) ?? {
      kind: "failure",
      failure: "unknown",
      errorCode: "UNKNOWN",
      message: "Unknown decryption error",
    }
  );
};
