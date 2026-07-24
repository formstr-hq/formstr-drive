import { Preferences } from "@capacitor/preferences";
import { localStorageAdapter, type StorageAdapter } from "@formstr/signer";
import { isNativePlatform } from "../utils/platform";

const SIGNER_STORAGE_PREFIX = "formstr-drive-signer:";

/**
 * @formstr/signer's `Signer` reads its storage adapter synchronously inside
 * its constructor, but Capacitor Preferences is async. On native we
 * pre-load every persisted signer key into an in-memory cache and hand back
 * a sync adapter backed by that cache, writing through to Preferences in
 * the background on every set/remove.
 */
export async function hydrateSignerStorage(): Promise<StorageAdapter> {
  if (!isNativePlatform) {
    return localStorageAdapter(SIGNER_STORAGE_PREFIX);
  }

  const cache = new Map<string, string>();

  try {
    const { keys } = await Preferences.keys();
    const prefixedKeys = keys.filter((key) => key.startsWith(SIGNER_STORAGE_PREFIX));

    await Promise.all(
      prefixedKeys.map(async (key) => {
        const { value } = await Preferences.get({ key });
        if (value !== null) {
          cache.set(key, value);
        }
      }),
    );
  } catch (error) {
    console.error("Failed to hydrate signer storage from Preferences", error);
  }

  return {
    get(key: string): string | null {
      return cache.get(SIGNER_STORAGE_PREFIX + key) ?? null;
    },
    set(key: string, value: string): void {
      const fullKey = SIGNER_STORAGE_PREFIX + key;
      cache.set(fullKey, value);
      void Preferences.set({ key: fullKey, value }).catch((error) => {
        console.error(`Failed to persist signer storage key "${key}"`, error);
      });
    },
    remove(key: string): void {
      const fullKey = SIGNER_STORAGE_PREFIX + key;
      cache.delete(fullKey);
      void Preferences.remove({ key: fullKey }).catch((error) => {
        console.error(`Failed to remove signer storage key "${key}"`, error);
      });
    },
  };
}
