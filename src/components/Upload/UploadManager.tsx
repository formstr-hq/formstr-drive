import { useSyncExternalStore } from 'react';
import { TransferManager } from "./TransferManager";
import { getTransfers, subscribeToTransfers, cancelTransfer } from '../../transfers/transferStore';
import { retryTransfer, dismissTransfer } from '../../transfers/transferQueue';

export function UploadManager() {
  const transfers = useSyncExternalStore(subscribeToTransfers, getTransfers);

  const uploads = transfers.filter((t) => t.type === "upload");

  if (uploads.length === 0) return null;

  return (
    <TransferManager
      type="upload"
      transfers={uploads}
      onCancel={cancelTransfer}
      onRetry={retryTransfer}
      onDismiss={dismissTransfer}
    />
  );
}
