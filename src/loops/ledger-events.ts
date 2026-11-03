import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { type EventBus } from "../util/event-bus.ts";
import { tenantScopedBus } from "../tenants/bus.ts";

export type LedgerEventOp =
  | "ingest"
  | "proposal"
  | "annotate"
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
  tenant?: string;
}

export interface OwnedLedgerEvent extends LedgerEvent {
  owner: string;
}

export type LedgerEventBus = EventBus<OwnedLedgerEvent>;

const CHANNEL = "loop_item_events";

export function createPostgresLedgerEventBus(connectionString: string): LedgerEventBus {
  return tenantScopedBus(createPostgresNotifyBus<OwnedLedgerEvent>(connectionString, CHANNEL, "ledger-event"));
}
