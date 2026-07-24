export type DriveSdkErrorCode =
  | "INVALID_CONFIGURATION"
  | "NOT_INITIALIZED"
  | "SIGNER_UNAVAILABLE"
  | "SIGNER_REJECTED"
  | "RELAY_ERROR"
  | "BLOSSOM_ERROR"
  | "ENCRYPTION_ERROR"
  | "DECRYPTION_ERROR"
  | "DRIVE_KEY_UNAVAILABLE"
  | "FILE_NOT_FOUND"
  | "INTEGRITY_ERROR"
  | "UNSUPPORTED_FORMAT"
  | "TRANSFER_FAILED"
  | "ABORTED";

export class DriveSdkError extends Error {
  readonly code: DriveSdkErrorCode;
  readonly cause?: unknown;

  constructor(code: DriveSdkErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DriveSdkError";
    this.code = code;
    this.cause = cause;
  }
}
