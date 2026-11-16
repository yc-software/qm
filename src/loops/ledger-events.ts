import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { type EventBus } from "../util/event-bus.ts";

export type LedgerEventOp =
  | "ingest"
  | "proposal"
  | "annotate"
  | "verdict"
  | "thread"
  | "triage"
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
  tenantId?: string;
}

export type LedgerEventBus = EventBus<OwnedLedgerEvent>;

const CHANNEL = "loop_item_events";

export function createPostgresLedgerEventBus(connectionString: string): LedgerEventBus {
  return createPostgresNotifyBus<OwnedLedgerEvent>(connectionString, CHANNEL, "ledger-event");
}
