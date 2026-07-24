import {
  getStoredSecret,
  removeStoredItem,
  removeStoredSecret,
  STORAGE_KEYS,
} from "../utils/persistence";
import { isNativePlatform } from "../utils/platform";

/**
 * Prior to @formstr/signer, native (Android) nsec logins stored a raw nsec
 * in secure storage. The package has no raw-nsec method (only NIP-49
 * ncryptsec), so a user coming from that flow needs to pick a passphrase
 * once to re-encrypt their existing key. This reads the legacy value so the
 * UI can prompt for that passphrase; it does not touch the new signer state.
 */
export async function readLegacyNsec(): Promise<string | null> {
  if (!isNativePlatform) {
    return null;
  }

  try {
    return await getStoredSecret(STORAGE_KEYS.NSEC);
  } catch (error) {
    console.error("Failed to read legacy nsec during migration check", error);
    return null;
  }
}

export async function clearLegacyNsec(): Promise<void> {
  await Promise.allSettled([
    removeStoredSecret(STORAGE_KEYS.NSEC),
    removeStoredItem(STORAGE_KEYS.AUTH_METHOD),
    removeStoredItem(STORAGE_KEYS.PROFILE),
  ]);
}
