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
  record(e: Omit<ErrorEvent, "ts">): ErrorEvent;
  onRecord(listener: (event: ErrorEvent) => void): () => void;
  flush(): Promise<void>;
  list(opts?: { scopeId?: string; sessionId?: string; since?: number; limit?: number }): Promise<ErrorEvent[]>;
  count(opts?: { scopeId?: string; sessionId?: string; since?: number }): Promise<number>;
}

const MAX = 5000;

export function createErrorLog(): ErrorLog {
  const sink = createTimestampedEventSink<ErrorEvent>({ max: MAX, defaultLimit: 200, equalityFields: ["sessionId"] });
  const listeners = new Set<(event: ErrorEvent) => void>();
  return {
    record(input) {
      const event = sink.record(input);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("[errors] record listener failed:", error);
        }
      }
      return event;
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: async () => {},
    list: (opts = {}) => sink.list(opts),
    count: async (opts = {}) => (await sink.list({ ...opts, limit: MAX })).length,
  };
}
