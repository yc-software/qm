import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

export type LedgerEventOp =
  | "ingest"
  | "proposal"
  | "annotate"
  | "thread"
  | "action"
  | "reopen"
  | "ready"
  | "shipped"
  | "returned"
  | "parked"
  | "skipped";

export interface LedgerEvent {
  loopId: string;
  itemId: string;
  op: LedgerEventOp;
  at: number;
}

export interface OwnedLedgerEvent extends LedgerEvent {
  owner: string;
}

export type LedgerEventBus = EventBus<OwnedLedgerEvent>;

const CHANNEL = "loop_item_events";

export function createMemoryLedgerEventBus(): LedgerEventBus {
  return createMemoryEventBus<OwnedLedgerEvent>("ledger-event");
}

export function createPostgresLedgerEventBus(connectionString: string): LedgerEventBus {
  return createPostgresNotifyBus<OwnedLedgerEvent>(connectionString, CHANNEL, "ledger-event");
}
