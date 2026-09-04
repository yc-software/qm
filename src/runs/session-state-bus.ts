import { swallow } from "../util/errors.ts";

type SessionState = "working" | "awaiting_approval" | "idle";

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  participants?: string[];
  state: SessionState;
  at: number;
}

export interface SessionStateBus {
  emit(event: SessionStateEvent): void;
  subscribe(cb: (event: SessionStateEvent) => void): () => void;
  close?(): Promise<void>;
}

export function createMemorySessionStateBus(): SessionStateBus {
  const listeners = new Set<(e: SessionStateEvent) => void>();
  return {
    emit(event) {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch (e) {
          swallow("session-state listener", e);
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
