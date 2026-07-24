import { SimplePool, type Event, type Filter } from "nostr-tools";
import { DriveSdkError } from "./errors";
import type {
  DriveRelayAdapter,
  DriveRelayFilter,
  NostrEvent,
} from "./types";

/** Default relay transport used when an application does not inject one. */
export class NostrRelayAdapter implements DriveRelayAdapter {
  private readonly pool = new SimplePool();

  async query(
    relays: readonly string[],
    filter: DriveRelayFilter,
  ): Promise<NostrEvent[]> {
    try {
      const events = await this.pool.querySync(
        [...relays],
        filter as Filter,
        { maxWait: 8_000 },
      );
      return events as NostrEvent[];
    } catch (error) {
      throw new DriveSdkError("RELAY_ERROR", "Unable to read Drive events from relays", error);
    }
  }

  async publish(relays: readonly string[], event: NostrEvent): Promise<void> {
    try {
      await Promise.any(this.pool.publish([...relays], event as Event));
    } catch (error) {
      throw new DriveSdkError("RELAY_ERROR", "Unable to publish the Drive event", error);
    }
  }

  close(relays: readonly string[]): void {
    this.pool.close([...relays]);
  }
}
