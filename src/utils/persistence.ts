import { Preferences } from "@capacitor/preferences";
import type { SecureKeyStoragePlugin } from "@khadarvsk/capacitor-secure-storage";
import { isAndroidPlatform, isNativePlatform } from "./platform";

// PROFILE, AUTH_METHOD, and NSEC are legacy keys kept only so
// src/signer/migration.ts can find and clear a pre-@formstr/signer nsec
// login; current signer state lives under the @formstr/signer storage
// adapter (see src/signer/storageAdapter.ts).
export const STORAGE_KEYS = {
  PROFILE: "formstr-drive-profile",
  CUSTOM_FOLDERS: "formstr-drive-custom-folders",
  CUSTOM_SERVERS: "formstr-drive-custom-servers",
  SELECTED_SERVER: "formstr-drive-selected-server",
  AUTH_METHOD: "formstr-drive-auth-method",
  NSEC: "formstr-drive-nsec",
  DRIVE_KEY_CACHE: "formstr-drive-drive-key-cache",
  DRIVE_PUBKEY_CACHE: "formstr-drive-drive-pubkey-cache",
  METADATA_OUTBOX: "formstr-drive-metadata-outbox",
  PROFILE_CACHE: "formstr-drive-profile-cache",
} as const;

function parseStoredValue<T>(value: string | null, defaultValue: T): T {
  if (value === null) {
    return defaultValue;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

export async function getStoredItem<T>(key: string, defaultValue: T): Promise<T> {
  if (isNativePlatform) {
    const { value } = await Preferences.get({ key });
    return parseStoredValue(value, defaultValue);
  }

  return parseStoredValue(localStorage.getItem(key), defaultValue);
}

export async function setStoredItem(key: string, value: unknown): Promise<void> {
  const serializedValue = JSON.stringify(value);

  if (isNativePlatform) {
    await Preferences.set({ key, value: serializedValue });
    return;
  }

  localStorage.setItem(key, serializedValue);
  window.dispatchEvent(new Event("storage"));
}

export async function removeStoredItem(key: string): Promise<void> {
  if (isNativePlatform) {
    await Preferences.remove({ key });
    return;
  }

  localStorage.removeItem(key);
  window.dispatchEvent(new Event("storage"));
}

// Load the Capacitor secure-storage plugin.
//
// IMPORTANT: we must NOT `return`/`await` the raw plugin proxy from an async
// function. `registerPlugin` returns a Proxy that responds to *every* property
// access — including `.then` — so promise-adoption machinery (any `await` or
// `return` of the proxy from an async fn) will call `proxy.then(...)`, which
// Capacitor forwards to native as an unimplemented method and throws
// "SecureKeyStorage.then() is not implemented on android". That silently hangs
// every secure read/write. Wrapping the proxy in a plain object avoids the trap.
async function getSecureKeyStorage(): Promise<{ plugin: SecureKeyStoragePlugin }> {
  const module = await import("@khadarvsk/capacitor-secure-storage");
  return { plugin: module.default };
}

export async function getStoredSecret(key: string): Promise<string | null> {
  if (isNativePlatform && isAndroidPlatform) {
    const { plugin } = await getSecureKeyStorage();
    const { value } = await plugin.get({ key });
    return value;
  }

  if (isNativePlatform) {
    const { value } = await Preferences.get({ key });
    return value;
  }

  return localStorage.getItem(key);
}

export async function setStoredSecret(key: string, value: string): Promise<void> {
  if (isNativePlatform && isAndroidPlatform) {
    const { plugin } = await getSecureKeyStorage();
    await plugin.set({ key, value });
    return;
  }

  if (isNativePlatform) {
    await Preferences.set({ key, value });
    return;
  }

  localStorage.setItem(key, value);
}

export async function removeStoredSecret(key: string): Promise<void> {
  if (isNativePlatform && isAndroidPlatform) {
    const { plugin } = await getSecureKeyStorage();
    await plugin.remove({ key });
    return;
  }

  if (isNativePlatform) {
    await Preferences.remove({ key });
    return;
  }

  localStorage.removeItem(key);
}
