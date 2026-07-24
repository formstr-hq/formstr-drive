import { useSyncExternalStore } from 'react';
import { TransferManager } from "./TransferManager";
import { getTransfers, subscribeToTransfers, cancelTransfer } from '../../transfers/transferStore';
import { retryTransfer, dismissTransfer } from '../../transfers/transferQueue';

export function DownloadManager() {
  const transfers = useSyncExternalStore(subscribeToTransfers, getTransfers);

  const downloads = transfers.filter((t) => t.type === "download");

  if (downloads.length === 0) return null;

  return (
    <TransferManager
      type="download"
      transfers={downloads}
      onCancel={cancelTransfer}
      onRetry={retryTransfer}
      onDismiss={dismissTransfer}
    />
  );
}
