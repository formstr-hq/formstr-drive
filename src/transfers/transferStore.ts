export type TransferType = "upload" | "download";
export type TransferStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface TransferItem {
  id: string; // Hash for downloads, file.name+hash for uploads
  type: TransferType;
  fileDetails: {
    name: string;
    size: number;
    hash: string;
    server?: string;
  };
  status: TransferStatus;
  progress: number; // 0 to 100
  stage?: string;
  currentChunk?: number;
  totalChunks?: number;
  error?: string;
  abortController: AbortController;
  // Native (Android) downloads: content:// uri of the finished file, for a
  // "View" action on the completed row.
  resultUri?: string;
}

const transfers = new Map<string, TransferItem>();
const listeners = new Set<() => void>();

let cachedTransfers: TransferItem[] = [];
let isCacheValid = false;

export function getTransfers(): TransferItem[] {
  if (!isCacheValid) {
    cachedTransfers = Array.from(transfers.values());
    isCacheValid = true;
  }
  return cachedTransfers;
}

export function getTransfer(id: string): TransferItem | undefined {
  return transfers.get(id);
}

export function subscribeToTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  isCacheValid = false;
  listeners.forEach((l) => l());
}

export function addTransfer(item: TransferItem) {
  if (transfers.has(item.id)) return;
  transfers.set(item.id, item);
  notify();
}

export function updateTransfer(id: string, updates: Partial<TransferItem>) {
  const existing = transfers.get(id);
  if (existing) {
    transfers.set(id, { ...existing, ...updates });
    notify();
  }
}

export function removeTransfer(id: string) {
  const existing = transfers.get(id);
  if (existing && (existing.status === "running" || existing.status === "pending")) {
    existing.abortController.abort();
  }
  transfers.delete(id);
  notify();
}

export function cancelTransfer(id: string) {
  const existing = transfers.get(id);
  if (existing) {
    existing.abortController.abort();
    updateTransfer(id, { status: "cancelled", stage: "Cancelled" });
  }
}
