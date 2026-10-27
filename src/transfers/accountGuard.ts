import { signerManager } from "../signer/manager";
import { AccountChangedError } from "../services/uploadErrors";

/** The account an upload belongs to — capture it before anything async. */
export function captureUploader(): string | undefined {
  return signerManager.getPubkey();
}

/** Throws if the active account is no longer the one that started the upload.
 *  Call right before anything is signed with, or queued under, the active
 *  account's keys. */
export function assertSameAccount(uploaderPubkey: string | undefined): void {
  if (signerManager.getPubkey() !== uploaderPubkey) throw new AccountChangedError();
}
