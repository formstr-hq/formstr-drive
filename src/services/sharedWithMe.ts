import { getStoredItem, setStoredItem, STORAGE_KEYS } from "../utils/persistence";

/** A share link this device has successfully opened. */
export interface OpenedShare {
  /** Full URL, including the `#shared=<naddr>&k=<hex>` fragment. */
  url: string;
  name: string;
  kind: "file" | "folder";
  /** Unix milliseconds. */
  openedAt: number;
}

const MAX_OPENED_SHARES = 50;

export async function listOpenedShares(): Promise<OpenedShare[]> {
  const items = await getStoredItem<OpenedShare[]>(STORAGE_KEYS.OPENED_SHARES, []);
  return Array.isArray(items) ? items : [];
}

/** Newest first, one entry per link; opening the same link again refreshes it. */
export async function rememberOpenedShare(share: OpenedShare): Promise<void> {
  const items = await listOpenedShares();
  const next = [share, ...items.filter((item) => item.url !== share.url)].slice(
    0,
    MAX_OPENED_SHARES,
  );
  await setStoredItem(STORAGE_KEYS.OPENED_SHARES, next);
}

export async function forgetOpenedShare(url: string): Promise<void> {
  const items = await listOpenedShares();
  await setStoredItem(
    STORAGE_KEYS.OPENED_SHARES,
    items.filter((item) => item.url !== url),
  );
}
