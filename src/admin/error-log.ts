import type { ScopeId } from "../types.ts";
import { createTimestampedEventSink } from "./scoped-event-sink.ts";

export interface ErrorEvent {
  ts: number;
  category: string;
  code: string;
  message: string;
  scopeLabel: ScopeId;
  sessionId?: string;
}

export interface ErrorLog {
  record(e: Omit<ErrorEvent, "ts">): void;
  flush(): Promise<void>;
  list(opts?: { scopeId?: string; sessionId?: string; limit?: number; offset?: number }): Promise<ErrorEvent[]>;
  count(opts?: { scopeId?: string; sessionId?: string }): Promise<number>;
}

const MAX = 5000;

export function createErrorLog(): ErrorLog {
  const sink = createTimestampedEventSink<ErrorEvent>({ max: MAX, defaultLimit: 200, equalityFields: ["sessionId"] });
  return {
    record: sink.record,
    flush: async () => {},
    list: (opts = {}) => sink.list(opts),
    count: async (opts = {}) => (await sink.list({ ...opts, limit: MAX })).length,
  };
}

const recordedErrors = new WeakSet<object>();

export function markErrorRecorded(err: unknown): void {
  if (typeof err === "object" && err !== null) recordedErrors.add(err);
}

export function errorAlreadyRecorded(err: unknown): boolean {
  return typeof err === "object" && err !== null && recordedErrors.has(err);
}
