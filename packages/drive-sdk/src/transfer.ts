import { DriveSdkError } from "./errors";
import type {
  DriveTransferProgress,
  DriveTransferTask,
} from "./types";

type TransferOperation<T> = (
  signal: AbortSignal,
  report: (progress: Omit<DriveTransferProgress, "id">) => void,
) => Promise<T>;

export class ManagedTransferTask<T> implements DriveTransferTask<T> {
  readonly id: string;
  readonly result: Promise<T>;

  private readonly operation: TransferOperation<T>;
  private readonly listeners = new Set<(progress: DriveTransferProgress) => void>();
  private controller = new AbortController();
  private active: Promise<T>;
  private running = true;
  private latest: DriveTransferProgress;

  constructor(id: string, operation: TransferOperation<T>) {
    this.id = id;
    this.operation = operation;
    this.latest = { id, state: "queued", percent: 0 };
    this.active = this.run();
    this.result = this.active;
  }

  subscribe(listener: (progress: DriveTransferProgress) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.latest);
    } catch {
      // Progress observers are isolated from the transfer, including the
      // immediate snapshot delivered when they first subscribe.
    }
    return () => this.listeners.delete(listener);
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.controller.abort();
    await this.active.catch(() => undefined);
  }

  async retry(): Promise<T> {
    if (this.running) {
      throw new DriveSdkError("TRANSFER_FAILED", "Cannot retry a transfer that is still running");
    }
    if (this.latest.state === "cancelled") {
      throw new DriveSdkError("ABORTED", "A cancelled transfer cannot be retried");
    }
    if (this.latest.state !== "failed") {
      throw new DriveSdkError("TRANSFER_FAILED", "Only a failed transfer can be retried");
    }
    this.controller = new AbortController();
    this.running = true;
    this.emit({ state: "queued", percent: 0, message: "Retrying transfer" });
    this.active = this.run();
    return this.active;
  }

  private emit(progress: Omit<DriveTransferProgress, "id">): void {
    this.latest = { id: this.id, ...progress };
    for (const listener of this.listeners) {
      try {
        listener(this.latest);
      } catch {
        // Progress observers must never be able to fail the transfer itself.
      }
    }
  }

  private async run(): Promise<T> {
    try {
      const value = await this.operation(this.controller.signal, (progress) =>
        this.emit(progress),
      );
      this.emit({ state: "completed", percent: 100 });
      return value;
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.emit({ state: "cancelled", message: "Transfer cancelled" });
        throw new DriveSdkError("ABORTED", "Transfer cancelled", error);
      }
      this.emit({
        state: "failed",
        message: error instanceof Error ? error.message : "Transfer failed",
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
